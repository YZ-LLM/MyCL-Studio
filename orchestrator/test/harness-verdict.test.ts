import { describe, expect, it } from "vitest";
import { computeVerdict } from "../src/harness-verdict.js";
import type { AuditEvent } from "../src/types.js";

function ev(phase: number, event: string, detail?: string): AuditEvent {
  return { ts: 1, phase, event, caller: "mycl-orchestrator", detail } as AuditEvent;
}

// Faz 2-17 hepsi complete (gate'ler yeşil) — referans "temiz" koşu.
function cleanRun(): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (let n = 2; n <= 17; n++) out.push(ev(n, `phase-${n}-complete`));
  return out;
}

describe("harness-verdict · computeVerdict", () => {
  it("tüm gate'ler yeşil + 17-complete → PASS (exit 0)", () => {
    const r = computeVerdict(cleanRun());
    expect(r.verdict).toBe("PASS");
    expect(r.completed).toBe(true);
    expect(r.gateFailures).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it("17-complete VAR ama gate-fail VAR → PARTIAL (sessiz 'tamamlandı' değil, exit 2)", () => {
    // Ekrandaki senaryo: Faz 13/14/15/16 fail, ama pipeline 17'ye ulaştı.
    const events = [
      ...cleanRun(),
      ev(13, "phase-13-fail", "npm audit ..."),
      ev(13, "phase-13-complete", "soft_complete_after_fail"),
      ev(14, "phase-14-fail"),
      ev(14, "phase-14-complete", "soft_complete_after_fail"),
    ];
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.completed).toBe(true);
    expect(r.exitCode).toBe(2);
    expect(r.gateFailures.map((g) => g.phase)).toEqual([13, 14]);
    // Faz başına tek kayıt; açıklayıcı -fail event'i tercih edilir (soft-complete değil).
    expect(r.gateFailures[0].event).toBe("phase-13-fail");
    expect(r.summary).toMatch(/AMA 2 gate başarısız/);
  });

  it("soft_complete_after_fail tek başına (yalnız complete) da PARTIAL sayılır", () => {
    const events = [...cleanRun(), ev(13, "phase-13-complete", "soft_complete_after_fail")];
    // Not: cleanRun zaten phase-13-complete (detailsiz) içeriyor; soft'lu olan eklenince fail sayılır.
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.gateFailures.map((g) => g.phase)).toContain(13);
  });

  it("custom gate-fail event'i (örn. lint-fail) de yakalanır", () => {
    const events = [...cleanRun(), ev(10, "lint-fail", "eslint errors")];
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PARTIAL");
    expect(r.gateFailures.map((g) => g.phase)).toContain(10);
  });

  it("17-complete YOK (controller fail / hard hata) → FAIL (exit 1)", () => {
    const events: AuditEvent[] = [];
    for (let n = 2; n <= 12; n++) events.push(ev(n, `phase-${n}-complete`)); // 13'te durdu
    const r = computeVerdict(events);
    expect(r.verdict).toBe("FAIL");
    expect(r.completed).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it("skipped (scope/missing-command) başarısızlık SAYILMAZ → PASS", () => {
    const events = [
      ...cleanRun(),
      ev(5, "phase-5-skipped-by-scope"),
      ev(11, "phase-11-skipped", "missing_command"),
    ];
    const r = computeVerdict(events);
    expect(r.verdict).toBe("PASS");
    expect(r.gateFailures).toEqual([]);
  });
});
