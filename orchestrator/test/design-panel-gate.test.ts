import { describe, expect, it } from "vitest";
import { designPanelDecision, designSynthesizedInCurrentIteration } from "../src/design-panel-gate.js";

describe("designPanelDecision (Faz 5 spec gate)", () => {
  const base = {
    designFlag: "create-only",
    isTweakMode: false,
    isCreateIteration: true,
    uiComplexity: undefined as "simple" | "moderate" | "complex" | undefined,
  };

  it("flag off → 'off' (panel hiç düşünülmez)", () => {
    expect(designPanelDecision({ ...base, designFlag: "off" })).toBe("off");
  });

  it("tweak modu → 'off'", () => {
    expect(designPanelDecision({ ...base, isTweakMode: true })).toBe("off");
  });

  it("create-only + iterasyon>1 → 'off'", () => {
    expect(designPanelDecision({ ...base, isCreateIteration: false })).toBe("off");
  });

  it("always + iterasyon>1 → yine değerlendirilir ('run')", () => {
    expect(
      designPanelDecision({ ...base, designFlag: "always", isCreateIteration: false }),
    ).toBe("run");
  });

  it("ui_complexity undefined → 'run' (regresyon-güvenli)", () => {
    expect(designPanelDecision({ ...base, uiComplexity: undefined })).toBe("run");
  });

  it("ui_complexity 'simple' → 'skip-simple' (tek-ajan tasarım)", () => {
    expect(designPanelDecision({ ...base, uiComplexity: "simple" })).toBe("skip-simple");
  });

  it("ui_complexity 'moderate' → 'run'", () => {
    expect(designPanelDecision({ ...base, uiComplexity: "moderate" })).toBe("run");
  });

  it("ui_complexity 'complex' → 'run'", () => {
    expect(designPanelDecision({ ...base, uiComplexity: "complex" })).toBe("run");
  });

  it("flag off, ui simple olsa bile → 'off' (flag önceliği)", () => {
    expect(
      designPanelDecision({ ...base, designFlag: "off", uiComplexity: "simple" }),
    ).toBe("off");
  });
});

// 2026-06-10 boot-resume: bu iterasyonda panel zaten sentezlendiyse yeniden koşma.
describe("designSynthesizedInCurrentIteration", () => {
  it("sentez var + sonrasında yeni iterasyon yok → true", () => {
    expect(
      designSynthesizedInCurrentIteration([
        { event: "iteration-2-start" },
        { event: "ui-design-synthesized" },
        { event: "phase-5-start" },
      ]),
    ).toBe(true);
  });
  it("sentezden SONRA yeni iterasyon başladı → false (eski iterasyonun sentezi)", () => {
    expect(
      designSynthesizedInCurrentIteration([
        { event: "ui-design-synthesized" },
        { event: "iteration-3-start" },
      ]),
    ).toBe(false);
  });
  it("hiç sentez yok → false", () => {
    expect(designSynthesizedInCurrentIteration([{ event: "phase-4-complete" }])).toBe(false);
  });
});
