// resume-decision — kesinti sonrası "baştan mı, kaldığı yerden mi?" (SAF).
//
// Canlı cave kanıtı (2026-07-30): sağlayıcı kesintisinde orphan uzlaştırması iterasyon durumunu
// KOŞULSUZ sıfırlıyordu → iş Faz 1'den yeniden başlıyor, niyet/brifing/spec baştan üretiliyordu.
// 23 kez oldu; Faz 1-4 toplam maliyetin ~%35'ini yedi ve hiçbir iş ilerlemedi.

import { describe, expect, it } from "vitest";
import {
  shouldPreserveIterationState,
  decideIterationStart,
  resumeWasStale,
} from "../src/resume-decision.js";

describe("shouldPreserveIterationState", () => {
  const base = { currentPhase: 8, hasIntent: true, iterationStartedAt: 1000 };

  it("KESİNTİ YOK (terminal hata) → durum sıfırlanır: BUGÜNKÜ davranış birebir korunur", () => {
    const r = shouldPreserveIterationState({ ...base, outageWaiting: false });
    expect(r.preserve).toBe(false);
    // Gerekçe: bayat niyet/spec sonraki işe sızmamalı (2026-07-03 mahkeme kararı).
    expect(r.why).toContain("terminal");
  });

  it("kesinti VAR + iterasyon ilerlemiş → durum KORUNUR, kaldığı faz kaydedilir", () => {
    const r = shouldPreserveIterationState({ ...base, outageWaiting: true });
    expect(r).toMatchObject({ preserve: true, resumePhase: 8, resumeIterTs: 1000 });
  });

  it("kesinti var ama niyet yok / Faz 1 → korunacak ilerleme yok, baştan", () => {
    expect(shouldPreserveIterationState({ ...base, outageWaiting: true, hasIntent: false }).preserve).toBe(false);
    expect(shouldPreserveIterationState({ ...base, outageWaiting: true, currentPhase: 1 }).preserve).toBe(false);
  });

  it("iterasyon damgası yoksa resume doğrulanamaz → baştan (bayat resume riski yok)", () => {
    const r = shouldPreserveIterationState({ ...base, outageWaiting: true, iterationStartedAt: undefined });
    expect(r.preserve).toBe(false);
  });
});

describe("decideIterationStart", () => {
  it("resume bilgisi + damga eşleşmesi + niyet → kaldığı fazdan devam", () => {
    const s = decideIterationStart({
      task: { resume_phase: 9, resume_iter_ts: 500 },
      stateIterationStartedAt: 500,
      stateHasIntent: true,
    });
    expect(s).toEqual({ kind: "resume", startPhase: 9 });
  });

  it("damga UYUŞMUYOR (arada başka iterasyon olmuş) → baştan (yanlış fazdan başlamaktansa)", () => {
    const s = decideIterationStart({
      task: { resume_phase: 9, resume_iter_ts: 500 },
      stateIterationStartedAt: 777,
      stateHasIntent: true,
    });
    expect(s).toEqual({ kind: "fresh" });
    expect(resumeWasStale({ task: { resume_phase: 9, resume_iter_ts: 500 }, stateIterationStartedAt: 777, stateHasIntent: true })).toBe(true);
  });

  it("niyet bu arada silinmişse → baştan", () => {
    const s = decideIterationStart({
      task: { resume_phase: 9, resume_iter_ts: 500 },
      stateIterationStartedAt: 500,
      stateHasIntent: false,
    });
    expect(s).toEqual({ kind: "fresh" });
  });

  it("MEVCUT DAVRANIŞ korunur: güvenlik işi from_phase'ten başlar (seeded)", () => {
    const s = decideIterationStart({
      task: { source: "security", from_phase: 3 },
      stateIterationStartedAt: 1,
      stateHasIntent: false,
    });
    expect(s).toEqual({ kind: "seeded", startPhase: 3 });
  });

  it("REGRESYON KİLİDİ: full-test/bakım işlerinin from_phase'i onları KAYDIRMAZ (yalnız security)", () => {
    for (const source of ["full-test", "maintenance", "verify-gap", "manual", "auto"]) {
      const s = decideIterationStart({
        task: { source, from_phase: 3 },
        stateIterationStartedAt: 1,
        stateHasIntent: true,
      });
      expect(s).toEqual({ kind: "fresh" });
    }
  });

  it("resume bilgisi olmayan iş → bugünkü davranış (fresh)", () => {
    expect(decideIterationStart({ task: {}, stateHasIntent: true, stateIterationStartedAt: 1 })).toEqual({
      kind: "fresh",
    });
    // resume_phase=1 anlamsız (zaten baş) → fresh
    expect(
      decideIterationStart({ task: { resume_phase: 1, resume_iter_ts: 1 }, stateHasIntent: true, stateIterationStartedAt: 1 }),
    ).toEqual({ kind: "fresh" });
  });

  it("resumeWasStale: resume bilgisi olmayan işte YANLIŞ uyarı vermez", () => {
    expect(resumeWasStale({ task: {}, stateIterationStartedAt: 1, stateHasIntent: true })).toBe(false);
    expect(
      resumeWasStale({ task: { resume_phase: 9, resume_iter_ts: 500 }, stateIterationStartedAt: 500, stateHasIntent: true }),
    ).toBe(false);
  });
});
