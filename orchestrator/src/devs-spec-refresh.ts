// devs-spec-refresh — iterasyon-SONU spec tazeleme (YZLLM 2026-06-16 tasarımı, Faz 4b).
//
// İKİ seviye spec:
//   - kök `.mycl/spec.md` = projenin GENEL spec'i ("müşteri temsilcisi gibi ama gerçekleri söyleyen",
//     detaysız, ## <yetenek> başlıklı). Faz 2'den beri per-iter spec devs/_pending'e yazıldığı için kök
//     spec bayatlıyordu → bunu canlı tutmanın eksik parçası. EXISTING_SPEC_DIGEST (Faz 2 çakışma-kontrolü)
//     + relevance recall bunu okur → genel anlatım yapısal AC listesinden daha iyi.
//   - `devs/<type>/<key>/page-spec.md` = per-birim KÜMÜLATİF spec ("o sayfanın ne yaptığını iyi anlatır",
//     tüm iterasyonlarının birikimi).
//
// Backend: ORKESTRATÖR rolü (living-docs deseni) — ana ajana/codegen'e GİTMEZ. Abonelik/CLI modunda
// runClaudeCli (salt-okunur Read/Grep/Glob → ajan devs/ + .mycl'i inceler). Ajan tek {"kind":"specs",...}
// JSON döner; YAZIMI MyCL yapar (forced-tool yok; ajan dosyaya yazamaz). Approval YOK.
// pipeline-end'de finalizeDevsArtifacts'tan SONRA, FAIL-SOFT çağrılır — throw pipeline'ı KIRMAZ.

import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { selectEffortForTask } from "./model-catalog.js";
import { appendAudit } from "./audit.js";
import { extractKindBlock } from "./cli-json.js";
import { runClaudeCli } from "./cli-run.js";
import { READ_ONLY_DISALLOWED_TOOLS } from "./tool-policy.js";
import { backendForRole, resolveProvider, type MyclConfig } from "./config.js";
import { resolveCliProvider } from "./claude-api.js";
import {
  emitChatMessage,
  emitClaudeStream,
  emitPhaseRunning,
  emitPhaseIdle,
} from "./ipc.js";
import { log } from "./logger.js";
import { templatePath } from "./phase-registry.js";
import { substitute } from "./template-engine.js";
import type { State } from "./types.js";
import type { FinalizeOutcome } from "./devs-finalize.js";

const SPEC_REL = join(".mycl", "spec.md");
const PAGE_SPEC_NAME = "page-spec.md";
const SENTINEL_EMPTY = "(none yet)";

function withTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

async function readTextSafe(path: string): Promise<string> {
  return fs
    .readFile(path, "utf-8")
    .then((c) => c.trim() || SENTINEL_EMPTY)
    .catch((e) => {
      // errno-AYRIMI (sessiz-fallback denetimi): ENOENT = gerçekten yok (SENTINEL_EMPTY meşru). BAŞKA hata
      // (EACCES/EIO) = spec VAR ama okunamadı → "boş" sanıp üstüne inceltilmiş spec yazmak içerik-kaybı. Görünür.
      if ((e as { code?: string }).code !== "ENOENT") {
        log.error("devs-spec-refresh", "spec okunamadı (var ama erişilemez) — SENTINEL_EMPTY döndü, üstüne yazma içerik-kaybı riski", {
          path,
          code: (e as { code?: string }).code,
        });
      }
      return SENTINEL_EMPTY;
    });
}

/** Birim → page-spec.md mutlak yolu. devs/<type>/<key>/<ts>/ dizininin EBEVEYNİ (page-spec birim kökünde). */
function pageSpecPathForUnit(unitDir: string): string {
  return join(dirname(unitDir), PAGE_SPEC_NAME);
}

/** SAF: spec-refresh prompt'unu kur (test edilebilir). */
export function buildSpecRefreshPrompt(opts: {
  tmpl: string;
  iterSpec: string;
  touchedUnits: string[];
  existingRootSpec: string;
  existingPageSpecs: string;
}): string {
  return substitute(opts.tmpl, {
    ITER_SPEC: opts.iterSpec.trim() || "(no iter-spec recorded)",
    TOUCHED_UNITS: opts.touchedUnits.length
      ? opts.touchedUnits.map((u) => `- ${u}`).join("\n")
      : "(none — only the root spec is refreshed this iteration)",
    EXISTING_ROOT_SPEC: opts.existingRootSpec,
    EXISTING_PAGE_SPECS: opts.existingPageSpecs,
  });
}

/** SAF: ajan çıktısından {kind:specs} bloğunu parse + doğrula. root_spec_md ZORUNLU; page_specs
 *  yalnız `validUnitIds`'te olan (bu iterasyonda dokunulan) birimleri tutar (uydurma birim elenir). */
export function parseSpecRefreshBlock(
  text: string,
  validUnitIds: ReadonlySet<string>,
): { root_spec_md: string; page_specs: { unit: string; spec_md: string }[] } | null {
  const block = extractKindBlock(text, ["specs"]);
  if (!block) return null;
  const b = block as Record<string, unknown>;
  const root = b.root_spec_md;
  if (typeof root !== "string" || root.trim() === "") return null; // root spec ZORUNLU
  const page_specs: { unit: string; spec_md: string }[] = [];
  if (Array.isArray(b.page_specs)) {
    for (const item of b.page_specs) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.unit !== "string" || typeof o.spec_md !== "string") continue;
      if (o.spec_md.trim() === "") continue;
      if (!validUnitIds.has(o.unit)) continue; // dokunulan-birim listesinde yok → uydurma, ele
      page_specs.push({ unit: o.unit, spec_md: o.spec_md });
    }
  }
  return { root_spec_md: root, page_specs };
}

/**
 * İterasyon-sonu spec tazeleme. fail-soft — her fail görünür uyarı + log, ASLA throw etmez
 * (pipeline-end zincirini KIRMAZ). API modunda görünür not + no-op (living-docs ile aynı sınır).
 */
export async function refreshDevsSpecs(
  state: State,
  config: MyclConfig,
  outcome: FinalizeOutcome,
): Promise<void> {
  try {
    // Spec'leri ORKESTRATÖR rolü yazar (living-docs deseni) — ana ajana GİTMEZ. API modu sonraki tur.
    // ⑥ CLI/abonelik VEYA Sağlayıcı=Z.AI (orkestratör) → çalışır; z.ai'de claude CLI z.ai endpoint'ine yönlenir.
    if (backendForRole(config, "orchestrator") !== "cli" && !resolveProvider(config, "orchestrator").isZai) {
      emitChatMessage(
        "system",
        "ℹ️ Proje/sayfa spec tazeleme şu an CLI/abonelik VEYA z.ai modunda yapılır (orkestratör rolü).",
      );
      return;
    }
    const baseSpecModel = config.selected_models.orchestrator ?? config.selected_models.main;
    const specCli = resolveCliProvider(config, "orchestrator", baseSpecModel);
    const specModel = specCli.model;

    // Bu iterasyonun iter-spec'i + dokunulan birimlerin mevcut page-spec'leri.
    const iterSpec = await fs.readFile(outcome.iterSpecPath, "utf-8").catch(() => "");
    const unitIds = outcome.units.map((u) => `${u.type}:${u.key}`);
    const validUnitIds = new Set(unitIds);
    const pageSpecPaths = new Map<string, string>(); // unitId → page-spec.md yolu
    let existingPageSpecs = "";
    for (const u of outcome.units) {
      const id = `${u.type}:${u.key}`;
      const psPath = pageSpecPathForUnit(u.dir);
      pageSpecPaths.set(id, psPath);
      existingPageSpecs += `### ${id}\n${await readTextSafe(psPath)}\n\n`;
    }
    if (!existingPageSpecs) existingPageSpecs = "(no units touched this iteration)";

    const tmpl = await fs.readFile(templatePath("devs-spec-refresh.md"), "utf-8");
    const prompt = buildSpecRefreshPrompt({
      tmpl,
      iterSpec,
      touchedUnits: unitIds,
      existingRootSpec: await readTextSafe(join(state.project_root, SPEC_REL)),
      existingPageSpecs,
    });

    emitChatMessage("system", "📝 Proje + sayfa spec'leri tazeleniyor…");
    // 30s heartbeat'i aktive et (banner açıkken observer tool_use'larını basar; yedek timer KURMA).
    emitPhaseRunning("📝 Spec tazeleme (proje + sayfa)…");
    emitClaudeStream({ sub: "init", text: "cli-spec-refresh", model: specModel, cwd: state.project_root });
    const res = await runClaudeCli({
      systemPrompt: prompt,
      userMessage: "Read the artifacts and emit the updated specs JSON block now.",
      modelId: specModel,
      extraEnv: specCli.extraEnv, // ⑥ z.ai ise claude CLI'yi z.ai endpoint'ine yönlendir
      cwd: state.project_root,
      allowedTools: ["Read", "Grep", "Glob"], // salt-okunur: devs/ + .mycl incele
      disallowedTools: READ_ONLY_DISALLOWED_TOOLS, // alt-ajan/yazma yasak; JSON döner, MyCL yazar
      effort: selectEffortForTask("verification", config.claude_code_flags.effort),
      onText: (t) => emitClaudeStream({ sub: "text", text: t }),
      observer: (tu) =>
        emitClaudeStream({ sub: "tool_use", tool_name: tu.name, tool_input: tu.input }),
      timeoutMs: 300_000,
    });
    if (res.usage) emitClaudeStream({ sub: "token_usage", usage: res.usage });

    if (!res.ok) {
      emitChatMessage("system", "⚠️ Spec tazeleme atlandı (claude hatası) — ana akış etkilenmez.");
      return;
    }
    const parsed = parseSpecRefreshBlock(res.text, validUnitIds);
    if (!parsed) {
      emitChatMessage("system", "⚠️ Spec bloğu üretilemedi — bu tur atlandı (ana akış etkilenmez).");
      return;
    }

    // Kök genel-spec (.mycl/spec.md) — EXISTING_SPEC_DIGEST + recall okur, bayatlamasın.
    await fs.mkdir(join(state.project_root, ".mycl"), { recursive: true });
    await fs.writeFile(
      join(state.project_root, SPEC_REL),
      withTrailingNewline(parsed.root_spec_md),
      "utf-8",
    );
    // Dokunulan birimlerin page-spec'leri.
    let pageCount = 0;
    for (const ps of parsed.page_specs) {
      const psPath = pageSpecPaths.get(ps.unit);
      if (!psPath) continue;
      await fs.mkdir(dirname(psPath), { recursive: true });
      await fs.writeFile(psPath, withTrailingNewline(ps.spec_md), "utf-8");
      pageCount++;
    }

    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: state.current_phase ?? 0,
      event: "devs-spec-refresh",
      caller: "mycl-bridge",
      detail: `root + ${pageCount} page-spec`,
    }).catch(() => {});
    emitChatMessage(
      "system",
      `📝 Proje spec'i tazelendi (.mycl/spec.md)${pageCount ? ` + ${pageCount} sayfa-spec'i` : ""}.`,
    );
  } catch (err) {
    log.warn("devs-spec-refresh", "refreshDevsSpecs failed (non-fatal)", err);
    emitChatMessage("system", "⚠️ Spec tazeleme atlandı (beklenmedik hata) — ana akış etkilenmez.");
  } finally {
    emitPhaseIdle();
  }
}
