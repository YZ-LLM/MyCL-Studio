// living-docs — yaşayan proje dökümantasyonu (.mycl/features.md) + UI kullanma
// kılavuzu (.mycl/user-guide.md). MyCL projeye dokundukça (pipeline sonu) +
// mevcut projeyi ilk açışta (bootstrap) günceller. Orkestratör + Faz 1/2 ajanları
// bunları okuyup grounded soru sorar — gereksiz "X özelliği var mı?" sorusunu sormaz.
//
// Backend: ORKESTRATÖR rolü (v15.13 — ana ajana/codegen'e GİTMEZ), abonelik/CLI modunda
// runClaudeCli (Read/Grep/Glob açık → ajan kodu inceler; Bash KALDIRILDI — güvenlik). Ajan tek bir {"kind":"docs",...}
// JSON bloğu döner; YAZIMI MyCL yapar (forced-tool yok; ajan .mycl dışına yazamaz). Approval YOK.
// Fail → görünür uyarı + audit, ana akışı BLOKLAMAZ (yan-yarar, sessiz değil).

import { selectEffortForTask } from "./model-catalog.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { type AdrDecision, DECISIONS_DIR_REL, parseAdrDecisions, writeAdrs } from "./adr.js";
import { appendAudit } from "./audit.js";
import { extractKindBlock } from "./cli-json.js";
import { runClaudeCli } from "./cli-run.js";
import { READ_ONLY_DISALLOWED_TOOLS } from "./tool-policy.js";
import { backendForRole, resolveProvider, type MyclConfig } from "./config.js";
import { resolveCliProvider } from "./claude-api.js";
import { emitChatMessage, emitClaudeStream, emitUserGuide, emitTechDoc, emitPhaseRunning, emitPhaseIdle } from "./ipc.js";
import { log } from "./logger.js";
import { templatePath } from "./phase-registry.js";
import { substitute } from "./template-engine.js";
import type { State } from "./types.js";

const FEATURES_REL = join(".mycl", "features.md");
const USER_GUIDE_REL = join(".mycl", "user-guide.md");
// YZLLM 2026-06-20: kullanım kılavuzu çift dilli — TR + EN. EN sürümü ayrı dosyada.
const USER_GUIDE_EN_REL = join(".mycl", "user-guide.en.md");
// YZLLM 2026-06-14: TR teknik döküman + app-içi kılavuz veri-temeli (help-pages.json). İlk-açılışta + her iterasyonda üretilir.
const TECH_DOC_REL = join(".mycl", "tech-doc.md");
const HELP_PAGES_REL = join(".mycl", "help-pages.json");
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
export function parseHelpPages(raw: unknown, knownRoutes: string[]): Array<Omit<HelpPage, "updated_at">> {
  if (!Array.isArray(raw)) return [];
  const known = new Set(knownRoutes);
  const out: Array<Omit<HelpPage, "updated_at">> = [];
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
    out.push({ route, title_tr, title_en, body_tr, body_en });
  }
  return out;
}

/** Pure: ajan çıktısından docs bloğunu parse + doğrula (features_md zorunlu; tech_doc_md/help_pages opsiyonel — fail-soft). */
export function parseLivingDocsBlock(text: string): {
  features_md: string;
  user_guide_tr_md: string;
  user_guide_en_md: string;
  tech_doc_md: string;
  help_pages: Array<Omit<HelpPage, "updated_at">>;
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
  return {
    features_md,
    user_guide_tr_md,
    user_guide_en_md: str(b.user_guide_en_md),
    tech_doc_md: str(b.tech_doc_md),
    help_pages: parseHelpPages(b.help_pages, extractRoutesFromFeatures(features_md)),
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
export async function bootstrapLivingDocs(state: State, config: MyclConfig): Promise<void> {
  try {
    // YZLLM 2026-06-14 (çıktı-başına kapı, onaylı): features.md VE tech-doc.md ikisi de varsa no-op. features.md
    // varken tech-doc.md yoksa (bu özellikten önce açılmış proje) eksik-üretimi TAMAMLA — onboarding tazelenir.
    const root = state.project_root;
    if ((await fileExists(join(root, FEATURES_REL))) && (await fileExists(join(root, TECH_DOC_REL)))) return;
    const { isExistingProject } = await import("./phase-1-codebase-probe.js");
    if (!(await isExistingProject(state.project_root))) return; // boş proje → pipeline üretir
    // v15.13: docs'u ORKESTRATÖR rolü yazar (ana ajan değil — kullanıcı kuralı).
    if (backendForRole(config, "orchestrator") !== "cli" && !resolveProvider(config, "orchestrator").isZai) {
      // KATI #4 (sessiz fallback yok — çapraz-aile mahkeme): API modunda orkestratör derin docs ÜRETMEZ →
      // GÖRÜNÜR not (eski kod sessizce return ediyordu). Onboarding'de bu, raporda da yer alır.
      emitChatMessage(
        "system",
        "ℹ️ Derin proje dökümantasyonu (features/tech-doc) CLI/abonelik VEYA z.ai modunda üretilir — API modunda atlandı.",
      );
      return;
    }
    emitChatMessage(
      "system",
      "📚 İlk açılış: mevcut koddan proje dökümantasyonu + kullanma kılavuzu üretiliyor…",
    );
    await updateLivingDocs(state, config);
  } catch (err) {
    log.warn("living-docs", "bootstrap failed (non-fatal)", err);
  }
}

/**
 * Yaşayan dökümantasyonu güncelle. Non-blocking — her fail görünür uyarı + audit,
 * ASLA throw etmez (ana pipeline'ı bloklamaz).
 */
export async function updateLivingDocs(state: State, config: MyclConfig): Promise<void> {
  try {
    // v15.13: Yaşayan dökümantasyonu ORKESTRATÖR rolü yazar — ana ajana (codegen) GİTMEZ
    // (kullanıcı kuralı). Orkestratör "her şeyi bilen" hafif rol → docs için doğru yer.
    // Abonelik/CLI modu birincil hedef. API modu sonraki tur — görünür not (sessiz değil).
    // ⑥ CLI/abonelik VEYA Sağlayıcı=Z.AI (orkestratör) → çalışır; z.ai'de claude CLI z.ai endpoint'ine yönlenir.
    if (backendForRole(config, "orchestrator") !== "cli" && !resolveProvider(config, "orchestrator").isZai) {
      emitChatMessage(
        "system",
        "ℹ️ Yaşayan dökümantasyon şu an CLI/abonelik VEYA z.ai modunda güncellenir (orkestratör rolü).",
      );
      return;
    }
    const includeUserGuide = !(state.skip_ui_phases ?? false);
    // Orkestratör modeli (yoksa main'e fallback — SelectedModels.orchestrator opsiyonel).
    const baseDocsModel = config.selected_models.orchestrator ?? config.selected_models.main;
    const docsCli = resolveCliProvider(config, "orchestrator", baseDocsModel);
    const docsModel = docsCli.model;

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
    emitClaudeStream({
      sub: "init",
      text: "cli-living-docs",
      model: docsModel,
      cwd: state.project_root,
    });
    const res = await runClaudeCli({
      systemPrompt: prompt,
      userMessage: "Inspect the codebase and emit the updated documentation JSON block now.",
      modelId: docsModel,
      extraEnv: docsCli.extraEnv, // ⑥ z.ai ise claude CLI'yi z.ai endpoint'ine yönlendir
      cwd: state.project_root,
      allowedTools: ["Read", "Grep", "Glob"],
      // salt-okunur: ajan kodu Read/Grep/Glob ile gezip JSON döner, dosyaları MyCL'in kendi Node kodu yazar.
      // Bash KALDIRILDI (çapraz-aile mahkeme): Bash açıkken salt-okunur niyete rağmen `cat > dosya << EOF`
      // ile YABANCI projenin kaynağını ezebiliyordu (tool-policy.ts belgeli kaçış). Doküman-üretimi için
      // Read/Grep/Glob yeterli — onboarding'in non-destructive garantisi buna dayanır.
      disallowedTools: READ_ONLY_DISALLOWED_TOOLS, // Write/Edit/alt-ajan yasak
      effort: selectEffortForTask("verification", config.claude_code_flags.effort), // oto-efor: doküman güncelleme hafif iş
      onText: (t) => emitClaudeStream({ sub: "text", text: t }),
      observer: (tu) =>
        emitClaudeStream({ sub: "tool_use", tool_name: tu.name, tool_input: tu.input }),
      timeoutMs: 300_000,
    });
    if (res.usage) emitClaudeStream({ sub: "token_usage", usage: res.usage });

    const fail = async (msg: string, detail: string): Promise<void> => {
      emitChatMessage("system", `⚠️ ${msg} — bu tur atlandı (ana akış etkilenmez).`);
      await appendAudit(state.project_root, {
        ts: Date.now(),
        phase: state.current_phase ?? 0,
        event: "living-docs-update-failed",
        caller: "mycl-bridge",
        detail: detail.slice(0, 200),
      }).catch((e) => log.error("living-docs", "update-failed audit yazılamadı (denetim izi eksik)", { error: String(e) }));
    };

    if (!res.ok) {
      await fail("Dökümantasyon güncellenemedi (claude hatası)", String(res.error ?? ""));
      return;
    }
    const parsed = parseLivingDocsBlock(res.text);
    if (!parsed) {
      await fail("Dökümantasyon bloğu üretilemedi", "no valid {kind:docs} block");
      return;
    }
    await fs.writeFile(
      join(state.project_root, FEATURES_REL),
      withTrailingNewline(parsed.features_md),
      "utf-8",
    );
    if (includeUserGuide && parsed.user_guide_tr_md.trim()) {
      const guide = withTrailingNewline(parsed.user_guide_tr_md);
      await fs.writeFile(join(state.project_root, USER_GUIDE_REL), guide, "utf-8");
      emitUserGuide(guide); // "Kılavuz" sekmesini güncelle (TR)
    }
    // YZLLM 2026-06-20: kullanım kılavuzunun İngilizce sürümü ayrı dosyaya.
    if (includeUserGuide && parsed.user_guide_en_md.trim()) {
      await fs.writeFile(
        join(state.project_root, USER_GUIDE_EN_REL),
        withTrailingNewline(parsed.user_guide_en_md),
        "utf-8",
      );
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
      const dated = assignHelpPageDates(
        parsed.help_pages,
        await readExistingHelpPages(state.project_root),
        stampDate(),
      );
      await fs.writeFile(
        join(state.project_root, HELP_PAGES_REL),
        JSON.stringify(dated, null, 2) + "\n",
        "utf-8",
      );
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
  } catch (err) {
    // Hiçbir koşulda pipeline'ı bloklama — görünür uyarı + log.
    log.warn("living-docs", "updateLivingDocs failed (non-fatal)", err);
    emitChatMessage("system", "⚠️ Yaşayan dökümantasyon güncellemesi atlandı (beklenmedik hata).");
  } finally {
    emitPhaseIdle(); // 30s heartbeat banner'ını kapat (her durumda)
  }
}
