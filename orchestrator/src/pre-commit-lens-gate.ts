// pre-commit-lens-gate — Pre-hoc bağımsız kör-nokta merceğinin NE ZAMAN koşacağına dair SAF karar.
//
// designPanelDecision (design-panel-gate.ts) deseninin kardeşi: saf, izole-test edilebilir, yan-etkisiz.
// Anti-friction çekirdeği: trivial/reversible karar DAİMA atlanır; mercek yalnız gerçekten consequential
// (kod/şema üreten, geri-dönülemez, iş-kaybı riskli) noktada koşar.
//
// Felsefe (kod-analiz 2026-06-07): ajan bir işe odaklanırken çevreyi bilinçsizce paranteze alır (kör nokta).
// Mercek, o kararı/artefaktı YAPMAYAN bağımsız bir göz olarak komit'ten ÖNCE bu kör noktayı yakalar. Ama her
// kararda koşmak friction yaratır → bu gate "neye değer" sorusunu deterministik yanıtlar.

import type { AgentDecision } from "./orchestrator-agent/decision.js";
import type { PhaseId } from "./types.js";

/** config.claude_code_flags.blindspot_lens — "off": kapalı; "consequential" (default): yalnız
 *  consequential + geri-dönülemez; "always": her consequential noktada (reversibility'ye bakmaz). */
export type LensFlag = "off" | "consequential" | "always";
export type LensDecision = "run" | "skip-trivial" | "off";

export function blindspotLensDecision(params: {
  lensFlag: LensFlag;
  isConsequential: boolean;
  isReversible: boolean;
}): LensDecision {
  if (params.lensFlag === "off") return "off";
  if (params.lensFlag === "always") {
    return params.isConsequential ? "run" : "skip-trivial";
  }
  // "consequential": yalnız consequential VE geri-dönülemez kararda koş.
  if (!params.isConsequential || params.isReversible) return "skip-trivial";
  return "run";
}

/** run_phase için: yalnız kod/şema ÜRETEN fazlar consequential (Faz 5 UI build, 7 DB, 8 TDD).
 *  Probe/spec/review/risk/mechanical fazları zaten kendi gate'leriyle korunur → friction yaratma. */
const CONSEQUENTIAL_PHASES: ReadonlySet<number> = new Set([5, 7, 8]);

export function phaseIsConsequential(phaseId: PhaseId | undefined): boolean {
  return phaseId !== undefined && CONSEQUENTIAL_PHASES.has(phaseId);
}

/** Orkestratör kararı, pre-commit merceğine değecek kadar consequential mi? */
export function decisionIsConsequential(decision: AgentDecision): boolean {
  switch (decision.action) {
    case "develop_new_or_iter": // yeni iterasyon: state reset, yön belirler
    case "cancel_pipeline": // iş kaybı, geri-dönülemez
    case "debug_triage": // Faz 0 başlatır (LLM maliyet)
      return true;
    case "run_phase":
      return phaseIsConsequential(decision.target_phase);
    default:
      // chat / ask_clarify / approve_ui / revise_ui / resume_pipeline / verify_feature /
      // save_memory_proposal / set_optional_phases / answer_askq / fallback → trivial.
      return false;
  }
}
