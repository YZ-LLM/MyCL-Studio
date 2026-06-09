// module-parallel/worker — GERÇEK scoped codegen worker'ı (dispatch motorunun RunWorker'ı).
//
// Her worker İZOLE bir git worktree'de (cwd) çalışır, YALNIZ kendi modülünün kapsamına yazar. Çakışmasızlık
// iki katmanlı: (1) prompt + cwd worktree → worker kendi kopyasında; (2) entegrasyonda `integrateWorktrees`
// kapsam-dışı/çakışan dosyayı reddeder (defense-in-depth). Mevcut `runClaudeCli` (abonelik/API CLI yolu) yeniden
// kullanılır; Bash tool'u olduğu için folder-guard SARMAZ (nesting) — zaten worktree cwd ile sınırlı.

import { runClaudeCli } from "../cli-run.js";
import type { MyclConfig } from "../config.js";
import { emitAgentEvent } from "../ipc.js";
import type { ModuleWork, RunWorker } from "./dispatch.js";

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
 * config'ten gerçek codegen worker'ı üretir (dispatch motoruna enjekte edilir). Her çağrı worktree cwd'sinde
 * scoped codegen koşar. runClaudeCli `ok=false` → worker başarısız → motor seri fallback yapar (fail-closed).
 */
export function makeScopedCodegenWorker(config: MyclConfig): RunWorker {
  return async (m: ModuleWork, worktreePath: string): Promise<{ ok: boolean; error?: string }> => {
    // Görünürlük: bu modül-ajanı başla/bit yayını → UI'da "🤖 <modül> çalışıyor/bitti" görünür.
    emitAgentEvent({ sub: "started", agent_label: m.id });
    try {
      const res = await runClaudeCli({
        systemPrompt: workerSystemPrompt(m),
        userMessage: m.brief,
        modelId: config.selected_models.main,
        cwd: worktreePath,
        allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
        folderGuard: false, // Bash kullanır → sandbox-exec ile sarma (nesting); cwd zaten worktree ile sınırlı
      });
      return { ok: res.ok, error: res.ok ? undefined : res.error };
    } finally {
      emitAgentEvent({ sub: "completed", agent_label: m.id });
    }
  };
}
