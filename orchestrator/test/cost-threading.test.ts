// F1 cost threading — recordTokenUsage faz-maliyet kovasını USD/model ile doldurur.
// Çekirdek: CLI modunda da kova dolsun (eskiden yalnız API yolu); USD yoksa undefined
// (uydurma 0 YOK); per-model döküm birikir; aktif kova yoksa no-op.

import { describe, expect, it, beforeEach } from "vitest";
import { beginPhaseCost, recordTokenUsage, takePhaseCost } from "../src/ipc.js";

describe("F1 cost threading", () => {
  beforeEach(() => {
    takePhaseCost(); // önceki testten kalan kovayı temizle
  });

  it("total_cost_usd + model → kovada birikir (çok turn)", () => {
    beginPhaseCost(5, 1);
    recordTokenUsage({ input_tokens: 100, output_tokens: 50, total_cost_usd: 0.012, model: "claude-opus-4-8" });
    recordTokenUsage({ input_tokens: 200, output_tokens: 80, total_cost_usd: 0.02, model: "claude-opus-4-8" });
    const b = takePhaseCost();
    expect(b).not.toBeNull();
    expect(b!.turns).toBe(2);
    expect(b!.input_tokens).toBe(300);
    expect(b!.total_cost_usd).toBeCloseTo(0.032, 6);
    expect(b!.model_usage!["claude-opus-4-8"].input_tokens).toBe(300);
    expect(b!.model_usage!["claude-opus-4-8"].output_tokens).toBe(130);
  });

  it("USD'siz çağrı (API yolu) → total_cost_usd undefined (uydurma 0 yok)", () => {
    beginPhaseCost(2, 1);
    recordTokenUsage({ input_tokens: 10, output_tokens: 5, model: "claude-haiku-4-5" });
    const b = takePhaseCost();
    expect(b!.total_cost_usd).toBeUndefined();
    expect(b!.model_usage!["claude-haiku-4-5"]).toBeDefined();
  });

  it("birden çok model → model_usage ayrı kovalar; USD toplanır", () => {
    beginPhaseCost(8, 1);
    recordTokenUsage({ input_tokens: 100, output_tokens: 40, total_cost_usd: 0.01, model: "claude-opus-4-8" });
    recordTokenUsage({ input_tokens: 30, output_tokens: 10, total_cost_usd: 0.002, model: "claude-haiku-4-5" });
    const b = takePhaseCost();
    expect(Object.keys(b!.model_usage!).sort()).toEqual(["claude-haiku-4-5", "claude-opus-4-8"]);
    expect(b!.total_cost_usd).toBeCloseTo(0.012, 6);
  });

  it("model'siz çağrı → model_usage oluşmaz (undefined)", () => {
    beginPhaseCost(1, 1);
    recordTokenUsage({ input_tokens: 5, output_tokens: 2 });
    const b = takePhaseCost();
    expect(b!.model_usage).toBeUndefined();
  });

  it("aktif kova yoksa no-op (throw etmez, faz-dışı çağrı güvenli)", () => {
    takePhaseCost(); // kovayı boşalt
    expect(() => recordTokenUsage({ input_tokens: 1, output_tokens: 1, model: "x" })).not.toThrow();
    expect(takePhaseCost()).toBeNull();
  });
});
