// Phase 1 gate — saf, yan etkisiz. Spec §11.4.
//
// Kararlar:
// - phase-1-intent-approve audit varsa → complete
// - phase-1-intent-cancel audit varsa → fail
// - aksi → incomplete (yeni tur bekleniyor)

import type { GateFunction } from "../../orchestrator/src/types.js";

export const phase01Gate: GateFunction = (_state, audit) => {
  const phase1 = audit.filter((e) => e.phase === 1);

  if (phase1.some((e) => e.event === "phase-1-intent-approve")) {
    return "complete";
  }
  if (phase1.some((e) => e.event === "phase-1-intent-cancel")) {
    return "fail";
  }
  return "incomplete";
};
