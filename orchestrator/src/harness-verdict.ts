// harness-verdict — headless e2e harness'in audit.log'dan ürettiği DÜRÜST hüküm (SAF).
//
// Kritik: mekanik gate'ler (Faz 10-17) SOFT — başarısız olsa bile orchestrator
// `phase-N-complete` (detail:"soft_complete_after_fail") yazıp devam eder; üst bar
// "TAMAMLANDI" der. Bu modül o gerçeği yüzeye çıkarır: gate patladıysa hüküm PASS değil
// PARTIAL'dır. Saf → test edilebilir; harness.mjs bunu audit event'leriyle çağırır.

import type { AuditEvent } from "./types.js";

export type Verdict = "PASS" | "PARTIAL" | "FAIL";

export interface GateFailure {
  phase: number;
  event: string;
  detail?: string;
}

export interface HarnessVerdict {
  verdict: Verdict;
  /** phase-17-complete (veya -20) görüldü mü — pipeline sonuna ulaştı mı. */
  completed: boolean;
  /** Başarısız gate'ler (faz başına bir kayıt). */
  gateFailures: GateFailure[];
  /** Süreç çıkış kodu: 0=PASS, 2=PARTIAL, 1=FAIL. */
  exitCode: 0 | 1 | 2;
  summary: string;
}

const COMPLETE_EVENTS = new Set(["phase-17-complete", "phase-20-complete"]);

/**
 * SAF: audit event'lerinden hüküm. completed + gate-fail yok → PASS; completed ama
 * en az bir gate-fail → PARTIAL (sessiz "tamamlandı" değil); completed değil → FAIL.
 * Gate-fail sinyali: `*-fail` event'i VEYA `soft_complete_after_fail` detaylı complete.
 * skipped (örn. scope/missing-command) başarısızlık SAYILMAZ.
 */
export function computeVerdict(events: AuditEvent[]): HarnessVerdict {
  const completed = events.some((e) => COMPLETE_EVENTS.has(e.event));

  const failByPhase = new Map<number, GateFailure>();
  for (const e of events) {
    const isFail =
      e.event.endsWith("-fail") ||
      (e.event.endsWith("-complete") && e.detail === "soft_complete_after_fail");
    if (!isFail) continue;
    const prev = failByPhase.get(e.phase);
    // Faz başına tek kayıt; açıklayıcı `-fail` event'ini soft-complete'e tercih et.
    if (!prev || (e.event.endsWith("-fail") && !prev.event.endsWith("-fail"))) {
      failByPhase.set(e.phase, { phase: e.phase, event: e.event, detail: e.detail });
    }
  }
  const gateFailures = [...failByPhase.values()].sort((a, b) => a.phase - b.phase);

  let verdict: Verdict;
  let exitCode: 0 | 1 | 2;
  if (!completed) {
    verdict = "FAIL";
    exitCode = 1;
  } else if (gateFailures.length > 0) {
    verdict = "PARTIAL";
    exitCode = 2;
  } else {
    verdict = "PASS";
    exitCode = 0;
  }

  const summary =
    verdict === "PASS"
      ? "Pipeline tamamlandı; tüm gate'ler yeşil."
      : verdict === "PARTIAL"
        ? `Pipeline tamamlandı AMA ${gateFailures.length} gate başarısız: ${gateFailures
            .map((g) => `Faz ${g.phase}`)
            .join(", ")}.`
        : "Pipeline TAMAMLANMADI (phase-17-complete yok / hard hata).";

  return { verdict, completed, gateFailures, exitCode, summary };
}
