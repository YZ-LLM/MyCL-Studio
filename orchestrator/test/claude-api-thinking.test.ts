// claude-api · thinkingConfigFor + modelSupportsAdaptive (F3).
// Opus 4.7+ → adaptive thinking + output_config.effort (eski budget_tokens Opus 4.8'de 400 verir);
// eski modeller → legacy budget yolu (mevcut davranış korunur). Forced tool_choice → thinking YOK.

import { describe, expect, it } from "vitest";
import {
  thinkingConfigFor,
  modelSupportsAdaptive,
  ULTRACODE_THINKING_BUDGET,
  ADAPTIVE_MAX_TOKENS_FLOOR,
} from "../src/claude-api.js";

describe("modelSupportsAdaptive", () => {
  it("Opus 4.7+ + mythos → adaptive", () => {
    for (const m of ["claude-opus-4-8", "claude-opus-4-7", "opus-4-8", "claude-mythos-preview"]) {
      expect(modelSupportsAdaptive(m)).toBe(true);
    }
  });
  it("eski modeller (opus 4.6/4.5, sonnet, haiku) → legacy", () => {
    for (const m of [
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-opus-4-1",
      "",
    ]) {
      expect(modelSupportsAdaptive(m)).toBe(false);
    }
  });
});

describe("thinkingConfigFor · ADAPTIVE yol (Opus 4.7+)", () => {
  it("ultracode + tool_choice yok → adaptive + effort:max + max_tokens floor + temp drop", () => {
    const p = thinkingConfigFor("ultracode", undefined, 4096, true);
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "max" });
    expect(p.max_tokens).toBe(ADAPTIVE_MAX_TOKENS_FLOOR);
    expect(p.dropTemperature).toBe(true);
  });

  it("budget_tokens enabled ASLA gönderilmez (Opus 4.8 400 bug fix)", () => {
    for (const effort of ["ultracode", "max", "high", "low"]) {
      const p = thinkingConfigFor(effort, undefined, 4096, true);
      expect(p.thinking).not.toEqual(
        expect.objectContaining({ type: "enabled" }),
      );
    }
  });

  it("her effort seviyesi → output_config.effort = effort + adaptive", () => {
    for (const eff of ["low", "medium", "high", "xhigh", "max"]) {
      const p = thinkingConfigFor(eff, { type: "auto" }, 4096, true);
      expect(p.output_config).toEqual({ effort: eff });
      expect(p.thinking).toEqual({ type: "adaptive" });
    }
  });

  it("forced tool_choice (any/tool) → thinking YOK + output_config YOK (0 risk, mevcut davranış)", () => {
    for (const tc of [{ type: "any" }, { type: "tool" }]) {
      const p = thinkingConfigFor("max", tc, 4096, true);
      expect(p.thinking).toBeUndefined();
      expect(p.output_config).toBeUndefined();
      expect(p.max_tokens).toBe(4096);
      expect(p.dropTemperature).toBe(false);
    }
  });

  it("effort undefined/tanınmıyor → thinking/output_config YOK", () => {
    for (const eff of [undefined, "banana"]) {
      const p = thinkingConfigFor(eff, undefined, 4096, true);
      expect(p.thinking).toBeUndefined();
      expect(p.output_config).toBeUndefined();
    }
  });

  it("max_tokens floor: base düşükse yükselt, yüksekse koru", () => {
    expect(thinkingConfigFor("max", undefined, 4096, true).max_tokens).toBe(ADAPTIVE_MAX_TOKENS_FLOOR);
    expect(thinkingConfigFor("max", undefined, 50000, true).max_tokens).toBe(50000);
  });
});

describe("thinkingConfigFor · LEGACY yol (eski model, regresyon korunur)", () => {
  it("ultracode + tool_choice yok → enabled budget_tokens + max_tokens bump + temp drop", () => {
    const p = thinkingConfigFor("ultracode", undefined, 4096, false);
    expect(p.thinking).toEqual({ type: "enabled", budget_tokens: ULTRACODE_THINKING_BUDGET });
    expect(p.output_config).toBeUndefined();
    expect(p.max_tokens).toBe(ULTRACODE_THINKING_BUDGET + 4096);
    expect(p.dropTemperature).toBe(true);
  });

  it("ultracode + forced (any/tool) → thinking YOK", () => {
    expect(thinkingConfigFor("ultracode", { type: "any" }, 4096, false).thinking).toBeUndefined();
    expect(thinkingConfigFor("ultracode", { type: "tool" }, 4096, false).thinking).toBeUndefined();
  });

  it("base max_tokens zaten budget+4096'dan büyükse korunur", () => {
    expect(thinkingConfigFor("ultracode", undefined, 30000, false).max_tokens).toBe(30000);
  });

  it("ultracode DIŞI effort → thinking/output_config YOK (davranış aynı)", () => {
    for (const effort of [undefined, "low", "medium", "high", "xhigh", "max"]) {
      const p = thinkingConfigFor(effort, undefined, 4096, false);
      expect(p.thinking).toBeUndefined();
      expect(p.output_config).toBeUndefined();
      expect(p.max_tokens).toBe(4096);
      expect(p.dropTemperature).toBe(false);
    }
  });
});
