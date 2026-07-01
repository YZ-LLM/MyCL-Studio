// model-catalog — TÜM Claude modellerinin HATASIZ kataloğu + iş→model alaka listesi.
//
// YZLLM: "LLM çağırmadan önce iş için doğru modeli seç. Hatasız liste — yanlış model sistemi bozar. Seçilen model
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

/**
 * z.ai/GLM modelleri — CANLI /v4/models ile DOĞRULANDI (2026-06-22): 8 model. Önceki glm-4-plus/
 * glm-4-flash SAHTE'ydi (yoktu → o tier seçilince çağrı patlardı). Provider "zai" seçili rol/tier'da
 * bu katalogdan model çözülür — claude id'si GLM endpoint'ine GİTMEZ. Tier-default = her tier'ın İLK'i
 * (strong→glm-5.2, balanced→glm-4.6, cheap→glm-4.5-air). contextTokens: API context vermiyor →
 * muhafazakâr tahmin (taşma 400'ünü önler). Hepsi canlı chat + forced tool_choice + cache_control +
 * Deep Think ile doğrulandı.
 */
export const GLM_CATALOG: ModelInfo[] = [
  { id: "glm-5.2", label: "GLM-5.2", tier: "strong", contextTokens: 200_000, isOpus: false, blurb: "z.ai flagship — codegen/spec/tasarım/inceleme; Deep Think" },
  { id: "glm-5.1", label: "GLM-5.1", tier: "strong", contextTokens: 200_000, isOpus: false, blurb: "z.ai güçlü (5 serisi)" },
  { id: "glm-5", label: "GLM-5", tier: "strong", contextTokens: 200_000, isOpus: false, blurb: "z.ai güçlü (5 serisi)" },
  { id: "glm-4.7", label: "GLM-4.7", tier: "strong", contextTokens: 200_000, isOpus: false, blurb: "z.ai güçlü (4.x)" },
  { id: "glm-4.6", label: "GLM-4.6", tier: "balanced", contextTokens: 200_000, isOpus: false, blurb: "z.ai dengeli kod modeli" },
  { id: "glm-4.5", label: "GLM-4.5", tier: "balanced", contextTokens: 128_000, isOpus: false, blurb: "z.ai dengeli" },
  { id: "glm-4.5-air", label: "GLM-4.5-Air", tier: "cheap", contextTokens: 128_000, isOpus: false, blurb: "z.ai hafif/hızlı — sınıflandırma/çeviri" },
  { id: "glm-5-turbo", label: "GLM-5-Turbo", tier: "cheap", contextTokens: 200_000, isOpus: false, blurb: "z.ai hızlı (5 serisi turbo)" },
];

/** Provider'a göre katalog (Settings model dropdown'ları + tier-default'ları). */
export function catalogForProvider(isZai: boolean): ModelInfo[] {
  return isZai ? GLM_CATALOG : MODEL_CATALOG;
}

/** id → ModelInfo (Claude + GLM). GLM id'leri artık tanınır → sessiz claude-default landmine'ı önler. */
export function findModel(id: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.id === id) ?? GLM_CATALOG.find((m) => m.id === id);
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
 * İŞ → TIER alaka listesi (HATASIZ olmalı). PRENSİP "kaliteli hız" (YZLLM): kaliteden ödün VERMEDEN hızlı —
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

/**
 * Bir tier'ı varsayılan modele çözer (config tier'ı yoksa fallback). Provider-aware:
 * isZai → GLM kataloğundan (claude id'si z.ai endpoint'ine gitmez), aksi Claude.
 */
function defaultModelForTier(tier: ModelTier, isZai = false): ModelInfo {
  const cat = isZai ? GLM_CATALOG : MODEL_CATALOG;
  const m = cat.find((x) => x.tier === tier);
  // Katalog her zaman her tier'dan en az bir model içerir (test bunu garanti eder).
  return m ?? cat[0];
}

/** Public: bir tier için z.ai/GLM varsayılan model id'si (Settings + provider-aware çözüm). */
export function glmModelForTier(tier: ModelTier): string {
  return defaultModelForTier(tier, true).id;
}

/**
 * Translator modeli — SABİT, kullanıcı DEĞİŞTİREMEZ (YZLLM 2026-06-11: "translator için model seçme kısmını sabit
 * yap, değiştirilemesin"). Çeviri mekanik bir iş (akıl yürütme değil) → hızlı/ucuz tier yeter; teknik token'lar
 * zaten verbatim geçer. config.selected_models.translator YOK SAYILIR; her zaman bu kullanılır.
 */
export const TRANSLATOR_MODEL: string = defaultModelForTier("cheap").id;

// ───────── CANLI keşif (YZLLM: "açılışta güncel modelleri çek + otomatik tier'la; yeni sürümü 1-2 yukarı taşı") ─────────
// Anthropic Models API'sinden (API key ile) gelen GÜNCEL modeller → en yeni opus=strong, sonnet=balanced, haiku=cheap.
// Yeni sürüm (opus-4-9) çıkınca strong otomatik ona taşınır. API key yoksa (subscription-only) bu boş kalır →
// selectModelForTask config/statik-katalog'a düşer (güvenli). API DESTEĞİ: keşif API key ile çalışır.

interface TierModel {
  id: string;
  label: string;
}

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
 * model otomatik tier'lanıp KULLANILIR (YZLLM: "yeni model geldiyse o kullanılsın, manuel bırakma"). İlk (en
 * yetenekli) per-tier kazanır. SAF.
 */
export function computeTiersFromModels(
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
  // SAF — cache YOK (YZLLM 2026-06-11: keşif kullanıcı ayarını EZMEZ; bu sadece "en güncel ne var" hesaplar,
  // index.ts bunu config ile karşılaştırıp gerekirse "geçeyim mi?" diye SORAR). selectModelForTask config okur.
  return {
    strong: result.strong?.id,
    balanced: result.balanced?.id,
    cheap: result.cheap?.id,
    newFamilies,
  };
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
  // Öncelik: KULLANICI config tier'ı > statik katalog varsayılanı. (YZLLM 2026-06-11: "ayarlar dikkate alınmıyor;
  // otomatik keşiften sonra bozuldu." Canlı keşif ARTIK otomatik EZMEZ — yalnız yeni model ÖNERİR (askq); kabul
  // edilince config.selected_models'e yazılır → buradan okunur. Kullanıcı ayarı tek doğruluk kaynağı.)
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

/**
 * Bir tier için gerçek modeli çöz (config kral > katalog default). Escalation merdiveni (rung.tier → model)
 * bunu kullanır. taskKind'den bağımsız — saf tier→model.
 */
export function modelForTier(
  tier: ModelTier,
  tierModels?: Partial<Record<ModelTier, string>>,
): { id: string; label: string } {
  const fromConfig = tierModels?.[tier];
  const resolved = fromConfig && findModel(fromConfig) ? findModel(fromConfig)! : defaultModelForTier(tier);
  return { id: resolved.id, label: resolved.label };
}

/** Seçilen modeli chat'te göstermek için (Türkçe). */
export function formatModelChoice(taskKind: TaskKind, choice: ModelChoice): string {
  return `🧠 "${taskKind}" işi için **${choice.label}** seçildi (${choice.tier}: ${choice.reason}).`;
}

// YZLLM 2026-07-01: model-seçim mesajı gürültüsü. Config deterministik → her faz/debug iterasyonunda AYNI model =
// aynı satır tekrar tekrar chat'i dolduruyordu (döngüde çok belirgin). Çözüm: YALNIZ-DEĞİŞİNCE yaz. Modül-seviyesi
// cache (state.json'a dokunmaz; oturum-boyu); handleOpenProject cache'i temizler → yeni projede ilk satır görünür.
const _lastEmittedModelLine = new Map<string, string>();

/** Aynı emit-noktası (key) için satır DEĞİŞTİYSE döndürür (emit et), aynıysa null (sessiz). İlk çağrı hep döndürür. */
export function modelChoiceLineIfChanged(key: string, line: string): string | null {
  if (_lastEmittedModelLine.get(key) === line) return null;
  _lastEmittedModelLine.set(key, line);
  return line;
}

/** Yeni proje açılışında model-satırı cache'ini sıfırla (ilk model satırı yine görünsün). */
export function resetModelChoiceCache(): void {
  _lastEmittedModelLine.clear();
}

// ───────── Otomatik EFOR seçimi (YZLLM 2026-06-10: "efor seçimi de otomatik olsun; kolay işte max
// gereksiz düşünüyor — ama en küçük hata bile istemiyorum") ─────────
// Prensip "kaliteli hız"ın efor boyutu: KALİTE-kritik (strong tier) işler config eforunu AYNEN alır
// (varsayılan max — tam düşünme, dokunulmaz). Hafif/sık işler (orkestrasyon/niyet/doğrulama/çeviri/
// sınıflandırma) "high" TAVANINA çekilir — high Anthropic'in önerilen varsayılanıdır (kalite tabanı),
// max bu kısa işlerde sadece gereksiz bekletir. Kullanıcının BİLİNÇLİ daha düşük seçimi (örn. medium)
// asla yükseltilmez (ekonomi tercihi). Hiçbir iş low'a otomatik düşürülmez.

export type EffortChoice = "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

const EFFORT_RANK: Record<EffortChoice, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
  ultracode: 5, // ayrı Claude Code ayarı ama "en derin" muamelesi görür
};

function isEffortChoice(v: unknown): v is EffortChoice {
  return typeof v === "string" && v in EFFORT_RANK;
}

/**
 * İş tipine göre eforu otomatik seç. strong-tier → config eforu aynen (tam düşünme);
 * diğerleri → min(config, "high"). SAF + deterministik.
 */
export function selectEffortForTask(
  taskKind: TaskKind,
  configEffort: string | undefined,
): EffortChoice {
  const base: EffortChoice = isEffortChoice(configEffort) ? configEffort : "max";
  if (TASK_RELEVANCE[taskKind].tier === "strong") return base;
  return EFFORT_RANK[base] > EFFORT_RANK.high ? "high" : base;
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
