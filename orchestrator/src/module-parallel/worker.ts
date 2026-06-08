// module-parallel/worker — GERÇEK scoped codegen worker'ı (dispatch motorunun RunWorker'ı).
//
// Her worker İZOLE bir git worktree'de (cwd) çalışır, YALNIZ kendi modülünün kapsamına yazar. Çakışmasızlık
// iki katmanlı: (1) prompt + cwd worktree → worker kendi kopyasında; (2) entegrasyonda `integrateWorktrees`
// kapsam-dışı/çakışan dosyayı reddeder (defense-in-depth). Mevcut `runClaudeCli` (abonelik/API CLI yolu) yeniden
// kullanılır; Bash tool'u olduğu için folder-guard SARMAZ (nesting) — zaten worktree cwd ile sınırlı.

import { runClaudeCli } from "../cli-run.js";
import type { MyclConfig } from "../config.js";
import type { ModuleWork, RunWorker } from "./dispatch.js";

function workerSystemPrompt(m: ModuleWork): string {
  return [
    "You are a PARALLEL codegen worker running on an ISOLATED git worktree.",
    `Your module: "${m.id}".`,
    `Write files ONLY within these paths: ${m.scope_paths.join(", ")}.`,
    "Do NOT create or edit any file outside your module's scope — other workers own those; out-of-scope",
    "writes will be REJECTED at integration. Keep your work fully inside your scope.",
    "Use Read/Glob/Grep to understand, Write/Edit/Bash to implement. Finish with your module's files written.",
  ].join("\n");
}

/**
 * config'ten gerçek codegen worker'ı üretir (dispatch motoruna enjekte edilir). Her çağrı worktree cwd'sinde
 * scoped codegen koşar. runClaudeCli `ok=false` → worker başarısız → motor seri fallback yapar (fail-closed).
 */
export function makeScopedCodegenWorker(config: MyclConfig): RunWorker {
  return async (m: ModuleWork, worktreePath: string): Promise<{ ok: boolean; error?: string }> => {
    const res = await runClaudeCli({
      systemPrompt: workerSystemPrompt(m),
      userMessage: m.brief,
      modelId: config.selected_models.main,
      cwd: worktreePath,
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      folderGuard: false, // Bash kullanır → sandbox-exec ile sarma (nesting); cwd zaten worktree ile sınırlı
    });
    return { ok: res.ok, error: res.ok ? undefined : res.error };
  };
}
