// codegen/cli-backend — saf yardımcılar birim testi.
//
// codegenWallClockMs (YZLLM 2026-07-07, zaman-kaybı planı): CLI codegen wall-clock tavanı faz-türüne göre.
// Eşikler kritik bir karar (medyan×5-8 pay: normal koşuya dokunmaz, patolojiyi keser) → regresyon guard.

import { describe, expect, it } from "vitest";
import { codegenWallClockMs, parseTestResultMarkers } from "./cli-backend.js";

describe("codegenWallClockMs", () => {
  it("Faz 8 (TDD) → 90 dk (medyan ~12dk, patoloji 288dk)", () => {
    expect(codegenWallClockMs("phase-8")).toBe(90 * 60_000);
  });
  it("Faz 5 (UI) → 60 dk (kod-yorumu 133dk runaway)", () => {
    expect(codegenWallClockMs("phase-5")).toBe(60 * 60_000);
  });
  it("diğer codegen tag'leri → 30 dk", () => {
    expect(codegenWallClockMs("verify-feature")).toBe(30 * 60_000);
    expect(codegenWallClockMs("gate-autofix")).toBe(30 * 60_000);
    expect(codegenWallClockMs("parallel-module")).toBe(30 * 60_000);
    expect(codegenWallClockMs("bilinmeyen")).toBe(30 * 60_000);
  });
  it("tüm tavanlar pozitif ve makul (normal koşuyu asla kesmeyecek kadar yüksek)", () => {
    for (const tag of ["phase-8", "phase-5", "verify-feature"]) {
      const ms = codegenWallClockMs(tag);
      expect(ms).toBeGreaterThanOrEqual(30 * 60_000); // en az 30 dk
      expect(ms).toBeLessThanOrEqual(120 * 60_000); // 2 saat üstü mantıksız
    }
  });
});

describe("parseTestResultMarkers", () => {
  it("green + red marker'ları çıkarır (substring, regex yok)", () => {
    const out = parseTestResultMarkers(
      "bazı log\nMYCL_TEST_RESULT: green: AC1\ndaha fazla log\nMYCL_TEST_RESULT: red: AC2 kırık\n",
    );
    expect(out).toEqual([
      { green: true, detail: "green: AC1" },
      { green: false, detail: "red: AC2 kırık" },
    ]);
  });
  it("marker yoksa boş dizi", () => {
    expect(parseTestResultMarkers("hiç marker yok\nsadece text")).toEqual([]);
  });
  it("green/red dışı marker değeri yok sayılır", () => {
    expect(parseTestResultMarkers("MYCL_TEST_RESULT: maybe\n")).toEqual([]);
  });
});
