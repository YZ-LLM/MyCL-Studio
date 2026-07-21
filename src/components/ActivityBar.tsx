// ActivityBar — "Şu an ne yapıyor" kalıcı durum şeridi (YZLLM 2026-07-20: "her zaman ne yaptığını
// yazan bi alan olsun"). Kullanıcı Faz 13 taraması sürerken ekranda ne olduğunu anlamıyordu: mevcut
// running-banner yalnız koşarken + KAYAN sohbetin içinde görünüyordu. Bu şerit HEP görünür (header'ın
// altında sabit), her an MyCL'in canlı aktivitesini gösterir. Yeni backend olayı GEREKMEZ — mevcut
// state'i (runningBanner label/detail + faz + askq) kalıcı bir yerde yüzeye çıkarır.

export type ActivityTone = "running" | "waiting" | "idle";

export interface ActivityInput {
  phase: number;
  /** Faz TR adı (phasesList'ten); yoksa boş. */
  phaseName: string;
  phaseStatus: string;
  /** runningBanner.label — koşarken "ne yaptığı" (backend zaten açıklayıcı yazar: 🛡️/🔍/📚…). null → koşmuyor. */
  runningLabel: string | null;
  /** runningBanner.detail — alt-aktivite / "Ns sürüyor · …" (heartbeat). */
  runningDetail: string | null;
  /** Kullanıcıdan cevap bekleyen açık soru var mı. */
  hasAskq: boolean;
}

export interface Activity {
  icon: string;
  text: string;
  tone: ActivityTone;
}

/** SAF: state anlık görüntüsünden tek satırlık canlı aktivite. Öncelik: bekleme > koşuyor > boşta. */
export function composeActivity(i: ActivityInput): Activity {
  const p =
    i.phase === 0
      ? "Hata Ayıklama"
      : `Faz ${i.phase}${i.phaseName ? ` · ${i.phaseName}` : ""}`;
  if (i.hasAskq || i.phaseStatus === "waiting") {
    return { icon: "⏸️", tone: "waiting", text: `${p} — senden cevap bekliyorum` };
  }
  if (i.runningLabel) {
    const d = i.runningDetail ? ` · ${i.runningDetail}` : "";
    // Label zaten faz bağlamını içeriyorsa (phaseLabelTR "Faz N: …") çift yazma; yoksa faz-prefiksle
    // (ör. "UI kodu yazılıyor" → "Faz 5 · UI Yapımı — UI kodu yazılıyor").
    const labelHasPhase = /^\s*Faz\s/i.test(i.runningLabel);
    const text = labelHasPhase ? `${i.runningLabel}${d}` : `${p} — ${i.runningLabel}${d}`;
    return { icon: "⚙️", tone: "running", text };
  }
  // MAHKEME MEDIUM (2026-07-21): mid-pipeline faz (Faz 0 + 2..16) phaseStatus="running" ama banner henüz
  // gelmemişse (askq cevabı işleniyor / banner'lar arası kısa pencere) YANLIŞ "boşta" DEME → nötr "çalışıyor".
  // Faz 1 istisna: orası niyet bekleme fazı; banner yoksa gerçekten kullanıcıyı bekliyordur → "boşta" doğru.
  if (i.phaseStatus === "running" && i.phase !== 1) {
    return { icon: "⚙️", tone: "running", text: `${p} — çalışıyor…` };
  }
  return { icon: "💤", tone: "idle", text: `${p} — boşta, yeni iş bekliyorum` };
}

export function ActivityBar(props: ActivityInput) {
  const a = composeActivity(props);
  return (
    <div
      className={`activity-bar activity-${a.tone}`}
      data-testid="activity-bar"
      // aria-live="off": şerit sık güncellenir (60s heartbeat) → ekran okuyucuya spam yapmasın; sohbetteki
      // running-banner zaten role="status" ile duyuruyor. Buradaki aria-label bağlam sağlar.
      aria-live="off"
      aria-label="MyCL şu an ne yapıyor"
    >
      <span className={`activity-dot${a.tone === "running" ? " spin" : ""}`} aria-hidden>
        {a.icon}
      </span>
      <span className="activity-prefix" aria-hidden>
        Şu an:
      </span>
      <span className="activity-text">{a.text}</span>
    </div>
  );
}
