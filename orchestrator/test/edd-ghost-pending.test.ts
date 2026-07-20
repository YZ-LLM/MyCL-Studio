// edd/engine — HAYALET pending uzlaşması (YZLLM 2026-07-19, canlı cave: silinen kopya dosyaları 13.07'den
// beri pending → EDD hiç "0 pending"e ulaşamıyor, her açılış boşa re-run + yanlış "N kaldı" vaadi).
import { describe, expect, it } from "vitest";
import { ghostPendingUnits } from "../src/edd/engine.js";
import type { EddUnitRecord } from "../src/edd/progress.js";
import type { SourceUnit } from "../src/edd/enumerate.js";

const rec = (status: EddUnitRecord["status"]): EddUnitRecord => ({ unit: "x", status, ts: 1 });
const su = (unit: string, analyzable: boolean, reason?: string): SourceUnit => ({
  unit,
  abs: `/p/${unit}`,
  bytes: 10,
  analyzable,
  reason,
});

describe("ghostPendingUnits", () => {
  it("pending + enumeration'da YOK (silinmiş) → deleted-before-analysis", () => {
    const cur = new Map<string, EddUnitRecord>([["routes/wellcome - Copy.js", rec("pending")]]);
    const g = ghostPendingUnits(cur, [su("app.js", true)]); // silinen enum'da yok
    expect(g).toEqual([{ unit: "routes/wellcome - Copy.js", reason: "deleted-before-analysis" }]);
  });

  it("pending + enumeration'da analyzable:false → o sebeple unanalyzable", () => {
    const cur = new Map<string, EddUnitRecord>([["big.min.js", rec("pending")]]);
    const g = ghostPendingUnits(cur, [su("big.min.js", false, "too-large (900KB)")]);
    expect(g).toEqual([{ unit: "big.min.js", reason: "too-large (900KB)" }]);
  });

  it("GENUINE pending (dosya var + analyzable) → DOKUNULMAZ", () => {
    const cur = new Map<string, EddUnitRecord>([["app.js", rec("pending")]]);
    expect(ghostPendingUnits(cur, [su("app.js", true)])).toEqual([]);
  });

  it("done / unanalyzable kayıtlar → dokunulmaz (yalnız pending uzlaşılır)", () => {
    const cur = new Map<string, EddUnitRecord>([
      ["a.js", rec("done")],
      ["b.js", rec("unanalyzable")],
    ]);
    expect(ghostPendingUnits(cur, [])).toEqual([]);
  });

  it("cave senaryosu: 3 silinen kopya → 3 hayalet, gerçek pending korunur", () => {
    const cur = new Map<string, EddUnitRecord>([
      ["routes/store - Copy.js", rec("pending")],
      ["routes/wellcome - Copy.js", rec("pending")],
      ["routes/wellcome - Copy (2).js", rec("pending")],
      ["routes/wellcome.js", rec("pending")], // gerçek, hâlâ var
    ]);
    const g = ghostPendingUnits(cur, [su("routes/wellcome.js", true)]);
    expect(g.map((x) => x.unit).sort()).toEqual([
      "routes/store - Copy.js",
      "routes/wellcome - Copy (2).js",
      "routes/wellcome - Copy.js",
    ]);
  });
});
