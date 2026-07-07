import { describe, expect, it } from "vitest";
import { subagentModelId } from "../src/config.js";
import { modelForTier } from "../src/model-catalog.js";
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

  it("model_tiers yoksa / ilgili tier boşsa → iş-seviyesine göre KATALOG varsayılanı (main/Opus DEĞİL — relevance-Opus bug sınıfı fix)", () => {
    // ESKİ (buggy) davranış: main'e düşüyordu → balanced roller (ux/security/data/hypothesis) dahil TÜM roller
    // kullanıcının main modeline (genelde Opus) koşuyordu — relevance sınıflandırıcısının Opus'a düşmesiyle aynı sınıf.
    // ARTIK: rolün iş-tier'ının katalog varsayılanına düşer (orchestratorModelId ile aynı modelForTier mekanizması).
    const strongDefault = modelForTier("strong").id;
    const balancedDefault = modelForTier("balanced").id;
    expect(strongDefault).not.toBe(balancedDefault); // gerçekten ayrı tier'lar
    expect(subagentModelId(base, "architect")).toBe(strongDefault); // strong rol → strong katalog default
    expect(subagentModelId({ ...base, model_tiers: {} }, "ux")).toBe(balancedDefault); // balanced rol → balanced default (main DEĞİL)
    expect(subagentModelId({ ...base, model_tiers: {} }, "hypothesis")).toBe(balancedDefault);
    // strong set (config değeri VERBATİM döner) ama balanced boş → balanced rol balanced-default'a (main DEĞİL)
    expect(subagentModelId({ ...base, model_tiers: { strong: "STRONG" } }, "ux")).toBe(balancedDefault);
    expect(subagentModelId({ ...base, model_tiers: { strong: "STRONG" } }, "architect")).toBe("STRONG");
  });
});
