import { describe, expect, it } from "vitest";
import { parseAuditReport } from "../src/quality-audit.js";

describe("parseAuditReport (denetim raporu JSON ayrıştırma)", () => {
  it("geçerli rapor → fixable + source-change ayrımı", () => {
    const txt = 'bla bla\n{"summary":"loop on E2BIG","findings":[{"q":4,"verdict":"fail","evidence":"climbed pointlessly"}],"fixable_in_mycl":["re-run on CLI"],"needs_source_change":["E2BIG env errors should short-circuit the debug loop"]}';
    const r = parseAuditReport(txt)!;
    expect(r.summary).toMatch(/E2BIG/);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].verdict).toBe("fail");
    expect(r.fixable_in_mycl).toContain("re-run on CLI");
    expect(r.needs_source_change[0]).toMatch(/short-circuit/);
  });
  it("JSON yoksa null (sistem saçmalamaz)", () => {
    expect(parseAuditReport("no json here")).toBeNull();
  });
  it("eksik alanlar → güvenli boş diziler", () => {
    const r = parseAuditReport('{"summary":"ok"}')!;
    expect(r.findings).toEqual([]);
    expect(r.fixable_in_mycl).toEqual([]);
    expect(r.needs_source_change).toEqual([]);
  });
});
