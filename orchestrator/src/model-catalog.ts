// model-catalog — TÜM Claude modellerinin HATASIZ kataloğu + iş→model alaka listesi.
//
// Ümit: "LLM çağırmadan önce iş için doğru modeli seç. Hatasız liste — yanlış model sistemi bozar. Seçilen model
// chat'te açıkça gösterilsin. Yeni Anthropic modeli çıkınca eklenmeli, güncel tutulmalı."
//
// GÜNCEL TUTMA: Anthropic yeni model çıkardığında SADECE MODEL_CATALOG'a bir satır ekle (tier'ı doğru ver).
// Alaka (TASK_RELEVANCE) task→TIER eşler; tier→model kullanıcının config.model_tiers'ından çözülür → kullanıcı
// tercihine saygı + iş-bazlı zekâ. Hız kaldıracı: basit işe fast, ağır işe strong.

// Tier adları config.model_tiers + WorkTier (config.ts) ile AYNI olmalı: cheap/balanced/strong.
export type ModelTier = "cheap" | "balanced" | "strong";

export interface ModelInfo {
  id: string;
  label: string;
  tier: ModelTier;
  contextTokens: number;
  isOpus: boolean;
  /** Ne için uygun (Türkçe, chat'te gösterilebilir). */
  blurb: string;
}

/** Bilinen Claude modelleri (2026-06-09). Yeni model → buraya ekle. */
export const MODEL_CATALOG: ModelInfo[] = [
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    tier: "strong",
    contextTokens: 1_000_000,
    isOpus: true,
    blurb: "En güçlü — codegen/spec/tasarım/inceleme/debug, karmaşık akıl yürütme",
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    tier: "strong",
    contextTokens: 1_000_000,
    isOpus: true,
    blurb: "Güçlü (önceki Opus)",
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    tier: "strong",
    contextTokens: 1_000_000,
    isOpus: true,
    blurb: "Güçlü (önceki Opus)",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    tier: "balanced",
    contextTokens: 1_000_000,
    isOpus: false,
    blurb: "Dengeli — orkestrasyon/çeviri/niyet/doğrulama; hızlı + yetkin",
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    tier: "cheap",
    contextTokens: 200_000,
    isOpus: false,
    blurb: "En hızlı/ucuz — sınıflandırma + kısa/basit işler",
  },
];

/** id → ModelInfo (hızlı arama). */
export function findModel(id: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/** MyCL'in LLM çağıran iş tipleri. Yeni iş tipi → buraya + TASK_RELEVANCE'a ekle. */
export type TaskKind =
  | "classification"
  | "translation"
  | "orchestration"
  | "intent"
  | "design"
  | "spec"
  | "codegen"
  | "review"
  | "debug"
  | "verification";

/**
 * İŞ → TIER alaka listesi (HATASIZ olmalı). PRENSİP "kaliteli hız" (Ümit): kaliteden ödün VERMEDEN hızlı —
 * kaliteyi düşürecek hiçbir downgrade YOK. Bu yüzden HİÇBİR iş "cheap"(haiku)'ya düşmez (haiku kaliteyi riske atar);
 * en düşük = balanced (sonnet, tam-kalite + hızlı). Hız: paralellik + kalite-eşit yerde hızlı model + faz-atlama.
 * Kalite-kritik (kod/spec/inceleme/debug/tasarım) → strong (opus). Çeviri balanced (anlam kaybı olmamalı).
 */
export const TASK_RELEVANCE: Record<TaskKind, { tier: ModelTier; reason: string }> = {
  classification: { tier: "balanced", reason: "sınıflandırma da yanlış olursa zarar → kaliteyi riske atma (haiku değil)" },
  translation: { tier: "balanced", reason: "çeviri → anlam kaybı olmamalı, dengeli model (ucuz değil)" },
  orchestration: { tier: "balanced", reason: "karar/yönlendirme → dengeli yeter" },
  intent: { tier: "balanced", reason: "niyet/clarify → dengeli yeter" },
  design: { tier: "strong", reason: "mimari tasarım → güçlü gerek" },
  spec: { tier: "strong", reason: "mühendislik spec → güçlü gerek" },
  codegen: { tier: "strong", reason: "kod üretimi → en güçlü gerek" },
  review: { tier: "strong", reason: "kod/anlam incelemesi → güçlü gerek" },
  debug: { tier: "strong", reason: "hata-ayıklama akıl yürütme → güçlü gerek" },
  verification: { tier: "balanced", reason: "doğrulama → dengeli yeter" },
};

/** Bir tier'ı katalogdan varsayılan modele çözer (config tier'ı yoksa fallback). */
function defaultModelForTier(tier: ModelTier): ModelInfo {
  const m = MODEL_CATALOG.find((x) => x.tier === tier);
  // Katalog her zaman her tier'dan en az bir model içerir (test bunu garanti eder).
  return m ?? MODEL_CATALOG[0];
}

// ───────── CANLI keşif (Ümit: "açılışta güncel modelleri çek + otomatik tier'la; yeni sürümü 1-2 yukarı taşı") ─────────
// Anthropic Models API'sinden (API key ile) gelen GÜNCEL modeller → en yeni opus=strong, sonnet=balanced, haiku=cheap.
// Yeni sürüm (opus-4-9) çıkınca strong otomatik ona taşınır. API key yoksa (subscription-only) bu boş kalır →
// selectModelForTask config/statik-katalog'a düşer (güvenli). API DESTEĞİ: keşif API key ile çalışır.

interface TierModel {
  id: string;
  label: string;
}
let _liveTiers: Partial<Record<ModelTier, TierModel>> = {};

/** Bilinen aile → deterministik tier (güvenlik ağı; LLM tier hatasını ezer). Bilinmeyen → undefined. */
function knownFamilyTier(id: string): ModelTier | undefined {
  const l = id.toLowerCase();
  if (l.includes("opus")) return "strong";
  if (l.includes("sonnet")) return "balanced";
  if (l.includes("haiku")) return "cheap";
  return undefined;
}

/**
 * Canlı/keşfedilen modelleri tier'lara atar (EN YETENEKLİ BAŞTA sıralı). HİBRİT: bilinen aile (opus/sonnet/haiku)
 * DETERMİNİSTİK tier (güvenlik ağı); YENİ aile (örn. "mythos") → LLM'in dökümandan attığı `tier`. Böylece yeni
 * model otomatik tier'lanıp KULLANILIR (Ümit: "yeni model geldiyse o kullanılsın, manuel bırakma"). İlk (en
 * yetenekli) per-tier kazanır. SAF.
 */
export function setLiveTiersFromModels(
  modelsBestFirst: Array<{ id: string; display_name: string; tier?: ModelTier }>,
): { strong?: string; balanced?: string; cheap?: string; newFamilies: string[] } {
  const result: Partial<Record<ModelTier, TierModel>> = {};
  const newFamilies: string[] = [];
  for (const m of modelsBestFirst) {
    const known = knownFamilyTier(m.id);
    const tier = known ?? m.tier; // bilinen aile deterministik; yeni aile → LLM dök-tier'ı
    if (!tier) continue; // ne bilinen aile ne LLM-tier → atlanamaz, geç
    if (!known && !newFamilies.includes(m.id)) newFamilies.push(m.id);
    if (!result[tier]) result[tier] = { id: m.id, label: m.display_name }; // ilk = en yetenekli, kazanır
  }
  _liveTiers = result;
  return {
    strong: result.strong?.id,
    balanced: result.balanced?.id,
    cheap: result.cheap?.id,
    newFamilies,
  };
}

/** Test/yeniden-init için canlı tier'ları temizle. */
export function clearLiveTiers(): void {
  _liveTiers = {};
}

export interface ModelChoice {
  modelId: string;
  label: string;
  tier: ModelTier;
  reason: string;
}

/**
 * Bir iş için doğru modeli seçer: task→tier (alaka listesi) → tier→model (kullanıcının config.model_tiers'ı,
 * yoksa katalog varsayılanı). Deterministik + SAF. `tierModels` = config.selected_models.model_tiers.
 */
export function selectModelForTask(
  taskKind: TaskKind,
  tierModels?: Partial<Record<ModelTier, string>>,
): ModelChoice {
  const rel = TASK_RELEVANCE[taskKind];
  // Öncelik: CANLI keşif (en güncel sürüm) > kullanıcı config tier'ı > statik katalog varsayılanı.
  const live = _liveTiers[rel.tier];
  if (live) {
    return { modelId: live.id, label: live.label, tier: rel.tier, reason: rel.reason };
  }
  const fromConfig = tierModels?.[rel.tier];
  const resolved =
    fromConfig && findModel(fromConfig) ? findModel(fromConfig)! : defaultModelForTier(rel.tier);
  return {
    modelId: resolved.id,
    label: resolved.label,
    tier: rel.tier,
    reason: rel.reason,
  };
}

/** Seçilen modeli chat'te göstermek için (Türkçe). */
export function formatModelChoice(taskKind: TaskKind, choice: ModelChoice): string {
  return `🧠 "${taskKind}" işi için **${choice.label}** seçildi (${choice.tier}: ${choice.reason}).`;
}

/**
 * GÜVENLİ görünürlük: KULLANILAN modeli (config'ten, override YOK) iş başına gösterir + işin alaka-tier'ını
 * not düşer. Kullanıcı hangi modelin hangi işe gittiğini görür, config'i ezilmez (hız korunur).
 */
export function formatModelInUse(taskKind: TaskKind, modelId: string): string {
  const info = findModel(modelId);
  const label = info?.label ?? modelId;
  const rel = TASK_RELEVANCE[taskKind];
  return `🧠 "${taskKind}" işi → **${label}** (bu iş tipi için uygun tier: ${rel.tier}).`;
}
