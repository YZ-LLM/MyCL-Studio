// DECISION_PRINCIPLES — karar-çerçevesi (Parça 3) regresyon guard'ı. Bu sabit karar-ajanlarının
// system-prompt'una gömülür ("YZLLM gibi karar ver"); yanlışlıkla boşalmamalı / çekirdek ilkeleri kaybetmemeli.

import { describe, expect, it } from "vitest";
import { DECISION_PRINCIPLES, VERIFY_BEFORE_CLAIM } from "../src/agent-language.js";

describe("DECISION_PRINCIPLES (Parça 3 — karar-çerçevesi)", () => {
  it("dolu + çekirdek ilkeleri içerir (varsayma-yok / no-silent-fallback / fail-closed / kalite / correct-by-construction)", () => {
    expect(DECISION_PRINCIPLES.length).toBeGreaterThan(200);
    expect(DECISION_PRINCIPLES).toMatch(/NEVER ASSUME/);
    expect(DECISION_PRINCIPLES).toMatch(/NO SILENT FALLBACK/);
    expect(DECISION_PRINCIPLES).toMatch(/FAIL-CLOSED/);
    expect(DECISION_PRINCIPLES).toMatch(/QUALITY IS A FIXED CONSTRAINT/);
    expect(DECISION_PRINCIPLES).toMatch(/CORRECT-BY-CONSTRUCTION/);
  });
  it("ENOENT vs gerçek-hata ayrımını + fake-green yasağını açıkça söyler (denetim dersleri)", () => {
    expect(DECISION_PRINCIPLES).toMatch(/ENOENT/);
    expect(DECISION_PRINCIPLES).toMatch(/fake-green/i);
  });
  it("VERIFY_BEFORE_CLAIM ile birbirini tamamlar (ikisi de dolu, ayrı)", () => {
    expect(VERIFY_BEFORE_CLAIM).toMatch(/VERIFY BEFORE YOU CLAIM/);
    expect(DECISION_PRINCIPLES).not.toEqual(VERIFY_BEFORE_CLAIM);
  });
});
