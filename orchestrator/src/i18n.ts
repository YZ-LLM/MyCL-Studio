// i18n — UI label resolver. assets/i18n/{tr,en}.json yükler.
//
// Amaç: askq option label'ları, faz adları, sistem mesajları gibi statik
// metinleri her seferinde translator'a göndermek yerine yerel JSON'dan döner.
// Sonuç: askq başına ~3-5 Sonnet çağrısı → ~1 (sadece dynamic question).
//
// Mimari yasak: Claude API'ye giden her şey EN. UI'ya gösterilen TR. Bu modül
// sadece o iki dili sabit dosyalardan okur — translator'a hiç gitmez.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** assets/i18n — phase-registry ile aynı kuralla çözülür (dist'ten iki yukarı). */
const I18N_ROOT = resolve(__dirname, "..", "..", "assets", "i18n");

export type Locale = "tr" | "en";

type Bundle = Record<string, unknown>;

let bundles: Record<Locale, Bundle> | null = null;

/** Startup'ta bir kere çağır — JSON'ları belleğe alır. */
export async function loadI18n(): Promise<void> {
  if (bundles) return;
  const [trRaw, enRaw] = await Promise.all([
    readFile(join(I18N_ROOT, "tr.json"), "utf-8"),
    readFile(join(I18N_ROOT, "en.json"), "utf-8"),
  ]);
  bundles = {
    tr: JSON.parse(trRaw) as Bundle,
    en: JSON.parse(enRaw) as Bundle,
  };
}

function dig(obj: Bundle, parts: string[]): string | undefined {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === "string" ? cur : undefined;
}

/**
 * Resolve a dotted key in the given locale. Falls back to EN if missing in TR;
 * returns `[?key]` sentinel if missing in both — surfaced rather than silent.
 */
export function t(key: string, locale: Locale): string {
  if (!bundles) {
    throw new Error("i18n not loaded — call loadI18n() at startup");
  }
  const parts = key.split(".");
  return dig(bundles[locale], parts) ?? dig(bundles.en, parts) ?? `[?${key}]`;
}

/** {name} placeholder substitution — minimal, no escaping. */
export function tFormat(
  key: string,
  locale: Locale,
  vars: Record<string, string | number>,
): string {
  let out = t(key, locale);
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

/**
 * Map English canonical labels (e.g., ["Approve", "Revise", "Cancel"]) to the
 * locale-specific i18n strings — avoids per-call translator round-trips.
 *
 * Unmapped labels fall back to the input string so dynamic options still work.
 */
export function localizeOptionLabels(
  labels_en: string[],
  locale: Locale,
): string[] {
  return labels_en.map((en) => {
    const key = `askq.options.${en.toLowerCase()}`;
    const looked = t(key, locale);
    return looked.startsWith("[?") ? en : looked;
  });
}
