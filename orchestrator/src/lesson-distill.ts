// lesson-distill — SIZDIRMASIZ projeler arası öğrenme döngüsü (YZLLM 2026-07-16: "çok kritik bi konu bu.
// hiç bir veri sızıntısı olmaması lazım projeler arasında").
//
// Mimari: HAM ders proje-YERELDİR (<proje>/.mycl/lessons.jsonl — experience-layer). Projeler arası yalnız
// DAMITILMIŞ, proje-agnostik İLKE taşınır (~/.mycl/global-lessons.jsonl):
//   ham ders → LLM damıtma (yalın Türkçe ilke; proje verisi YASAK; genellenemiyorsa dürüst skip)
//            → DETERMİNİSTİK sızıntı kapısı (leakGate — LLM önerir, KOD karar verir; fail-closed:
//              yol/URL/e-posta/proje adı/kod tanımlayıcısı/backtick kokusu → ders ATILIR, asla saklanmaz)
//            → tekilleştirme (kelime örtüşmesi) → global depo.
// Uygulama tarafı: orkestratör sistem prompt'una son N genel ders enjekte edilir (context-builder).
//
// İlke: KAYIP > SIZINTI. Kapı bir dersi haksız yere reddedebilir (kabul edilebilir; görünür loglanır);
// tersi (proje verisinin başka projeye taşınması) yapısal olarak kabul edilemez. Yalnız verified
// (düşman-doğrulanmış) dersler damıtılır — çapraz proje etki alanında zayıf iddia taşınmaz.

import Anthropic from "@anthropic-ai/sdk";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { resolveLlmClient } from "./claude-api.js";
import { runClaudeCli } from "./cli-run.js";
import { backendForRole, type MyclConfig } from "./config.js";
import { signatureOverlap } from "./experience-layer.js";
import { emitClaudeStream, withClaudeStreamBanner } from "./ipc.js";
import { log } from "./logger.js";
import { selectEffortForTask, selectModelForTask } from "./model-catalog.js";
import { globalConfigDir } from "./paths.js";
import { ZERO_TOOLS_DISALLOWED } from "./tool-policy.js";

export interface GlobalLesson {
  ts: number;
  /** Kısa kategori (küçük harf, boşluksuz; leakGate + sanitize'dan geçer). */
  category: string;
  /** Proje-agnostik ilke — 1-2 cümle yalın Türkçe. */
  principle_tr: string;
}

function globalLessonsPath(): string {
  return join(globalConfigDir(), "global-lessons.jsonl");
}

// ───────── Sızıntı kapısı (SAF, deterministik, fail-closed) ─────────

/** Genel teknoloji adları — dosya-uzantısı/PascalCase kurallarına yanlış takılmasın ("Next.js",
 *  "TypeScript" proje verisi değildir). Bilinçli dar liste: genişletmek kolay, delik açmak zor olsun.
 *  Çerçeve .js adları harf-duyarsız ("Next.js"/"next.js"); PascalCase adlar TAM yazımla (aksi delik açar). */
const FRAMEWORK_JS_RE = /\b(node|next|vue|nuxt|angular|express|three|d3)\.js\b/gi;
const TECH_NAME_RE =
  /\b(TypeScript|JavaScript|GitHub|GitLab|PostgreSQL|MongoDB|MySQL|SQLite|GraphQL|WebSocket|WebSockets|OAuth|OpenAPI|RabbitMQ|PyPI|NuGet)\b/g;

/** Kod-dosyası uzantıları — çıplak dosya adı bile (yol olmasa da) proje kokusudur. */
const FILE_TOKEN_RE =
  /\b[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|php|java|kt|swift|css|scss|html|json|jsonl|ya?ml|md|sql|sh|env|lock|toml)\b/i;

export type LeakVerdict = { ok: true } | { ok: false; reason: string };

/**
 * SAF sızıntı kapısı: damıtılmış metin proje verisi kokusu taşıyorsa REDDET (ders atılır).
 * Aşırı-reddetme bilinçli tercihtir (kayıp > sızıntı); genel teknoloji adları serbesttir.
 */
export function leakGate(text: string, projectName: string): LeakVerdict {
  const t = text.trim();
  if (t.length < 20) return { ok: false, reason: "çok kısa (ders değil)" };
  if (t.length > 500) return { ok: false, reason: "çok uzun (ham veri dökümü kokusu)" };
  if (t.includes("`")) return { ok: false, reason: "backtick/kod parçası" };
  if (/https?:\/\/|www\./i.test(t)) return { ok: false, reason: "URL" };
  if (/\S+@\S+\.\S+/.test(t)) return { ok: false, reason: "e-posta" };
  if (/(^|[\s"'(])[/~][\w.-]+\/[\w./-]+/.test(t) || /\b[A-Za-z]:\\/.test(t)) {
    return { ok: false, reason: "dosya yolu" };
  }
  const noTech = t.replace(FRAMEWORK_JS_RE, " ").replace(TECH_NAME_RE, " ");
  if (FILE_TOKEN_RE.test(noTech)) return { ok: false, reason: "dosya adı" };
  // Kod tanımlayıcısı kokusu: kelime İÇİNDE herhangi bir küçük→BÜYÜK geçiş (camelCase VE PascalCase —
  // MAHKEME CRITICAL 2026-07-17: eski regex küçük harfle başlıyordu, "AuthService" geçiyordu) veya
  // snake_case. Yalın Türkçe ilke cümlesi bunları içermez; içeriyorsa damıtma yasağı deldi → at.
  if (/\b\w*[a-zçğıöşü][A-ZÇĞİÖŞÜ]\w*\b/.test(noTech)) {
    return { ok: false, reason: "kod tanımlayıcısı (camelCase/PascalCase)" };
  }
  if (/\b\w+_\w+\b/.test(noTech)) return { ok: false, reason: "snake_case tanımlayıcı" };
  // Proje adı: Türkçe aksan normalize (mahkeme MEDIUM: klasör "arcelik-app", metin "Arçelik'te") +
  // ad token'larına böl (≥4 harf) — çekim eki almış geçişler substring'le yakalanır.
  const trFold = (x: string) =>
    x.toLowerCase().replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u");
  const tNorm = trFold(t);
  const pnNorm = trFold(projectName.trim());
  if (pnNorm.length >= 3 && tNorm.includes(pnNorm)) return { ok: false, reason: "proje adı" };
  for (const tok of pnNorm.split(/[-_\s.]+/)) {
    if (tok.length >= 4 && tNorm.includes(tok)) return { ok: false, reason: "proje adı parçası" };
  }
  return { ok: true };
}

// ───────── Damıtma (LLM önerir) + ayrıştırma ─────────

export const DISTILL_SYSTEM_PROMPT = `Sen MyCL'in ders damıtıcısısın. Sana BİR projede yaşanmış somut bir sorun/çözüm verilecek.
Görevin: bundan PROJEDEN TAMAMEN BAĞIMSIZ, başka projelerde de geçerli TEK bir mühendislik dersi çıkarmak.

KATI YASAKLAR (tek ihlal dersi geçersiz kılar):
- Proje adı, dosya adı/yolu, dizin, URL, e-posta YAZMA.
- Kod tanımlayıcısı (fonksiyon/değişken/sınıf adı, camelCase/snake_case kelime) YAZMA.
- Kod parçası ve backtick KULLANMA.
- Projeye özgü alan terimleri (ürün/veri/ekran adları) YAZMA.
Genel teknoloji adları (npm, TypeScript, Playwright, Docker gibi) serbesttir.

Genellenebilir bir ders yoksa dürüstçe skip döndür.

YALNIZ şu JSON'lardan birini yaz (başka hiçbir metin yok):
{"kind":"global_lesson","category":"<kısa-kategori>","principle_tr":"<1-2 cümle yalın Türkçe ilke>"}
{"kind":"skip"}`;

/** LLM çıktısından damıtılmış dersi ayrıştır. skip → null (dürüst atlama); bozuk → null + uyarı caller'da. */
export function parseDistilledLesson(
  text: string,
): { category: string; principle_tr: string } | "skip" | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { kind?: string; category?: string; principle_tr?: string };
    if (obj.kind === "skip") return "skip";
    if (obj.kind !== "global_lesson" || typeof obj.principle_tr !== "string") return null;
    const category =
      typeof obj.category === "string" && /^[a-zçğıöşü][a-zçğıöşü-]{2,29}$/i.test(obj.category.trim())
        ? obj.category.trim().toLowerCase()
        : "genel";
    return { category, principle_tr: obj.principle_tr.trim() };
  } catch {
    return null;
  }
}

// ───────── Global depo ─────────

export async function appendGlobalLesson(lesson: GlobalLesson): Promise<void> {
  const path = globalLessonsPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(lesson) + "\n", "utf-8");
}

/** Son N genel dersi getir (enjeksiyon bütçesi — prompt şişmesin). */
export async function readGlobalLessons(limit = 12): Promise<GlobalLesson[]> {
  try {
    const raw = await readFile(globalLessonsPath(), "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as GlobalLesson;
        } catch {
          return null;
        }
      })
      .filter((x): x is GlobalLesson => Boolean(x && x.principle_tr))
      .slice(-limit);
  } catch {
    return []; // dosya yok → ders yok
  }
}

/** Orkestratör prompt'una giren kısa TR blok. */
export function formatGlobalLessonsTR(lessons: GlobalLesson[]): string {
  return lessons.map((l) => `- [${l.category}] ${l.principle_tr}`).join("\n");
}

// ───────── Uçtan uca: damıt → kapıla → tekilleştir → sakla ─────────

export interface RawLessonInput {
  projectRoot: string;
  problem: string;
  resolution: string;
  principle: string;
}

export type DistillOutcome = "stored" | "duplicate" | "rejected" | "skip" | "error";

type LlmCall = (system: string, user: string) => Promise<string>;

async function defaultLlmCall(config: MyclConfig): Promise<LlmCall> {
  const model = selectModelForTask("classification", config.selected_models.model_tiers).modelId;
  const useCli = backendForRole(config, "orchestrator") === "cli";
  // MAHKEME CRITICAL (2026-07-17): cwd PROJE DEĞİL — nötr ~/.mycl + SIFIR araç (Read/Grep/Glob dahil
  // kapalı). Eski hali proje kökünde PURE_REASONING ile koşuyordu → model proje dosyalarını okuyup
  // içeriği sözdizim izi bırakmadan parafraz edebilirdi (leakGate sözdizimseldir, semantiği göremez).
  const neutralCwd = globalConfigDir();
  if (useCli) {
    return async (system, user) => {
      const res = await withClaudeStreamBanner({ text: "cli-ders-damitma", model, cwd: neutralCwd }, () =>
        runClaudeCli({
          systemPrompt: system,
          userMessage: user,
          modelId: model,
          cwd: neutralCwd,
          // Girdisi zaten prompt'ta — araçsız (sızıntı vektörü açılmaz).
          disallowedTools: ZERO_TOOLS_DISALLOWED,
          effort: selectEffortForTask("classification", config.claude_code_flags.effort),
          onText: (t) => emitClaudeStream({ sub: "text", text: t }),
          timeoutMs: 90_000,
        }),
      );
      if (!res.ok) throw new Error(res.error);
      return res.text;
    };
  }
  return async (system, user) => {
    const { client, model: apiModel } = resolveLlmClient(
      config,
      "orchestrator",
      config.api_keys.orchestrator ?? config.api_keys.main,
      model,
      { timeoutMs: 90_000 },
    );
    const response = await client.messages.create({
      model: apiModel,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    });
    return response.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  };
}

/**
 * Ham (proje-yerel) dersten genel ders üret ve sakla. Best-effort: ana akışı ASLA bozmaz (caller
 * fire-and-forget çağırır). `llm` testte enjekte edilir (LLM'siz CI).
 */
export async function distillAndStoreGlobalLesson(
  config: MyclConfig,
  raw: RawLessonInput,
  llm?: LlmCall,
): Promise<DistillOutcome> {
  try {
    const call = llm ?? (await defaultLlmCall(config));
    const user = `Sorun: ${raw.problem.slice(0, 600)}\n\nÇözüm: ${raw.resolution.slice(0, 600)}\n\nYerel ilke: ${raw.principle.slice(0, 300)}`;
    const text = await call(DISTILL_SYSTEM_PROMPT, user);
    const parsed = parseDistilledLesson(text);
    if (parsed === "skip") return "skip";
    if (!parsed) {
      log.warn("lesson-distill", "damıtma çıktısı ayrıştırılamadı — ders atıldı (fail-closed)");
      return "error";
    }
    const verdict = leakGate(`${parsed.category} ${parsed.principle_tr}`, basename(raw.projectRoot));
    if (!verdict.ok) {
      // Görünür (KATI #4) ama akış bozmaz: sızıntı kokusu → ders ATILDI. Kayıp > sızıntı.
      log.warn("lesson-distill", "sızıntı kapısı dersi reddetti — SAKLANMADI", { reason: verdict.reason });
      return "rejected";
    }
    const existing = await readGlobalLessons(200);
    if (existing.some((e) => signatureOverlap(e.principle_tr, parsed.principle_tr) >= 0.7)) {
      return "duplicate";
    }
    await appendGlobalLesson({ ts: Date.now(), category: parsed.category, principle_tr: parsed.principle_tr });
    return "stored";
  } catch (e) {
    log.warn("lesson-distill", "genel ders damıtma başarısız (non-fatal)", { error: String(e) });
    return "error";
  }
}
