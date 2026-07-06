// resume-detection — SAF boot karar fonksiyonları birim testi.
//
// decideBootQueueAction (YZLLM 2026-07-03, yarım-iterasyon resume) + shouldRunBootStatusCheck
// (YZLLM 2026-07-06, "iş kuyruğundan işi aldı — MyCL akıllı olmalı") IO'suz saf fonksiyonlar → tam test.

import { describe, expect, it } from "vitest";
import { decideBootQueueAction, shouldRunBootStatusCheck } from "./resume-detection.js";
import type { AuditEvent, PhaseId, State } from "./types.js";

// İki saf fonksiyonun okuduğu tüm alanların birleşimi (Pick üst-kümesi → her ikisine yapısal atanabilir).
type BootState = Pick<
  State,
  | "current_phase"
  | "iteration_count"
  | "iteration_started_at"
  | "intent_summary"
  | "pending_diagnostic"
  | "pending_ui_tweak"
  | "pending_ui_review"
  | "dev_server_pid"
  | "origin"
>;

function mkState(o: Partial<BootState> = {}): BootState {
  return {
    current_phase: (o.current_phase ?? 1) as PhaseId,
    iteration_count: o.iteration_count ?? 1,
    iteration_started_at: o.iteration_started_at,
    intent_summary: o.intent_summary,
    pending_diagnostic: o.pending_diagnostic,
    pending_ui_tweak: o.pending_ui_tweak,
    pending_ui_review: o.pending_ui_review,
    dev_server_pid: o.dev_server_pid,
    origin: o.origin,
  };
}

function ev(event: string, ts: number, phase = 1): AuditEvent {
  return { ts, phase: phase as PhaseId, event, caller: "mycl-orchestrator" };
}

const running = [{ id: "t1", status: "running" }];
const pending = [{ id: "t2", status: "pending" }];
const D2: NonNullable<BootState["pending_diagnostic"]> = {
  phase: "D2_WAITING",
  askq_id: "a",
  rootCauseTR: "r",
  options: [],
  ts: 1000,
};

describe("decideBootQueueAction", () => {
  it("(a) mid-Faz-13 running orphan + intent + phase-13-complete YOK → resume", () => {
    const st = mkState({
      current_phase: 13,
      iteration_count: 2,
      iteration_started_at: 1000,
      intent_summary: "yardım sistemi ekle",
    });
    expect(decideBootQueueAction(st, running, [ev("phase-12-complete", 1500, 12)])).toEqual({
      kind: "resume",
      phaseId: 13,
      taskId: "t1",
    });
  });

  it("(b) yalnız pending iş (running orphan yok) → drain (Faz 1'den)", () => {
    const st = mkState({ current_phase: 5, iteration_count: 2, iteration_started_at: 1000, intent_summary: "x" });
    expect(decideBootQueueAction(st, pending, []).kind).toBe("drain");
  });

  it("(c) cp=1 + running orphan → resume DEĞİL (Faz-1 orphan taze koşar) → drain", () => {
    const st = mkState({ current_phase: 1, iteration_count: 2, iteration_started_at: 1000, intent_summary: "x" });
    expect(decideBootQueueAction(st, running, []).kind).toBe("drain");
  });

  it("(d) önceki-iter phase-17-complete VAR ama iterasyon-kapsamlı mid-Faz-13 → yine resume (wasPipelineCompleted tuzağı)", () => {
    const st = mkState({ current_phase: 13, iteration_count: 3, iteration_started_at: 2000, intent_summary: "x" });
    const audit = [
      ev("phase-17-complete", 100, 17), // ÖNCEKİ iterasyon — scope (2000) öncesi → yok sayılmalı
      ev("iteration-3-start", 2000, 1),
      ev("phase-12-complete", 2500, 12),
    ];
    expect(decideBootQueueAction(st, running, audit)).toEqual({ kind: "resume", phaseId: 13, taskId: "t1" });
  });

  it("(e) pending_diagnostic (standDown) → resume DEĞİL → drain", () => {
    const st = mkState({
      current_phase: 8,
      iteration_count: 2,
      iteration_started_at: 1000,
      intent_summary: "x",
      pending_diagnostic: D2,
    });
    expect(decideBootQueueAction(st, running, []).kind).toBe("drain");
  });

  it("(f) running orphan + mid-faz ama intent BOŞ → resume DEĞİL → drain", () => {
    const st = mkState({ current_phase: 8, iteration_count: 2, iteration_started_at: 1000, intent_summary: "  " });
    expect(decideBootQueueAction(st, running, []).kind).toBe("drain");
  });

  it("(g) hiç iş yok (boş / hepsi done) → none", () => {
    expect(decideBootQueueAction(mkState({ current_phase: 5 }), [], []).kind).toBe("none");
    expect(decideBootQueueAction(mkState({ current_phase: 5 }), [{ id: "d", status: "done" }], []).kind).toBe("none");
  });

  it("(h) mekanik faz gerçekten TAMAMLANMIŞ (phase-13-complete scope içinde) → resume DEĞİL → drain", () => {
    const st = mkState({ current_phase: 13, iteration_count: 2, iteration_started_at: 1000, intent_summary: "x" });
    // 13 RESUMABLE_PARKED değil → handled ise truly-done → detektör null → drain
    expect(decideBootQueueAction(st, running, [ev("phase-13-complete", 1500, 13)]).kind).toBe("drain");
  });
});

describe("shouldRunBootStatusCheck", () => {
  it("kuyrukta iş VARSA → false (kuyruk sürücüsü tek narrator; boot-check susar)", () => {
    // mid-pipeline olsa bile kuyruk işi varken boot-check konuşmaz
    expect(shouldRunBootStatusCheck(mkState({ current_phase: 5, iteration_count: 2, intent_summary: "x" }), true)).toBe(
      false,
    );
    // cave5 senaryosu (ekran): yeni iterasyon Faz 1'de + kuyruk işi sürüyor → "Niyet bekleniyor" DEME
    expect(shouldRunBootStatusCheck(mkState({ current_phase: 1, iteration_count: 28 }), true)).toBe(false);
  });

  it("greenfield temiz açılış (cp≤1 + iter=1 + intent yok) → false", () => {
    expect(shouldRunBootStatusCheck(mkState({ current_phase: 1, iteration_count: 1 }), false)).toBe(false);
  });

  it("mid-pipeline (cp 2-16) + kuyruk YOK → true (yarıda kalan işi özetle)", () => {
    expect(shouldRunBootStatusCheck(mkState({ current_phase: 8, iteration_count: 2, intent_summary: "x" }), false)).toBe(
      true,
    );
  });

  it("cp=1 + iter>1 (önceki iterasyon / tdd-red retry) + kuyruk YOK → true", () => {
    expect(shouldRunBootStatusCheck(mkState({ current_phase: 1, iteration_count: 3 }), false)).toBe(true);
  });

  it("pending_ui_tweak set + kuyruk YOK → true", () => {
    expect(
      shouldRunBootStatusCheck(mkState({ current_phase: 1, iteration_count: 2, pending_ui_tweak: "tweak" }), false),
    ).toBe(true);
  });

  it("dev_server_pid set (tamamlanmış, server açık) + kuyruk YOK → true", () => {
    expect(
      shouldRunBootStatusCheck(
        mkState({ current_phase: 17, iteration_count: 2, intent_summary: "x", dev_server_pid: 123 }),
        false,
      ),
    ).toBe(true);
  });

  it("tamamlanmış (cp=17) + tweak/dev-server yok + kuyruk YOK → false (bekleyen bir şey yok)", () => {
    expect(
      shouldRunBootStatusCheck(mkState({ current_phase: 17, iteration_count: 2, intent_summary: "x" }), false),
    ).toBe(false);
  });

  it("REGRESYON: kuyruk YOK iken guard no-op — düzeltme öncesi davranışla birebir", () => {
    // hasPendingQueueWork=false → yeni !hasPendingQueueWork guard'ı davranışı DEĞİŞTİRMEMELİ
    expect(shouldRunBootStatusCheck(mkState({ current_phase: 5, iteration_count: 2, intent_summary: "x" }), false)).toBe(
      true,
    );
  });
});
