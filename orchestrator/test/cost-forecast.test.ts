import { describe, expect, it } from "vitest";
import { predictPipelineCost } from "../src/cost-forecast.js";
import type { CostRecord } from "../src/types.js";

// Kısa yardımcı: minimal CostRecord (öngörü yalnız phase/tokens/duration kullanır).
function cr(phase: number, iteration: number, tokens: number, dur = 1000): CostRecord {
  return {
    ts: iteration * 1000 + phase,
    phase: phase as CostRecord["phase"],
    iteration,
    duration_ms: dur,
    turns: 1,
    input_tokens: Math.round(tokens * 0.1),
    output_tokens: Math.round(tokens * 0.9),
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

const PIPELINE = Array.from({ length: 17 }, (_, i) => i + 1); // 1..17

describe("predictPipelineCost (tam-pipeline öngörü)", () => {
  it("boş veri → null (uydurma sayı yok)", () => {
    expect(predictPipelineCost([], PIPELINE)).toBeNull();
    expect(predictPipelineCost([cr(8, 1, 1000)], [])).toBeNull();
  });

  it("pipeline-dışı faz (Faz 0) öngörüye girmez → null", () => {
    // Yalnız Faz 0 verisi + pipeline 1..17 → hiç eşleşme → null.
    expect(predictPipelineCost([cr(0, 23, 20000)], PIPELINE)).toBeNull();
  });

  it("tüm 17 faz gerçek veriyle → per-faz medyan toplamı (tekdüze ×17 DEĞİL)", () => {
    const costs = PIPELINE.map((p) => cr(p, 1, p * 1000)); // Faz p → p·1000 token
    const pred = predictPipelineCost(costs, PIPELINE)!;
    const expected = PIPELINE.reduce((s, p) => s + p * 1000, 0); // Σ p·1000 = 153000
    expect(pred.total_tokens).toBe(expected);
    expect(pred.known_phases).toBe(17);
    expect(pred.reliable).toBe(true);
    // Naif ×17 = ort × 17 = 9000 × 17 = 153000 — bu tekdüze örnekte eşit; asıl fark ağır-şişme profilinde (aşağıda).
  });

  it("cave5 profili (kısmi iterasyon, ağır 8/9/15) → ×17 şişmesi GİTMELİ, regresyon YOK", () => {
    // iter 23: yalnız Faz 8-17 koştu (1-7 yok). Ağır: 8≈102K, 9≈112K, 15≈70K.
    const costs = [
      cr(8, 23, 102000), cr(9, 23, 112000), cr(10, 23, 8000), cr(11, 23, 0),
      cr(12, 23, 0), cr(13, 23, 16000), cr(14, 23, 0), cr(15, 23, 70000),
      cr(16, 23, 17000), cr(17, 23, 0),
    ];
    const pred = predictPipelineCost(costs, PIPELINE)!;
    // Naif eski öngörü: ort(10 faz)=32500 × 17 ≈ 552500 (şişmiş).
    const naive = Math.round(costs.reduce((s, c) => s + c.input_tokens + c.output_tokens, 0) / costs.length) * 17;
    expect(naive).toBeGreaterThan(500000);
    // Yeni: bilinen 10 fazın gerçek toplamı (325K) + 7 eksik faz × genel-medyan(bilinen faz-medyanları).
    // Genel medyan düşük (çok sıfır/ucuz faz) → eksikler şişmez → naiften belirgin DÜŞÜK.
    expect(pred.total_tokens).toBeLessThan(naive);
    expect(pred.total_tokens).toBeLessThan(450000);
    expect(pred.known_phases).toBe(10);
    expect(pred.reliable).toBe(true);
  });

  it("aynı faz birden çok iterasyonda → MEDYAN (outlier-dayanıklı, ortalama değil)", () => {
    // Faz 8: 3 kez {100K, 100K, 400K(outlier)} → medyan 100K (ortalama 200K olurdu).
    const costs = [cr(8, 1, 100000), cr(8, 2, 100000), cr(8, 3, 400000)];
    const pred = predictPipelineCost(costs, [8])!;
    expect(pred.total_tokens).toBe(100000); // medyan, ortalama(200K) değil
    expect(pred.known_phases).toBe(1);
  });

  it("2'den az faz → reliable=false (kaba işaretlensin)", () => {
    const pred = predictPipelineCost([cr(8, 1, 100000), cr(9, 1, 100000)], PIPELINE)!;
    expect(pred.known_phases).toBe(2);
    expect(pred.reliable).toBe(false);
  });
});
