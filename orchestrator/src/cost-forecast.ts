// cost-forecast — tam pipeline (1-17 faz) token+süre öngörüsü.
//
// YZLLM 2026-07-01: eski öngörü `avgTotal × 17` (TokenTimelinePanel) tekdüze ekstrapolasyondu —
// koşan fazların ortalaması (ağır Faz 8/9/15 ile şişer) × 17 → tüm fazlara yayılıp %54 fazla verdi.
// Fazlar ÇOK farklı maliyet profilli (ağır LLM 70-112K; mekanik gate 0-16K). Doğru öngörü:
// HER fazın KENDİ geçmiş maliyetini (medyan — outlier-dayanıklı) topla; hiç koşmamış fazı
// bilinen fazların GENEL medyanıyla doldur (sınıf-medyanı DEĞİL: LLM sınıfı ucuz-pahalı ayırmıyor →
// ağır-ekstrapolasyon regresyonu; genel medyan regresyon-güvenli, kısmi-iterasyonda şişmez).
// Güvenilirlik (kaç faz gerçek veriye dayanıyor) GÖRÜNÜR (uydurma kesinlik yok).

import type { CostRecord } from "./types.js";

export interface PipelinePrediction {
  /** Öngörülen toplam token (giriş+çıkış). */
  total_tokens: number;
  /** Öngörülen toplam LLM süresi (ms). */
  total_duration_ms: number;
  /** Kaç faz GERÇEK cost verisine dayandı (kalanı genel-medyan tahmini). */
  known_phases: number;
  /** Öngörüye giren toplam faz sayısı (tam pipeline = 17). */
  pipeline_phases: number;
  /** Yeterli veri var mı (az veride "kaba" işaretlensin — uydurma kesinlik yok). */
  reliable: boolean;
}

/** Medyan (outlier-dayanıklı; ortalama tek ağır koşuyla şişer). Boş → 0. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * SAF: cost geçmişinden tam-pipeline öngörüsü. `pipelinePhaseIds` = öngörüye girecek fazlar (tam build = 1..17;
 * Faz 0 debug hariç). Her faz için o fazın TÜM iterasyonlardaki medyan token+süresi; hiç verisi olmayan faz →
 * bilinen fazların genel medyanı (regresyon-güvenli). Veri yoksa null (panel "yeterli veri yok" gösterir).
 */
export function predictPipelineCost(
  costs: CostRecord[],
  pipelinePhaseIds: number[],
): PipelinePrediction | null {
  if (pipelinePhaseIds.length === 0 || costs.length === 0) return null;
  const ids = new Set(pipelinePhaseIds);

  // Faz bazlı grupla (yalnız pipeline fazları; Faz 0 gibi pipeline-dışı kayıtlar öngörüye girmez).
  const byPhase = new Map<number, { totals: number[]; durs: number[] }>();
  for (const c of costs) {
    if (!ids.has(c.phase)) continue;
    const e = byPhase.get(c.phase) ?? { totals: [], durs: [] };
    e.totals.push(c.input_tokens + c.output_tokens);
    e.durs.push(c.duration_ms ?? 0);
    byPhase.set(c.phase, e);
  }
  if (byPhase.size === 0) return null;

  const phaseTotal = new Map<number, number>();
  const phaseDur = new Map<number, number>();
  for (const [p, e] of byPhase) {
    phaseTotal.set(p, median(e.totals));
    phaseDur.set(p, median(e.durs));
  }
  // Hiç-koşmamış faz için genel medyan (bilinen faz-medyanları üzerinden). Sınıf-medyanı DEĞİL —
  // ağır LLM fazları (codegen/qa) eksik fazlara yayılıp şişirmesin (kısmi-iterasyon regresyon önlemi).
  const overallTotal = median([...phaseTotal.values()]);
  const overallDur = median([...phaseDur.values()]);

  let total = 0;
  let dur = 0;
  let known = 0;
  for (const id of ids) {
    if (phaseTotal.has(id)) {
      total += phaseTotal.get(id)!;
      dur += phaseDur.get(id)!;
      known++;
    } else {
      total += overallTotal;
      dur += overallDur;
    }
  }

  return {
    total_tokens: Math.round(total),
    total_duration_ms: Math.round(dur),
    known_phases: known,
    pipeline_phases: ids.size,
    reliable: known >= 3,
  };
}
