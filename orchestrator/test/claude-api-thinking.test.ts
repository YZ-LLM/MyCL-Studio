// claude-api · thinkingConfigFor — ultracode API modu extended-thinking planı (item 7).
// Saf fonksiyon: regresyon güvencesi (ultracode-DIŞI plan boş = davranış aynı) +
// forced tool_choice uyumsuzluğu + max_tokens bump + temperature drop sözleşmesi.

import { describe, expect, it } from "vitest";
import { thinkingConfigFor, ULTRACODE_THINKING_BUDGET } from "../src/claude-api.js";

describe("thinkingConfigFor · ultracode", () => {
  it("ultracode + tool_choice yok → thinking enable, max_tokens bump, temp drop", () => {
    const p = thinkingConfigFor("ultracode", undefined, 4096);
    expect(p.thinking).toEqual({ type: "enabled", budget_tokens: ULTRACODE_THINKING_BUDGET });
    expect(p.max_tokens).toBe(ULTRACODE_THINKING_BUDGET + 4096);
    expect(p.dropTemperature).toBe(true);
  });

  it("ultracode + tool_choice auto → thinking enable", () => {
    const p = thinkingConfigFor("ultracode", { type: "auto" }, 4096);
    expect(p.thinking).toBeDefined();
  });

  it("ultracode + forced tool_choice (any) → thinking YOK (API uyumsuz), davranış aynı", () => {
    const p = thinkingConfigFor("ultracode", { type: "any" }, 4096);
    expect(p.thinking).toBeUndefined();
    expect(p.max_tokens).toBe(4096);
    expect(p.dropTemperature).toBe(false);
  });

  it("ultracode + forced tool_choice (tool) → thinking YOK", () => {
    const p = thinkingConfigFor("ultracode", { type: "tool" }, 4096);
    expect(p.thinking).toBeUndefined();
  });

  it("base max_tokens zaten budget+4096'dan büyükse korunur", () => {
    const p = thinkingConfigFor("ultracode", undefined, 30000);
    expect(p.max_tokens).toBe(30000);
  });
});

describe("thinkingConfigFor · ultracode DIŞI (regresyon yok)", () => {
  for (const effort of [undefined, "low", "medium", "high", "xhigh", "max"]) {
    it(`effort=${String(effort)} → thinking YOK, max_tokens/temperature dokunulmaz`, () => {
      const p = thinkingConfigFor(effort, undefined, 4096);
      expect(p.thinking).toBeUndefined();
      expect(p.max_tokens).toBe(4096);
      expect(p.dropTemperature).toBe(false);
    });
  }
});
