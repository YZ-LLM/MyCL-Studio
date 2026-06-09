// module-parallel/select — "ÇOKLU AJAN SEÇİMİ": develop akışında ≥2 bağımsız modülü paralel yazdırma kararı + yürütme.
//
// FAIL-CLOSED: flag kapalı / bölünemez / herhangi bir hata → {used:false} → caller NORMAL (seri) develop akışına
// devam eder → normal akış ASLA bozulmaz (flag varsayılan KAPALI olduğu için de zaten devre dışı).

import type { MyclConfig } from "../config.js";
import type { State } from "../types.js";
import { proposeModules } from "./decompose.js";
import { runParallelModules } from "./dispatch.js";
import { makeScopedCodegenWorker } from "./worker.js";

export interface MultiAgentResult {
  /** Paralel yol çalıştı mı? false → caller seri/normal akış yapmalı. */
  used: boolean;
  reason: string;
  /** Paralel yazılan modül id'leri (used=true). */
  modules?: string[];
  /** Entegre edilen dosyalar (used=true). */
  files?: string[];
}

/**
 * Çoklu Ajan Seçimi: flag açık + niyet ≥2 GERÇEKTEN bağımsız modüle bölünüyorsa, onları izole worktree'lerde
 * PARALEL yazdırır + ayrık entegre eder. Aksi hâlde {used:false} → caller seri develop yapar. Her aşama korumalı.
 */
export async function runMultiAgentSelection(
  config: MyclConfig,
  state: State,
  request: string,
): Promise<MultiAgentResult> {
  if (!config.claude_code_flags.multi_agent_selection) {
    return { used: false, reason: "Çoklu Ajan Seçimi kapalı → seri" };
  }
  const projectRoot = state.project_root;
  let modules;
  try {
    modules = await proposeModules(config, request, projectRoot);
  } catch (e) {
    return { used: false, reason: `bölme hatası → seri: ${String(e)}` };
  }
  if (!modules) {
    return { used: false, reason: "≥2 gerçekten bağımsız modül çıkmadı → seri" };
  }
  let outcome;
  try {
    outcome = await runParallelModules(
      projectRoot,
      modules,
      { enabled: true },
      makeScopedCodegenWorker(config, state), // backend-aware worker (api/cli)
    );
  } catch (e) {
    return { used: false, reason: `paralel codegen hatası → seri: ${String(e)}` };
  }
  if (!outcome.parallel || !outcome.ok) {
    return { used: false, reason: `${outcome.reason} → seri` };
  }
  return {
    used: true,
    reason: outcome.reason,
    modules: modules.map((m) => m.id),
    files: outcome.integratedFiles,
  };
}
