import { describe, it, expect } from "vitest";
import {
  applyClusters,
  DEBATE_AXES,
  WAVE1_AXES,
  WAVE2_AXES,
  type DebateFinding,
} from "../src/phase-9-debate-review.js";

const f = (over: Partial<DebateFinding>): DebateFinding => ({
  risk: "risk",
  decision: "fix",
  fix_phase: "code",
  severity: "medium",
  axis: "security",
  ...over,
});

describe("Faz 9 dalga bölünmesi (YZLLM 2026-06-30)", () => {
  it("Dalga 1 + Dalga 2 TÜM eksenleri örtüşmesiz kapsar (7 eksen, bulgu düşmez)", () => {
    expect(WAVE1_AXES.length + WAVE2_AXES.length).toBe(DEBATE_AXES.length);
    const keys1 = new Set(WAVE1_AXES.map((a) => a.key));
    const keys2 = new Set(WAVE2_AXES.map((a) => a.key));
    // Örtüşme yok (bir eksen iki dalgada olamaz).
    for (const k of keys1) expect(keys2.has(k)).toBe(false);
    // Birleşim = tüm eksenler.
    expect(new Set([...keys1, ...keys2]).size).toBe(DEBATE_AXES.length);
  });

  it("Dalga 2 = rafine eksenler (örtüştüğü Dalga-1 eksenini tamamlar)", () => {
    const keys2 = WAVE2_AXES.map((a) => a.key).sort();
    expect(keys2).toEqual(["error-paths", "stride", "tech-debt"]);
    const keys1 = new Set(WAVE1_AXES.map((a) => a.key));
    // Örtüşen çiftlerin temel yarısı Dalga 1'de olmalı (rafine ondan sonra gelsin).
    expect(keys1.has("correctness")).toBe(true); // error-paths bunu rafine eder
    expect(keys1.has("security")).toBe(true); // stride bunu rafine eder
    expect(keys1.has("maintainability")).toBe(true); // tech-debt bunu rafine eder
  });
});

describe("applyClusters (semantik dedup uygulaması — SAF, güvenlik-kritik)", () => {
  it("bir grup → tek temsilci (EN YÜKSEK severity)", () => {
    const out = applyClusters(
      [f({ risk: "a", severity: "low" }), f({ risk: "b", severity: "high" })],
      [[0, 1]],
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
  });

  it("eşit severity → EN ZENGİN detail'li bulgu TEMSİLCİ olur (risk'i kullanılır)", () => {
    const out = applyClusters(
      [f({ risk: "a", detail: "kısa" }), f({ risk: "b", detail: "çok daha uzun detay metni" })],
      [[0, 1]],
    );
    expect(out).toHaveLength(1);
    expect(out[0].risk).toBe("b"); // zengin-detail'li temsilci → onun risk'i
  });

  it("birden çok eksen birleşince iz için 'a+b' olur", () => {
    const out = applyClusters(
      [f({ axis: "correctness" }), f({ axis: "tech-debt" })],
      [[0, 1]],
    );
    expect(out).toHaveLength(1);
    expect(out[0].axis).toBe("correctness+tech-debt");
  });

  it("KRİTİK GÜVENLİK: birleşen bulguların TÜM risk+detail'i temsilcide korunur (bilgi kaybı yok)", () => {
    const out = applyClusters(
      [
        f({ risk: "SQL injection", severity: "high", detail: "app.js:12 raw query", axis: "security" }),
        f({ risk: "login bypass", severity: "medium", detail: "auth.js:5 no check", axis: "correctness" }),
      ],
      [[0, 1]],
    );
    expect(out).toHaveLength(1);
    // Yanlış birleştirilmiş olsa bile İKİ risk de detail'de → çürütücü + düzeltici görür.
    expect(out[0].detail).toContain("SQL injection");
    expect(out[0].detail).toContain("login bypass");
    expect(out[0].detail).toContain("app.js:12");
    expect(out[0].detail).toContain("auth.js:5");
    expect(out[0].severity).toBe("high"); // en yüksek severity temsilci
  });

  it("büyük grup (tümü tek kümede) → 1 temsilci ama TÜM üyeler detail'de (hiçbiri sessizce düşmez)", () => {
    const findings = ["a", "b", "c", "d", "e"].map((r) => f({ risk: r, detail: `${r}-detay` }));
    const out = applyClusters(findings, [[0, 1, 2, 3, 4]]);
    expect(out).toHaveLength(1);
    for (const r of ["a", "b", "c", "d", "e"]) {
      expect(out[0].detail).toContain(r);
      expect(out[0].detail).toContain(`${r}-detay`);
    }
  });

  it("GÜVENLİK: hiçbir gruba girmeyen bulgu AYNEN korunur (bulgu kaybı yok)", () => {
    const out = applyClusters(
      [f({ risk: "a" }), f({ risk: "b" }), f({ risk: "c" })],
      [[0]], // LLM yalnız index 0'ı döndürdü; 1 ve 2 atlandı
    );
    expect(out).toHaveLength(3); // hepsi korunur
    expect(out.map((x) => x.risk).sort()).toEqual(["a", "b", "c"]);
  });

  it("GÜVENLİK: geçersiz/kapsam-dışı index atlanır, geçerliler korunur", () => {
    const out = applyClusters(
      [f({ risk: "a" }), f({ risk: "b" })],
      [[0, 99, -1, 1.5 as unknown as number]], // yalnız 0 geçerli
    );
    // 0 grupta temsilci; 1 kapsanmadı → aynen korunur
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.risk).sort()).toEqual(["a", "b"]);
  });

  it("GÜVENLİK: aynı index iki grupta → ikincisinde yok sayılır (çift-say yok)", () => {
    const out = applyClusters(
      [f({ risk: "a" }), f({ risk: "b" })],
      [[0, 1], [0]], // 0 zaten kapsandı
    );
    expect(out).toHaveLength(1); // [0,1] birleşti; ikinci grup [0] boşa düşer
  });

  it("boş/geçersiz grup yapıları güvenle atlanır", () => {
    const out = applyClusters(
      [f({ risk: "a" }), f({ risk: "b" })],
      ["saçma" as unknown, [], [0, 1]],
    );
    expect(out).toHaveLength(1);
  });

  it("gruplar boşsa TÜM bulgular korunur (no-op)", () => {
    const out = applyClusters([f({ risk: "a" }), f({ risk: "b" })], []);
    expect(out).toHaveLength(2);
  });
});
