// F1 cost threading — recordTokenUsage faz-maliyet kovasını USD/model ile doldurur.
// Çekirdek: CLI modunda da kova dolsun (eskiden yalnız API yolu); USD yoksa undefined
// (uydurma 0 YOK); per-model döküm birikir; aktif kova yoksa no-op.

import { describe, expect, it, beforeEach } from "vitest";
import {
  beginPhaseCost,
  emitAskq,
  emitAskqResolved,
  recordTokenUsage,
  takePhaseCost,
} from "../src/ipc.js";

describe("F1 cost threading", () => {
  beforeEach(() => {
    takePhaseCost(); // önceki testten kalan kovayı temizle
  });

  it("sideTask:true → AYRI SÜREÇ token'ı faz kovasına YAZILMAZ (YZLLM 'iterasyonu etkilemesin')", () => {
    beginPhaseCost(5, 1);
    recordTokenUsage({ input_tokens: 100, output_tokens: 50, model: "claude-opus-4-8" }); // gerçek faz turu
    recordTokenUsage({ input_tokens: 9999, output_tokens: 9999, model: "claude-opus-4-8" }, { sideTask: true }); // özet
    const b = takePhaseCost();
    expect(b!.turns).toBe(1); // yalnız gerçek faz turu sayıldı
    expect(b!.input_tokens).toBe(100); // özetin 9999'u kovaya girmedi
    expect(b!.output_tokens).toBe(50);
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

// YZLLM 2026-06-17: Faz süresinden askq-bekleme düşülmesi — emit→cevap aralığı
// askqWaitMs'e birikir; index.ts flush'ı duration_ms'ten çıkarır.
describe("askq-bekleme süresi (faz süresinden düşülür)", () => {
  beforeEach(() => {
    takePhaseCost(); // önceki testten kalan kovayı temizle
  });

  it("emit→cevap aralığı askqWaitMs'e birikir", async () => {
    beginPhaseCost(1, 1);
    emitAskq({ id: "q1", question: "?", options: ["a", "b"] });
    await new Promise((r) => setTimeout(r, 20)); // kullanıcı cevabını bekliyor
    emitAskqResolved("q1");
    const b = takePhaseCost();
    expect(b).not.toBeNull();
    expect(b!.askqWaitMs).toBeGreaterThanOrEqual(15); // ~20ms (zamanlayıcı toleransı)
    expect(b!.currentAskqEmitTs).toBeUndefined(); // cevap sonrası temizlenir
  });

  it("birden çok askq → bekleme süreleri toplanır", async () => {
    beginPhaseCost(2, 1);
    emitAskq({ id: "q1", question: "?", options: ["a"] });
    await new Promise((r) => setTimeout(r, 15));
    emitAskqResolved("q1");
    emitAskq({ id: "q2", question: "?", options: ["a"] });
    await new Promise((r) => setTimeout(r, 15));
    emitAskqResolved("q2");
    const b = takePhaseCost();
    expect(b!.askqWaitMs).toBeGreaterThanOrEqual(25); // ~30ms toplam
  });

  it("askq yokken askqWaitMs=0 (saf çalışma fazı)", () => {
    beginPhaseCost(8, 1);
    recordTokenUsage({ input_tokens: 10, output_tokens: 5, model: "x" });
    const b = takePhaseCost();
    expect(b!.askqWaitMs).toBe(0);
  });

  it("oto-cevap (emit→hemen resolve) → bekleme ~0", () => {
    beginPhaseCost(5, 1);
    emitAskq({ id: "auto", question: "?", options: ["a"] });
    emitAskqResolved("auto"); // hemen cevaplandı (programatik/oto)
    const b = takePhaseCost();
    expect(b!.askqWaitMs).toBeLessThan(15); // pratikte ~0ms
  });
});
