// İkili Soru Bankası — ternary motor (saf mantık, Dilim 1).
//
// İki saf çevrim:
//   1. classifyExit: bir check komutunun exit kodunu PASS/FAIL/INCONCLUSIVE'e
//      çevirir. Yanıt-yolunda LLM yok — kararı KOD verir.
//   2. aggregateGate: soru hükümlerini tek bir gate kararına toplar. Yalnız
//      blocking FAIL → halt_defect; blocking INCONCLUSIVE → halt_infra (defect
//      değil, ayrı hat); advisory bulgular durdurmaz, rapora girer.
//
// "INCONCLUSIVE" hiçbir zaman "PASS"e çökmez — araç eksik/crash/timeout durumu
// sessizce yeşile çevrilmez (sahte-yeşil panzehiri, katı kural #4 sessiz-fallback-yok).

import type {
  CheckOutcome,
  CoverageReport,
  GateDecision,
  GateResult,
  QuestionVerdict,
} from "./types.js";

/**
 * Daima INCONCLUSIVE sayılan exit kodları — gerçek "bulgu" değil, "checkin
 * kendisi değerlendirilemedi". 126 not-executable, 127 not-found (araç yok),
 * 124 GNU timeout, 137 SIGKILL, 143 SIGTERM (hung/kill). Bunlar bir invariant
 * ihlali DEĞİL; insana infra-fault olarak gider, asla yeşile çevrilmez.
 */
const ALWAYS_INCONCLUSIVE: ReadonlySet<number> = new Set([124, 126, 127, 137, 143]);

/**
 * Bir check komutunun exit kodunu üç-değerli sonuca çevir.
 *   exit 0                         → PASS
 *   ALWAYS_INCONCLUSIVE | spec'te  → INCONCLUSIVE
 *   diğer her şey                  → FAIL (gerçek invariant ihlali)
 */
export function classifyExit(
  exitCode: number,
  inconclusiveCodes: readonly number[] = [],
): CheckOutcome {
  if (exitCode === 0) return "PASS";
  if (ALWAYS_INCONCLUSIVE.has(exitCode) || inconclusiveCodes.includes(exitCode)) {
    return "INCONCLUSIVE";
  }
  return "FAIL";
}

/**
 * Soru hükümlerini tek gate kararına topla. Karar önceliği:
 *   blocking FAIL varsa            → halt_defect
 *   yoksa blocking INCONCLUSIVE    → halt_infra
 *   ikisi de yoksa                 → green
 * Advisory (non-blocking) FAIL/INCONCLUSIVE kararı ETKİLEMEZ — yalnız
 * advisory_findings raporuna girer (trivial "Hayır" pipeline'ı tıkamasın,
 * insan blanket-onaya alışmasın diye).
 */
export function aggregateGate(verdicts: readonly QuestionVerdict[]): GateResult {
  const blocking_fail: QuestionVerdict[] = [];
  const blocking_inconclusive: QuestionVerdict[] = [];
  const advisory_findings: QuestionVerdict[] = [];
  let pass = 0;
  let fail = 0;
  let inconclusive = 0;
  let na = 0;

  for (const v of verdicts) {
    switch (v.outcome) {
      case "PASS":
        pass++;
        break;
      case "NA":
        na++;
        break;
      case "FAIL":
        fail++;
        if (v.blocking_class === "blocking") blocking_fail.push(v);
        else advisory_findings.push(v);
        break;
      case "INCONCLUSIVE":
        inconclusive++;
        if (v.blocking_class === "blocking") blocking_inconclusive.push(v);
        else advisory_findings.push(v);
        break;
    }
  }

  const total = pass + fail + inconclusive + na;
  const coverage: CoverageReport = {
    pass,
    fail,
    inconclusive,
    na,
    total,
    fraction: total > 0 ? pass / total : 0,
  };

  const decision: GateDecision =
    blocking_fail.length > 0
      ? "halt_defect"
      : blocking_inconclusive.length > 0
        ? "halt_infra"
        : "green";

  return { decision, blocking_fail, blocking_inconclusive, advisory_findings, coverage };
}

/**
 * Sonuç → insan-yüzlü etiket. Soru ikili kalır (PASS=Evet/FAIL=Hayır) ama motor
 * ikiliye çökmez: INCONCLUSIVE ve NA ayrı etiketler — "Hayır" sanılmamalı.
 * Kullanıcının diliyle (TR) emit edilir.
 */
export function outcomeLabel(outcome: CheckOutcome): string {
  switch (outcome) {
    case "PASS":
      return "Evet";
    case "FAIL":
      return "Hayır";
    case "INCONCLUSIVE":
      return "Değerlendirilemedi";
    case "NA":
      return "Kapsam dışı";
  }
}
