import { describe, it, expect } from "vitest";
import { DEBATE_AXES, WAVE1_AXES, WAVE2_AXES } from "../src/phase-9-debate-review.js";

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
