import { describe, expect, it } from "vitest";
import {
  blindspotLensDecision,
  decisionIsConsequential,
  phaseIsConsequential,
  specIsConsequential,
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
  it("run_project (var olan app'i çalıştır) → false (operasyonel; kör-nokta merceği KOŞMAZ)", () => {
    // YZLLM 2026-07-15: "çalıştır" artık run_project → non-consequential → mercek bu istekte tetiklenmez.
    expect(decisionIsConsequential(dec("run_project"))).toBe(false);
  });
});

describe("run_project → gate 'skip-trivial' (mercek koşmaz — her bayrakta)", () => {
  it("consequential VE always bayraklarında NON-consequential → skip-trivial", () => {
    const cons = decisionIsConsequential(dec("run_project")); // false
    expect(blindspotLensDecision({ lensFlag: "consequential", isConsequential: cons, isReversible: false })).toBe(
      "skip-trivial",
    );
    expect(blindspotLensDecision({ lensFlag: "always", isConsequential: cons, isReversible: false })).toBe(
      "skip-trivial",
    );
  });
});

describe("specIsConsequential (mercek frekans gate — YZLLM 2026-06-16 perf)", () => {
  const ac = (...statements: string[]) => statements.map((s) => ({ statement: s }));

  it("≤3 AC + risk imzası YOK → false (önemsiz spec, mercek atlanır)", () => {
    expect(
      specIsConsequential({
        title: "Show user name on profile",
        scope: "display the name field on the profile card",
        acceptance_criteria: ac("name shows", "empty handled"),
      }),
    ).toBe(false);
  });

  it("4+ AC → true (kayda değer iş, mercek koşar)", () => {
    expect(
      specIsConsequential({
        title: "Reorder dashboard widgets",
        scope: "sort widgets by saved order",
        acceptance_criteria: ac("a", "b", "c", "d"),
      }),
    ).toBe(true);
  });

  it("riskli imza (auth) → ≤3 AC olsa bile true", () => {
    expect(
      specIsConsequential({
        title: "Fix login redirect",
        scope: "auth flow after session expiry",
        acceptance_criteria: ac("redirects after login"),
      }),
    ).toBe(true);
  });

  it("riskli imza (şema/yarış/unique) → true — survey çift-oy spec'i gibi", () => {
    expect(
      specIsConsequential({
        title: "Duplicate-vote guard",
        scope: "race-safe UNIQUE constraint on responses",
        acceptance_criteria: ac("first vote ok", "second → 409", "race-safe at DB layer"),
      }),
    ).toBe(true);
  });

  it("yıkıcı imza (delete/sil) → true", () => {
    expect(
      specIsConsequential({
        title: "Remove stale records",
        scope: "delete old rows nightly",
        acceptance_criteria: ac("old rows deleted"),
      }),
    ).toBe(true);
  });

  it("nötr küçük spec (reorder/sort) → false", () => {
    expect(
      specIsConsequential({
        title: "Reorder list",
        scope: "sort the items by name ascending",
        acceptance_criteria: ac("items sorted"),
      }),
    ).toBe(false);
  });

  it("AC yok + nötr → false (kuşkuda değil, açıkça önemsiz)", () => {
    expect(specIsConsequential({ title: "Tweak spacing", scope: "increase card padding" })).toBe(false);
  });
});
