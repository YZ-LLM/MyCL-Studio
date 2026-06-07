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
  /**
   * Atlanan GÜVENLİK taramaları (örn. csp-evaluator-skipped, semgrep-skipped,
   * phase-13-skipped). Boş değilse: tool eksikti → "tarandı" denemez → false-green
   * koruması (PASS yerine PARTIAL).
   */
  securitySkipped: string[];
  /** Süreç çıkış kodu: 0=PASS, 2=PARTIAL, 1=FAIL. */
  exitCode: 0 | 1 | 2;
  summary: string;
}

const COMPLETE_EVENTS = new Set(["phase-17-complete", "phase-20-complete"]);

/**
 * Güvenlik-baseline Unit 2 (false-green koruması): bir güvenlik tarayıcısı atlandıysa
 * (tool eksik / komut yok) sonuç "yeşil" sayılamaz — taranmadı. Lint/test skip'i
 * (faz 10/14...) güvenlik değil; yalnız güvenlik scan'lerini yakala (regex'siz, sade).
 */
function isSecuritySkip(e: AuditEvent): boolean {
  if (!e.event.endsWith("-skipped")) return false;
  // KÖK FİX (kod-analiz 2026-06-07): Faz 13 = güvenlik fazı → oradaki HER `-skipped` bir güvenlik
  // tarayıcısının atlanmasıdır (csp-evaluator, semgrep*, security-headers, data-sanitization,
  // web-security, gitleaks, phase-13-skipped...). Eskiden SABİT isim-listesi (csp/secret-scan/
  // semgrep) security-headers/data-sanitization/web-security'yi KAÇIRIYOR + "secret-scan" hiçbir
  // gerçek event'le eşleşmiyordu → güvenlik fazı atlansa bile PASS verilebiliyordu (false-green).
  // Phase'e bağlamak (mechanical-runner skip'leri phase=opts.phaseId yazar) drift-proof.
  return e.phase === 13;
}

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

  // false-green koruması: atlanan güvenlik taramaları (dedup).
  const securitySkipped = [
    ...new Set(events.filter((e) => isSecuritySkip(e)).map((e) => e.event)),
  ];

  let verdict: Verdict;
  let exitCode: 0 | 1 | 2;
  let summary: string;
  if (!completed) {
    verdict = "FAIL";
    exitCode = 1;
    summary = "Pipeline TAMAMLANMADI (phase-17-complete yok / hard hata).";
  } else if (gateFailures.length > 0) {
    verdict = "PARTIAL";
    exitCode = 2;
    summary = `Pipeline tamamlandı AMA ${gateFailures.length} gate başarısız: ${gateFailures
      .map((g) => `Faz ${g.phase}`)
      .join(", ")}.`;
  } else if (securitySkipped.length > 0) {
    // Gate'ler patlamadı AMA en az bir güvenlik tarayıcısı atlandı (tool eksik) →
    // "tarandı" denemez → çıplak PASS değil PARTIAL (mükemmel/dürüst hedefi).
    verdict = "PARTIAL";
    exitCode = 2;
    summary = `Pipeline tamamlandı ve gate'ler patlamadı AMA güvenlik taraması atlandı (${securitySkipped.join(
      ", ",
    )}) — "tam tarandı" sayılmaz.`;
  } else {
    verdict = "PASS";
    exitCode = 0;
    summary = "Pipeline tamamlandı; tüm gate'ler yeşil.";
  }

  return { verdict, completed, gateFailures, securitySkipped, exitCode, summary };
}
