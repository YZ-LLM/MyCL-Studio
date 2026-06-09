// module-parallel/worker — GERÇEK scoped codegen worker'ı (dispatch motorunun RunWorker'ı).
//
// BACKEND-AWARE (Ümit: "her şey API'yi de desteklesin"): `createCodegenBackend` backend'i (api/cli) backendForRole
// + tag ("parallel-module" CLI-eligible) ile seçer → CLI modunda CLI, API modunda SDK. İzole git worktree'de
// (state.project_root = worktreePath) scoped codegen. Çakışmasızlık: prompt + worktree izolasyonu + entegrasyonda
// kapsam-kontrolü (integrateWorktrees defense). Her tool çağrısı modül-etiketiyle ize yazılır (kör nokta yok).

import { createCodegenBackend } from "../codegen/backend.js";
import { selectModelForTask } from "../model-catalog.js";
import { emitAgentEvent } from "../ipc.js";
import { traceAgentEvent } from "../agent-trace.js";
import { TOOLS_CODEGEN, type ToolContext } from "../tool-handlers.js";
import type { ToolDef } from "../claude-api.js";
import type { MyclConfig } from "../config.js";
import type { State } from "../types.js";
import type { ModuleWork, RunWorker } from "./dispatch.js";

const WORKER_TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"];

function workerSystemPrompt(m: ModuleWork): string {
  return [
    "You are a PARALLEL codegen worker running on an ISOLATED git worktree.",
    `Your module: "${m.id}".`,
    `Create/edit files ONLY within these paths: ${m.scope_paths.join(", ")}.`,
    "STRICT scope rules — any violation is REJECTED at integration (your work is discarded):",
    "- Do NOT create or edit package.json, tsconfig.json, .gitignore, lockfiles, READMEs, or ANY file at the",
    "  repo root or outside your scope. Other workers / the integration own those.",
    "- Do NOT run `npm`/`yarn`/`pnpm`/`git` init/install or any command that writes outside your scope.",
    "- Write ONLY the source files your module needs, all inside your scope paths.",
    "Use Read/Glob/Grep to understand, Write/Edit to implement. Finish with your module's files written, nothing else.",
  ].join("\n");
}

/**
 * config + base state'ten gerçek codegen worker'ı üretir (dispatch motoruna enjekte edilir). Her çağrı izole
 * worktree'de scoped codegen koşar (backend-aware: api/cli). outcome.kind!=="done" → {ok:false} → motor seri fallback.
 */
export function makeScopedCodegenWorker(config: MyclConfig, baseState: State): RunWorker {
  return async (m: ModuleWork, worktreePath: string): Promise<{ ok: boolean; error?: string }> => {
    // Görünürlük: bu modül-ajanı başla/bit yayını → UI'da "🤖 <modül>" görünür.
    emitAgentEvent({ sub: "started", agent_label: m.id });
    try {
      const modelId = selectModelForTask("codegen", config.selected_models.model_tiers).modelId;
      const toolCtx: ToolContext = { project_root: worktreePath };
      const backend = createCodegenBackend({
        tag: "parallel-module", // CLI-eligible → CLI modunda CLI; API modunda SDK (backend-aware)
        phaseId: 8,
        state: { ...baseState, project_root: worktreePath }, // worktree-scoped
        config,
        systemPrompt: workerSystemPrompt(m),
        modelId,
        apiKey: config.api_keys.main,
        initialUserMessage: m.brief,
        tools: TOOLS_CODEGEN as unknown as ToolDef[],
        toolContext: toolCtx,
        allowed_tool_names: WORKER_TOOLS,
        betas: config.claude_code_flags.betas,
        // Tam iz (kör nokta yok): her tool çağrısı modül-etiketiyle .mycl/traces'a.
        observer: async (ctx) => {
          void traceAgentEvent({
            ts: Date.now(),
            agent_label: m.id,
            sub: "tool_use",
            tool_name: ctx.tool_use.name,
            tool_input: ctx.tool_use.input,
          });
        },
      });
      const outcome = await backend.run();
      void traceAgentEvent({
        ts: Date.now(),
        agent_label: m.id,
        sub: "output",
        text: `codegen: ${outcome.kind}${outcome.kind === "failed" ? ` — ${outcome.reason}` : ""}`,
      });
      if (outcome.kind === "done") return { ok: true };
      return { ok: false, error: outcome.kind === "failed" ? outcome.reason : "aborted" };
    } finally {
      emitAgentEvent({ sub: "completed", agent_label: m.id });
    }
  };
}
