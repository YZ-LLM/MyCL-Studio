// resume-detection — boot-resume faz tespiti (saf). Regresyon: audit tail'i
// iteration-N-start'ı kaçırsa bile resume scope'u state'ten doğru hesaplanmalı.

import { describe, expect, it } from "vitest";
import { computeMidPipeline, detectInterruptedPhase2To9Pure, decideBootQueueAction } from "../src/resume-detection.js";
import type { AuditEvent, State } from "../src/types.js";

function ev(ts: number, event: string): AuditEvent {
  return { ts, phase: 0, event, caller: "mycl-orchestrator" };
}

function task(status: string, id = "t1"): { id: string; status?: string } {
  return { id, status };
}

type S = Pick<
  State,
  "current_phase" | "iteration_count" | "iteration_started_at"
>;

describe("resume-detection · detectInterruptedPhase2To9Pure", () => {
  it("faz 1 / 18+ → null (kapsam dışı); 10-17 artık KAPSAMDA (YZLLM 2026-06-11: mekanik fazlar da oto-resume)", () => {
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

  // YZLLM 2026-06-12: ONAY fazı (2/3/4/7) park etmiş + BAYAT complete → yine resume.
  // Faz gerçekten bitseydi advanceToNextPhase current_phase'i ilerletirdi; current_phase
  // hâlâ 4 ise verify-up Faz 4'e geri dönüp yeni onay açmış demektir → otomatik yeniden-aç
  // (orkestratör "faza tıkla" demesin). Mekanik fazda (6) bayat complete hâlâ null verir.
  it("onay fazı 4 + bu iterasyonda phase-4-complete VAR ama park etmiş → resume {phaseId:4}", () => {
    const s: S = { current_phase: 4, iteration_count: 1 };
    const audit = [ev(100, "phase-4-complete"), ev(200, "phase-4-complete")];
    expect(detectInterruptedPhase2To9Pure(s, audit)).toEqual({ phaseId: 4 });
  });

  it("mekanik faz 6 + phase-6-complete VAR → null (deferred UI; istisna 6'yı kapsamaz)", () => {
    const s: S = { current_phase: 6, iteration_count: 1 };
    const audit = [ev(200, "phase-6-complete")];
    expect(detectInterruptedPhase2To9Pure(s, audit)).toBeNull();
  });

  // YZLLM 2026-06-12: codegen/risk fazları (5/8/9) güvenlik-fix/verify-up ile YENİDEN girilebilir → park edebilir.
  // Faz 8 bayat phase-8-complete'e rağmen current_phase=8'de park etmişse → resume (eskiden "soldan tıkla" diyordu).
  it("codegen faz 8 (TDD) + bu iterasyonda phase-8-complete VAR ama park etmiş → resume {phaseId:8}", () => {
    const s: S = { current_phase: 8, iteration_count: 1 };
    const audit = [ev(100, "phase-8-complete"), ev(200, "phase-8-complete")];
    expect(detectInterruptedPhase2To9Pure(s, audit)).toEqual({ phaseId: 8 });
  });

  it("risk faz 9 + phase-9-complete VAR ama park → resume {phaseId:9}", () => {
    const s: S = { current_phase: 9, iteration_count: 1 };
    expect(detectInterruptedPhase2To9Pure(s, [ev(100, "phase-9-complete")])).toEqual({ phaseId: 9 });
  });

  it("mekanik faz 13 + phase-13-complete VAR → null (mekanik gate; redo istemez)", () => {
    const s: S = { current_phase: 13, iteration_count: 1 };
    expect(detectInterruptedPhase2To9Pure(s, [ev(200, "phase-13-complete")])).toBeNull();
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

// YZLLM 2026-07-03: decideBootQueueAction — yarım iterasyonu kaldığı fazdan resume et (Faz 1'den koşma).
describe("resume-detection · decideBootQueueAction (kesinti-resume)", () => {
  const base = { current_phase: 13, iteration_count: 1, intent_summary: "auth ekle" } as unknown as Parameters<typeof decideBootQueueAction>[0];

  it("(a) running orphan + mid-Faz-13 + intent dolu → resume (kaldığı fazdan)", () => {
    const r = decideBootQueueAction(base, [task("running")], [ev(1, "phase-12-complete")]);
    expect(r).toEqual({ kind: "resume", phaseId: 13, taskId: "t1" });
  });

  it("(b) yalnız pending iş (running orphan yok) → drain (Faz 1'den)", () => {
    expect(decideBootQueueAction(base, [task("pending")], []).kind).toBe("drain");
  });

  it("(c) cp=1 + running → resume DEĞİL (detector Faz 1'i kapsamaz) → drain", () => {
    const s = { ...base, current_phase: 1 } as typeof base;
    expect(decideBootQueueAction(s, [task("running")], []).kind).toBe("drain");
  });

  it("(c2) intent_summary boş → resume DEĞİL (mid-Faz-1 clarify checkpoint yok)", () => {
    const s = { ...base, intent_summary: "" } as typeof base;
    expect(decideBootQueueAction(s, [task("running")], []).kind).toBe("drain");
  });

  it("(d) önceki-iter phase-17-complete VAR ama iterasyon-kapsamlı mid-Faz-13 → yine resume (wasPipelineCompleted tuzağı yok)", () => {
    const s = { ...base, iteration_count: 2, iteration_started_at: 1000 } as typeof base;
    // phase-17-complete ts=500 (önceki iter, scope öncesi) → iterasyon-kapsamlı detector onu SAYMAZ.
    const r = decideBootQueueAction(s, [task("running")], [ev(500, "phase-17-complete"), ev(1200, "phase-12-complete")]);
    expect(r).toEqual({ kind: "resume", phaseId: 13, taskId: "t1" });
  });

  it("(e) standDown: pending_diagnostic → resume DEĞİL (boot Faz 0 debug re-emit'i işler)", () => {
    const s = { ...base, pending_diagnostic: { phase: "D2_WAITING" } } as unknown as typeof base;
    expect(decideBootQueueAction(s, [task("running")], [ev(1, "phase-12-complete")]).kind).toBe("drain");
  });

  it("(e2) standDown: foreign + pending_ui_review + cp=6 → resume DEĞİL", () => {
    const s = { current_phase: 6, iteration_count: 1, intent_summary: "x", origin: "foreign", pending_ui_review: true } as unknown as typeof base;
    expect(decideBootQueueAction(s, [task("running")], []).kind).toBe("drain");
  });

  it("(f) hiç iş yok → none", () => {
    expect(decideBootQueueAction(base, [], []).kind).toBe("none");
    expect(decideBootQueueAction(base, [task("done")], []).kind).toBe("none");
  });
});

// KÖK NEDEN (YZLLM 2026-08-04, cave): eski `current_phase > 1` hesabı TAMAMLANMIŞ pipeline'ı da
// "ortada" sayıyordu → kılavuz bayatlık kontrolü ve EDD devamı bitmiş projede hiç koşmuyordu.
describe("computeMidPipeline — bitmiş pipeline 'ortada' sayılmaz", () => {
  const base = {
    hasPendingQueueWork: false,
    pendingUiTweak: false,
    pendingDiagnostic: false,
  };

  it("CAVE DURUMU: Faz 17 bitmiş + kuyruk boş → pipeline ortasında DEĞİL (açılış tetikleyicileri koşar)", () => {
    // Kopyanın gerçek durumu: current_phase=17, yarıda kalmış faz yok, bekleyen iş yok.
    expect(computeMidPipeline({ ...base, currentPhase: 17, interruptedPhase: null })).toBe(false);
  });

  it("Faz 17 YARIDA (bu iterasyonda complete/skipped yok) → hâlâ ortada", () => {
    expect(computeMidPipeline({ ...base, currentPhase: 17, interruptedPhase: { phaseId: 17 } })).toBe(true);
  });

  it("bitmiş ama kuyrukta iş var → ortada (ağır açılış işi kuyrukla eşzamanlı başlamaz)", () => {
    expect(
      computeMidPipeline({ ...base, currentPhase: 17, interruptedPhase: null, hasPendingQueueWork: true }),
    ).toBe(true);
  });

  it("bitmiş ama kullanıcı seçimi bekleniyor (tweak/diagnostic) → ortada", () => {
    expect(computeMidPipeline({ ...base, currentPhase: 17, interruptedPhase: null, pendingUiTweak: true })).toBe(true);
    expect(
      computeMidPipeline({ ...base, currentPhase: 17, interruptedPhase: null, pendingDiagnostic: true }),
    ).toBe(true);
  });

  it("ESKİ DAVRANIŞ KORUNUR: gerçekten ortadaki fazlar (2..16) ortada sayılır", () => {
    for (const cp of [2, 5, 9, 13, 16]) {
      expect(computeMidPipeline({ ...base, currentPhase: cp, interruptedPhase: null }), `faz ${cp}`).toBe(true);
      expect(
        computeMidPipeline({ ...base, currentPhase: cp, interruptedPhase: { phaseId: cp as never } }),
        `faz ${cp} yarıda`,
      ).toBe(true);
    }
  });

  it("ESKİ DAVRANIŞ KORUNUR: taze/ilk açılış (faz ≤1) ortada değil", () => {
    expect(computeMidPipeline({ ...base, currentPhase: 1, interruptedPhase: null })).toBe(false);
    expect(computeMidPipeline({ ...base, currentPhase: undefined, interruptedPhase: null })).toBe(false);
  });

  it("Faz 17'nin 'ele alınmış' tespiti detectInterruptedPhase2To9Pure ile tutarlı (uçtan uca)", () => {
    const st = { current_phase: 17, iteration_count: 1 } as unknown as State;
    // Faz 17 complete → interrupted null → bitmiş → ortada değil.
    const done = detectInterruptedPhase2To9Pure(st, [ev(10, "phase-17-complete")]);
    expect(done).toBeNull();
    expect(computeMidPipeline({ ...base, currentPhase: 17, interruptedPhase: done })).toBe(false);
    // Faz 17 hiç koşmamış → interrupted {17} → ortada.
    const mid = detectInterruptedPhase2To9Pure(st, []);
    expect(mid).toEqual({ phaseId: 17 });
    expect(computeMidPipeline({ ...base, currentPhase: 17, interruptedPhase: mid })).toBe(true);
  });
});
