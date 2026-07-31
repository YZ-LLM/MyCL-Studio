// resume-decision — kesinti sonrası "baştan mı, kaldığı yerden mi?" kararı (SAF, test edilebilir).
//
// KÖK NEDEN (canlı cave kanıtı 2026-07-30): sağlayıcı kesintisinde pipeline duruyor, ama orphan
// uzlaştırması (reconcileAndDrainTasks) iterasyon durumunu KOŞULSUZ sıfırlıyordu
// (current_phase:1, intent_summary/spec_approved/needed_phases silinir). Erişim dönünce iş Faz 1'den
// yeniden başlıyor: niyet, brifing ve spec baştan üretiliyor. cave'de bu 23 kez oldu; Faz 1-4 toplam
// maliyetin ~%35'ini yedi ve hiçbir iş ilerlemedi.
//
// Ayrım net: TERMİNAL HATA (iş gerçekten çuvalladı) → durumu temizle, sonraki iş sıfırdan başlasın
// (bayat niyet/spec sonraki işe SIZMASIN — bu davranış 2026-07-03 mahkemesinde bilerek konuldu).
// KESİNTİ (sağlayıcı kapalı, bekliyoruz) → hiçbir şey çuvallamadı, yalnız duraklandı → durumu KORU.

/** Kesintide durum korunmalı mı? preserve=true ise çağıran state'i SIFIRLAMAZ ve resume bilgisini yazar. */
export function shouldPreserveIterationState(p: {
  /** llm-outage bekleme aktif mi (sağlayıcıya erişim yok, otomatik devam kurulu). */
  outageWaiting: boolean;
  /** İşin kesildiği faz. */
  currentPhase: number;
  /** Niyet üretilmiş mi (yoksa korunacak anlamlı ilerleme yok). */
  hasIntent: boolean;
  /** İterasyon başlangıç damgası — resume'da eşleşme anahtarı. */
  iterationStartedAt?: number;
}): { preserve: boolean; resumePhase?: number; resumeIterTs?: number; why: string } {
  if (!p.outageWaiting) {
    return { preserve: false, why: "kesinti yok — terminal hata: bayat durum sonraki işe sızmasın" };
  }
  if (!p.hasIntent || p.currentPhase <= 1) {
    return { preserve: false, why: "korunacak ilerleme yok (niyet üretilmemiş ya da Faz 1)" };
  }
  if (!p.iterationStartedAt) {
    return { preserve: false, why: "iterasyon damgası yok — resume doğrulanamaz, baştan güvenli" };
  }
  return {
    preserve: true,
    resumePhase: p.currentPhase,
    resumeIterTs: p.iterationStartedAt,
    why: `sağlayıcı kesintisi — Faz ${p.currentPhase} ilerlemesi korunuyor`,
  };
}

/** Bir kuyruk işi nasıl başlatılmalı. */
export type IterationStart =
  /** Bugünkü varsayılan: Faz 1'den yeni iterasyon. */
  | { kind: "fresh" }
  /** Güvenlik/pentest sistem işi: niyet bulgudan türetildiği için Faz 3'ten (mevcut davranış). */
  | { kind: "seeded"; startPhase: number }
  /** Kesintiden dönüş: kaldığı fazdan devam (niyet/spec korunmuş). */
  | { kind: "resume"; startPhase: number; note?: string };

/**
 * SAF: iş hangi modda başlatılmalı?
 *
 * resume YALNIZ çift anahtar tutarsa: (1) işte resume_phase var, (2) resume_iter_ts state'in AKTİF
 * iterasyon damgasıyla birebir aynı, (3) niyet hâlâ duruyor. Aksi halde bayat resume bilgisiyle yanlış
 * fazdan başlamaktansa baştan başlanır — ve bu GÖRÜNÜR not olarak söylenir (sessiz fallback yok).
 */
export function decideIterationStart(p: {
  task: { source?: string; from_phase?: number; resume_phase?: number; resume_iter_ts?: number };
  stateIterationStartedAt?: number;
  stateHasIntent: boolean;
}): IterationStart {
  const t = p.task;
  if (t.resume_phase !== undefined && t.resume_phase > 1) {
    const tsMatch = t.resume_iter_ts !== undefined && t.resume_iter_ts === p.stateIterationStartedAt;
    if (tsMatch && p.stateHasIntent) return { kind: "resume", startPhase: t.resume_phase };
    return {
      kind: "fresh",
      // Not: çağıran bunu kullanıcıya söyler — "kaldığı yerden sürdürülemedi" sessiz kalmasın.
    };
  }
  // MEVCUT DAVRANIŞ (değişmedi): güvenlik sistem işi bulgudan türetilen niyetle Faz 3'ten başlar.
  if (t.source === "security" && t.from_phase !== undefined && t.from_phase > 1) {
    return { kind: "seeded", startPhase: t.from_phase };
  }
  return { kind: "fresh" };
}

/** SAF: resume denendi ama tutmadı mı (kullanıcıya görünür not gerekir)? */
export function resumeWasStale(p: {
  task: { resume_phase?: number; resume_iter_ts?: number };
  stateIterationStartedAt?: number;
  stateHasIntent: boolean;
}): boolean {
  if (p.task.resume_phase === undefined || p.task.resume_phase <= 1) return false;
  const tsMatch =
    p.task.resume_iter_ts !== undefined && p.task.resume_iter_ts === p.stateIterationStartedAt;
  return !(tsMatch && p.stateHasIntent);
}
