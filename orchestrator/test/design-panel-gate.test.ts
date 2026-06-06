import { describe, expect, it } from "vitest";
import { designPanelDecision } from "../src/design-panel-gate.js";

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
