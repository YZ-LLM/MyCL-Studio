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

/**
 * Bilinen Claude modelleri (2026-08-04). Yeni model → buraya ekle.
 *
 * SIRA ANLAMLIDIR: `defaultModelForTier` bir tier'ın İLK modelini döner, yani sıra "ayar yapmamış
 * kullanıcının varsayılanı" demektir. Bu yüzden her tier'ın başında o tier'ın önerilen modeli durur.
 */
export const MODEL_CATALOG: ModelInfo[] = [
  {
    id: "claude-opus-5",
    label: "Opus 5",
    tier: "strong",
    contextTokens: 1_000_000,
    isOpus: true,
    blurb: "En güçlü varsayılan — codegen/spec/tasarım/inceleme/debug, karmaşık akıl yürütme",
  },
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
    // Fable 5 en yetenekli model ama strong LİSTESİNİN SONUNDA duruyor: `defaultModelForTier` ilk
    // elemanı döndürdüğü için başa konsaydı hiç ayar yapmamış her kullanıcı en pahalı modele geçerdi.
    // Bilinçli seçimle (Ayarlar → Plan Modeli / güçlü katman) gelir. `knownFamilyTier` de "fable"ı
    // TANIMAZ → canlı keşif bunu otomatik strong'a terfi ettiremez.
    id: "claude-fable-5",
    label: "Fable 5",
    tier: "strong",
    contextTokens: 1_000_000,
    isOpus: false,
    blurb: "En yetenekli (Mythos sınıfı) — plan/mimari gibi kalite belirleyici işler; maliyeti yüksek",
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    tier: "balanced",
    contextTokens: 1_000_000,
    isOpus: false,
    blurb: "Dengeli varsayılan — orkestrasyon/çeviri/niyet/doğrulama; hızlı + yetkin",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    tier: "balanced",
    contextTokens: 1_000_000,
    isOpus: false,
    blurb: "Dengeli (önceki Sonnet)",
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

// (GLM_CATALOG KALDIRILDI — 2026-07-16, YZLLM: z.ai sağlayıcısı çıkarıldı; yalnız Claude.)

/** id → ModelInfo (Claude kataloğu). */
export function findModel(id: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/**
 * Model id'sinden okunabilir etiket türetir (SAF): `claude-opus-5` → "Opus 5", `claude-haiku-4-5` →
 * "Haiku 4.5". `claude-` öneki ve tarih son eki (`-20251001`) atılır; sürüm parçaları noktayla birleşir.
 */
export function prettyModelLabel(id: string): string {
  const core = (id ?? "").replace(/^claude-/i, "").replace(/-\d{8}$/, "");
  const parts = core.split("-").filter(Boolean);
  if (parts.length === 0) return id ?? "";
  const family = parts[0]!;
  const version = parts.slice(1).join(".");
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return version ? `${name} ${version}` : name;
}

/**
 * Bir model id'sini ModelInfo'ya çözer — KATALOGDA OLMASA BİLE (YZLLM 2026-08-04, KATI #4).
 *
 * ESKİ DAVRANIŞ VE NEDEN DEĞİŞTİ: `selectModelForTask`/`modelForTier` katalogda bulamadığı config
 * modelini SESSİZCE katalog varsayılanıyla değiştiriyordu. Kullanıcının `model_tiers.strong` =
 * `claude-opus-5` ayarı bu yüzden hiç uygulanmıyordu; tüm fazlar haber verilmeden Opus 4.8 koşuyordu.
 * Katalog bayatladığı ANDA (yeni model ailesi çıkınca) kullanıcının ayarını yok sayan bu sessiz ikame,
 * "sessiz fallback yok" kuralının ihlaliydi. Artık kullanıcının modeli AYNEN kullanılır; katalogda
 * olmadığı `fromCatalog:false` ile veri olarak taşınır ve çağıran GÖRÜNÜR uyarıya çevirir.
 *
 * `tierHint`: modelin okunduğu slot. Kullanıcı modeli `model_tiers.strong`'a yazdıysa tier'ı zaten
 * beyan etmiştir — tahmin etmekten iyidir. Yoksa bilinen aile, o da yoksa `strong` (kaliteyi düşüren
 * yönde varsayma).
 */
export function describeModel(id: string, tierHint?: ModelTier): ModelInfo {
  const known = findModel(id);
  if (known) return known;
  return {
    id,
    label: prettyModelLabel(id),
    tier: tierHint ?? knownFamilyTier(id) ?? "strong",
    // contextTokens/isOpus'un katalog dışında tüketicisi yok (2026-08-04 grep) — muhafazakâr değer.
    contextTokens: 200_000,
    isOpus: /opus/i.test(id),
    blurb: "MyCL kataloğunda yok — Ayarlar'dan seçildi, olduğu gibi kullanılıyor.",
  };
}

/** Katalog dışı bir config modeli (hangi ayar alanı, hangi id). */
export interface UnknownConfiguredModel {
  /** Kullanıcıya gösterilecek alan adı (Türkçe), ör. "güçlü katman". */
  role: string;
  id: string;
}

/**
 * SAF: config'teki model ayarlarını gezip katalog DIŞI olanları döner. Boş dizi = hepsi tanınıyor.
 * Çağıran bunu tek bir görünür uyarı satırına çevirir (KATI #4: sessiz ikame yerine haber ver).
 */
export function auditConfiguredModels(sel: {
  main?: string;
  orchestrator?: string;
  plan_model?: string;
  model_tiers?: Partial<Record<ModelTier, string>>;
}): UnknownConfiguredModel[] {
  const slots: Array<{ role: string; id?: string }> = [
    { role: "ana model", id: sel.main },
    { role: "orkestratör", id: sel.orchestrator },
    { role: "plan modeli", id: sel.plan_model },
    { role: "güçlü katman", id: sel.model_tiers?.strong },
    { role: "dengeli katman", id: sel.model_tiers?.balanced },
    { role: "ucuz katman", id: sel.model_tiers?.cheap },
  ];
  const out: UnknownConfiguredModel[] = [];
  for (const s of slots) {
    if (!s.id || findModel(s.id)) continue;
    if (out.some((o) => o.id === s.id)) continue; // aynı model birden çok slotta → tek satır
    out.push({ role: s.role, id: s.id });
  }
  return out;
}

export interface ResolvedModel {
  /** Kullanılacak model id. */
  model: string;
  /** Fallback olduysa GÖRÜNÜR mesaj (KATI #4 sessiz-fallback-yok). Yoksa model tanınıyordu. */
  note?: string;
}

/**
 * Model guard (YZLLM 2026-07-01): yardımcı LLM adımları (living-docs / spec-refresh / module-stock /
 * quality-audit) `selected_models.orchestrator ?? main`'i doğrulamadan CLI'a veriyordu → katalog-DIŞI bir id
 * (canlı: `claude-fable-5` — MyCL kataloğunda yok, CLI `exit=1 "issue with the selected model"`) adımı DÜŞÜRÜYORDU.
 *
 * Bu guard: model MODEL_CATALOG'da (findModel) ise DOKUNMAZ (kullanıcı ayarı kral). Değilse
 * `mainModel`'e düşer (o da bilinen ise) + GÖRÜNÜR note. main de bilinmiyorsa modeli DEĞİŞTİRMEZ (yanlış
 * sağlayıcıya zorlamaktan iyidir) → yalnız uyarır. SAF (config değil, main string alır → test edilebilir).
 * NOT: katalog bayatsa (gerçek yeni model henüz eklenmemiş) fallback tetiklenir — note kullanıcıyı bilgilendirir;
 * çözüm katalogu güncellemek. Görünür fallback (KATI #4) "kullanıcı ayarı kral"la uyumlu: sessiz ezme yok, uyarır
 * (nadir katalog-dışı-ama-geçerli model main'e düşerse note ile görünür — kullanıcı Ayarlar'dan geri alır).
 */
export function resolveKnownModel(
  model: string,
  mainModel: string,
  roleLabel: string,
): ResolvedModel {
  const known = (id: string): boolean => !!findModel(id);
  if (known(model)) return { model };
  if (mainModel !== model && known(mainModel)) {
    return {
      model: mainModel,
      note: `'${model}' modeli MyCL kataloğunda yok (${roleLabel}) — ana model '${mainModel}'e düşüldü. Kalıcıysa Ayarlar'dan modeli düzeltin.`,
    };
  }
  // main de tanınmıyor → değiştirme (sağlayıcı-karışıklığından iyi); yalnız uyar.
  return {
    model,
    note: `'${model}' modeli MyCL kataloğunda yok (${roleLabel}) — çağrı başarısız olabilir; Ayarlar'dan modeli doğrulayın.`,
  };
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

/** Bir tier'ı varsayılan Claude modeline çözer (config tier'ı yoksa fallback). */
function defaultModelForTier(tier: ModelTier): ModelInfo {
  const m = MODEL_CATALOG.find((x) => x.tier === tier);
  // Katalog her zaman her tier'dan en az bir model içerir (test bunu garanti eder).
  return m ?? MODEL_CATALOG[0];
}

/**
 * Translator modeli — SABİT, kullanıcı DEĞİŞTİREMEZ (YZLLM 2026-06-11: "translator için model seçme kısmını sabit
 * yap, değiştirilemesin"). Çeviri mekanik bir iş (akıl yürütme değil) → hızlı/ucuz tier yeter; teknik token'lar
 * zaten verbatim geçer. config.selected_models.translator YOK SAYILIR; her zaman bu kullanılır.
 */
// AÇIK SABİT (YZLLM 2026-08-04): eskiden `defaultModelForTier("cheap").id` ile türetiliyordu, yani
// katalog SIRASINA kırılgan biçimde bağlıydı — cheap tier'ın başına bir gün yeni bir model eklenirse
// çevirmen kimsenin haberi olmadan değişirdi. Çevirmen "sabit, kullanıcı değiştiremez" olduğuna göre
// kaynağı da sabit olmalı. Değişmezlik testi katalogda var olduğunu + tier'ını doğrular.
export const TRANSLATOR_MODEL = "claude-haiku-4-5";

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
  /** false → model MyCL kataloğunda yok (kullanıcı ayarı aynen kullanılıyor). Çağıran uyarabilir. */
  fromCatalog: boolean;
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
  // YZLLM 2026-08-04: katalogda BULUNAMAYAN config modeli artık varsayılana DÜŞMEZ (bkz. describeModel) —
  // sessiz ikame kullanıcının Opus 5 ayarını yok sayıyordu. Uyarı `fromCatalog` ile çağırana taşınır.
  const fromConfig = tierModels?.[rel.tier];
  const resolved = fromConfig ? describeModel(fromConfig, rel.tier) : defaultModelForTier(rel.tier);
  return {
    modelId: resolved.id,
    label: resolved.label,
    tier: rel.tier,
    reason: rel.reason,
    fromCatalog: !!findModel(resolved.id),
  };
}

/**
 * Bir tier için gerçek modeli çöz (config kral > katalog default). Escalation merdiveni (rung.tier → model)
 * bunu kullanır. taskKind'den bağımsız — saf tier→model.
 */
export function modelForTier(
  tier: ModelTier,
  tierModels?: Partial<Record<ModelTier, string>>,
): { id: string; label: string; tier: ModelTier; fromCatalog: boolean } {
  const fromConfig = tierModels?.[tier];
  // selectModelForTask ile AYNI kural: katalog dışı config modeli sessizce değiştirilmez (YZLLM 2026-08-04).
  const resolved = fromConfig ? describeModel(fromConfig, tier) : defaultModelForTier(tier);
  return { id: resolved.id, label: resolved.label, tier, fromCatalog: !!findModel(resolved.id) };
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

// ZAMAN-KAYBI PLANI (YZLLM 2026-07-07, "efor ayarını yap, canlıda izle"): strong-tier işlerde per-iş efor tavanı.
// Kod üretimi (codegen) + inceleme (review) → xhigh: Claude Code'un kodlama/agentik iş için ÖNERDİĞİ varsayılan;
// max nadiren ek değer katar ama belirgin daha yavaştır (en büyük gecikme kaynağı). Şartname (spec) + tasarım
// (design) + hata ayıklama (debug) → tavan YOK → max korunur (düşünme derinliği bu işlerde kritik). Kalite sabit
// kısıt: kullanıcı canlıda izler, bir işte gerileme görürse o iş max'a geri alınır.
const STRONG_EFFORT_CEILING: Partial<Record<TaskKind, EffortChoice>> = {
  codegen: "xhigh",
  review: "xhigh",
};

/**
 * İş tipine göre eforu otomatik seç. strong-tier → config eforu aynen (tam düşünme), AMA per-iş tavanı varsa min alınır
 * (codegen/review → xhigh). diğerleri → min(config, "high"). "kullanıcı ayarı kral": açık DÜŞÜK config seçimi asla
 * yükseltilmez (hep min alınır). SAF + deterministik.
 */
export function selectEffortForTask(
  taskKind: TaskKind,
  configEffort: string | undefined,
): EffortChoice {
  const base: EffortChoice = isEffortChoice(configEffort) ? configEffort : "max";
  if (TASK_RELEVANCE[taskKind].tier === "strong") {
    // ultracode = kullanıcının BİLİNÇLİ en-derin seçimi (ayrı Claude Code modu) → tavanla EZME ("kullanıcı ayarı
    // kral"). Tavan yalnız VARSAYILAN max'ı codegen/review'de xhigh'e indirir.
    if (base === "ultracode") return base;
    const ceiling = STRONG_EFFORT_CEILING[taskKind];
    if (ceiling && EFFORT_RANK[base] > EFFORT_RANK[ceiling]) return ceiling;
    return base;
  }
  return EFFORT_RANK[base] > EFFORT_RANK.high ? "high" : base;
}

// (formatModelInUse KALDIRILDI — mahkeme denetimi 2026-07-11: 0 çağıran, ölü export.)
