import { describe, it, expect } from "vitest";
import { parseFindings } from "./phase-9-debate-review.js";

// Faz 9 (düşman incelemesi) SON SAVUNMA HATTI: parseFindings LLM çıktısını bulgulara çevirir. Şekil-uyuşmazlığında
// SESSİZCE [] döner → Faz 9 "temiz" raporlar → sahte-yeşil riski. Bu testler parser'ı (eskiden test EDİLMİYORDU) kilitler.
const block = (findings: unknown[]): string =>
  `Some prose from the agent.\n\n${JSON.stringify({ kind: "findings", findings })}\n`;

describe("parseFindings — Faz 9 bulgu parser'ı (son savunma; gerçek kod)", () => {
  it("geçerli bulgu → alanlar doğru + axis eklenir", () => {
    const r = parseFindings(
      block([{ risk: "SQL injection in login", decision: "fix", fix_phase: "code", severity: "high", detail: "x" }]),
      "security",
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ risk: "SQL injection in login", decision: "fix", fix_phase: "code", severity: "high", axis: "security" });
  });

  it("risk BOŞ/eksik → bulgu atlanır (gürültü değil)", () => {
    expect(parseFindings(block([{ risk: "", severity: "high" }, { severity: "low" }]), "a")).toHaveLength(0);
  });

  it("decision='rule' → fix_phase ZORLA 'none' (kural fix fazı gerektirmez)", () => {
    const r = parseFindings(block([{ risk: "naming convention", decision: "rule", fix_phase: "code", severity: "low" }]), "quality");
    expect(r[0].decision).toBe("rule");
    expect(r[0].fix_phase).toBe("none");
  });

  it("geçersiz severity → 'medium' default", () => {
    expect(parseFindings(block([{ risk: "x", severity: "catastrophic" }]), "a")[0].severity).toBe("medium");
  });
  it("geçersiz fix_phase → 'code' default (fix kararında)", () => {
    expect(parseFindings(block([{ risk: "x", decision: "fix", fix_phase: "wormhole" }]), "a")[0].fix_phase).toBe("code");
  });
  it("geçerli fix_phase değerleri korunur (ui/db/code/none)", () => {
    for (const fp of ["ui", "db", "code", "none"] as const) {
      expect(parseFindings(block([{ risk: "x", decision: "fix", fix_phase: fp }]), "a")[0].fix_phase).toBe(fp);
    }
  });

  it("findings bloğu YOK (kind:findings eşleşmiyor) → [] (dokümante sessiz-drop — Faz 9 sinyali)", () => {
    expect(parseFindings("just prose, no json block at all", "a")).toEqual([]);
    expect(parseFindings(JSON.stringify({ kind: "other", data: [] }), "a")).toEqual([]);
  });
  it("findings dizi DEĞİL → []", () => {
    expect(parseFindings(JSON.stringify({ kind: "findings", findings: "not-array" }), "a")).toEqual([]);
  });
  it("obje-olmayan bulgu girdileri atlanır", () => {
    expect(parseFindings(block(["string", 42, null, { risk: "real" }]), "a")).toHaveLength(1);
  });
});
