// finding-queue — teker-teker gate-bulgu kuyruğu (YZLLM 2026-07-03: "3 sorunu ayrı ayrı sor").
//
// SAF karar mantığı (answer-memory.ts / security-convergence.ts deseni: index.ts run-loop'undan AYRI,
// boot side-effect'siz test edilebilir). Bir gate-fail birden çok DISTINCT finding bulursa (SQL-injection +
// test parolaları + 3.taraf takvim = 3), her biri SIRAYLA sorulur: sor → çöz → sonraki; kuyruk bitince gate
// BİR kez yeniden koşulur (final doğrulama). Gate'in yeniden-koşması pipeline'ın faza geri yürümesidir;
// intercept (index.ts, next===13 girişi) awaitingRerun'da tam-gate yerine bir sonraki finding'i açar.

import type { PhaseId } from "./types.js";
import type { ErrorFinding } from "./error-analysis.js";

export interface FindingQueue {
  /** Bulguların ait olduğu faz (şu an yalnız 13/Güvenlik — blocking gate). */
  phase: PhaseId;
  /** GÜVENLİK (mahkeme): kuyruğu ait olduğu projeye bağla — intercept yalnız AYNI projede ateşler
   *  (bayat/çapraz-proje kuyruğun gerçek güvenlik gate'ini sessizce bypass etmesi önlenir; KATI #4). */
  project_root: string;
  /** triage'ın bulduğu TÜM distinct finding'ler (sırayla sorulacak). */
  findings: ErrorFinding[];
  /** Şu an sorulan finding'in 0-tabanlı indeksi. */
  index: number;
  /** Per-finding imza tabanı (failSignature) — answer-memory/karar-hafızası izolasyonu için. */
  sig_base: string;
  /** "Kabul et, devam et" seçilirse phase-N-complete yazılacak faz (kuyruk boşalınca). */
  acceptContinuePhase?: number;
  /** true → mevcut finding'in fix'i dispatch edildi + gate'e geri yürüyor; intercept sonraki finding'e ilerletir. */
  awaitingRerun: boolean;
  /** En az bir finding GERÇEKTEN fix'lendi mi (yalnız-kabul kuyruğunda gate'i tekrar koşmaya gerek yok). */
  anyFixed: boolean;
  /** Bu triage TURUNDA güvenlik bulguları AZALIYOR mu (security-convergence). Entegre "ajan eminse otomatik düzelt"
   *  opt-in'inde döngü koruması: yakınsamıyorsa (false) kuyruğun HİÇBİR bulgusu foreign'de otomatik uygulanmaz →
   *  kullanıcıya sorulur. TÜM bulgulara tutarlı (yalnız finding[0]'a değil — mahkeme blocker fix 2026-07-09). */
  converging: boolean;
}

/**
 * SAF: bir kuyruk-finding'i OTOMATİK uygula(ma) kararı. Faz 13 (güvenlik) entegre opt-in: oto-cevap toggle AÇIK VE bu
 * tur YAKINSIYOR (converging) → otomatik. Yakınsamıyorsa (döngü/riski-kabul koruması) → false → kullanıcıya sorulur.
 * Diğer faz/kuyruklar: normal oto-cevap (kategori-bastırmalı autoAnswerSuggested). Test edilebilir; run-loop'tan ayrı.
 */
export function findingQueueAutoApply(
  queue: Pick<FindingQueue, "phase" | "converging">,
  s: { autoAnswerEnabled: boolean; autoAnswerSuggested: boolean },
): boolean {
  if (queue.phase === 13) {
    // NON-FOREIGN: normal oto-cevap (autoAnswerSuggested = bastırma yoksa _enabled) — converging'siz, ESKİ davranışla
    // BİREBİR (finding[0]'ın autoResolve=auto||converging mantığıyla tutarlı; mahkeme minor: race'siz tam parite).
    // FOREIGN opt-in: autoAnswerSuggested false (bastırma) → yalnız _enabled && YAKINSIYOR (döngü/riski-kabul koruması).
    return s.autoAnswerSuggested || (s.autoAnswerEnabled && queue.converging);
  }
  return s.autoAnswerSuggested;
}

/**
 * Bir finding'in KARARLI anahtarı (per-finding answer-memory/loop-guard imzası için). code_ref.file:line
 * tercih edilir (re-triage'ta kararlı); yoksa summary_tr normalize (rakam→#); yoksa index (son çare).
 */
export function findingKey(f: ErrorFinding, i: number): string {
  if (f.code_ref && f.code_ref.file) {
    return `${f.code_ref.file}:${f.code_ref.startLine}`;
  }
  const norm = (f.summary_tr || "")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return norm !== "" ? norm : `#${i}`;
}

/** Per-finding hata imzası — sig_base + finding anahtarı (SQL-injection cevabı ≠ test-parola cevabı). */
export function perFindingSig(sigBase: string, key: string): string {
  return `${sigBase}#${key}`;
}

/**
 * SAF: kuyruk bir sonraki finding'e ilerletilirse ne olur — index+1 geçerliyse "asked" (sonraki finding var),
 * değilse "exhausted" (kuyruk bitti). MEVCUT index'e göre değerlendirir; çağıran index'i ayrıca artırır.
 */
export function advanceDecision(queue: FindingQueue): "asked" | "exhausted" {
  return queue.index + 1 < queue.findings.length ? "asked" : "exhausted";
}
