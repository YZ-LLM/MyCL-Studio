import { describe, expect, it } from "vitest";
import { parseAcIds, acCoverage } from "../src/phase-8.js";

describe("parseAcIds (keystone ①)", () => {
  it("'- **ACn**:' satırlarından id çıkarır (girintili dahil)", () => {
    const md = `## Acceptance Criteria
- **AC1**: kullanıcı giriş yapabilir
- **AC2**: hatalı şifre reddedilir
  - **AC3**: oturum 15dk sürer`;
    expect(parseAcIds(md)).toEqual(["AC1", "AC2", "AC3"]);
  });
  it("AC yoksa []", () => {
    expect(parseAcIds("## Scope\nblah blah")).toEqual([]);
  });
});

describe("acCoverage (keystone ① — AC→test izlenebilirliği)", () => {
  it("hiç AC-id yok → tagged:false (caller SESSİZ kalmalı, gürültü yok)", () => {
    const c = acCoverage(["AC1", "AC2"], ["green", "passed all"]);
    expect(c.tagged).toBe(false);
    expect(c.uncovered).toEqual(["AC1", "AC2"]);
  });
  it("tümü etiketli → kapsandı (virgüllü çoklu dahil)", () => {
    const c = acCoverage(["AC1", "AC2", "AC3"], ["AC1", "AC2,AC3 bütünsel"]);
    expect(c.tagged).toBe(true);
    expect(c.covered).toEqual(["AC1", "AC2", "AC3"]);
    expect(c.uncovered).toEqual([]);
  });
  it("kısmi kapsam → uncovered doğru", () => {
    const c = acCoverage(["AC1", "AC2", "AC3"], ["AC1 testi geçti"]);
    expect(c.tagged).toBe(true);
    expect(c.covered).toEqual(["AC1"]);
    expect(c.uncovered).toEqual(["AC2", "AC3"]);
  });
  it("AC listesi boş → uncovered boş", () => {
    expect(acCoverage([], ["AC1"]).uncovered).toEqual([]);
  });
});
