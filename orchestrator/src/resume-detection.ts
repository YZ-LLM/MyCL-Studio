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
  // Ümit 2026-06-11: "devam için faz tıklatma — neyi çalıştıracağı belli." 2-9 → 2-17: MEKANİK fazlar (10-17,
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
  // Ümit 2026-06-12: bir faz GERÇEKTEN tamamlanınca advanceToNextPhase current_phase'i İLERLETİR (index.ts:
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
