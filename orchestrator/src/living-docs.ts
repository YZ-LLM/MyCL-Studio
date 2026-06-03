// living-docs — yaşayan proje dökümantasyonu (.mycl/features.md) + UI kullanma
// kılavuzu (.mycl/user-guide.md). MyCL projeye dokundukça (pipeline sonu) +
// mevcut projeyi ilk açışta (bootstrap) günceller. Orkestratör + Faz 1/2 ajanları
// bunları okuyup grounded soru sorar — gereksiz "X özelliği var mı?" sorusunu sormaz.
//
// Backend: abonelik/CLI modunda runClaudeCli (Read/Grep/Glob/Bash açık → ajan kodu
// inceler). Ajan tek bir {"kind":"docs",...} JSON bloğu döner; YAZIMI MyCL yapar
// (forced-tool yok; ajan .mycl dışına yazamaz). Approval YOK (iç belge).
// Fail → görünür uyarı + audit, ana akışı BLOKLAMAZ (yan-yarar, sessiz değil).

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { appendAudit } from "./audit.js";
import { extractKindBlock } from "./cli-json.js";
import { runClaudeCli } from "./cli-run.js";
import { backendForRole, type MyclConfig } from "./config.js";
import { emitChatMessage, emitClaudeStream, emitUserGuide } from "./ipc.js";
import { log } from "./logger.js";
import { templatePath } from "./phase-registry.js";
import { substitute } from "./template-engine.js";
import type { State } from "./types.js";

const FEATURES_REL = join(".mycl", "features.md");
const USER_GUIDE_REL = join(".mycl", "user-guide.md");
const SENTINEL_EMPTY = "(none yet)";

async function readDocSafe(projectRoot: string, rel: string): Promise<string> {
  try {
    const c = await fs.readFile(join(projectRoot, rel), "utf-8");
    return c.trim() || SENTINEL_EMPTY;
  } catch {
    return SENTINEL_EMPTY;
  }
}

/** Pure: living-docs prompt'unu kur (test edilebilir). */
export function buildLivingDocsPrompt(opts: {
  tmpl: string;
  intentSummary: string;
  existingFeatures: string;
  existingUserGuide: string;
  includeUserGuide: boolean;
}): string {
  const guideInstruction = opts.includeUserGuide
    ? "Produce **user-guide.md** — an end-user manual for the UI, written **in Turkish** (the end user reads Turkish). One `## <Nasıl: görev>` heading per common task, with numbered steps a non-technical user can follow."
    : 'This project has NO end-user UI — set `user_guide_md` to an empty string "".';
  return substitute(opts.tmpl, {
    INTENT_SUMMARY: opts.intentSummary || "(no intent recorded)",
    EXISTING_FEATURES: opts.existingFeatures,
    EXISTING_USER_GUIDE: opts.existingUserGuide,
    USER_GUIDE_INSTRUCTION: guideInstruction,
  });
}

/** Pure: ajan çıktısından docs bloğunu parse + doğrula (features_md zorunlu). */
export function parseLivingDocsBlock(
  text: string,
): { features_md: string; user_guide_md: string } | null {
  const block = extractKindBlock(text, ["docs"]);
  if (!block) return null;
  const f = (block as Record<string, unknown>).features_md;
  const u = (block as Record<string, unknown>).user_guide_md;
  if (typeof f !== "string" || f.trim() === "") return null;
  return { features_md: f, user_guide_md: typeof u === "string" ? u : "" };
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

/**
 * Bootstrap — MEVCUT (MyCL-dışı) projeyi ilk açışta dökümante et. İdempotent:
 * `.mycl/features.md` zaten varsa no-op. Yalnız kod içeren projelerde çalışır
 * (boş greenfield'de pipeline-sonu hook üretir). Arka planda (await edilmeden)
 * çağrılmalı — open'ı bloklamasın. Non-blocking.
 */
export async function bootstrapLivingDocs(state: State, config: MyclConfig): Promise<void> {
  try {
    if (await fileExists(join(state.project_root, FEATURES_REL))) return; // zaten var
    const { isExistingProject } = await import("./phase-1-codebase-probe.js");
    if (!(await isExistingProject(state.project_root))) return; // boş proje → pipeline üretir
    if (backendForRole(config, "main") !== "cli") return; // API modu: sessiz değil ama updateLivingDocs not basar
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
    // Abonelik/CLI modu birincil hedef. API modu sonraki tur — görünür not (sessiz değil).
    if (backendForRole(config, "main") !== "cli") {
      emitChatMessage(
        "system",
        "ℹ️ Yaşayan dökümantasyon şu an yalnız CLI/abonelik modunda güncellenir.",
      );
      return;
    }
    const includeUserGuide = !(state.skip_ui_phases ?? false);

    const tmpl = await fs.readFile(templatePath("living-docs.md"), "utf-8");
    const prompt = buildLivingDocsPrompt({
      tmpl,
      intentSummary: state.intent_summary ?? "",
      existingFeatures: await readDocSafe(state.project_root, FEATURES_REL),
      existingUserGuide: includeUserGuide
        ? await readDocSafe(state.project_root, USER_GUIDE_REL)
        : SENTINEL_EMPTY,
      includeUserGuide,
    });

    emitChatMessage("system", "📚 Proje dökümantasyonu güncelleniyor…");
    emitClaudeStream({
      sub: "init",
      text: "cli-living-docs",
      model: config.selected_models.main,
      cwd: state.project_root,
    });
    const res = await runClaudeCli({
      systemPrompt: prompt,
      userMessage: "Inspect the codebase and emit the updated documentation JSON block now.",
      modelId: config.selected_models.main,
      cwd: state.project_root,
      allowedTools: ["Read", "Grep", "Glob", "Bash"],
      disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
      effort: config.claude_code_flags.effort,
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
      }).catch(() => {});
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
    if (includeUserGuide && parsed.user_guide_md.trim()) {
      const guide = withTrailingNewline(parsed.user_guide_md);
      await fs.writeFile(join(state.project_root, USER_GUIDE_REL), guide, "utf-8");
      emitUserGuide(guide); // "Kılavuz" sekmesini güncelle
    }
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: state.current_phase ?? 0,
      event: "living-docs-update",
      caller: "mycl-bridge",
    }).catch(() => {});
    emitChatMessage(
      "system",
      `📚 Proje dökümantasyonu güncellendi (.mycl/features.md${includeUserGuide ? " + user-guide.md" : ""}).`,
    );
  } catch (err) {
    // Hiçbir koşulda pipeline'ı bloklama — görünür uyarı + log.
    log.warn("living-docs", "updateLivingDocs failed (non-fatal)", err);
    emitChatMessage("system", "⚠️ Yaşayan dökümantasyon güncellemesi atlandı (beklenmedik hata).");
  }
}
