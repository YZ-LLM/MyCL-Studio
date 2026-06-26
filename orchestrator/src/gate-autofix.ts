// gate-autofix — auto-düzeltilebilir mekanik gate'lerin (lint vb.) KENDİ İÇİNDE düzeltmesi.
//
// YZLLM (2026-06-10): "lint ayrı bir faz; o faza gelince ÇALIŞMASI (düzeltip geçmesi) gerekiyordu." Sorun: lint
// fazının tek otomatik silahı `eslint --fix` ve o `no-unused-vars` gibi şeyleri SİLMEZ → faz fail olup 1 satırlık
// işi debug→Faz 8 codegen döngüsüne atıyordu (orantısız). Çözüm: deterministik fix_cmd yetmezse, fazın İÇİNDE,
// TAM o hatalara odaklı MİNİMAL bir düzeltme yap (Edit) + caller gate'i yeniden koşar. Backend-aware
// (createCodegenBackend → cli/api). Yalnız bildirilen hataları düzeltir; refactor/davranış değişikliği YOK.

import { createCodegenBackend } from "./codegen/backend.js";
import { TOOLS_CODEGEN, type ToolContext } from "./tool-handlers.js";
import type { ToolDef } from "./claude-api.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { buildProjectFacts } from "./project-facts.js";
import { snapshotBeforeAutofix } from "./fix-snapshot.js";
import type { MyclConfig } from "./config.js";
import type { PhaseId, State } from "./types.js";

/**
 * Bildirilen gate hatalarını fazın içinde, odaklı + minimal düzeltir. true → düzeltme koştu (caller gate'i
 * yeniden koşup gerçekten geçtiğini DOĞRULAR — bu fonksiyon "geçti" demez, sadece "denedi/bitti" der).
 */
export async function runGateAutofix(
  state: State,
  config: MyclConfig,
  phaseId: PhaseId,
  gateLabel: string,
  errors: string,
  inspectorGuidance?: string, // B5 (YZLLM): mahkeme bu bulguyu GERÇEK ilan etti → müfettiş gerekçesi fix'i besler
): Promise<boolean> {
  const facts = await buildProjectFacts(state.project_root).catch(() => null);
  const systemPrompt = [
    `You are fixing ONLY the errors reported by the "${gateLabel}" static-check gate. This is the dedicated`,
    "gate phase doing its job: resolve the reported errors IN PLACE — do not defer, do not escalate.",
    "",
    ...(facts?.summary ? [facts.summary, ""] : []),
    "Reported errors:",
    errors.slice(0, 3000),
    "",
    ...(inspectorGuidance
      ? [
          "INSPECTOR ANALYSIS — an INDEPENDENT court (a skeptic separate from the orchestrator, judging from",
          "its own evidence) reviewed this and ruled the finding REAL. Use its reasoning to SHAPE your fix:",
          inspectorGuidance.slice(0, 1500),
          "",
        ]
      : []),
    "RULES (strict):",
    "- Fix ONLY these exact errors, with the MINIMAL edit. Touch only the file:line each error points to.",
    "- Do NOT refactor, rename, reformat, change behavior, or edit unrelated files.",
    "- Unused variable/import → remove it; BUT if it's a test that clearly intended to use it, add the missing",
    "  usage (e.g. an assertion) instead of deleting. Pick the change that keeps the test meaningful.",
    "",
    "GATE INTEGRITY — NEVER cheat the gate to make it green (this is the cardinal rule):",
    "- Do NOT weaken, skip, delete, or comment out tests; no `.skip`/`.only`/`xit`/`it.skip`; do NOT loosen",
    "  assertions just to pass. If a test catches a REAL bug, fix the CODE so the test passes honestly.",
    "- Do NOT disable lint rules, add `eslint-disable`/`ts-ignore`, or edit the gate/lint/tsconfig config to",
    "  ignore the failure. Do NOT lower thresholds or exclude files from the check.",
    "- The goal is a GENUINELY correct codebase, not a green checkmark. A suppressed/weakened gate is a failure.",
    "- After fixing, STOP (no further tool calls). Do not run the linter yourself — the gate re-runs automatically.",
  ].join("\n");
  try {
    // Otomatik kod düzenlemesinden ÖNCE snapshot (git checkpoint veya .mycl/backups) → yanlışsa geri alınır.
    await snapshotBeforeAutofix(state.project_root, Date.now());
    const backend = createCodegenBackend({
      tag: "gate-autofix",
      phaseId,
      state,
      config,
      systemPrompt,
      // Odaklı düzeltme — kullanıcının ana modeli yeter (kaliteli hız; trivial iş için strong-opus gereksiz).
      modelId: config.selected_models.main,
      apiKey: config.api_keys.main,
      initialUserMessage: "Fix the reported gate errors now, minimally. Then stop.",
      tools: TOOLS_CODEGEN as unknown as ToolDef[],
      toolContext: { project_root: state.project_root } as ToolContext,
      // Yalnız okuma + düzenleme; Write/Bash gerekmez (mevcut dosyada minimal edit).
      allowed_tool_names: ["Read", "Edit", "Grep", "Glob"],
      betas: config.claude_code_flags.betas,
    });
    const outcome = await backend.run();
    log.info("gate-autofix", "focused fix done", { phaseId, kind: outcome.kind });
    return outcome.kind === "done";
  } catch (e) {
    log.warn("gate-autofix", "focused fix failed (non-fatal)", e);
    emitChatMessage("system", `⚠️ Faz ${phaseId} kendi içinde düzeltme denemesi hata verdi — normal akışa düşülüyor.`);
    return false;
  }
}
