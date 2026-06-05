import { describe, expect, it } from "vitest";
import { subagentModelId } from "../src/config.js";
import type { SelectedModels } from "../src/config.js";

const base: SelectedModels = { translator: "TR", main: "MAIN" };

describe("config · subagentModelId (auto-model: yapılacak işe göre)", () => {
  it("açık per-rol override en öncelikli (tier'ı geçer)", () => {
    const m: SelectedModels = {
      ...base,
      subagent_models: { architect: "OVERRIDE" },
      model_tiers: { strong: "STRONG" },
    };
    expect(subagentModelId(m, "architect")).toBe("OVERRIDE");
  });

  it("override yoksa rolün iş-seviyesi tier'ı otomatik (architect→strong, ux→balanced)", () => {
    const m: SelectedModels = { ...base, model_tiers: { strong: "STRONG", balanced: "BAL" } };
    expect(subagentModelId(m, "architect")).toBe("STRONG"); // derin akıl yürütme
    expect(subagentModelId(m, "synthesizer")).toBe("STRONG"); // sentez
    expect(subagentModelId(m, "verifier")).toBe("STRONG"); // eleme
    expect(subagentModelId(m, "ux")).toBe("BAL"); // geniş-sığ perspektif
    expect(subagentModelId(m, "security")).toBe("BAL");
    expect(subagentModelId(m, "data")).toBe("BAL");
    expect(subagentModelId(m, "hypothesis")).toBe("BAL");
  });

  it("model_tiers yoksa / ilgili tier boşsa → main fallback (regresyon yok)", () => {
    expect(subagentModelId(base, "architect")).toBe("MAIN");
    expect(subagentModelId({ ...base, model_tiers: {} }, "ux")).toBe("MAIN");
    // strong set ama balanced değil → balanced rol main'e düşer
    expect(subagentModelId({ ...base, model_tiers: { strong: "S" } }, "ux")).toBe("MAIN");
    expect(subagentModelId({ ...base, model_tiers: { strong: "S" } }, "architect")).toBe("S");
  });
});
