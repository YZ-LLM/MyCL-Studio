// escalation — adaptif model+efor MERDİVENİ (Ümit 2026-06-11: "bütün ajanlar en düşük model+efordan başlasın;
// sorun çıktıkça adım adım yükselt; efor bitince model yükselt + o modelin low'undan başla").
//
// Amaç: HIZ + maliyet — kolay iş ucuz/hızlı modelde biter; zor iş gerektiği kadar tırmanır (gerektiğinde opus'a
// ulaşır → kalite garanti). "Config kral": merdiven TIER'ları (cheap→balanced→strong) tırmanır; her tier'ın gerçek
// MODELİ kullanıcının config.model_tiers'ından çözülür (selectModelForTask ile). Translator HARİÇ (o sabit).
//
// Saf + deterministik (test edilebilir). Tier→model çözümü + tırmanma kararı dışarıda (escalation-state, wiring).

import { modelForTier, type ModelTier } from "./model-catalog.js";
import type { State } from "./types.js";
import type { MyclConfig } from "./config.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Rung {
  /** cheap | balanced | strong — gerçek model config.model_tiers'tan çözülür (config kral). */
  tier: ModelTier;
  effort: Effort;
}

// Efor seviyeleri per tier (Anthropic kuralı): xhigh + max YALNIZ strong/opus. cheap/balanced: low→medium→high.
// (Sonnet/Haiku'da max/xhigh 400 verir; bu yüzden onlara koymuyoruz.)
const EFFORTS_BY_TIER: Record<ModelTier, Effort[]> = {
  cheap: ["low", "medium", "high"],
  balanced: ["low", "medium", "high"],
  strong: ["low", "medium", "high", "xhigh", "max"],
};

// En ucuz/hızlıdan en güçlüye tier sırası.
const TIER_ORDER: readonly ModelTier[] = ["cheap", "balanced", "strong"];

/** Tüm merdiven, en alttan (cheap@low) en üste (strong@max). */
export function buildLadder(): Rung[] {
  const rungs: Rung[] = [];
  for (const tier of TIER_ORDER) {
    for (const effort of EFFORTS_BY_TIER[tier]) {
      rungs.push({ tier, effort });
    }
  }
  return rungs;
}

/** İlk (en düşük) basamak — her iş buradan başlar. */
export function firstRung(): Rung {
  return { tier: "cheap", effort: "low" };
}

const sameRung = (a: Rung, b: Rung): boolean => a.tier === b.tier && a.effort === b.effort;

/**
 * Bir sonraki basamak (sorun çıktı → yükselt). Önce AYNI tier'da efor yükselir; efor bitince SONRAKİ tier'ın
 * low'una atlar. En üstteyse (strong@max) null — artık yükseltilemez (caller normal fail/çözüm akışına düşer).
 */
export function nextRung(cur: Rung): Rung | null {
  const ladder = buildLadder();
  const i = ladder.findIndex((r) => sameRung(r, cur));
  if (i < 0 || i + 1 >= ladder.length) return null;
  return ladder[i + 1];
}

/** İnsan-okur etiket (chat/rapor için): "haiku · low" gibi tier+efor. Model adı çözümü caller'da. */
export function rungLabel(r: Rung): string {
  return `${r.tier} · ${r.effort}`;
}

/**
 * Bir basamağı gerçek model+efora çöz. tier→model config'ten (config kral), efor rung'tan. Escalation aktifken
 * fazlar bunu KULLANIR (selectModelForTask/selectEffortForTask yerine) → tüm işler merdivenden çözülür.
 */
export function resolveRung(
  rung: Rung,
  tierModels?: Partial<Record<ModelTier, string>>,
): { modelId: string; modelLabel: string; effort: Effort; tier: ModelTier } {
  const m = modelForTier(rung.tier, tierModels);
  return { modelId: m.id, modelLabel: m.label, effort: rung.effort, tier: rung.tier };
}

/** Bir domain'in o anki basamağı (per-domain harita; yoksa firstRung=cheap·low). Monotonik — yalnız climb yükseltir. */
export function rungForDomain(state: State, domain: string): Rung {
  return state.escalation_rungs?.[domain] ?? firstRung();
}

/**
 * Bir fazın (domain'in) model+eforu — PER-DOMAIN merdivenden çözülür (Ümit 2026-06-11). Her iş kendi alanının
 * öğrenilmiş basamağından başlar (intent cheap kalır, codegen tırmanır); config KRAL: tier→model config'ten.
 * Model seçimi tamamen merdivene devredildi (ayarlardaki picker'lar kilitli). Tek çoke point — fazlar bunu çağırır.
 */
export function escalatedModelEffort(
  state: State,
  config: MyclConfig,
  domain: string,
): { modelId: string; modelLabel: string; effort: string } {
  const r = resolveRung(rungForDomain(state, domain), config.selected_models.model_tiers);
  return { modelId: r.modelId, modelLabel: r.modelLabel, effort: r.effort };
}

/** Geçerli bir Rung mu (state.json'dan okurken doğrulama). */
export function isRung(v: unknown): v is Rung {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    (r.tier === "cheap" || r.tier === "balanced" || r.tier === "strong") &&
    typeof r.effort === "string" &&
    (EFFORTS_BY_TIER[r.tier as ModelTier] as string[]).includes(r.effort)
  );
}
