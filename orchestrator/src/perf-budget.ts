// perf-budget — performans kapısının SAF karar çekirdeği (eşik/temel karşılaştırması).
//
// KÖK NEDEN (2026-08-03): Faz 12 gerçek ölçüm yapmıyordu. MyCL'in KENDİ şablonu codegen'e
// `"perf": "npm run build"` yazmayı zorunlu tutuyordu → kapı yalnız build'i tekrar çalıştırıyordu
// ("build geçti = performans tamam" varsayımı). Üstelik 19 stack'in 13'ünde `perf` komutu hiç yoktu.
// Kullanıcının ürün amacı açıkça "performanslı" olduğu için bu, ölçmeden geçen bir kapıydı.
//
// YANLIŞ ALARM YASAĞI (kullanıcının en sert kuralı — "gate false-positive'i ASLA varsayma"):
//  1. İlk koşu ASLA düşmez → temel (baseline) kaydedilir.
//  2. Düşme yalnız (a) mutlak dip eşiği ya da (b) temele göre GENİŞ gerileme.
//  3. İhlal görülürse çağıran ikinci ölçüm yapar → medyan (tek seferlik dalgalanma düşürmez).
//  4. Geliştirme ve üretim ölçümlerinin temelleri AYRI (dev sunucu ile üretim build'i kıyaslanmaz).
//  5. `report_only` modu tek satırla açılır (hiç düşürmez, yalnız raporlar).

export type PerfMode = "regression" | "absolute" | "report_only";

export interface PerfMeasurement {
  /** Sayfa performans skoru 0-100 (Lighthouse). Ölçülemediyse undefined. */
  score?: number;
  /** Toplam paket boyutu (bayt). Ölçülemediyse undefined. */
  bundleBytes?: number;
  /** Ölçüm ortamı — temeller ayrı tutulur. */
  env: "dev" | "prod";
}

export interface PerfBaseline {
  score?: number;
  bundleBytes?: number;
}

export interface PerfBudget {
  schema: 1;
  mode: PerfMode;
  /** Altına düşerse tartışmasız kötü (temel olmasa bile düşer). */
  hard_floor_score: number;
  /** Temele göre kaç puan düşüş kabul edilemez. */
  regression_points: number;
  /** Paket boyutunda yüzde kaç büyüme kabul edilemez. */
  bundle_regression_pct: number;
  /** Mutlak boyut tavanı (bayt) — null ise yok. */
  bundle_hard_ceiling_bytes: number | null;
  /** Ortam başına temel (ilk koşuda doldurulur). */
  baseline?: Partial<Record<"dev" | "prod", PerfBaseline>>;
}

export const DEFAULT_PERF_BUDGET: PerfBudget = {
  schema: 1,
  mode: "regression",
  hard_floor_score: 25, // 25 altı: tartışmasız kötü (temel gerekmez)
  regression_points: 20, // 20 puandan az düşüş dalgalanma sayılır
  bundle_regression_pct: 25,
  bundle_hard_ceiling_bytes: null,
};

export type PerfOutcome =
  | { kind: "pass"; note: string }
  | { kind: "baseline_recorded"; note: string }
  | { kind: "fail"; reasons: string[] }
  | { kind: "report_only"; note: string };

/** SAF: ölçüm bütçeyi geçiyor mu? */
export function decidePerf(m: PerfMeasurement, b: PerfBudget): PerfOutcome {
  const base = b.baseline?.[m.env];
  const haveAnyMeasurement = m.score !== undefined || m.bundleBytes !== undefined;
  if (!haveAnyMeasurement) {
    // Çağıran bu duruma hiç düşmemeli (ölçülemedi → atlama yolu); yine de sessiz "geçti" DEME.
    return { kind: "fail", reasons: ["hiçbir performans ölçümü alınamadı"] };
  }
  if (b.mode === "report_only") {
    return { kind: "report_only", note: describe(m) };
  }

  const reasons: string[] = [];
  // (a) Mutlak dip — temel olmasa bile geçerli.
  if (m.score !== undefined && m.score < b.hard_floor_score) {
    reasons.push(`sayfa performans skoru ${m.score} — mutlak alt sınır ${b.hard_floor_score}`);
  }
  if (b.bundle_hard_ceiling_bytes !== null && m.bundleBytes !== undefined && m.bundleBytes > b.bundle_hard_ceiling_bytes) {
    reasons.push(
      `paket boyutu ${kb(m.bundleBytes)} — mutlak tavan ${kb(b.bundle_hard_ceiling_bytes)}`,
    );
  }
  // (b) Temele göre geniş gerileme — yalnız temel VARSA.
  if (b.mode === "regression" && base) {
    if (m.score !== undefined && base.score !== undefined && base.score - m.score >= b.regression_points) {
      reasons.push(
        `sayfa performans skoru ${base.score} → ${m.score} (${base.score - m.score} puan düştü, sınır ${b.regression_points})`,
      );
    }
    if (m.bundleBytes !== undefined && base.bundleBytes !== undefined && base.bundleBytes > 0) {
      const pct = ((m.bundleBytes - base.bundleBytes) / base.bundleBytes) * 100;
      if (pct >= b.bundle_regression_pct) {
        reasons.push(
          `paket boyutu ${kb(base.bundleBytes)} → ${kb(m.bundleBytes)} (%${Math.round(pct)} büyüdü, sınır %${b.bundle_regression_pct})`,
        );
      }
    }
  }
  if (reasons.length > 0) return { kind: "fail", reasons };
  if (!base) {
    // İLK KOŞU ASLA DÜŞMEZ: temel kaydedilir, sonraki koşular buna göre kıyaslanır.
    return { kind: "baseline_recorded", note: `${describe(m)} — temel olarak kaydedildi` };
  }
  return { kind: "pass", note: describe(m) };
}

/** SAF: ölçümü temele işle (var olan diğer ortamın temeli korunur). */
export function nextBaseline(m: PerfMeasurement, b: PerfBudget): PerfBudget["baseline"] {
  const prev = b.baseline?.[m.env] ?? {};
  return {
    ...(b.baseline ?? {}),
    [m.env]: {
      score: m.score ?? prev.score,
      bundleBytes: m.bundleBytes ?? prev.bundleBytes,
    },
  };
}

/** SAF: iki ölçümün medyanı (tek seferlik dalgalanma düşürmesin diye ihlalde ikinci ölçüm alınır). */
export function medianMeasurement(a: PerfMeasurement, b: PerfMeasurement): PerfMeasurement {
  const pick = (x?: number, y?: number): number | undefined => {
    if (x === undefined) return y;
    if (y === undefined) return x;
    return (x + y) / 2;
  };
  return {
    env: a.env,
    score: pick(a.score, b.score) === undefined ? undefined : Math.round(pick(a.score, b.score)!),
    bundleBytes: pick(a.bundleBytes, b.bundleBytes),
  };
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

function describe(m: PerfMeasurement): string {
  const parts: string[] = [];
  if (m.score !== undefined) parts.push(`sayfa skoru ${m.score}`);
  if (m.bundleBytes !== undefined) parts.push(`paket ${kb(m.bundleBytes)}`);
  return parts.join(", ") || "ölçüm yok";
}
