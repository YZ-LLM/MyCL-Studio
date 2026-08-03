// living-docs — yaşayan proje dökümantasyonu (.mycl/features.md) + UI kullanma
// kılavuzu (.mycl/user-guide.md). MyCL projeye dokundukça (pipeline sonu) +
// mevcut projeyi ilk açışta (bootstrap) günceller. Orkestratör + Faz 1/2 ajanları
// bunları okuyup grounded soru sorar — gereksiz "X özelliği var mı?" sorusunu sormaz.
//
// Backend: ORKESTRATÖR rolü (v15.13 — ana ajana/codegen'e GİTMEZ), abonelik/CLI modunda
// runClaudeCli (Read/Grep/Glob açık → ajan kodu inceler; Bash KALDIRILDI — güvenlik). Ajan tek bir {"kind":"docs",...}
// JSON bloğu döner; YAZIMI MyCL yapar (forced-tool yok; ajan .mycl dışına yazamaz). Approval YOK.
// Fail → görünür uyarı + audit, ana akışı BLOKLAMAZ (yan-yarar, sessiz değil).

import { selectEffortForTask, resolveKnownModel } from "./model-catalog.js";
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { type AdrDecision, DECISIONS_DIR_REL, parseAdrDecisions, writeAdrs } from "./adr.js";
import { appendAudit } from "./audit.js";
import { extractKindBlock } from "./cli-json.js";
import { runClaudeCli } from "./cli-run.js";
import { runReadOnlySdkLoop } from "./sdk-read-loop.js";
import { READ_ONLY_DISALLOWED_TOOLS } from "./tool-policy.js";
import { backendForRole, claudeKeyForRole, type MyclConfig } from "./config.js";
import { emitChatMessage, emitClaudeStream, emitUserGuide, emitTechDoc, emitPhaseRunning, emitPhaseIdle, type ClaudeUsage } from "./ipc.js";
import { log } from "./logger.js";
import { templatePath } from "./phase-registry.js";
import { resolvePublicDir } from "./public-dir.js";
import {
  DOCS_SCHEMA_VERSION,
  decideDocsStale,
  buildSourceDigest,
  shortHash,
  type DocsStamp,
  type FreshnessInput,
  type StaleReason,
} from "./docs-freshness.js";
import { enumerateSourceUnits } from "./edd/enumerate.js";
import { safeSourceHash } from "./edd/source-hash.js";
import { isGitRepo, getHeadSha, isWorkingTreeClean } from "./git.js";
import { substitute } from "./template-engine.js";
import type { State } from "./types.js";

const FEATURES_REL = join(".mycl", "features.md");
const USER_GUIDE_REL = join(".mycl", "user-guide.md");
// YZLLM 2026-06-20: kullanım kılavuzu çift dilli — TR + EN. EN sürümü ayrı dosyada.
const USER_GUIDE_EN_REL = join(".mycl", "user-guide.en.md");
// YZLLM 2026-06-14: TR teknik döküman + app-içi kılavuz veri-temeli (help-pages.json). İlk-açılışta + her iterasyonda üretilir.
const TECH_DOC_REL = join(".mycl", "tech-doc.md");
const HELP_PAGES_REL = join(".mycl", "help-pages.json");
// 2026-08-03 (YZLLM kararı): kılavuz PROJENİN İÇİNE de yazılır — depoyla birlikte gider, kullanıcı
// deposunda görür, ve uygulama içi "?" penceresi yayına alınmış projede de çalışır. `.mycl` kopyaları
// çalışma kaydı olarak KORUNUR (orkestratör grounding'i ve Full Test onları okur).
const PROJECT_GUIDE_TR_REL = join("docs", "kullanim-kilavuzu.md");
const PROJECT_GUIDE_EN_REL = join("docs", "user-guide.md");
/** Uygulama içi "?" penceresinin veri temeli — statik klasöre yazılır → çalışma anında `fetch` ile okunur. */
const PROJECT_HELP_PAGES_SUBPATH = join("docs", "help-pages.json");
const DOCS_STAMP_REL = join(".mycl", "docs-stamp.json");
const SENTINEL_EMPTY = "(none yet)";

/** Tek kullanım-kılavuzu sayfası: bir app-route'una eşlenen görev metni + güncelleme tarihi.
 *  Çift-yönlü link + "?" popup'ın veri temeli; Faz 5 codegen + ekran-görüntüsü boru hattı bunu okur.
 *  YZLLM 2026-06-20: ÇİFT DİLLİ — "?" popup'ında TR/EN sekmeleri bu alanları gösterir. */
export interface HelpPage {
  /** Anlatılan app-sayfasının route'u (ör. "/kullanicilar"). "?" popup + çift-yönlü link bunu kullanır. */
  route: string;
  /** Görev başlığı — Türkçe (ör. "Kullanıcı ekleme"). */
  title_tr: string;
  /** Görev başlığı — İngilizce (ör. "Add user"). */
  title_en: string;
  /** Türkçe anlatım (markdown) — "?" popup TR sekmesi. */
  body_tr: string;
  /** İngilizce anlatım (markdown) — "?" popup EN sekmesi. */
  body_en: string;
  /** MyCL'in damgaladığı son-güncelleme tarihi (YYYY-AA-GG) — yalnız içerik değişince yenilenir. */
  updated_at: string;
}

/** Deterministik tarih damgası (YYYY-AA-GG) — LLM'e ÜRETTİRİLMEZ (halüsinasyon riski). */
function stampDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** SAF: features.md'den app-route yollarını çıkar (help_pages çapraz-kontrolü için — yanlış "?" hedefini eler). */
export function extractRoutesFromFeatures(featuresMd: string): string[] {
  const routes = new Set<string>();
  for (const m of featuresMd.matchAll(/(?:^|\s|`|\(|\[)(\/[a-z0-9][a-z0-9/_-]*)/gim)) {
    routes.add(m[1].replace(/\/+$/, "") || "/");
  }
  return [...routes];
}

async function readDocSafe(projectRoot: string, rel: string): Promise<string> {
  try {
    const c = await fs.readFile(join(projectRoot, rel), "utf-8");
    return c.trim() || SENTINEL_EMPTY;
  } catch (e) {
    // errno-AYRIMI (sessiz-fallback denetimi): ENOENT = doküman gerçekten yok (SENTINEL_EMPTY meşru). Diğer hata
    // (EACCES/EIO/bozulma) = var ama okunamadı → "boş" sanıp üstüne ince doküman yazmak içerik-kaybı. Görünür.
    if ((e as { code?: string }).code !== "ENOENT") {
      log.error("living-docs", "doküman okunamadı (var ama erişilemez) — SENTINEL_EMPTY döndü, üstüne yazma riski", { rel, code: (e as { code?: string }).code });
    }
    return SENTINEL_EMPTY;
  }
}

/** Pure: living-docs prompt'unu kur (test edilebilir). */
export function buildLivingDocsPrompt(opts: {
  tmpl: string;
  intentSummary: string;
  existingFeatures: string;
  existingUserGuide: string;
  existingDecisions: string;
  includeUserGuide: boolean;
}): string {
  // YZLLM 2026-06-20: kullanım kılavuzu ÇİFT DİLLİ — TR + EN ikisi de üretilir.
  const guideInstruction = opts.includeUserGuide
    ? "Produce the end-user manual for the UI in BOTH languages: `user_guide_tr_md` **in Turkish** and `user_guide_en_md` **in English** (same tasks, mirrored). One `## <Nasıl: görev>` (TR) / `## <How to: task>` (EN) heading per common task, with numbered steps a non-technical user can follow."
    : 'This project has NO end-user UI — set both `user_guide_tr_md` and `user_guide_en_md` to an empty string "".';
  // YZLLM 2026-06-14: app-içi kılavuzun veri temeli — her user-guide görevini bir app-route'una eşle ("?" popup içeriği).
  // YZLLM 2026-06-20: ÇİFT DİLLİ — "?" popup'ında TR/EN sekmeleri için her görev iki dilde.
  const helpPagesInstruction = opts.includeUserGuide
    ? 'Also produce **help_pages** — a JSON array. For EACH user-guide task emit one object {route, title_tr, title_en, body_tr, body_en}: `route` = the in-app route/path where that task happens (e.g. "/kullanicilar"); `title_tr`/`title_en` = the task name in Turkish/English; `body_tr`/`body_en` = the step-by-step help for that page in Turkish/English (these become the TR/EN tabs of the in-app "?" help popup). Routes MUST be REAL app routes (do NOT invent — they are cross-checked against features).'
    : "No UI → set `help_pages` to [].";
  // ADR (mimari karar kayıtları): yalnız GERÇEK mimari kararları yakala — uydurma/jenerik
  // ("X seçildi çünkü iyi") YASAK (mahkeme: içeriksiz ADR tiyatrodur). Mevcut kararlar verilir
  // ki ajan ÇELİŞMESİN / gereksiz yeniden-karar vermesin; değişen kararı status:superseded ile güncelle.
  const adrInstruction =
    "Also produce **adr_decisions** — a JSON array of the project's REAL architecture decisions (auth strategy, data store choice, state management, API style, key security trade-offs, framework/library picks with lasting impact). Each: {slug (stable kebab-case id), title, status (accepted|proposed|superseded|deprecated), context (why the decision was needed), options (alternatives considered), decision (what was chosen), consequences (trade-offs)}. ONLY record decisions actually evidenced in the code/spec — do NOT invent or pad. If a previously-recorded decision changed, re-emit it with the SAME slug and status:superseded + a note. If there are no genuine architecture decisions, set adr_decisions to []. Prose in English (agent-facing, like features.md). The EXISTING decisions are provided below — keep them consistent, do NOT contradict silently.";
  return substitute(opts.tmpl, {
    INTENT_SUMMARY: opts.intentSummary || "(no intent recorded)",
    EXISTING_FEATURES: opts.existingFeatures,
    EXISTING_USER_GUIDE: opts.existingUserGuide,
    EXISTING_DECISIONS: opts.existingDecisions,
    ADR_INSTRUCTION: adrInstruction,
    USER_GUIDE_INSTRUCTION: guideInstruction,
    // Her zaman: o iterasyonun TR teknik dökümanı. Bootstrap/ilk-açılışta DERİN tarama (klasör ağacı, her modül/route/endpoint).
    TECH_DOC_INSTRUCTION:
      "Always produce **tech_doc_md** — a TURKISH technical document for THIS iteration: what was built/changed and WHY (architecture, key design decisions, modules/routes/endpoints/stores). **YZLLM 2026-06-15: her konuyu KISA ve ÖZ anlat** — her başlık altında 1-3 cümle/birkaç madde, gereksiz tekrar/dolgu YOK; okuyan hızlıca kavrasın. Tek `## <konu>` başlığı per topic, altında özet. In bootstrap/first-open mode, deeply walk the folder + subfolders (Glob/Grep/Read) so NO module/route/endpoint/store is missed — but still describe each CONCISELY (kapsam tam, anlatım kısa). No invention. File paths and code identifiers stay verbatim (English); prose in Turkish.",
    HELP_PAGES_INSTRUCTION: helpPagesInstruction,
  });
}

/** Pure: ajan help_pages'ini doğrula + features'ta OLMAYAN route'a eşlenenleri ELE (yanlış "?" hedefini önle).
 *  features.md'de hiç route yoksa (greenfield ilk üretim) çapraz-kontrol ATLANIR. updated_at burada YOK —
 *  tarih updateLivingDocs'ta, yalnız içerik değişen sayfaya atanır. */
export function parseHelpPages(
  raw: unknown,
  knownRoutes: string[],
): Array<Omit<HelpPage, "updated_at">> {
  return parseHelpPagesDetailed(raw, knownRoutes).pages;
}

/**
 * parseHelpPages + DÜRÜSTLÜK bilgisi (2026-08-03): eski/bozuk şema geldiğinde İngilizce alanlar Türkçe
 * içerikle dolduruluyor (dayanıklılık). Bu sessiz kalırsa kullanıcı "İngilizce kılavuz" sanır ama içerik
 * Türkçedir — kullanıcının şartı "TÜRKÇE VE İNGİLİZCE 2 TANE" olduğu için bu sessiz bir söz ihlali.
 * Artık hangi sayfalarda düşüldüğü DÖNÜLÜR; çağıran görünür uyarı basar.
 */
export function parseHelpPagesDetailed(
  raw: unknown,
  knownRoutes: string[],
): { pages: Array<Omit<HelpPage, "updated_at">>; enFellBack: string[] } {
  if (!Array.isArray(raw)) return { pages: [], enFellBack: [] };
  const known = new Set(knownRoutes);
  const out: Array<Omit<HelpPage, "updated_at">> = [];
  const enFellBack: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.route !== "string" || o.route.trim() === "") continue;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    // Çift dilli alanlar; eski şema (task_title/body_md) gelirse her iki dile düşür (dayanıklılık).
    const title_tr = str(o.title_tr) || str(o.task_title);
    const title_en = str(o.title_en) || title_tr;
    const body_tr = str(o.body_tr) || str(o.body_md);
    const body_en = str(o.body_en) || body_tr;
    if (!title_tr || !body_tr) continue; // en az TR içerik şart
    const route = o.route.replace(/\/+$/, "") || "/";
    if (known.size > 0 && !known.has(route)) continue; // features'ta yok → uydurma route, ele
    // İngilizce alan ÜRETİLMEDİ ve Türkçeye düşüldü mü?
    if ((!str(o.title_en) && title_tr) || (!str(o.body_en) && body_tr)) enFellBack.push(route);
    out.push({ route, title_tr, title_en, body_tr, body_en });
  }
  return { pages: out, enFellBack };
}

/** Pure: ajan çıktısından docs bloğunu parse + doğrula (features_md zorunlu; tech_doc_md/help_pages opsiyonel — fail-soft). */
export function parseLivingDocsBlock(text: string): {
  features_md: string;
  user_guide_tr_md: string;
  user_guide_en_md: string;
  tech_doc_md: string;
  help_pages: Array<Omit<HelpPage, "updated_at">>;
  /** 2026-08-03: İngilizce metni üretilmeyip Türkçeye düşülen route'lar (görünür uyarı için). */
  help_en_fell_back: string[];
  adr_decisions: AdrDecision[];
} | null {
  const block = extractKindBlock(text, ["docs"]);
  if (!block) return null;
  const b = block as Record<string, unknown>;
  const f = b.features_md;
  if (typeof f !== "string" || f.trim() === "") return null; // features_md ZORUNLU (geriye uyumlu)
  const features_md = f;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  // Çift dilli kılavuz; eski tek-alan (user_guide_md) gelirse TR'ye düşür (dayanıklılık).
  const user_guide_tr_md = str(b.user_guide_tr_md) || str(b.user_guide_md);
  const helpDetailed = parseHelpPagesDetailed(b.help_pages, extractRoutesFromFeatures(features_md));
  return {
    features_md,
    user_guide_tr_md,
    user_guide_en_md: str(b.user_guide_en_md),
    tech_doc_md: str(b.tech_doc_md),
    help_pages: helpDetailed.pages,
    help_en_fell_back: helpDetailed.enFellBack,
    adr_decisions: parseAdrDecisions(b.adr_decisions),
  };
}

/** Mevcut `.mycl/decisions/*.md` içeriğini tek digest'e topla — living-docs ajanına "çelişme" girdisi.
 *  Dizin yoksa SENTINEL_EMPTY. Token sınırı: dosya başına ilk ~700 char. */
async function readDecisionsDigest(projectRoot: string): Promise<string> {
  const dir = join(projectRoot, DECISIONS_DIR_REL);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".md") && n.startsWith("ADR-")).sort();
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      log.warn("living-docs", "kararlar dizini okunamadı (var ama erişilemez)", { code: (e as { code?: string }).code });
    }
    return SENTINEL_EMPTY;
  }
  if (names.length === 0) return SENTINEL_EMPTY;
  const parts: string[] = [];
  for (const n of names) {
    try {
      parts.push((await fs.readFile(join(dir, n), "utf-8")).trim().slice(0, 700));
    } catch {
      /* tek dosya okunamadı → atla */
    }
  }
  return parts.length ? parts.join("\n\n---\n\n") : SENTINEL_EMPTY;
}

function withTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

async function fileExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/** Mevcut help-pages.json'u oku (yoksa boş) — tarih karşılaştırması için. */
async function readExistingHelpPages(projectRoot: string): Promise<HelpPage[]> {
  try {
    const arr = JSON.parse(await fs.readFile(join(projectRoot, HELP_PAGES_REL), "utf-8"));
    return Array.isArray(arr) ? arr.filter((p) => p && typeof p.route === "string" && typeof p.updated_at === "string") : [];
  } catch (e) {
    // errno-AYRIMI: ENOENT = help-pages.json yok (meşru boş). Parse-hatası/EACCES = bozuk/erişilemez → görünür
    // (tarih-karşılaştırması güvenilmez → kılavuz gereksiz yeniden-çekilebilir/bayat kalabilir).
    if ((e as { code?: string }).code !== "ENOENT") {
      log.warn("living-docs", "help-pages.json okunamadı/parse edilemedi (bozuk?) — tarih karşılaştırması güvenilmez", { error: String(e) });
    }
    return [];
  }
}

/** SAF: yeni sayfalara tarih ata — içerik (body_md+task_title) DEĞİŞMEMİŞSE eski tarihi koru, değişmişse bugün.
 *  Böylece yalnız DEĞİŞEN sayfanın tarihi yenilenir (bayat değil, ama gereksiz tarih-kayması da yok). */
export function assignHelpPageDates(
  fresh: Array<Omit<HelpPage, "updated_at">>,
  existing: HelpPage[],
  today: string,
): HelpPage[] {
  const prev = new Map(existing.map((p) => [p.route, p]));
  return fresh.map((p) => {
    const old = prev.get(p.route);
    const unchanged =
      old &&
      old.body_tr === p.body_tr &&
      old.body_en === p.body_en &&
      old.title_tr === p.title_tr &&
      old.title_en === p.title_en;
    return { ...p, updated_at: unchanged ? old.updated_at : today };
  });
}

/**
 * Bootstrap — MEVCUT (MyCL-dışı) projeyi ilk açışta dökümante et. İdempotent:
 * `.mycl/features.md` zaten varsa no-op. Yalnız kod içeren projelerde çalışır
 * (boş greenfield'de pipeline-sonu hook üretir). Arka planda (await edilmeden)
 * çağrılmalı — open'ı bloklamasın. Non-blocking.
 */
export async function bootstrapLivingDocs(
  state: State,
  config: MyclConfig,
  opts?: { onboarding?: boolean },
): Promise<{
  ok: boolean;
  reason: "written" | "exists" | "empty" | "provider-skip" | "failed" | "no-access";
}> {
  try {
    // YZLLM 2026-06-14 (çıktı-başına kapı, onaylı): features.md VE tech-doc.md ikisi de varsa no-op. features.md
    // varken tech-doc.md yoksa (bu özellikten önce açılmış proje) eksik-üretimi TAMAMLA — onboarding tazelenir.
    const root = state.project_root;
    if ((await fileExists(join(root, FEATURES_REL))) && (await fileExists(join(root, TECH_DOC_REL)))) {
      // Mevcut features.md APOLOGY ise (önceki no-access koşusu: "kod tabanına erişilemiyor…") "exists" SAYMA
      // → yeniden üret (cave5: eski apology → bu sefer (A)-fix ile gerçek docs). isNoAccessDoc apology'yi yakalar.
      const existing = await readDocSafe(root, FEATURES_REL).catch(() => "");
      if (!isNoAccessDoc({ features_md: existing })) return { ok: true, reason: "exists" };
      log.info("living-docs", "mevcut features.md apology → yeniden üretiliyor");
    }
    const { isExistingProject } = await import("./phase-1-codebase-probe.js");
    if (!(await isExistingProject(state.project_root))) return { ok: false, reason: "empty" }; // boş proje → pipeline üretir
    // v15.13: docs'u ORKESTRATÖR rolü yazar (ana ajan değil — kullanıcı kuralı).
    // 2026-08-03: API modu artık ATLANMIYOR — updateLivingDocs iki arka ucu da destekliyor (salt-okunur
    // SDK araç döngüsü). Yalnız anahtar yoksa üretilemez; o durumu updateLivingDocs görünür şekilde söyler.
    emitChatMessage(
      "system",
      "📚 İlk açılış: mevcut koddan proje dökümantasyonu + kullanma kılavuzu üretiliyor…",
    );
    // Onboarding (entegrasyon) bağlamında döküman ÇEKİRDEK iş → 3× tekrar dene + fail "önemli" tonunda.
    const r = await updateLivingDocs(state, config, {
      attempts: opts?.onboarding ? 3 : 1,
      onboarding: opts?.onboarding,
    });
    // r: "written" | "failed" | "no-access" → reason'a doğrudan taşı (no-access ayrı ele alınır).
    return { ok: r === "written", reason: r };
  } catch (err) {
    log.warn("living-docs", "bootstrap failed (non-fatal)", err);
    return { ok: false, reason: "failed" };
  }
}

/**
 * Ajanın "kod tabanını okuyamadım" sinyali/özrü mü? İKİ katman:
 *  - BİRİNCİL: MYCL_NO_ACCESS belirteci (prompt-yönlendirmeli, kesin).
 *  - GÜÇLÜ apology-imzaları (tek eşleşme yeter): SADECE "döküman üretemedim" özründe geçer, gerçek feature-doc'ta
 *    ASLA — ör. "no features could be documented", "nothing was inventable". (cave5 canlı: İngilizce apology bunu
 *    içeriyordu ama eski konservatif eşik KAÇIRIYORDU → yanlış-negatif, mahkemenin uyardığı. Düzeltildi.)
 *  - ZAYIF açık-başarısızlık ibareleri (≥2 ayrı): tek tesadüfi "erişilemedi" (ör. "dosya-erişilemedi hatalarını
 *    yönetir") tetiklemesin (mahkeme false-pozitif). Olumlu formlar (erişilebilir/erişildi) eşleşmez.
 */
export function isNoAccessDoc(parsed: { features_md?: string; tech_doc_md?: string }): boolean {
  const f = (parsed.features_md ?? "").trim();
  if (/^MYCL_NO_ACCESS/i.test(f)) return true;
  const blob = `${parsed.features_md ?? ""}\n${parsed.tech_doc_md ?? ""}`.toLowerCase();
  const strong = [
    "no features could be documented", "no functionality could be documented", "could not be documented",
    "nothing was inventable", "without real code", "hiçbir özellik belgelenem", "hiçbir özellik bulunam",
  ];
  if (strong.some((m) => blob.includes(m))) return true;
  const weak = [
    // TR — olumsuz form (olumlu "erişilebilir/erişildi" eşleşmez):
    "erişilemiyor", "erişilemedi", "erişemedim", "ulaşamadım", "okuyamadım", "inceleyemedim", "göremedim",
    "okuma izni reddedil", "izni reddedil", "erişim engellendi", "erişim reddedil",
    "kod tabanına erişilem", "koda erişilem",
    // EN — açık başarısızlık (cave5: "is inaccessible", "reads denied", "denied by permission"):
    "is inaccessible", "reads denied", "denied by permission", "permission denied", "access denied",
    "cannot access", "couldn't access", "could not access", "unable to read", "could not read",
  ];
  const hits = weak.filter((m) => blob.includes(m)).length;
  return hits >= 2;
}

/**
 * Yaşayan dökümantasyonu güncelle. Non-blocking — her fail görünür uyarı + audit, ASLA throw etmez.
 * Döner: "written"=yazıldı, "failed"=üretilemedi, "no-access"=ajan kodu OKUYAMADI (özrü yazma; escalate).
 * opts.attempts → LLM geçersiz blok döndürürse tekrar dene (aralıklı; onboarding 3×). opts.onboarding →
 * entegrasyon bağlamı: fail mesajı "ana akış etkilenmez" DEMEZ (YZLLM: "entegrasyon sırasında her şey önemli").
 */
/**
 * Kılavuz dosyasını hedef projenin İÇİNE yaz (depoyla gitsin). Görünür fail-soft: yazılamazsa uyarı
 * (kılavuzun `.mycl` kopyası zaten yazıldığı için akış durmaz, ama sessiz kalmaz).
 * `.gitignore` bu yolu dışlıyorsa BİR KEZ görünür not — MyCL `.gitignore`'a ASLA dokunmaz.
 */
async function writeProjectDoc(state: State, relPath: string, content: string): Promise<void> {
  const abs = join(state.project_root, relPath);
  try {
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
  } catch (e) {
    emitChatMessage(
      "system",
      `⚠️ Kullanım kılavuzu projeye yazılamadı (${relPath}): ${String(e).slice(0, 120)}. ` +
        `Kopyası .mycl klasöründe duruyor.`,
    );
  }
}

export async function updateLivingDocs(
  state: State,
  config: MyclConfig,
  opts?: { attempts?: number; onboarding?: boolean },
): Promise<"written" | "failed" | "no-access"> {
  // emitPhaseRunning gerçekten çağrıldıysa true → finally emitPhaseIdle'ı YALNIZ o zaman çalıştırır.
  // Provider-skip / erken-template-hatası dalında emitPhaseRunning'siz emitPhaseIdle, bekleyen bir AskQ'nun
  // _askqPending'ini yanlışlıkla temizlerdi (çapraz-aile mahkeme; ipc.ts:471 doğrulandı).
  let phaseStarted = false;
  try {
    // v15.13: Yaşayan dökümantasyonu ORKESTRATÖR rolü yazar — ana ajana (codegen) GİTMEZ
    // (kullanıcı kuralı). Orkestratör "her şeyi bilen" hafif rol → docs için doğru yer.
    // Abonelik/CLI modu birincil hedef. API modu sonraki tur — görünür not (sessiz değil).
    // 2026-08-03 (YZLLM şartı "kılavuz HER ZAMAN güncel, TR + EN"): API modunda bu adım eskiden TAMAMEN
    // atlanıyordu → kullanıcı API modundaysa kılavuz HİÇ üretilmiyordu (sözün sessizce tutulmaması).
    // Artık iki arka uç da destekleniyor: CLI/abonelik → `claude` binary; API → ortak salt-okunur SDK
    // araç döngüsü (aynı Read/Grep/Glob seti, Bash YOK). Anahtar yoksa görünür hata (sessiz atlama yok).
    const docsBackend = backendForRole(config, "orchestrator");
    const docsApiKey =
      docsBackend === "cli" ? undefined : claudeKeyForRole(config.api_keys, "orchestrator")?.trim();
    if (docsBackend !== "cli" && !docsApiKey) {
      emitChatMessage(
        "system",
        "⚠️ Kullanım kılavuzu güncellenemedi — API modundasın ama orkestratör rolü için API anahtarı yok. " +
          "Ayarlardan anahtarı gir ya da abonelik moduna geç.",
      );
      return "failed";
    }
    const includeUserGuide = !(state.skip_ui_phases ?? false);
    // Orkestratör modeli (yoksa main'e fallback — SelectedModels.orchestrator opsiyonel).
    const baseDocsModel = config.selected_models.orchestrator ?? config.selected_models.main;
    // Model guard (YZLLM 2026-07-01): katalog-dışı id (canlı: claude-fable-5) CLI'da exit=1 verip bu adımı
    // düşürüyordu. Tanınmayan model → ana modele GÖRÜNÜR fallback (kullanıcı ayarı kral: bilineni değiştirmez).
    const knownDocs = resolveKnownModel(baseDocsModel, config.selected_models.main, "dökümantasyon");
    if (knownDocs.note) emitChatMessage("system", `ℹ️ ${knownDocs.note}`);
    const docsModel = knownDocs.model;

    const tmpl = await fs.readFile(templatePath("living-docs.md"), "utf-8");
    const prompt = buildLivingDocsPrompt({
      tmpl,
      intentSummary: state.intent_summary ?? "",
      existingFeatures: await readDocSafe(state.project_root, FEATURES_REL),
      existingUserGuide: includeUserGuide
        ? await readDocSafe(state.project_root, USER_GUIDE_REL)
        : SENTINEL_EMPTY,
      existingDecisions: await readDecisionsDigest(state.project_root),
      includeUserGuide,
    });

    emitChatMessage("system", "📚 Proje dökümantasyonu güncelleniyor…");
    // YZLLM 2026-06-14: 30s heartbeat'i AKTİVE ET — bootstrap/update emitPhaseRunning çağırmadığı için onboarding'de
    // hiç çalışmıyordu. Banner açıkken heartbeat (HEARTBEAT_MS=30_000) observer'ın tool_use'larını "şu an: X" basar
    // (yedek timer KURMA). emitPhaseIdle finally'de.
    emitPhaseRunning("📚 Proje inceleniyor / döküman üretiliyor…");
    phaseStarted = true;
    emitClaudeStream({
      sub: "init",
      text: "cli-living-docs",
      model: docsModel,
      cwd: state.project_root,
    });
    // Tekrar-deneme: LLM bazen geçerli {kind:docs} bloğu döndürmüyor (aralıklı). attempts kez dene; ilkten
    // sonra "yalnız blok" hatırlatması ekle. Onboarding 3× geçer (entegrasyon dökümanı çekirdek iş).
    const maxAttempts = Math.max(1, opts?.attempts ?? 1);
    let parsed: ReturnType<typeof parseLivingDocsBlock> = null;
    let noAccess = false;
    let lastDetail = "";
    for (let attempt = 1; attempt <= maxAttempts && !parsed && !noAccess; attempt++) {
      if (attempt > 1) {
        emitChatMessage(
          "system",
          `↻ Döküman bloğu geçersiz/eksik geldi — tekrar isteniyor (deneme ${attempt}/${maxAttempts})…`,
        );
      }
      const userMessage =
          (attempt === 1
            ? "Inspect the codebase and emit the updated documentation JSON block now."
            : 'Reminder: output ONLY the single {"kind":"docs", ...} JSON block — no prose before or after, no code fences. Emit it now.') +
        ' IMPORTANT: If you CANNOT read the project files (Read/Grep/Glob fail due to permission or sandbox errors), do NOT apologize or invent documentation — instead emit exactly {"kind":"docs","features_md":"MYCL_NO_ACCESS"} and stop.';
      const effort = selectEffortForTask("verification", config.claude_code_flags.effort); // hafif iş
      const onText = (t: string): void => emitClaudeStream({ sub: "text", text: t });
      const observer = (tu: { name: string; input: Record<string, unknown> }): void =>
        emitClaudeStream({ sub: "tool_use", tool_name: tu.name, tool_input: tu.input });
      // salt-okunur: ajan kodu Read/Grep/Glob ile gezip JSON döner, dosyaları MyCL'in kendi Node kodu yazar.
      // Bash KALDIRILDI (çapraz-aile mahkeme): Bash açıkken salt-okunur niyete rağmen `cat > dosya << EOF`
      // ile YABANCI projenin kaynağını ezebiliyordu (tool-policy.ts belgeli kaçış). Doküman-üretimi için
      // Read/Grep/Glob yeterli — onboarding'in non-destructive garantisi buna dayanır. İKİ arka uçta da AYNI.
      const res = docsApiKey
        ? await runReadOnlySdkLoop(config, docsApiKey, {
            systemPrompt: prompt,
            userMessage,
            projectRoot: state.project_root,
            modelId: docsModel,
            effort,
            toolNames: ["Read", "Grep", "Glob"],
            maxTurns: 20,
            toolResultCap: 12_000,
            maxTokens: 16_384, // kılavuz + özellik listesi uzun olabilir (truncate riskini düşür)
            onText,
            observer,
            tag: "living-docs",
          })
        : await runClaudeCli({
            systemPrompt: prompt,
            userMessage,
            modelId: docsModel,
            cwd: state.project_root,
            allowedTools: ["Read", "Grep", "Glob"],
            disallowedTools: READ_ONLY_DISALLOWED_TOOLS, // Write/Edit/alt-ajan yasak
            effort,
            onText,
            observer,
            timeoutMs: 300_000,
          });
      // Token telemetrisi yalnız CLI yolunda gelir (SDK döngüsü kendi muhasebesini runTurn içinde yapar).
      const cliUsage = (res as { usage?: ClaudeUsage }).usage;
      if (cliUsage) emitClaudeStream({ sub: "token_usage", usage: cliUsage });
      if (!res.ok) {
        lastDetail = String(res.error ?? "claude hatası (error alanı boş)");
        continue; // tekrar dene
      }
      const candidate = parseLivingDocsBlock(res.text);
      if (!candidate) {
        lastDetail = `no valid {kind:docs} block (çıktı başı: ${(res.text ?? "").slice(0, 100)})`;
        continue;
      }
      if (isNoAccessDoc(candidate)) {
        // Ajan kodu OKUYAMADI → MYCL_NO_ACCESS sinyali veya "erişemedim" özrü üretti. Retry FUTİL (izin
        // değişmez) → döngüyü kır + özrü döküman diye YAZMA (YZLLM: "düşünmesi lazım", körü körüne yazma).
        noAccess = true;
        lastDetail = `no-access: ajan kod tabanını okuyamadı (${(candidate.features_md ?? "").slice(0, 80)})`;
        break;
      }
      parsed = candidate;
    }

    if (noAccess) {
      // Görünür + escalate: ajan projeyi okuyamadı → döküman üretilemez. Rutin yolda uyar; onboarding'de
      // runOnboarding aksiyon-önerili tek mesajı verir (çift-mesaj yok). Audit no-access olarak.
      if (!opts?.onboarding) {
        emitChatMessage(
          "system",
          "⚠️ Dökümantasyon üretilemedi — ajan proje dosyalarını OKUYAMADI (izin/sandbox engeli). Bu tur atlandı.",
        );
      }
      await appendAudit(state.project_root, {
        ts: Date.now(),
        phase: state.current_phase ?? 0,
        event: "living-docs-no-access",
        caller: "mycl-bridge",
        detail: lastDetail.slice(0, 200),
      }).catch((e) => log.error("living-docs", "no-access audit yazılamadı (denetim izi eksik)", { error: String(e) }));
      return "no-access";
    }

    if (!parsed) {
      // onboarding'de TEK, bağlam-zengin mesajı runOnboarding verir → updateLivingDocs SUSTAR (çift-mesaj yok;
      // çapraz-aile mahkeme). Rutin pipeline'da bu fail mesajı tek kaynak → bırak (eski ton: "ana akış etkilenmez").
      if (!opts?.onboarding) {
        emitChatMessage(
          "system",
          `⚠️ Dökümantasyon üretilemedi (${maxAttempts} deneme) — bu tur atlandı (ana akış etkilenmez).`,
        );
      }
      await appendAudit(state.project_root, {
        ts: Date.now(),
        phase: state.current_phase ?? 0,
        event: "living-docs-update-failed",
        caller: "mycl-bridge",
        detail: lastDetail.slice(0, 200),
      }).catch((e) => log.error("living-docs", "update-failed audit yazılamadı (denetim izi eksik)", { error: String(e) }));
      return "failed";
    }
    await fs.writeFile(
      join(state.project_root, FEATURES_REL),
      withTrailingNewline(parsed.features_md),
      "utf-8",
    );
    if (includeUserGuide && parsed.user_guide_tr_md.trim()) {
      const guide = withTrailingNewline(parsed.user_guide_tr_md);
      await fs.writeFile(join(state.project_root, USER_GUIDE_REL), guide, "utf-8");
      await writeProjectDoc(state, PROJECT_GUIDE_TR_REL, guide);
      emitUserGuide(guide); // "Kılavuz" sekmesini güncelle (TR)
    }
    // YZLLM 2026-06-20: kullanım kılavuzunun İngilizce sürümü ayrı dosyaya.
    if (includeUserGuide && parsed.user_guide_en_md.trim()) {
      const guideEn = withTrailingNewline(parsed.user_guide_en_md);
      await fs.writeFile(join(state.project_root, USER_GUIDE_EN_REL), guideEn, "utf-8");
      await writeProjectDoc(state, PROJECT_GUIDE_EN_REL, guideEn);
    }
    // YZLLM 2026-06-14: TR teknik döküman (.mycl/tech-doc.md) + app-içi kılavuz veri-temeli (.mycl/help-pages.json).
    // Tarih MyCL'de deterministik damgalanır (LLM'e ürettirilmez).
    if (parsed.tech_doc_md.trim()) {
      const techDoc = withTrailingNewline(`> Son güncelleme: ${stampDate()}\n\n${parsed.tech_doc_md}`);
      await fs.writeFile(join(state.project_root, TECH_DOC_REL), techDoc, "utf-8");
      emitTechDoc(techDoc);
    }
    if (includeUserGuide) {
      // Ajan çıktısı KÜMÜLATİF current set → eksik sayfa düşer (artık-kullanılmayan kılavuz temizliği). Tarih yalnız
      // içerik değişen sayfada yenilenir (assignHelpPageDates). help_pages boşsa [] yazılır (stale temizliği).
      // DÜRÜSTLÜK (KATI #4): İngilizce metin üretilemeyip Türkçeye düşüldüyse kullanıcı bunu BİLMELİ —
      // aksi halde "İngilizce kılavuz var" sanır ama içerik Türkçedir (şart: TR + EN iki dosya).
      if (parsed.help_en_fell_back.length > 0) {
        const n = parsed.help_en_fell_back.length;
        emitChatMessage(
          "system",
          `⚠️ Kullanım kılavuzunun İngilizce metni ${n} sayfada üretilemedi ` +
            `(${parsed.help_en_fell_back.slice(0, 3).join(", ")}${n > 3 ? "…" : ""}) — o sayfalarda İngilizce ` +
            `alan şimdilik Türkçe içerikle dolduruldu. Sonraki tazelemede yeniden denenecek.`,
        );
      }
      const dated = assignHelpPageDates(
        parsed.help_pages,
        await readExistingHelpPages(state.project_root),
        stampDate(),
      );
      const helpJson = JSON.stringify(dated, null, 2) + "\n";
      await fs.writeFile(join(state.project_root, HELP_PAGES_REL), helpJson, "utf-8");
      // Uygulama içi "?" penceresi bunu ÇALIŞMA ANINDA `fetch("/docs/help-pages.json")` ile okur →
      // sunucu tarafı dosya okuma yok, yayına alınca da çalışır (eskiden `.mycl` gitmezse kırılıyordu).
      try {
        const pub = await resolvePublicDir(state);
        await writeProjectDoc(state, join(pub.rel, PROJECT_HELP_PAGES_SUBPATH), helpJson);
      } catch (e) {
        log.warn("living-docs", "uygulama içi kılavuz verisi projeye yazılamadı", { error: String(e) });
      }
    }
    // ADR (mimari karar kayıtları): .mycl/decisions/ADR-NNNN-<slug>.md (MADR). Numara+tarih
    // korunur (içerik değişmediyse); kararlar TARİHSEL → silinmez. Relevance recall (source
    // "decisions") bunları Faz 2 grounding'e enjekte eder → ajan önceki kararla çelişmez.
    if (parsed.adr_decisions.length > 0) {
      const { written } = await writeAdrs(state.project_root, parsed.adr_decisions, stampDate());
      if (written > 0) {
        emitChatMessage("system", `🗏 Mimari karar kaydı güncellendi (.mycl/decisions/ — ${written} ADR).`);
      }
    }
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: state.current_phase ?? 0,
      event: "living-docs-update",
      caller: "mycl-bridge",
    }).catch((e) => log.error("living-docs", "update audit yazılamadı (denetim izi eksik)", { error: String(e) }));
    emitChatMessage(
      "system",
      `📚 Proje dökümantasyonu güncellendi (.mycl/features.md${includeUserGuide ? " + user-guide.md" : ""}).`,
    );
    return "written";
  } catch (err) {
    // Hiçbir koşulda pipeline'ı bloklama — görünür uyarı + log.
    log.warn("living-docs", "updateLivingDocs failed (non-fatal)", err);
    emitChatMessage("system", "⚠️ Yaşayan dökümantasyon güncellemesi atlandı (beklenmedik hata).");
    return "failed";
  } finally {
    // YALNIZ emitPhaseRunning çağrıldıysa kapat → provider-skip/erken-hata dalında emitPhaseRunning'siz
    // emitPhaseIdle, bekleyen AskQ'nun _askqPending'ini yanlışlıkla temizlemesin (çapraz-aile mahkeme).
    if (phaseStarted) emitPhaseIdle();
  }
}

// ───────────────────────── Tazelik (2026-08-03) ─────────────────────────
// KULLANICI ŞARTI: "KULLANIM KILAVUZU HER ZAMAN GÜNCEL TUTMALI." Eskiden tazeleme YALNIZ pipeline sonunda
// tetikleniyordu; üç manuel düğme (Full Test / Bakım Turu / Güvenlik Taraması) ve proje açılışı kılavuzu
// hiç tazelemiyordu — bakım turu bağımlılıkları güncelleyip kodu değiştirse bile kılavuz eski kalıyordu.

/** Kılavuz çıktılarının beklenen yolları (damgada ve bayatlık kontrolünde kullanılır). */
async function expectedDocOutputs(state: State): Promise<string[]> {
  const out = [FEATURES_REL, TECH_DOC_REL];
  if (!(state.skip_ui_phases ?? false)) {
    out.push(USER_GUIDE_REL, USER_GUIDE_EN_REL, HELP_PAGES_REL, PROJECT_GUIDE_TR_REL, PROJECT_GUIDE_EN_REL);
    try {
      const pub = await resolvePublicDir(state);
      out.push(join(pub.rel, PROJECT_HELP_PAGES_SUBPATH));
    } catch {
      /* statik klasör çözülemedi — o çıktı beklenenler listesine girmez */
    }
  }
  return out;
}

/** Şimdiki durumun parmak izini çıkar (git kısa yolu + kaynak özeti + çıktı özetleri). */
async function computeDocsSignature(state: State): Promise<FreshnessInput["current"]> {
  const root = state.project_root;
  let head: string | undefined;
  let dirty: boolean | undefined;
  try {
    if (await isGitRepo(root)) {
      head = (await getHeadSha(root)) ?? undefined;
      dirty = !(await isWorkingTreeClean(root));
    }
  } catch {
    head = undefined; // git okunamadı → kaynak özeti yoluna düş
  }
  // Kaynak özeti: git temizse gereksiz (HEAD yeter) — pahalı taramayı atla.
  let source_digest = "";
  let unit_count = 0;
  if (!head || dirty) {
    try {
      const units = await enumerateSourceUnits(root);
      const hashed = await Promise.all(
        units.map(async (u) => {
          if (!u.analyzable) return { path: u.unit, skipped: true };
          const r = await safeSourceHash(u.abs).catch(() => null);
          return { path: u.unit, hash: r?.hash ?? null, skipped: !r };
        }),
      );
      const built = buildSourceDigest(hashed);
      source_digest = built.digest;
      unit_count = built.count;
    } catch {
      source_digest = ""; // hesaplanamadı → damgayla eşleşmez → bayat say (kuşkuda tazele)
    }
  }
  const outputs: Record<string, string | null> = {};
  for (const rel of await expectedDocOutputs(state)) {
    try {
      outputs[rel] = shortHash(await fs.readFile(join(root, rel), "utf-8"));
    } catch {
      outputs[rel] = null; // yok/okunamıyor
    }
  }
  return { head, dirty, source_digest, unit_count, outputs };
}

/** Damgayı oku (bozuksa null → bayat say). */
async function readDocsStamp(root: string): Promise<DocsStamp | null> {
  try {
    return JSON.parse(await fs.readFile(join(root, DOCS_STAMP_REL), "utf-8")) as DocsStamp;
  } catch {
    return null;
  }
}

/** Damgayı yaz — YALNIZ üretim BAŞARILI olduğunda (başarısızda damga yazılmaz → sonraki tetikte tekrar denenir). */
async function writeDocsStamp(state: State): Promise<void> {
  const cur = await computeDocsSignature(state);
  const outputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(cur.outputs)) if (v) outputs[k] = v;
  const stamp: DocsStamp = {
    schema: DOCS_SCHEMA_VERSION,
    ts: Date.now(),
    head: cur.head,
    dirty: cur.dirty,
    source_digest: cur.source_digest,
    unit_count: cur.unit_count,
    outputs,
  };
  await fs
    .writeFile(join(state.project_root, DOCS_STAMP_REL), JSON.stringify(stamp, null, 2) + "\n", "utf-8")
    .catch((e) => log.warn("living-docs", "kılavuz damgası yazılamadı", { error: String(e) }));
}

/**
 * TEK GİRİŞ NOKTASI: kılavuz bayatsa tazele, değilse HİÇBİR LLM çağrISI yapma (ucuz).
 * Pipeline koşuyorsa ertelenir (pipeline sonunda zaten çalışacak → çift üretim yok).
 */
export async function refreshDocsIfStale(
  state: State,
  config: MyclConfig,
  opts: { origin: "pipeline-end" | "open" | "full-test" | "maintenance" | "dast"; force?: boolean },
): Promise<"refreshed" | "fresh" | "failed" | "deferred"> {
  let verdict = { stale: true, reason: "no_stamp" as StaleReason, detail: "zorunlu tazeleme" };
  if (!opts.force) {
    try {
      verdict = decideDocsStale({
        stamp: await readDocsStamp(state.project_root),
        current: await computeDocsSignature(state),
        schema: DOCS_SCHEMA_VERSION,
        maxUnits: 5000,
      });
    } catch (e) {
      log.warn("living-docs", "bayatlık kontrolü yapılamadı → tazele (kuşkuda bayat)", { error: String(e) });
    }
    if (!verdict.stale) {
      await appendAudit(state.project_root, {
        ts: Date.now(),
        phase: state.current_phase,
        event: "living-docs-fresh",
        caller: "mycl-orchestrator",
        detail: `${opts.origin}: ${verdict.detail}`,
      }).catch(() => {});
      return "fresh"; // gürültü yok: taze olduğunu kullanıcıya söylemeye gerek yok
    }
  }
  if (opts.origin !== "pipeline-end") {
    emitChatMessage("system", `📚 Kullanım kılavuzu güncelleniyor (${verdict.detail})…`);
  }
  const r = await updateLivingDocs(state, config);
  if (r !== "written") return "failed"; // damga YAZILMAZ → bir sonraki tetikte tekrar denenir
  await writeDocsStamp(state);
  return "refreshed";
}
