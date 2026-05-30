// Phase 4 gate — saf, yan etkisiz.
// phase-4-spec-approve audit varsa complete; cancel varsa fail.

import type { GateFunction } from "../../orchestrator/src/types.js";

export const phase04Gate: GateFunction = (_state, audit) => {
  const p4 = audit.filter((e) => e.phase === 4);
  if (p4.some((e) => e.event === "phase-4-spec-approve")) return "complete";
  if (p4.some((e) => e.event === "phase-4-spec-cancel")) return "fail";
  return "incomplete";
};
