// revert-decision — "geri al mı, düzeltmeyi tut mu?" kararı MyCL'de (YZLLM 2026-07-16 yol haritası:
// "geri almak mı daha hatasız çalışır yoksa yeni düzeltme mi? bunun kararını da MyCL verse daha güçlü
// bir programım olur").
//
// Eski davranış: Faz 8 fix modunda kapı düşünce değişiklikler KOŞULSUZ geri alınıyordu — test takımı
// YEŞİLKEN yalnız yöntem/borç kapısı düştüyse bile kazanılmış düzeltme siliniyor, döngü sıfırdan
// başlıyordu. Karar DETERMİNİSTİK ve kanıta dayalıdır (LLM yok; "LLM önerir, KOD karar verir"
// deseninin daha sıkısı): kanıt yoksa ya da regresyon varsa GERİ AL (güvenli varsayılan; bilinen temiz
// durum belirsiz durumdan iyidir); suite yeşilse ya da tüm kırıklar düzeltmeden önce de kırıksa TUT.
//
// "Tut" birikimi güvenlidir: yalnız baseline'a göre TEMİZ (yeşil / regresyonsuz) durumlar tutulur —
// 2026-06-12'deki "başarısız fix artıkları birikip baseline'ı şişirdi (20→21→24)" sınıfı burada
// yapısal olarak imkânsızdır (kırık durum hiç tutulmaz).

export interface RevertEvidence {
  /** Fix ÖNCESİ suite temeli yeşil miydi (phase-8 baseline) — null: temel kurulamadı. */
  baselineGreen: boolean | null;
  /**
   * SON final-suite (anchor) koşusunun kanıtı — null: anchor hiç koşmadı (erken fail / spawn faultu)
   * → kanıt yok → geri al.
   */
  anchor: {
    /** Suite mutlak yeşil VEYA kırıkların HEPSİ düzeltmeden önce de kırıktı (regresyon yok). */
    cleanVsBaseline: boolean;
    /** Düzeltmenin YENİ kırdığı testler (önce geçiyordu, şimdi düşüyor). */
    newRegressions: string[];
  } | null;
}

export type RevertAction = "revert" | "keep";

export interface RevertDecision {
  action: RevertAction;
  /** Kullanıcıya gösterilen kanıta dayalı gerekçe (sade Türkçe). */
  reason_tr: string;
}

/**
 * SAF karar: başarısız fix'in değişiklikleri geri mi alınsın, tutulsun mu?
 * Güvenli varsayılan GERİ AL; TUT yalnız pozitif kanıtla (suite temiz).
 */
export function decideRevertOrKeep(e: RevertEvidence): RevertDecision {
  if (!e.anchor) {
    return {
      action: "revert",
      reason_tr:
        "final test kanıtı yok (suite koşmadı ya da ayrıştırılamadı) — bilinen temiz duruma dönmek daha güvenli",
    };
  }
  if (e.anchor.newRegressions.length > 0) {
    const shown = e.anchor.newRegressions.slice(0, 3).join(", ");
    const more = e.anchor.newRegressions.length > 3 ? ` (+${e.anchor.newRegressions.length - 3})` : "";
    return {
      action: "revert",
      reason_tr: `düzeltme daha önce geçen testleri kırdı: ${shown}${more} — regresyonlu değişiklik tutulmaz`,
    };
  }
  if (e.anchor.cleanVsBaseline) {
    return {
      action: "keep",
      reason_tr:
        "test takımı temiz (yeşil ya da tüm kırıklar düzeltmeden önce de vardı) — kapıyı düşüren test değil, başka bir kontrol; kazanılmış düzeltmeyi geri almak daha hatalı olur",
    };
  }
  return {
    action: "revert",
    reason_tr: "test kanıtı ilerleme göstermiyor (suite kırmızı, temele göre temizlik kanıtlanamadı) — temiz duruma dön",
  };
}
