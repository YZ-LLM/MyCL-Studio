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
  // HARİÇ: Faz 6 (deferred UI review — tamamlanmamışsa aşağıda zaten resume edilir) + mekanik gate'ler (10-17,
  // tamamlanırsa truly-done, redo istemez). Kuyruksuz boot-resume katmanı ayrıca pending_diagnostic/
  // pending_ui_tweak'te resume yapmaz — bkz index.ts boot akışı. Kuyrukta yetim iş varken bekleyen rötuşun
  // nasıl sürdürüldüğü: decideBootQueueAction / uiTweakResumePhase.
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
 * kendi özel yolunu işler: Faz 0 debug re-emit `pending_diagnostic`; foreign Faz 6 unpark).
 * decideBootQueueAction bunları dışlar → çift-işlem/çakışma olmaz.
 *
 * BEKLEYEN RÖTUŞ ARTIK BURADA DEĞİL (2026-11-27, ekransız deneme koşusu 7): eskiden üçüncü dal
 * `pending_ui_tweak && current_phase <= 9` idi ve yorum "index.ts açılış bloğu kendi özel yoluyla işler"
 * diyordu. Öyle bir yol YOK: açılış bloğu yalnız kendi devamını bastırıyor, kuyruk ise `drain` ile yetim
 * işi `pending` yapıp Faz 1'den baştan sürüyordu (onaylanmış niyet, brif ve spec yeniden üretildi).
 * Bekleyen rötuş artık kuyruğu durdurmaz; yalnız HANGİ fazdan sürüleceğini belirler (uiTweakResumePhase).
 */
function bootResumeStandDown(
  state: Pick<State, "pending_diagnostic" | "pending_ui_review" | "current_phase" | "origin">,
): boolean {
  if (state.pending_diagnostic) return true;
  if (state.origin === "foreign" && state.pending_ui_review && state.current_phase === 6) return true;
  return false;
}

/**
 * SAF: bekleyen rötuş isteği (`pending_ui_tweak`, Faz ≤ 9) varken açılışta hangi fazdan sürülür?
 * `null` → rötuş bu kararı etkilemiyor (istek yok ya da kapı fazında düzeltme planı; eski davranış).
 *
 *   • Faz 5, ya da spec'i ONAYLI Faz 4 → Faz 5 (rötuş sürdürülür). İsteği koyan iki yol da
 *     (`revise_ui`, Faz 0 arayüz düzeltmesi) `current_phase = 4` yazıp ilerler; Faz 4 orada bir
 *     BAŞLANGIÇ NOKTASIDIR → Faz 4 yeniden koşturulmaz (onaylanmış spec yeniden üretilmez).
 *     Spec onaylı DEĞİLSE Faz 4 gerçekten yarıdadır → kesinti tespitinin verdiği faz, onay atlanmaz.
 *     SINIR: `spec_approved` Faz 4 yeniden koşarken sıfırlanmaz (yalnız yeni iterasyon, düşen iş ve
 *     Faz 2 vazgeçmesinde). Spec dosyası kaybolduğu için Faz 4'e düşülüp onay sorusunda kapanılmışsa
 *     bayrak hâlâ doğrudur ve bu durum başlangıç noktasından ayırt edilemez.
 *   • Faz 6-9 → kesinti tespitinin verdiği faz; istek BAYATTIR ve düşürülür. Akış Faz 5'i geçtiyse o
 *     isteğin Faz 5 koşusu bitmiştir (başarısız rötuşa mahkeme "devam" dedi ya da başarılı rötuş isteği
 *     silmeden ilerledi). Faz 6 parkında (`pending_ui_review`) bu, Faz 6 beklemesine dönmek demektir.
 *   • Faz 2-3 → kesinti tespitinin verdiği faz; istek durur (yalnız eski hatanın ürettiği durum).
 */
function uiTweakResumePhase(
  state: Pick<State, "pending_ui_tweak" | "current_phase" | "spec_approved">,
  interrupted: PhaseId,
): { phaseId: PhaseId; dropUiTweak: boolean } | null {
  const cp = state.current_phase ?? 0;
  if (!state.pending_ui_tweak || cp > 9) return null;
  if (cp >= 6) return { phaseId: interrupted, dropUiTweak: true };
  if (cp === 5 || (cp === 4 && state.spec_approved === true)) {
    return { phaseId: 5 as PhaseId, dropUiTweak: false };
  }
  return { phaseId: interrupted, dropUiTweak: false };
}

export type BootQueueAction =
  | {
      kind: "resume";
      phaseId: PhaseId;
      taskId: string;
      /** true → durumdaki `pending_ui_tweak` bayattır; sürdürmeden ÖNCE silinmeli (çağıran yazar). */
      dropUiTweak?: true;
    }
  | { kind: "drain" }
  | { kind: "none" };

/**
 * SAF: boot'ta iş-kuyruğu ne yapmalı? YARIM iterasyon diskte "running" orphan bırakır. Onu körlemesine
 * "pending"e alıp Faz 1'den koşmak (bugünkü davranış → tekrar sorar) YERİNE: iterasyon MID-FLIGHT ise
 * (running orphan + detectInterruptedPhase2To9Pure phaseId + intent_summary dolu + standDown yok) →
 * KALDIĞI FAZDAN devam et ("resume"). Aksi (yeni pending iş / Faz-1 orphan / standDown) → "drain"
 * (mevcut flip→pending + Faz 1'den koşma). Hiç iş yoksa "none".
 * Bekleyen rötuş isteği (Faz ≤ 9) "resume"u ENGELLEMEZ; yalnız fazı belirler ve bayatsa `dropUiTweak`
 * ile düşürülmesini ister (bkz. uiTweakResumePhase).
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
    | "spec_approved"
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
  // FAZ 6 PARKI kesinti tespitinden BAĞIMSIZ sürdürülür: `pending_ui_review` "inceleme bekleniyor"un
  // kendi işaretidir. Aynı iterasyonda daha önce onaylanmış bir Faz 6 varsa (onaydan sonra arayüz
  // düzeltmesi Faz 5'e dönüp Faz 6'yı yeniden park ettiyse) bayat `phase-6-complete` tespiti `null`
  // yapar; eskiden bu `drain` demekti → park etmiş iş Faz 1'den baştan başlardı.
  const parkedAtUiReview = state.pending_ui_review === true && state.current_phase === 6;
  const rd =
    detectInterruptedPhase2To9Pure(state, audit) ?? (parkedAtUiReview ? { phaseId: 6 as PhaseId } : null);
  if (
    orphan &&
    rd &&
    typeof state.intent_summary === "string" &&
    state.intent_summary.trim() !== "" &&
    !bootResumeStandDown(state)
  ) {
    const tweak = uiTweakResumePhase(state, rd.phaseId);
    if (tweak) {
      return {
        kind: "resume",
        phaseId: tweak.phaseId,
        taskId: orphan.id,
        ...(tweak.dropUiTweak ? { dropUiTweak: true as const } : {}),
      };
    }
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
