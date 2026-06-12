// resume-detection — boot-resume faz tespiti (saf). Regresyon: audit tail'i
// iteration-N-start'ı kaçırsa bile resume scope'u state'ten doğru hesaplanmalı.

import { describe, expect, it } from "vitest";
import { detectInterruptedPhase2To9Pure } from "../src/resume-detection.js";
import type { AuditEvent, State } from "../src/types.js";

function ev(ts: number, event: string): AuditEvent {
  return { ts, phase: 0, event, caller: "mycl-orchestrator" };
}

type S = Pick<
  State,
  "current_phase" | "iteration_count" | "iteration_started_at"
>;

describe("resume-detection · detectInterruptedPhase2To9Pure", () => {
  it("faz 1 / 18+ → null (kapsam dışı); 10-17 artık KAPSAMDA (Ümit 2026-06-11: mekanik fazlar da oto-resume)", () => {
    expect(detectInterruptedPhase2To9Pure({ current_phase: 1 } as S, [])).toBeNull();
    expect(detectInterruptedPhase2To9Pure({ current_phase: 0 } as S, [])).toBeNull();
    // Faz 13 (mekanik güvenlik) yarıda + handled-event yok → resume sinyali ver (tıklat-prompt yerine oto-devam).
    expect(detectInterruptedPhase2To9Pure({ current_phase: 13 } as S, [])).toEqual({ phaseId: 13 });
    // phase-13-skipped varsa kasıtlı atlanmış → resume YOK.
    expect(detectInterruptedPhase2To9Pure({ current_phase: 13 } as S, [ev(100, "phase-13-skipped")])).toBeNull();
  });

  it("iter 1, phase-6-complete YOK → resume {phaseId:6}", () => {
    const s: S = { current_phase: 6, iteration_count: 1 };
    const audit = [ev(100, "phase-5-complete")];
    expect(detectInterruptedPhase2To9Pure(s, audit)).toEqual({ phaseId: 6 });
  });

  it("iter 1, phase-6-complete VAR → null (resume yok)", () => {
    const s: S = { current_phase: 6, iteration_count: 1 };
    const audit = [ev(100, "phase-5-complete"), ev(200, "phase-6-complete")];
    expect(detectInterruptedPhase2To9Pure(s, audit)).toBeNull();
  });

  // Ümit 2026-06-12: ONAY fazı (2/3/4/7) park etmiş + BAYAT complete → yine resume.
  // Faz gerçekten bitseydi advanceToNextPhase current_phase'i ilerletirdi; current_phase
  // hâlâ 4 ise verify-up Faz 4'e geri dönüp yeni onay açmış demektir → otomatik yeniden-aç
  // (orkestratör "faza tıkla" demesin). Mekanik fazda (6) bayat complete hâlâ null verir.
  it("onay fazı 4 + bu iterasyonda phase-4-complete VAR ama park etmiş → resume {phaseId:4}", () => {
    const s: S = { current_phase: 4, iteration_count: 1 };
    const audit = [ev(100, "phase-4-complete"), ev(200, "phase-4-complete")];
    expect(detectInterruptedPhase2To9Pure(s, audit)).toEqual({ phaseId: 4 });
  });

  it("mekanik faz 6 + phase-6-complete VAR → null (onay-fazı istisnası 6'yı kapsamaz)", () => {
    const s: S = { current_phase: 6, iteration_count: 1 };
    const audit = [ev(200, "phase-6-complete")];
    expect(detectInterruptedPhase2To9Pure(s, audit)).toBeNull();
  });

  // ASIL BUG: uzun iter-2'de iteration-2-start audit tail'i dışında kalmış +
  // tail'de ÖNCEKİ iterasyonun (iter-1) phase-6-complete'i duruyor. State'te
  // iteration_started_at YOKSA scopeStartTs=0 → eski complete "tamamlandı"
  // sanılır → resume YANLIŞLIKLA atlanırdı.
  it("iter 2, iteration-start tail dışında + state.iteration_started_at VAR → doğru resume", () => {
    const s: S = {
      current_phase: 6,
      iteration_count: 2,
      iteration_started_at: 5000, // iter-2 başlangıcı
    };
    // Tail'de SADECE iter-1'in eski phase-6-complete'i var (ts=100 < 5000);
    // iter-2'nin phase-6-complete'i YOK → yarıda → resume olmalı.
    const audit = [ev(100, "phase-6-complete"), ev(5100, "phase-5-complete")];
    expect(detectInterruptedPhase2To9Pure(s, audit)).toEqual({ phaseId: 6 });
  });

  it("iter 2, iteration_started_at VAR + bu iterasyonda phase-6-complete VAR → null", () => {
    const s: S = {
      current_phase: 6,
      iteration_count: 2,
      iteration_started_at: 5000,
    };
    const audit = [ev(100, "phase-6-complete"), ev(5200, "phase-6-complete")];
    expect(detectInterruptedPhase2To9Pure(s, audit)).toBeNull();
  });

  it("iter 2, state.iteration_started_at YOK (eski state) → audit iteration-2-start fallback", () => {
    const s: S = { current_phase: 6, iteration_count: 2 };
    const audit = [
      ev(100, "phase-6-complete"), // iter-1 eski complete
      ev(4000, "iteration-2-start"),
      ev(5100, "phase-5-complete"), // iter-2'de phase-6-complete YOK
    ];
    expect(detectInterruptedPhase2To9Pure(s, audit)).toEqual({ phaseId: 6 });
  });
});
