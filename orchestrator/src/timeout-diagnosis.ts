// timeout-diagnosis — gate-komutu TIMEOUT/asılma için "atlama YOK → gerçek çözüm → çok-açılı orkestra → dürüst dur"
// karar çekirdeği + çok-açılı fan-out sarmalayıcı. YZLLM 2026-07-09 ("MyCL HİÇBİR SORUNU ATLAMASIN; en doğru çözümü
// bulsun; bulamazsa ORKESTRA AJANI farklı açılardan çözümler geliştirsin — o anki İŞE ve PROJEYE uygun"). failPhase'in
// timeout dalı (index.ts) bunu okur; run-loop side-effect'inden AYRI → SAF çekirdek test edilebilir (decideAutoAnswer deseni).

import type { MyclConfig } from "./config.js";
import { backendForRole } from "./config.js";
import { runHypothesisInvestigations } from "./hypothesis-investigation.js";
import { runHypothesisFanout } from "./design-fanout.js";
import { log } from "./logger.js";

/** Bir faz için timeout-divert azami deneme (sonsuz-döngü emniyeti). Aşılınca dürüst görünür-dur (escalate — atlama DEĞİL). */
export const TIMEOUT_DIVERT_MAX = 2;

export type TimeoutDivertDecision = "divert" | "stop" | "escalate";

/**
 * SAF karar: gate-timeout'ta ne yap? "hiçbir sorunu atlama" ilkesi (YZLLM).
 *   stop     = mevcut env-STOP (PARİTE): saf-timeout DEĞİL (gerçek errno/port) VEYA mod KAPALI → kullanıcı elle inceler.
 *   divert   = gerçek-çözüm + çok-açılı orkestra akışına düş (mod açık + saf-asılma + deneme hakkı var).
 *   escalate = deneme hakkı tükendi → dürüst görünür-dur/kuyruk (escalateUnanalyzableError; ATLAMA/sahte-yeşil DEĞİL).
 * index.ts geçirir: isTimeoutHangOnly(envReason) + (autoAnswerSuggested()||isNeverAsk()) + timeoutRetried sayacı.
 */
export function decideTimeoutDivert(s: {
  isTimeoutHangOnly: boolean;
  modeOn: boolean;
  divertCount: number;
}): TimeoutDivertDecision {
  if (!s.isTimeoutHangOnly || !s.modeOn) return "stop"; // PARİTE: gerçek env / manuel / genel-env → mevcut STOP (byte-aynı)
  if (s.divertCount >= TIMEOUT_DIVERT_MAX) return "escalate"; // tükendi → dürüst görünür-dur (atlama/sahte-yeşil DEĞİL)
  return "divert";
}

/**
 * Çok-açılı orkestra: bir timeout/asılma kök-nedenini FARKLI MERCEKLERDEN (state-data / async-timing / integration-
 * contract) araştır — fokus metni işe/projeye özel (çağıran enjekte eder). Backend'e göre gerçek-inceleme (CLI, Bash'li:
 * runHypothesisInvestigations) veya akıl-yürütme (API: runHypothesisFanout) seç (Faz 0 deseni, phase-0.ts:392). Etiketli
 * `[mercek] hipotez` dizisi döner → çağıran errCtx'e katar (analiz + Faz 0 çok-açılı köklere göre çalışır). Hata/boş → []
 * (fail-soft — çağıran mevcut derin-çözüm gövdesiyle devam eder). Görünür (withAgentRun/emitAgentEvent — Ajan Takımı popup'ı).
 */
export async function runTimeoutMultiAngle(
  config: MyclConfig,
  projectRoot: string,
  bugReport: string,
  evidence: string,
): Promise<string[]> {
  try {
    const useInvestigation = backendForRole(config, "main") === "cli";
    return useInvestigation
      ? await runHypothesisInvestigations(config, projectRoot, bugReport, evidence)
      : await runHypothesisFanout(config, projectRoot, bugReport, evidence);
  } catch (e) {
    log.warn("timeout-diagnosis", "çok-açılı orkestra hata (yutuldu → derin-çözüm devam)", { error: String(e) });
    return [];
  }
}
