import { describe, it, expect } from "vitest";
import { resolveRiskFixTarget } from "../src/risk-fix-routing.js";

const open = { skipUi: false, noDb: false };

describe("resolveRiskFixTarget", () => {
  it("ui → Faz 5, db → Faz 7, code → Faz 8", () => {
    expect(resolveRiskFixTarget("ui", open).target).toBe(5);
    expect(resolveRiskFixTarget("db", open).target).toBe(7);
    expect(resolveRiskFixTarget("code", open).target).toBe(8);
  });

  it("büyük/küçük harf + boşluk toleranslı", () => {
    expect(resolveRiskFixTarget("  UI ", open).target).toBe(5);
    expect(resolveRiskFixTarget("Code", open).target).toBe(8);
  });

  it("fix_phase yok/none/bilinmeyen → Faz 8 (code) + assumedCode", () => {
    for (const v of [undefined, "", "none", "frontend", "database-ish"]) {
      const r = resolveRiskFixTarget(v, open);
      expect(r.target).toBe(8);
      expect(r.assumedCode).toBe(true);
    }
  });

  it("net domain'de assumedCode set EDİLMEZ", () => {
    expect(resolveRiskFixTarget("ui", open).assumedCode).toBeUndefined();
    expect(resolveRiskFixTarget("code", open).assumedCode).toBeUndefined();
  });

  it("kapsam koruması: UI riski + UI'sız proje → atla (no-ui)", () => {
    const r = resolveRiskFixTarget("ui", { skipUi: true, noDb: false });
    expect(r.target).toBeNull();
    expect(r.skipReason).toBe("no-ui");
  });

  it("kapsam koruması: DB riski + DB'siz proje → atla (no-db)", () => {
    const r = resolveRiskFixTarget("db", { skipUi: false, noDb: true });
    expect(r.target).toBeNull();
    expect(r.skipReason).toBe("no-db");
  });

  it("kapsam koruması yalnız ilgili domain'i etkiler — code her zaman geçer", () => {
    expect(resolveRiskFixTarget("code", { skipUi: true, noDb: true }).target).toBe(8);
    // UI'sız projede DB riski hâlâ Faz 7'ye gider (skipUi DB'yi etkilemez)
    expect(resolveRiskFixTarget("db", { skipUi: true, noDb: false }).target).toBe(7);
  });
});
