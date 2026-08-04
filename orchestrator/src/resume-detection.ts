// resume-detection — SAF: boot-resume faz tespiti (audit + state → karar).
//
// index.ts'ten ayrıştırıldı (index.ts `void main()` ile boot tetiklediğinden
// test edilemiyordu). Burada IO yok → orchestrator vitest'te test edilebilir.

import type { AuditEvent, PhaseId, State } from "./types.js";

/**
 * Faz 2-17 yarıda mı kaldı? state.current_phase 2-17 + bu iterasyonda
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
 * SAF: açılışta "pipeline ortasında mı?" kararı — açılış tetikleyicilerinin (ilk açılış dökümantasyonu,
 * kılavuz bayatlık kontrolü, EDD devamı) kapısı.
 *
 * KÖK NEDEN (YZLLM 2026-08-04, cave kopyası): eski hesap `current_phase > 1` idi — bu, YARIDA kalmış
 * pipeline ile TAMAMLANMIŞ pipeline'ı ayırt etmiyordu. Faz 17'si bitmiş, kuyruğu boş bir proje her
 * açılışta "ortada" sayılıyor ve açılış tetikleyicileri atlanıyordu → "kılavuz her zaman güncel" sözü
 * tamamlanmış her entegre projede ÖLÜYDÜ (cave: docs/ hiç üretilmemiş, damga yok, dökümantasyon bayat).
 *
 * Bitmiş pipeline tanımı: son fazda (17) VE yarıda kalmış faz yok (`detectInterruptedPhase2To9Pure`
 * null — yani Faz 17 bu iterasyonda complete/skipped ile ele alınmış). Eski koruma amaçları korunur:
 * kuyrukta iş varken / faz yarıdayken / kullanıcı seçimi beklenirken ağır açılış işleri yine başlamaz.
 */
export function computeMidPipeline(input: {
  currentPhase: number | undefined;
  /** detectInterruptedPhase2To9Pure sonucu — null ise yarıda kalmış faz yok. */
  interruptedPhase: { phaseId: PhaseId } | null;
  hasPendingQueueWork: boolean;
  pendingUiTweak: boolean;
  pendingDiagnostic: boolean;
}): boolean {
  const cp = input.currentPhase ?? 1;
  const finished = cp === 17 && input.interruptedPhase === null;
  return (
    (cp > 1 && !finished) ||
    input.hasPendingQueueWork ||
    input.interruptedPhase !== null ||
    input.pendingUiTweak ||
    input.pendingDiagnostic
  );
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

/**
 * SAF: proje açılışında boot-check narrator'ı (runBootStatusCheck) çalışmalı mı?
 *
 * runBootStatusCheck, yarıda kalan iş varsa kullanıcıya TEK cümle durum özeti yazar. AMA iş-kuyruğu tek
 * sürücüdür ve emitInitialTaskQueue kuyruk-işini zaten anlatır ("İş başlıyor / 🔄 Yeni iterasyon / 📍 kaldığım
 * yerden devam"). Boot-check kuyruk-işini bilmediğinden, kuyruk sürerken `current_phase=1 + intent boş →
 * "Niyet bekleniyor — ne yapmak istersin?"` matris kuralını seçip kullanıcıdan İKİNCİ kez niyet istiyordu
 * (redundant + yanıltıcı: iş metni niyeti zaten belli ediyor). Kuyruk = tek sürücü + tek narrator.
 *
 * YZLLM 2026-07-06 ("iş kuyruğundan işi aldı, ne istediğimiz kabak gibi ortada — MyCL akıllı olmalı").
 *
 * Kurallar: (1) greenfield/temiz açılış (yeni proje, henüz niyet yok) → boot-check YOK. (2) kuyrukta
 * bekleyen/koşan iş VAR → boot-check YOK (kuyruk sürücüsü anlatır). (3) aksi + yarıda/devam eden iş
 * göstergesi (mid-pipeline / bekleyen tweak / canlı dev server) → boot-check koşsun.
 */
export function shouldRunBootStatusCheck(
  state: Pick<
    State,
    "current_phase" | "iteration_count" | "intent_summary" | "pending_ui_tweak" | "dev_server_pid"
  >,
  hasPendingQueueWork: boolean,
): boolean {
  const cp = state.current_phase ?? 0;
  const isCleanStart = cp <= 1 && (state.iteration_count ?? 1) === 1 && !state.intent_summary;
  if (isCleanStart) return false;
  if (hasPendingQueueWork) return false;
  return (cp > 0 && cp < 17) || !!state.pending_ui_tweak || state.dev_server_pid !== undefined;
}
