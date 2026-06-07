import { describe, expect, it } from "vitest";
import {
  blindspotLensDecision,
  decisionIsConsequential,
  phaseIsConsequential,
} from "../src/pre-commit-lens-gate.js";
import type { AgentDecision } from "../src/orchestrator-agent/decision.js";

const dec = (action: string, target_phase?: number): AgentDecision =>
  ({ action, reason: "r", target_phase } as unknown as AgentDecision);

describe("blindspotLensDecision (gate)", () => {
  it("flag off → 'off' (her girdide)", () => {
    expect(
      blindspotLensDecision({ lensFlag: "off", isConsequential: true, isReversible: false }),
    ).toBe("off");
  });

  it("consequential flag + consequential + irreversible → 'run'", () => {
    expect(
      blindspotLensDecision({ lensFlag: "consequential", isConsequential: true, isReversible: false }),
    ).toBe("run");
  });

  it("consequential flag + NON-consequential → 'skip-trivial'", () => {
    expect(
      blindspotLensDecision({ lensFlag: "consequential", isConsequential: false, isReversible: false }),
    ).toBe("skip-trivial");
  });

  it("consequential flag + reversible → 'skip-trivial' (anti-friction)", () => {
    expect(
      blindspotLensDecision({ lensFlag: "consequential", isConsequential: true, isReversible: true }),
    ).toBe("skip-trivial");
  });

  it("always + consequential → 'run' (reversibility'ye bakmaz)", () => {
    expect(
      blindspotLensDecision({ lensFlag: "always", isConsequential: true, isReversible: true }),
    ).toBe("run");
  });

  it("always + NON-consequential → 'skip-trivial'", () => {
    expect(
      blindspotLensDecision({ lensFlag: "always", isConsequential: false, isReversible: false }),
    ).toBe("skip-trivial");
  });
});

describe("phaseIsConsequential", () => {
  it("kod/şema üreten fazlar (5,7,8) → true", () => {
    for (const p of [5, 7, 8]) expect(phaseIsConsequential(p as never)).toBe(true);
  });
  it("probe/spec/review/mechanical fazları → false", () => {
    for (const p of [0, 1, 2, 3, 4, 6, 9, 10, 14]) expect(phaseIsConsequential(p as never)).toBe(false);
  });
  it("undefined → false", () => {
    expect(phaseIsConsequential(undefined)).toBe(false);
  });
});

describe("decisionIsConsequential", () => {
  it("develop_new_or_iter / cancel_pipeline / debug_triage → true", () => {
    for (const a of ["develop_new_or_iter", "cancel_pipeline", "debug_triage"]) {
      expect(decisionIsConsequential(dec(a))).toBe(true);
    }
  });
  it("trivial action'lar → false", () => {
    for (const a of ["chat", "ask_clarify", "approve_ui", "revise_ui", "resume_pipeline", "verify_feature", "answer_askq"]) {
      expect(decisionIsConsequential(dec(a))).toBe(false);
    }
  });
  it("run_phase: kod/şema fazı (5/7/8) → true, diğer → false, target yok → false", () => {
    expect(decisionIsConsequential(dec("run_phase", 8))).toBe(true);
    expect(decisionIsConsequential(dec("run_phase", 5))).toBe(true);
    expect(decisionIsConsequential(dec("run_phase", 2))).toBe(false);
    expect(decisionIsConsequential(dec("run_phase", 14))).toBe(false);
    expect(decisionIsConsequential(dec("run_phase"))).toBe(false);
  });
});
