// docs-freshness — kullanım kılavuzu bayat mı? (SAF karar + damga hesabı)
//
// KÖK NEDEN (2026-08-03): kullanıcının şartı "KULLANIM KILAVUZU HER ZAMAN GÜNCEL". Ama tazeleme yalnız
// pipeline sonunda tetikleniyordu; üç manuel düğme (Full Test, Bakım Turu, Güvenlik Taraması) ve proje
// açılışı kılavuzu HİÇ tazelemiyordu. Bakım turu bağımlılıkları güncelleyip kodu değiştirse bile kılavuz
// eski kalıyordu. Ayrıca "bayat mı?" sorusunu soran hiçbir mekanizma yoktu — ne kaynak karşılaştırması,
// ne zaman damgası, ne de üretilen dosyaların yerinde durup durmadığı kontrolü.
//
// Tasarım: damga (`.mycl/docs-stamp.json`) kılavuz üretildiği ANIN parmak izini tutar; her tetikte şimdiki
// durumla kıyaslanır. KUŞKUDA BAYAT SAY (fail-open) — yanlış "taze" demek sessiz bir yalandır; gereksiz
// tazeleme yalnız biraz maliyettir.

/** Damga şeması sürümü — çıktı formatı değişince kılavuz ZORLA yenilenir. */
export const DOCS_SCHEMA_VERSION = 1;

export interface DocsStamp {
  schema: number;
  ts: number;
  /** git HEAD (varsa) — ucuz karşılaştırma yolu. */
  head?: string;
  /** Damga anında çalışma ağacı kirli miydi. */
  dirty?: boolean;
  /** Kaynak dosyaların birleşik özeti (git yoksa / kirliyken kullanılır). */
  source_digest: string;
  /** Özete giren birim sayısı (tavan aşımı tespiti). */
  unit_count: number;
  /** Üretilen her kılavuz dosyasının içerik özeti — elle silinme/bozulma yakalanır. */
  outputs: Record<string, string>;
}

export type StaleReason =
  | "no_stamp"
  | "schema_changed"
  | "head_moved"
  | "tree_dirty"
  | "source_changed"
  | "output_missing"
  | "output_modified"
  | "too_many_units"
  | "none";

export interface FreshnessInput {
  stamp: DocsStamp | null;
  current: {
    head?: string;
    dirty?: boolean;
    source_digest: string;
    unit_count: number;
    /** Beklenen çıktı yolu → şimdiki içerik özeti (null = dosya yok). */
    outputs: Record<string, string | null>;
  };
  schema: number;
  /** Bu sayının üstünde birim varsa özet güvenilmez → her zaman bayat say. */
  maxUnits: number;
}

/** SAF: kılavuz bayat mı? */
export function decideDocsStale(inp: FreshnessInput): { stale: boolean; reason: StaleReason; detail: string } {
  if (!inp.stamp) return { stale: true, reason: "no_stamp", detail: "kılavuz damgası yok (hiç üretilmemiş)" };
  if (inp.stamp.schema !== inp.schema) {
    return { stale: true, reason: "schema_changed", detail: `çıktı formatı değişti (${inp.stamp.schema} → ${inp.schema})` };
  }
  if (inp.current.unit_count > inp.maxUnits) {
    // Özet güvenilmez → YANLIŞ "taze" deme (sessiz yalan yerine biraz fazladan maliyet).
    return { stale: true, reason: "too_many_units", detail: `proje çok büyük (${inp.current.unit_count} dosya) — özet güvenilmez` };
  }
  // Üretilen dosyalar yerinde ve dokunulmamış mı? (elle silme/bozma → yeniden üret)
  for (const [path, hash] of Object.entries(inp.current.outputs)) {
    if (hash === null) return { stale: true, reason: "output_missing", detail: `kılavuz dosyası yok: ${path}` };
    const expected = inp.stamp.outputs[path];
    if (expected && expected !== hash) {
      return { stale: true, reason: "output_modified", detail: `kılavuz dosyası dışarıdan değişmiş: ${path}` };
    }
    if (!expected) {
      return { stale: true, reason: "output_missing", detail: `damgada olmayan kılavuz dosyası: ${path}` };
    }
  }
  // git yolu (ucuz): HEAD aynı + ağaç temizse kaynak değişmemiştir.
  if (inp.stamp.head && inp.current.head) {
    if (inp.stamp.head !== inp.current.head) {
      return { stale: true, reason: "head_moved", detail: "yeni commit var" };
    }
    if (inp.current.dirty) {
      // Kirli ağaç: commit'lenmemiş değişiklik var → özete bak.
      if (inp.current.source_digest !== inp.stamp.source_digest) {
        return { stale: true, reason: "source_changed", detail: "kaydedilmemiş kaynak değişikliği var" };
      }
      return { stale: false, reason: "none", detail: "kaynak değişmedi (kirli ama aynı)" };
    }
    return { stale: false, reason: "none", detail: "aynı commit, temiz ağaç" };
  }
  // git yok → yalnız kaynak özeti.
  if (inp.current.source_digest !== inp.stamp.source_digest) {
    return { stale: true, reason: "source_changed", detail: "kaynak dosyalar değişmiş" };
  }
  return { stale: false, reason: "none", detail: "kaynak özeti aynı" };
}

/** SAF: birim listesinden birleşik kaynak özeti (sıralı → deterministik). */
export function buildSourceDigest(
  units: ReadonlyArray<{ path: string; hash?: string | null; skipped?: boolean }>,
): { digest: string; count: number; unhashed: string[] } {
  const unhashed: string[] = [];
  const parts: string[] = [];
  for (const u of [...units].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (u.skipped || !u.hash) {
      unhashed.push(u.path);
      // Özetlenemeyen dosya da özete GİRER (yol + işaret) — yoksa "değişmedi" yanılgısı olur.
      parts.push(`${u.path}:?`);
      continue;
    }
    parts.push(`${u.path}:${u.hash}`);
  }
  return { digest: shortHash(parts.join("\n")), count: units.length, unhashed };
}

/** SAF: kısa deterministik özet (FNV-1a 64 bit, onaltılık). Kriptografik değil — değişim tespiti için. */
export function shortHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 16);
}
