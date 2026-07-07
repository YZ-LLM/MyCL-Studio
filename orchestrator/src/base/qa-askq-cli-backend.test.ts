// qa-askq-cli-backend — saf yardımcı birim testi.
//
// qaAskqWallClockMs (YZLLM 2026-07-07, zaman-kaybı planı): keşif oturumu per-tag wall-clock. Canlı kanıt: Faz 1
// tek oturumda 62dk grepledi. Eşikler kritik (gerçek medyan×~2.5 pay: normal koşuya dokunmaz) → regresyon guard.

import { describe, expect, it } from "vitest";
import { qaAskqWallClockMs, qaAskqTotalBudgetMs } from "./qa-askq-cli-backend.js";

describe("qaAskqWallClockMs", () => {
  it("Faz 1 (Niyet) → 8 dk (medyan 3dk)", () => {
    expect(qaAskqWallClockMs("phase-1")).toBe(8 * 60_000);
  });
  it("Faz 2 (Hassasiyet) → 12 dk (medyan 5dk)", () => {
    expect(qaAskqWallClockMs("phase-2")).toBe(12 * 60_000);
  });
  it("Faz 9 (Risk) → 15 dk (medyan 7.5dk)", () => {
    expect(qaAskqWallClockMs("phase-9")).toBe(15 * 60_000);
  });
  it("diğer qa-askq tag'leri → 30 dk (mevcut default korunur)", () => {
    expect(qaAskqWallClockMs("phase-3")).toBe(30 * 60_000);
    expect(qaAskqWallClockMs("bilinmeyen")).toBe(30 * 60_000);
  });
  it("her tavan gerçek medyanın belirgin üstünde (normal koşuyu kesmez)", () => {
    // Faz 1 medyan ~3dk < 8dk; Faz 2 ~5dk < 12dk; Faz 9 ~7.5dk < 15dk
    expect(qaAskqWallClockMs("phase-1")).toBeGreaterThan(3 * 60_000);
    expect(qaAskqWallClockMs("phase-2")).toBeGreaterThan(5 * 60_000);
    expect(qaAskqWallClockMs("phase-9")).toBeGreaterThan(7.5 * 60_000);
  });
});

describe("qaAskqTotalBudgetMs (per-faz toplam makine-bütçesi — mahkeme Bulgu 6)", () => {
  it("Faz 1/2/9 → 20/30/40 dk, diğer → 60 dk", () => {
    expect(qaAskqTotalBudgetMs("phase-1")).toBe(20 * 60_000);
    expect(qaAskqTotalBudgetMs("phase-2")).toBe(30 * 60_000);
    expect(qaAskqTotalBudgetMs("phase-9")).toBe(40 * 60_000);
    expect(qaAskqTotalBudgetMs("phase-3")).toBe(60 * 60_000);
  });
  it("toplam bütçe her zaman per-oturum tavanından BÜYÜK (çok-turlu netleştirmeye yer bırakır)", () => {
    for (const tag of ["phase-1", "phase-2", "phase-9"]) {
      expect(qaAskqTotalBudgetMs(tag)).toBeGreaterThan(qaAskqWallClockMs(tag));
    }
  });
});
