import { describe, it, expect } from "vitest";
import { dedupeFindings, normalizeRisk } from "../src/phase-9-debate-dedup.js";
import type { DebateFinding } from "../src/phase-9-debate-review.js";

const f = (over: Partial<DebateFinding>): DebateFinding => ({
  risk: "risk",
  decision: "fix",
  fix_phase: "code",
  severity: "medium",
  axis: "security",
  ...over,
});

describe("normalizeRisk", () => {
  it("küçük-harf + boşluk normalize", () => {
    expect(normalizeRisk("  Missing   NULL  check ")).toBe("missing null check");
    expect(normalizeRisk("Missing null check")).toBe(normalizeRisk("missing  null   check"));
  });
});

describe("dedupeFindings", () => {
  it("farklı riskler korunur", () => {
    const out = dedupeFindings([f({ risk: "a risk" }), f({ risk: "b risk" })]);
    expect(out).toHaveLength(2);
  });

  it("normalize-eşit riskler tekillenir (case/boşluk farkı)", () => {
    const out = dedupeFindings([
      f({ risk: "Missing null check", axis: "correctness" }),
      f({ risk: "missing   null check", axis: "security" }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("çakışmada daha yüksek önem korunur", () => {
    const out = dedupeFindings([
      f({ risk: "same", severity: "low", axis: "a" }),
      f({ risk: "same", severity: "high", axis: "b" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
  });

  it("eşit önemde fix, rule'u yener", () => {
    const out = dedupeFindings([
      f({ risk: "same", severity: "medium", decision: "rule" }),
      f({ risk: "same", severity: "medium", decision: "fix" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].decision).toBe("fix");
  });

  it("boş risk metni atlanır", () => {
    expect(dedupeFindings([f({ risk: "   " })])).toHaveLength(0);
  });
});
