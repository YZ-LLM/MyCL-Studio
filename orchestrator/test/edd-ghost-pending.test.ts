// edd/engine — HAYALET pending sınıflaması (YZLLM 2026-07-19, canlı cave: silinen kopya dosyaları 13.07'den
// beri pending → EDD hiç "0 pending"e ulaşamıyor). MAHKEME CRITICAL: enum'da yokluk ≠ silinmiş (geçici I/O
// eksikliği gerçek pending'i kaybettirmesin) → notEnumerated AYRI kategori; runEdd safeSourceHash ile teyit eder.
import { describe, expect, it } from "vitest";
import { classifyGhostPending } from "../src/edd/engine.js";
import type { EddUnitRecord } from "../src/edd/progress.js";
import type { SourceUnit } from "../src/edd/enumerate.js";

const rec = (status: EddUnitRecord["status"]): EddUnitRecord => ({ unit: "x", status, ts: 1 });
const su = (unit: string, analyzable: boolean, reason?: string): SourceUnit => ({
  unit, abs: `/p/${unit}`, bytes: 10, analyzable, reason,
});

describe("classifyGhostPending", () => {
  it("pending + enumeration'da analyzable:false → nonAnalyzable (güvenli, doğrudan)", () => {
    const cur = new Map<string, EddUnitRecord>([["big.min.js", rec("pending")]]);
    const r = classifyGhostPending(cur, [su("big.min.js", false, "too-large (900KB)")]);
    expect(r.nonAnalyzable).toEqual([{ unit: "big.min.js", reason: "too-large (900KB)" }]);
    expect(r.notEnumerated).toEqual([]);
  });

  it("MAHKEME CRITICAL: pending + enum'da YOK → notEnumerated (doğrudan 'silinmiş' SAYILMAZ; caller fs ile teyit)", () => {
    const cur = new Map<string, EddUnitRecord>([["routes/wellcome - Copy.js", rec("pending")]]);
    const r = classifyGhostPending(cur, [su("app.js", true)]);
    expect(r.notEnumerated).toEqual(["routes/wellcome - Copy.js"]);
    expect(r.nonAnalyzable).toEqual([]); // ENOENT teyidi olmadan unanalyzable'a yazılmaz
  });

  it("GENUINE pending (dosya var + analyzable) → hiçbir kategoriye girmez (DOKUNULMAZ)", () => {
    const cur = new Map<string, EddUnitRecord>([["app.js", rec("pending")]]);
    const r = classifyGhostPending(cur, [su("app.js", true)]);
    expect(r.nonAnalyzable).toEqual([]);
    expect(r.notEnumerated).toEqual([]);
  });

  it("done / unanalyzable kayıtlar → dokunulmaz (yalnız pending sınıflanır)", () => {
    const cur = new Map<string, EddUnitRecord>([["a.js", rec("done")], ["b.js", rec("unanalyzable")]]);
    const r = classifyGhostPending(cur, []);
    expect(r.nonAnalyzable).toEqual([]);
    expect(r.notEnumerated).toEqual([]);
  });

  it("cave senaryosu: 3 kopya enum'da yok → notEnumerated; gerçek pending korunur", () => {
    const cur = new Map<string, EddUnitRecord>([
      ["routes/store - Copy.js", rec("pending")],
      ["routes/wellcome - Copy.js", rec("pending")],
      ["routes/wellcome - Copy (2).js", rec("pending")],
      ["routes/wellcome.js", rec("pending")], // gerçek, hâlâ var
    ]);
    const r = classifyGhostPending(cur, [su("routes/wellcome.js", true)]);
    expect(r.notEnumerated.sort()).toEqual([
      "routes/store - Copy.js",
      "routes/wellcome - Copy (2).js",
      "routes/wellcome - Copy.js",
    ]);
    expect(r.nonAnalyzable).toEqual([]);
  });
});
