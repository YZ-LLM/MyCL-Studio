// src/i18n.ts — Frontend ince i18n helper.
//
// Kapsam (şu an): UI'nın en görünür modal/başlık etiketleri. Tüm UI string'lerinin
// i18n'e geçişi ayrı bir tur (~30 string).
//
// Yapı: orchestrator/src/i18n.ts ile paralel desen — t(key, locale) dotted-path
// lookup. Backend `assets/i18n/{tr,en}.json` async yükler; frontend için inline
// sabit dict (Vite resource async load gereksiz kompleksite).

export type Locale = "tr" | "en";

const BUNDLES: Record<Locale, Record<string, string>> = {
  tr: {
    "settings.title": "Ayarlar",
    "settings.tab.models": "Modeller",
    "settings.tab.api_keys": "API Keys",
    "settings.tab.features": "Özellikler",
    "settings.tab.about": "Hakkında",
    "settings.close": "Kapat",
    "phases.title": "Aşamalar",
    "phases.refresh": "Yenile",
    "phases.close": "Kapat",
    "phases.filter.all": "Tümü",
    "phases.filter.missing": "Eksik",
    "phases.add_new": "+ Yeni Faz Ekle",
    "phases.add_close": "− Faz Ekleme Formunu Kapat",
  },
  en: {
    "settings.title": "Settings",
    "settings.tab.models": "Models",
    "settings.tab.api_keys": "API Keys",
    "settings.tab.features": "Features",
    "settings.tab.about": "About",
    "settings.close": "Close",
    "phases.title": "Phases",
    "phases.refresh": "Refresh",
    "phases.close": "Close",
    "phases.filter.all": "All",
    "phases.filter.missing": "Missing",
    "phases.add_new": "+ Add New Phase",
    "phases.add_close": "− Close Add Phase Form",
  },
};

/**
 * Resolve a key in the given locale. Throws if key missing — fallback YOK
 * (Ümit kuralı). Bilinmeyen key derleme zamanında bulunmalı.
 */
export function t(key: string, locale: Locale = "tr"): string {
  const bundle = BUNDLES[locale];
  const value = bundle[key];
  if (value === undefined) {
    throw new Error(`[i18n] missing key "${key}" for locale "${locale}"`);
  }
  return value;
}
