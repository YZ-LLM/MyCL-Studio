// resume-detection — SAF: boot-resume faz tespiti (audit + state → karar).
//
// index.ts'ten ayrıştırıldı (index.ts `void main()` ile boot tetiklediğinden
// test edilemiyordu). Burada IO yok → orchestrator vitest'te test edilebilir.

import type { AuditEvent, PhaseId, State } from "./types.js";

/**
 * Faz 2-9 yarıda mı kaldı? state.current_phase 2-9 + bu iterasyonda
 * `phase-N-complete` YOK → resume sinyali (phaseId döner).
 *
 * scopeStartTs (bu iterasyona ait event sınırı) STATE-ÖNCELİKLİ: audit tail'i
 * (son N) uzun iterasyonda `iteration-N-start`'ı kaçırırsa, audit.find undefined
 * döner ve scopeStartTs 0'a düşerdi → ÖNCEKİ iterasyonun phase-complete'i "bu
 * iterasyon tamamlandı" sanılır → resume yanlışlıkla atlanır (deferred Faz 6
 * takılı kalır). state.iteration_started_at bu bağımlılığı kırar; audit fallback
 * yalnızca alan henüz set edilmemiş eski state'ler için.
 */
export function detectInterruptedPhase2To9Pure(
  state: Pick<
    State,
    "current_phase" | "iteration_count" | "iteration_started_at"
  >,
  audit: AuditEvent[],
): { phaseId: PhaseId } | null {
  const cp = state.current_phase;
  // YZLLM 2026-06-11: "devam için faz tıklatma — neyi çalıştıracağı belli." 2-9 → 2-17: MEKANİK fazlar (10-17,
  // örn. Faz 13 Güvenlik) yarıda kalınca da boot'ta OTOMATİK devam (tıklat-prompt'una düşmesin).
  if (cp < 2 || cp > 17) return null;
  const iterCount = state.iteration_count ?? 1;
  let scopeStartTs = 0;
  if (iterCount > 1) {
    scopeStartTs =
      state.iteration_started_at ??
      audit.find((e) => e.event === `iteration-${iterCount}-start`)?.ts ??
      0;
  }
  // complete VEYA skipped → o faz ele alındı (skip kasıtlı, yeniden koşma). Yoksa yarıda kalmış → resume.
  const handled = audit.some(
    (e) => e.ts > scopeStartTs && (e.event === `phase-${cp}-complete` || e.event === `phase-${cp}-skipped`),
  );
  // YZLLM 2026-06-12: bir faz GERÇEKTEN tamamlanınca advanceToNextPhase current_phase'i İLERLETİR (index.ts:
  // `current_phase = next`). Demek ki current_phase HÂLÂ N ise faz PARK ETMİŞ/yeniden-açılmış demektir — gerçekten
  // bitseydi N'de durmazdık. Park nedenleri: onay fazı (2/3/4/7) verify-up geri-dönüşüyle yeni onay açtı; ya da
  // codegen/risk fazı (5/8/9) güvenlik-fix/verify-up ile YENİDEN girildi ama bitmeden oturum koptu (BAYAT
  // phase-N-complete önceki koşudan kalır). Her iki halde de bayat complete'e rağmen RESUME et — "soldan faza tıkla"
  // DEMESİN ("nerede kaldıysak orayı aç"). Re-run bitince loop ilerler → döngü yok.
  // HARİÇ: Faz 6 (deferred UI review — boot'ta pending_ui_tweak ile ayrı ele alınır) + mekanik gate'ler (10-17,
  // tamamlanırsa truly-done, redo istemez). Boot-resume katmanı ayrıca pending_diagnostic/pending_ui_tweak'te
  // resume yapmaz (kullanıcı seçimi bekleniyor) — bkz index.ts boot akışı.
  const RESUMABLE_PARKED = new Set<number>([2, 3, 4, 5, 7, 8, 9]);
  if (handled && !RESUMABLE_PARKED.has(cp)) return null;
  return { phaseId: cp as PhaseId };
}

/**
 * boot-resume bloğunun ÖZEL-DÖNÜŞ bayrakları — bu durumlarda kuyruk-resume DEVREYE GİRMEZ (index.ts boot bloğu
 * kendi özel yolunu işler: Faz 0 debug re-emit `pending_diagnostic`; deferred UI tweak Faz≤9; foreign Faz 6 unpark).
 * decideBootQueueAction bunları dışlar → çift-işlem/çakışma olmaz.
 */
function bootResumeStandDown(
  state: Pick<
    State,
    "pending_diagnostic" | "pending_ui_tweak" | "pending_ui_review" | "current_phase" | "origin"
  >,
): boolean {
  if (state.pending_diagnostic) return true;
  if (state.pending_ui_tweak && (state.current_phase ?? 0) <= 9) return true;
  if (state.origin === "foreign" && state.pending_ui_review && state.current_phase === 6) return true;
  return false;
}

export type BootQueueAction =
  | { kind: "resume"; phaseId: PhaseId; taskId: string }
  | { kind: "drain" }
  | { kind: "none" };

/**
 * SAF: boot'ta iş-kuyruğu ne yapmalı? YARIM iterasyon diskte "running" orphan bırakır. Onu körlemesine
 * "pending"e alıp Faz 1'den koşmak (bugünkü davranış → tekrar sorar) YERİNE: iterasyon MID-FLIGHT ise
 * (running orphan + detectInterruptedPhase2To9Pure phaseId + intent_summary dolu + standDown yok) →
 * KALDIĞI FAZDAN devam et ("resume"). Aksi (yeni pending iş / Faz-1 orphan / standDown) → "drain"
 * (mevcut flip→pending + Faz 1'den koşma). Hiç iş yoksa "none".
 *
 * YZLLM 2026-07-03: kullanıcı "yarım iterasyonu kapat-aç'ta kaldığı yerden devam et" istedi; kök —
 * current_phase doğru persist ediliyordu ama kuyruk-sürücü current_phase'e bakmadan Faz 1'den koşuyordu.
 */
export function decideBootQueueAction(
  state: Pick<
    State,
    | "current_phase"
    | "iteration_count"
    | "iteration_started_at"
    | "intent_summary"
    | "pending_diagnostic"
    | "pending_ui_tweak"
    | "pending_ui_review"
    | "origin"
  >,
  tasks: { id: string; status?: string }[],
  audit: AuditEvent[],
): BootQueueAction {
  const hasWork = tasks.some((t) => {
    const s = t.status ?? "pending";
    return s === "pending" || s === "running";
  });
  if (!hasWork) return { kind: "none" };
  const orphan = tasks.find((t) => (t.status ?? "pending") === "running");
  const rd = detectInterruptedPhase2To9Pure(state, audit);
  if (
    orphan &&
    rd &&
    typeof state.intent_summary === "string" &&
    state.intent_summary.trim() !== "" &&
    !bootResumeStandDown(state)
  ) {
    return { kind: "resume", phaseId: rd.phaseId, taskId: orphan.id };
  }
  return { kind: "drain" };
}
