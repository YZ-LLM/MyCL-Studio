// open-status — proje açılışında "📍 Durum + Yapman gereken" özeti (YZLLM 2026-07-19: "mycl son
// mesajında ne durumda olduğunu ve yapmam gerekeni kısaca yazsın her zaman").
//
// DETERMİNİSTİK (LLM'siz, token'sız, kırılgan değil): açılış rutini yerleşince state + kuyruk + EDD
// anlık görüntüsünden TEK bakışlık durum + kullanıcının yapması gereken eylem üretir. Eski LLM tabanlı
// boot-narrator kuyrukta iş varken susuyordu → "her zaman" garantisi yoktu; bu onu değiştirir.

/** Faz kısa TR adları (README tablosuyla birebir; spec bağımsız — özet için yeter). */
const PHASE_TR: Record<number, string> = {
  0: "Hata Ayıklama",
  1: "Niyet Toplama",
  2: "Hassasiyet Denetimi",
  3: "Mühendislik Brifingi",
  4: "Spec Yazımı",
  5: "UI Yapımı",
  6: "UI İncelemesi",
  7: "Veritabanı Tasarımı",
  8: "BDD + TDD Uygulama",
  9: "Risk İncelemesi",
  10: "Lint",
  11: "Sadeleştirme",
  12: "Performans",
  13: "Güvenlik",
  14: "Birim Testler",
  15: "Entegrasyon Testleri",
  16: "E2E Testler",
  17: "Sızma Testi",
};

export interface OpenStatusInput {
  currentPhase: number;
  /** intent_summary boş mu (Faz 1'de yeni iş bekleniyor mu). */
  intentEmpty: boolean;
  /** Yabancı/entegre proje mi. */
  isForeign: boolean;
  /** Debug çözüm seçimi askq'si açık mı. */
  pendingDiagnostic: boolean;
  /** Faz 6 UI incelemesi parkı aktif mi. */
  pendingUiReview: boolean;
  /** Şu an koşan/başlamak üzere olan kuyruk işinin metni (yoksa null). */
  runningTaskText: string | null;
  /** Kuyrukta bekleyen (koşmayan) iş sayısı. */
  pendingTaskCount: number;
  /** EDD (yabancı proje analizi) — analiz edilen / toplam birim; pending>0 ise analiz sürüyor. */
  eddDone: number;
  eddTotal: number;
  eddPending: number;
}

export interface OpenStatus {
  durum: string;
  action: string;
}

function phaseName(p: number): string {
  return PHASE_TR[p] ?? `Faz ${p}`;
}

/** SAF: açılış anlık görüntüsünden durum + kullanıcı-eylemi üret. Öncelik: en spesifik/bekleyen durum önce. */
export function composeOpenStatus(i: OpenStatusInput): OpenStatus {
  if (i.pendingDiagnostic) {
    return {
      durum: "Bir hata için çözüm seçimi bekliyor.",
      action: "Chat'te açılan soruyu yanıtla; ardından düzeltmeye geçerim.",
    };
  }
  if (i.pendingUiReview) {
    return {
      durum: `UI incelemesi bekliyor (Faz 6, ${phaseName(6)}).`,
      action: "Açılan uygulamayı incele; beğendiysen onayla, beğenmediysen değişikliği yaz.",
    };
  }
  // Mid-pipeline (2..16): faz otomatik kaldığı yerden sürer — kullanıcının bir şey yapmasına gerek yok.
  if (i.currentPhase >= 2 && i.currentPhase <= 16) {
    return {
      durum: `Faz ${i.currentPhase} (${phaseName(i.currentPhase)}) kaldığı yerden otomatik sürüyor.`,
      action: "Bir şey yapmana gerek yok — otomatik ilerliyor. Yeni bir hedef için yazman yeterli.",
    };
  }
  if (i.runningTaskText) {
    const t = i.runningTaskText.trim().slice(0, 80);
    return {
      durum: `Önceki iş kaldığı yerden sürüyor: "${t}".`,
      action: "Bitmesini bekleyebilirsin; yeni bir hedef için yazman yeterli.",
    };
  }
  if (i.pendingTaskCount > 0) {
    return {
      durum: `İş kuyruğunda ${i.pendingTaskCount} iş bekliyor.`,
      action: "Sıradaki iş birazdan otomatik başlar; yeni hedef eklemek için yazabilirsin.",
    };
  }
  if (i.isForeign && i.eddPending > 0) {
    return {
      durum: `Proje analizi (EDD) arka planda sürüyor: ${i.eddDone}/${i.eddTotal} birim.`,
      action: "Analiz bitince projeyi tam kavrarım; şimdiden yeni bir hedef yazabilirsin.",
    };
  }
  if (i.currentPhase === 1 && i.intentEmpty) {
    return {
      durum: i.isForeign
        ? "Proje analizi tamam; yeni bir iş bekliyorum."
        : "Yeni bir iş bekliyorum.",
      action: "Ne yapmak istediğini yaz — hedefi verince başlarım.",
    };
  }
  return {
    durum: "Hazırım, bekleyen bir işim yok.",
    action: "Ne yapmak istediğini yaz.",
  };
}

/** SAF: özet mesaj metni (chat'e basılacak). */
export function formatOpenStatus(s: OpenStatus): string {
  return `📍 **Durum:** ${s.durum}\n**Yapman gereken:** ${s.action}`;
}
