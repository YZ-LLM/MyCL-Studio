// perf-budget — performans kapısının karar çekirdeği (SAF).
//
// KÖK NEDEN (2026-08-03): Faz 12 ölçüm YAPMIYORDU. MyCL'in kendi Faz 5 şablonu codegen'e
// `"perf": "npm run build"` yazmayı zorunlu tutuyordu → kapı yalnız build'i tekrar çalıştırıyordu.
// Ayrıca 19 stack'in 13'ünde `perf` komutu hiç tanımlı değildi. Kullanıcının ürün amacı "performanslı"
// olduğu için bu, ölçmeden geçen bir kapıydı.
//
// YANLIŞ ALARM YASAĞI kullanıcının en sert kuralı — bu testler onu kilitler.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERF_BUDGET,
  decidePerf,
  nextBaseline,
  medianMeasurement,
  type PerfBudget,
} from "../src/perf-budget.js";

const budget = (over: Partial<PerfBudget> = {}): PerfBudget => ({ ...DEFAULT_PERF_BUDGET, ...over });

describe("decidePerf — yanlış alarm savunması", () => {
  it("İLK KOŞU ASLA DÜŞMEZ — temel kaydedilir", () => {
    const r = decidePerf({ score: 41, env: "dev" }, budget());
    expect(r.kind).toBe("baseline_recorded");
  });

  it("temel varken küçük dalgalanma düşürmez (sınırın altı)", () => {
    const b = budget({ baseline: { dev: { score: 90 } } });
    expect(decidePerf({ score: 71, env: "dev" }, b).kind).toBe("pass"); // 19 puan düşüş < 20
  });

  it("temele göre GENİŞ gerileme düşürür (sınır ve üstü)", () => {
    const b = budget({ baseline: { dev: { score: 90 } } });
    const r = decidePerf({ score: 70, env: "dev" }, b); // tam 20 puan
    expect(r.kind).toBe("fail");
    if (r.kind === "fail") expect(r.reasons[0]).toContain("20 puan");
  });

  it("mutlak dip eşiği temel OLMASA da düşürür (tartışmasız kötü)", () => {
    const r = decidePerf({ score: 12, env: "dev" }, budget());
    expect(r.kind).toBe("fail");
  });

  it("geliştirme ve üretim temelleri AYRI tutulur (yavaş dev sunucu üretimi düşürmez)", () => {
    const b = budget({ baseline: { prod: { score: 95 } } });
    // dev ölçümü prod temeliyle kıyaslanmaz → ilk dev koşusu temel kaydeder, düşmez.
    expect(decidePerf({ score: 55, env: "dev" }, b).kind).toBe("baseline_recorded");
  });

  it("report_only modu ASLA düşürmez (tek satırla açılır)", () => {
    const b = budget({ mode: "report_only", baseline: { dev: { score: 95 } } });
    expect(decidePerf({ score: 5, env: "dev" }, b).kind).toBe("report_only");
  });
});

describe("decidePerf — paket boyutu", () => {
  it("temele göre yüzde büyüme sınırı", () => {
    const b = budget({ baseline: { prod: { bundleBytes: 100_000 } } });
    expect(decidePerf({ bundleBytes: 124_000, env: "prod" }, b).kind).toBe("pass"); // %24
    expect(decidePerf({ bundleBytes: 126_000, env: "prod" }, b).kind).toBe("fail"); // %26
  });

  it("mutlak tavan verilirse temelden bağımsız uygulanır", () => {
    const b = budget({ bundle_hard_ceiling_bytes: 50_000, baseline: { prod: { bundleBytes: 10_000 } } });
    const r = decidePerf({ bundleBytes: 60_000, env: "prod" }, b);
    expect(r.kind).toBe("fail");
    if (r.kind === "fail") expect(r.reasons[0]).toContain("mutlak tavan");
  });

  it("hiç ölçüm yoksa SESSİZ 'geçti' DEMEZ", () => {
    expect(decidePerf({ env: "prod" }, budget()).kind).toBe("fail");
  });
});

describe("nextBaseline / medianMeasurement", () => {
  it("temel yalnız kendi ortamını günceller, diğerini korur", () => {
    const b = budget({ baseline: { prod: { bundleBytes: 1 }, dev: { score: 50 } } });
    const next = nextBaseline({ score: 88, env: "dev" }, b);
    expect(next?.dev?.score).toBe(88);
    expect(next?.prod?.bundleBytes).toBe(1); // dokunulmadı
  });

  it("medyan: tek seferlik dalgalanma yumuşatılır", () => {
    const m = medianMeasurement({ score: 40, env: "dev" }, { score: 80, env: "dev" });
    expect(m.score).toBe(60);
  });

  it("medyan: bir ölçüm eksikse diğeri kullanılır", () => {
    expect(medianMeasurement({ score: 70, env: "dev" }, { env: "dev" }).score).toBe(70);
  });
});
