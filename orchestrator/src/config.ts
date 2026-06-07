// config — API key + selected model + timeout resolution.
//
// İki tür dosya:
//   - ~/.mycl/secrets.json — chmod 600, API key'leri tutar
//   - ~/.mycl/config.json  — kullanıcı tercihleri (selected_models, timeouts)
//
// Hardcoded model alias yok. Kullanıcı Settings ekranından iki model id seçer:
//   - selected_models.translator: çeviri için (Phase 1 askq da kullanır)
//   - selected_models.main: production/codegen fazları için
//
// API key arama sırası (her key için bağımsız):
//   1. env MYCL_API_KEY_TRANSLATOR / MYCL_API_KEY_MAIN
//   2. secrets.json api_keys.{translator,main}
//   3. env ANTHROPIC_API_KEY (her ikisi için fallback)
// İki key de yoksa ApiKeyMissingError.
// selected_models yoksa ModelSelectionMissingError.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { cliCurrentlyLimited, resolveAuto } from "./cli-rate-limit.js";
import { globalConfigDir } from "./paths.js";

export interface ClaudeCodeFlags {
  /**
   * Main model efor seviyesi (Claude Code CLI backend için). low/medium/high/
   * xhigh/max → CLI `--effort <value>`. "ultracode" AYRI bir Claude Code
   * ayarı (efor seviyesi değil): CLI'a `--effort` ile DEĞİL, `--settings
   * '{"ultracode": true}'` ile geçer; xhigh + dynamic workflows orchestration
   * yapar; SADECE Opus 4.7/4.8'de geçerli. (Anthropic SDK/API'de "effort"/
   * "ultracode" YOK — bunlar Claude Code CLI kavramı.) Aşama 3 wiring bu
   * ayrımı uygular.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";
  betas?: string[];
  /**
   * v15.11 GÜVENLİK: spawn edilen main-ajan `claude` alt-süreçlerinin dosya
   * erişimini açık proje + alt klasörlerine hapseder (Claude Code yerli sandbox
   * + denyRead). "enforce" (varsayılan): sandbox kurulamazsa fail-closed (ajan
   * koşmaz). "warn": kurulamazsa görünür uyarı + soft (deny-only) devam. "off":
   * sandbox kapalı (eski davranış — acil geri-alma). Bkz agent-sandbox.ts.
   */
  agent_sandbox_policy?: "enforce" | "warn" | "off";
  /**
   * v15.13: Faz 5 (UI) tasarım fan-out'u — çok-perspektifli tasarım paneli
   * (architect/ux/security/data → synthesizer) MyCL-native paralel ile koşar
   * (E1: API'de runTurn, abonelikte cli-run; iki modda da, deterministik).
   * "off" (default): mevcut tek-ajan davranışı (geriye uyum). "create-only":
   * yalnız yeni proje (CREATE, iteration 1) Faz 5'inde. "always": her Faz 5'te
   * (tweak hariç). Settings'ten seçilir.
   */
  design_workflow?: "off" | "create-only" | "always";
  /**
   * v15.13 (Layer B): Faz 5 tasarım çatışmalarını GERÇEK Agent Teams peer-müzakeresiyle çöz.
   * false (default): synthesizer'ın provizyon kararı kullanılır (Faz A davranışı korunur). true:
   * design_workflow açık + conflicts[] varsa → abonelik (CLI) modunda kısa-ömürlü Agent Team
   * (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) çelişkileri müzakere eder; API modunda MyCL-simüle
   * cross-critique turu. ~2.5-5x token → opt-in.
   * v15.13 (Faz 0): AYRICA debug hipotez fan-out'unu açar — Faz 0 D1'den önce 3 mercekten
   * (state/async/integration) paralel kök-neden hipotezi üretilir + D1'e rehber verilir (tünel-
   * görüşünü önler). Yani "gerçek çok-ajanlı derinlik" umbrella flag'i: tasarım müzakeresi + debug.
   */
  agent_teams_optin?: boolean;
  /**
   * v15.14 (F2): Prompt cache ömrü. "5m" (default): mevcut davranış (Anthropic
   * varsayılanı). "1h": uzun pipeline koşularında cache-hit'i artırır → maliyet
   * düşer (1h cache-write 2x, cache-read 0.1x). API yolu: `cache_control.ttl:"1h"`.
   * CLI/abonelik yolu: `ENABLE_PROMPT_CACHING_1H=1` env. Settings'ten seçilir.
   */
  cache_ttl?: "5m" | "1h";
  /**
   * v15.15: Pre-hoc bağımsız kör-nokta merceği. Kritik bir artefakt/karar KOMİT olmadan ÖNCE,
   * o işi YAPMAYAN ayrı bir ajan "neyi paranteze aldı?"yı yakalar (spec onayı + consequential
   * orkestratör kararları). "off": kapalı (eski davranış). "consequential" (default): yalnız
   * consequential + geri-dönülemez noktalarda — tek ucuz tur, trivial/reversible atlanır.
   * "always": her consequential noktada. Bulgular GÖRÜNÜR; mercek hatası komit'i BLOKLAMAZ.
   */
  blindspot_lens?: "off" | "consequential" | "always";
}

export interface ApiKeys {
  translator: string;
  main: string;
  /**
   * Relevance engine (LLM-based chunk scoring) için API key. Opsiyonel —
   * set edilmezse translator key fallback. Mevcut secrets.json olan
   * kullanıcılar etkilenmez.
   */
  relevance?: string;
  /**
   * Orkestrator agent (v15.5) için API key. Opsiyonel — set edilmezse main
   * key fallback. Ayrı key sayesinde user farklı tier (örn. dedicated Sonnet
   * API key) veya farklı kotaya bağlayabilir.
   */
  orchestrator?: string;
}

export interface SelectedModels {
  /** Translator + Phase 1 (qa, askq) için Anthropic model id'si. */
  translator: string;
  /** Phase 4/9 (production, codegen) için Anthropic model id'si. */
  main: string;
  /**
   * Relevance engine için model id'si. Opsiyonel — set edilmezse translator
   * model fallback. Önerilen: Haiku 4.5 (cost/perf optimum: chunk scoring
   * light task, Sonnet/Opus overkill).
   */
  relevance?: string;
  /**
   * Orkestrator agent (v15.5) için model id'si. Opsiyonel — set edilmezse
   * main model fallback. User isterse daha güçlü model (Opus) seçebilir;
   * agent kullanıcı niyetini doğru anlamak için ana modelde ne seçili ise
   * onu kullanır (default).
   */
  orchestrator?: string;
  /**
   * v15.13: Fan-out alt-ajan (subagent) rolleri için model id'leri. Her biri
   * opsiyonel — yoksa main model fallback (subagentModelId helper). Settings'te
   * kullanıcı seçer (örn. architect→Opus, ux/security/data→Sonnet). İş seviyesine
   * göre model. MyCL hardcoded alias KOYMAZ.
   */
  subagent_models?: {
    architect?: string;
    ux?: string;
    security?: string;
    data?: string;
    synthesizer?: string;
    hypothesis?: string;
    verifier?: string;
  };
  /**
   * v15.13 (auto-model — "yapılacak işe göre model seç"): iş-seviyesi katmanları. Fan-out
   * rolleri OTOMATİK olarak iş-seviyelerine göre bu katmanlara dağıtılır (architect/synthesizer/
   * verifier → strong; ux/security/data/hypothesis → balanced). Tam model id'leri kullanıcı
   * Settings'te seçer → MyCL hardcoded SÜRÜM koymaz, dağıtımı otomatik yapar. Çözüm önceliği:
   * subagent_models[role] (açık override) > model_tiers[rolün tier'ı] > main.
   */
  model_tiers?: { strong?: string; balanced?: string; cheap?: string };
}

export interface FeatureFlags {
  /**
   * v15.7 (2026-05-25): Faz 16 E2E testleri için Playwright kullanımı.
   * `true` (default): UI projelerinde Faz 16 `npx playwright test` çalıştırır
   * + Faz 5 codegen `@playwright/test` install eder. `false`: Faz 16 atlanır,
   * Faz 5 install adımı skip. Kullanıcı talebi: Settings'ten açılır/kapanır.
   */
  playwright_enabled: boolean;
  /**
   * v15.8 (2026-05-30): Main codegen ajanını Claude Code CLI ile çalıştır.
   * `false` (default): mevcut Anthropic SDK turn-loop. `true`: `claude` CLI
   * subprocess (Phase 5 + verify-feature kapsamında; Phase 8/0 SDK kalır).
   * `claude` binary yoksa SDK'ya dürüst fallback. Aktifse `claude_code_flags.
   * effort` CLI'a `--effort` olarak geçer.
   */
  claude_code_cli_enabled: boolean;
  /**
   * v15.13 (Ümit isteği): MyCL açılışında claude CLI'yı otomatik güncelle (`claude update`,
   * non-blocking). `true` (default): her açılışta arka planda günceller. `false`: kapalı.
   * Resmi + güvenli işlem; hata yutulur, boot'u bloklamaz. Bkz claude-updater.ts.
   */
  auto_update_claude?: boolean;
}

const DEFAULT_FEATURES: FeatureFlags = {
  playwright_enabled: true,
  claude_code_cli_enabled: false,
  auto_update_claude: true,
};

/**
 * v15.8 (2026-05-31): Her ajan rolü ayrı ayrı API (Anthropic SDK) veya CLI
 * (Claude Code aboneliği — `claude` subprocess, oauthAccount auth, API faturası
 * YOK) ile koşabilir. "api" = mevcut SDK yolu (default, davranış korunur). "cli"
 * = `claude` CLI (abonelik). Eski `features.claude_code_cli_enabled:true` →
 * `main:"cli"` migration'ı resolveAgentBackends'te yapılır.
 */
/** Efektif (çözülmüş) backend — dispatch noktalarının tükettiği. */
export type AgentBackend = "api" | "cli";
/**
 * Yapılandırılmış backend (config'te saklanan). "auto" = Auto Mode: CLI ile başla,
 * abonelik limiti dolunca API kullan, limit açılınca CLI'ye dön (cli-rate-limit.ts).
 * backendForRole bunu runtime'da "api"|"cli"'ye çözer.
 */
export type ConfiguredBackend = AgentBackend | "auto";
export type AgentRole = "orchestrator" | "translator" | "main";
export interface AgentBackends {
  orchestrator: ConfiguredBackend;
  translator: ConfiguredBackend;
  main: ConfiguredBackend;
}
const DEFAULT_BACKENDS: AgentBackends = {
  orchestrator: "api",
  translator: "api",
  main: "api",
};

export interface MyclConfig {
  api_keys: ApiKeys;
  selected_models: SelectedModels;
  /** Claude Code SDK çağrılarında effort/betas — main model için. */
  claude_code_flags: ClaudeCodeFlags;
  /** v15.8: rol başına backend (api/cli). selected_models'e paralel. */
  agent_backends: AgentBackends;
  /** v15.7: opsiyonel özellikler (kullanıcı ayarlanabilir). */
  features: FeatureFlags;
  timeouts_ms: {
    translator: number;
    claude_subprocess_spawn: number;
    claude_first_event: number;
  };
}

const DEFAULT_FLAGS: ClaudeCodeFlags = {
  effort: "max",
  // prompt-caching-2024-07-31 — system + tools blocklarına cache_control:
  // ephemeral koyunca multi-turn fazlarda (Faz 8 vb.) ilk turn'den sonraki
  // input token'lar **%90 indirimle** cache'ten okunur. 5dk TTL.
  betas: ["context-1m-2025-08-07", "prompt-caching-2024-07-31"],
  // GÜVENLİK varsayılanı: ajanı projeye hapset, sandbox yoksa fail-closed.
  agent_sandbox_policy: "enforce",
  // v15.13: tasarım fan-out'u default KAPALI (opt-in, geriye uyum). Settings'te
  // "create-only" / "always" ile açılır.
  design_workflow: "off",
  // v15.13 (Layer B): çatışma → gerçek Agent Teams müzakeresi default KAPALI (opt-in, maliyet).
  agent_teams_optin: false,
  // v15.14 (F2): prompt cache ömrü default 5dk (mevcut davranış; geriye uyum). "1h" opt-in.
  cache_ttl: "5m",
  // v15.15: pre-hoc kör-nokta merceği — açık ama gate'li (yalnız consequential + geri-dönülemez;
  // tek ucuz tur; trivial atlanır; non-blocking). "off" ile tamamen kapatılır.
  blindspot_lens: "consequential",
};

const DEFAULT_TIMEOUTS = {
  translator: 30_000,
  claude_subprocess_spawn: 10_000,
  claude_first_event: 60_000,
};

export class ConfigError extends Error {
  override readonly name: string = "ConfigError";
}

export class ApiKeyMissingError extends ConfigError {
  override readonly name: string = "ApiKeyMissingError";
}

export class ModelSelectionMissingError extends ConfigError {
  override readonly name: string = "ModelSelectionMissingError";
}

function configDir(): string {
  // v15.8 (2026-05-30): Platform-aware (paths.ts). mac'te ~/.mycl korunur.
  return globalConfigDir();
}

function configPath(): string {
  return join(configDir(), "config.json");
}

function secretsPath(): string {
  return join(configDir(), "secrets.json");
}

interface ConfigFile {
  selected_models?: Partial<SelectedModels>;
  claude_code_flags?: ClaudeCodeFlags;
  agent_backends?: Partial<AgentBackends>;
  features?: Partial<FeatureFlags>;
  timeouts_ms?: Partial<MyclConfig["timeouts_ms"]>;
}

interface SecretsFile {
  api_keys?: Partial<ApiKeys>;
}

async function loadConfigFile(): Promise<ConfigFile> {
  try {
    const raw = await fs.readFile(configPath(), "utf-8");
    return JSON.parse(raw) as ConfigFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`config read failed: ${String(err)}`);
  }
}

async function loadSecrets(): Promise<SecretsFile> {
  try {
    const raw = await fs.readFile(secretsPath(), "utf-8");
    return JSON.parse(raw) as SecretsFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`secrets read failed: ${String(err)}`);
  }
}

function resolveApiKeys(secrets: SecretsFile): ApiKeys {
  const envFallback = process.env.ANTHROPIC_API_KEY;
  const envTranslator = process.env.MYCL_API_KEY_TRANSLATOR;
  const envMain = process.env.MYCL_API_KEY_MAIN;
  const envRelevance = process.env.MYCL_API_KEY_RELEVANCE;
  const envOrchestrator = process.env.MYCL_API_KEY_ORCHESTRATOR;
  const translatorKey =
    envTranslator ?? secrets.api_keys?.translator ?? envFallback;
  const mainKey = envMain ?? secrets.api_keys?.main ?? envFallback;
  // Relevance opsiyonel — explicit set yoksa undefined kalır; runtime'da
  // caller translator key fallback uygular (relevanceKey()).
  const relevanceKey = envRelevance ?? secrets.api_keys?.relevance;
  // Orchestrator agent (v15.5) opsiyonel — set edilmezse main key fallback
  // (orchestratorApiKey() helper'ı ile).
  const orchestratorKey = envOrchestrator ?? secrets.api_keys?.orchestrator;
  if (!translatorKey || !mainKey) {
    throw new ApiKeyMissingError(
      `API key eksik. Settings → API Keys'ten girin.`,
    );
  }
  return {
    translator: translatorKey,
    main: mainKey,
    ...(relevanceKey ? { relevance: relevanceKey } : {}),
    ...(orchestratorKey ? { orchestrator: orchestratorKey } : {}),
  };
}

/**
 * Relevance API key — opsiyonel relevance ayarlanmadıysa **main** key fallback.
 * Kullanıcı talebi: "ek call için haiku 4.5 sabit olmasın, ana model olarak
 * hangisi seçili ise onu kullansın." Daha güçlü model = daha iyi sınıflandırma
 * = MyCL'in "hafıza" iddiasının desteklenmesi. Maliyet artışı kullanıcı kararı.
 */
export function relevanceApiKey(keys: ApiKeys): string {
  return keys.relevance ?? keys.main;
}

/**
 * Relevance model id — opsiyonel relevance ayarlanmadıysa **main** model
 * fallback. Caller'lar (relevance engine) bu helper'ı kullanır. Yeni
 * `selected_models.relevance` set ederse onun değeri devreye girer (override).
 */
export function relevanceModelId(models: SelectedModels): string {
  return models.relevance ?? models.main;
}

/**
 * Orkestrator agent API key — opsiyonel orchestrator ayarlanmadıysa **main**
 * key fallback. User talebi (v15.5): "ona ayrı api key veriyim". Settings'te
 * boş bırakılırsa main key kullanılır.
 */
export function orchestratorApiKey(keys: ApiKeys): string {
  return keys.orchestrator ?? keys.main;
}

/**
 * Orkestrator agent model id — opsiyonel orchestrator ayarlanmadıysa **main**
 * model fallback. User talebi (v15.5): "ana modelde ne seçili ise onu
 * kullansın" — default davranış main, ama Settings'te override edilebilir
 * (örn. agent için Opus, codegen için Sonnet).
 */
export function orchestratorModelId(models: SelectedModels): string {
  return models.orchestrator ?? models.main;
}

/** v15.13: Fan-out alt-ajan rolleri (Faz 5 tasarım paneli + Faz 0 kök-neden fan-out). */
export type SubagentRole =
  | "architect"
  | "ux"
  | "security"
  | "data"
  | "synthesizer"
  | "hypothesis"
  | "verifier";

/** v15.13 (auto-model): rolün İŞ-SEVİYESİ → model katmanı. Derin akıl yürütme / sentez /
 *  eleme(verifier) = strong; geniş-ama-sığ perspektif / araştırma(hypothesis) = balanced.
 *  (cheap şu an atanmıyor ama desen hazır — ileride sınıflandırma/özet gibi hafif işler için.) */
export type WorkTier = "strong" | "balanced" | "cheap";
const ROLE_TIER: Record<SubagentRole, WorkTier> = {
  architect: "strong",
  synthesizer: "strong",
  verifier: "strong",
  ux: "balanced",
  security: "balanced",
  data: "balanced",
  hypothesis: "balanced",
};

/**
 * v15.13 (auto-model — "yapılacak işe göre model"): Fan-out alt-ajan rolü için model id'sini
 * OTOMATİK seçer (rolün iş-seviyesine göre). Çözüm sırası:
 *   1) subagent_models[role] — kullanıcının açık per-rol override'ı (en öncelikli).
 *   2) model_tiers[ROLE_TIER[role]] — iş-seviyesine göre OTOMATİK; MyCL rolü tier'a dağıtır,
 *      tam model id kullanıcının Settings'te seçtiği değer (hardcoded sürüm YOK).
 *   3) main — hiçbiri yoksa güvenli fallback (mevcut davranış birebir korunur).
 * Kullanıcı 3 katman modelini BİR kez seçer; MyCL her rolü işine göre otomatik atar.
 */
export function subagentModelId(models: SelectedModels, role: SubagentRole): string {
  const explicit = models.subagent_models?.[role];
  if (explicit) return explicit;
  const tierModel = models.model_tiers?.[ROLE_TIER[role]];
  if (tierModel) return tierModel;
  return models.main;
}

function resolveSelectedModels(file: ConfigFile): SelectedModels {
  const sel = file.selected_models;
  if (!sel || !sel.translator || !sel.main) {
    throw new ModelSelectionMissingError(
      `Model seçimi eksik. Settings → Modeller'den translator ve main için model seçin.`,
    );
  }
  // Relevance + Orchestrator opsiyonel — Settings UI bu alanları opsiyonel
  // gösterir; yoksa runtime'da main fallback uygulanır (helper'lar üzerinden).
  return {
    translator: sel.translator,
    main: sel.main,
    ...(sel.relevance ? { relevance: sel.relevance } : {}),
    ...(sel.orchestrator ? { orchestrator: sel.orchestrator } : {}),
    ...(sel.subagent_models ? { subagent_models: sel.subagent_models } : {}),
    ...(sel.model_tiers ? { model_tiers: sel.model_tiers } : {}),
  };
}

/**
 * Rol başına backend'i çözer. Default hepsi "api". Migration: eski
 * `features.claude_code_cli_enabled:true` + main backend'i explicit set değilse
 * → main:"cli" (geriye uyum; eski kullanıcının main-CLI tercihi korunur).
 */
function resolveAgentBackends(file: ConfigFile): AgentBackends {
  const ab = file.agent_backends ?? {};
  const merged: AgentBackends = { ...DEFAULT_BACKENDS, ...ab };
  if (ab.main === undefined && file.features?.claude_code_cli_enabled === true) {
    merged.main = "cli";
  }
  return merged;
}

/**
 * Bir rol için EFEKTİF backend ("api" | "cli"). "auto" → runtime'da çözülür:
 * abonelik limiti aktifse "api", değilse "cli" (cli-rate-limit.ts). loadConfig her
 * zaman agent_backends'i doldurur; partial/cast config'lere karşı savunmacı — eksikse
 * "api" (güvenli default). Tek çözüm-noktası: 9 dispatch yeri bunu çağırır.
 */
export function backendForRole(config: MyclConfig, role: AgentRole): AgentBackend {
  const configured = config.agent_backends?.[role] ?? "api";
  return resolveAuto(configured, configured === "auto" ? cliCurrentlyLimited() : false);
}

/** Rol Auto Mode'da mı (factory'ler görünür CLI→API fallback'i yalnız auto'da uygular). */
export function isAutoMode(config: MyclConfig, role: AgentRole): boolean {
  return (config.agent_backends?.[role] ?? "api") === "auto";
}

/**
 * Tüm config'i yükler. API key veya model seçimi eksikse spesifik hata fırlatır;
 * UI bu hata türlerine göre ayarlar ekranının ilgili tab'ını açar.
 */
export async function loadConfig(): Promise<MyclConfig> {
  const fileConfig = await loadConfigFile();
  const secrets = await loadSecrets();

  const api_keys = resolveApiKeys(secrets);
  const selected_models = resolveSelectedModels(fileConfig);

  return {
    api_keys,
    selected_models,
    claude_code_flags: { ...DEFAULT_FLAGS, ...(fileConfig.claude_code_flags ?? {}) },
    agent_backends: resolveAgentBackends(fileConfig),
    features: { ...DEFAULT_FEATURES, ...(fileConfig.features ?? {}) },
    timeouts_ms: { ...DEFAULT_TIMEOUTS, ...(fileConfig.timeouts_ms ?? {}) },
  };
}

/**
 * API key'leri secrets.json'a yazar (chmod 600).
 */
/**
 * Yalnız TANIMLI + boş-olmayan alanları üzerine yazar (kod-analiz 2026-06-07): UI eksik payload
 * mevcut per-rol key/model'i SESSİZCE silmesin. Nesne değerleri (model_tiers/subagent_models) olduğu
 * gibi geçer; "" / undefined / null gelen alan mevcut değeri korur.
 */
function mergeDefinedFields(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

export async function persistApiKeys(keys: ApiKeys): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  // MERGE (kod-analiz 2026-06-07): mevcut secrets'ı KORU. Eskiden `JSON.stringify({api_keys: keys})`
  // dosyayı tamamen eziyordu + UI payload relevance/orchestrator taşımadığından bu key'ler sessizce
  // SİLİNİYOR → relevanceApiKey()/orchestratorApiKey() sessizce main'e düşüyordu (yanlış tier/kota).
  const existing = await loadSecrets();
  const mergedKeys = mergeDefinedFields(
    existing.api_keys as Record<string, unknown> | undefined,
    keys as unknown as Record<string, unknown>,
  );
  const raw =
    JSON.stringify({ ...existing, api_keys: mergedKeys }, null, 2) + "\n";
  await fs.writeFile(secretsPath(), raw, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Seçili modelleri config.json'a yazar. Mevcut config'i merge'ler (claude_code_flags,
 * timeouts korunur).
 */
export async function persistSelectedModels(sel: SelectedModels): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const existing = await loadConfigFile();
  const next: ConfigFile = {
    ...existing,
    // MERGE (kod-analiz 2026-06-07): selected_models'ı tam-replace etme — UI payload relevance/
    // subagent_models taşımadığında bu alanlar sessizce silinip main'e düşüyordu. Alan-bazlı merge.
    selected_models: mergeDefinedFields(
      existing.selected_models as Record<string, unknown> | undefined,
      sel as unknown as Record<string, unknown>,
    ) as Partial<SelectedModels>,
  };
  const raw = JSON.stringify(next, null, 2) + "\n";
  await fs.writeFile(configPath(), raw, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Mevcut seçili modelleri okur (varsa). UI Settings ekranında "şu an seçili" göstermek için.
 */
export async function readSelectedModels(): Promise<Partial<SelectedModels> | null> {
  const file = await loadConfigFile();
  return file.selected_models ?? null;
}

/**
 * v15.8 (2026-05-30): Claude Code flags'i (effort) config.json'a yazar (merge).
 * Model kaydetme ile birlikte çağrılır (Settings → Modeller → Efor seçici).
 */
export async function persistClaudeCodeFlags(
  flags: Partial<ClaudeCodeFlags>,
): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const existing = await loadConfigFile();
  const next: ConfigFile = {
    ...existing,
    claude_code_flags: {
      ...DEFAULT_FLAGS,
      ...(existing.claude_code_flags ?? {}),
      ...flags,
    },
  };
  const raw = JSON.stringify(next, null, 2) + "\n";
  await fs.writeFile(configPath(), raw, { encoding: "utf-8", mode: 0o600 });
}

/** Mevcut effort'u okur (Settings'te seçili göstermek için). */
export async function readClaudeCodeFlags(): Promise<ClaudeCodeFlags> {
  const file = await loadConfigFile();
  return { ...DEFAULT_FLAGS, ...(file.claude_code_flags ?? {}) };
}

/**
 * v15.7 (2026-05-25): Feature flags'i config.json'a yazar (merge).
 */
export async function persistFeatures(
  features: Partial<FeatureFlags>,
): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const existing = await loadConfigFile();
  const next: ConfigFile = {
    ...existing,
    features: { ...DEFAULT_FEATURES, ...(existing.features ?? {}), ...features },
  };
  const raw = JSON.stringify(next, null, 2) + "\n";
  await fs.writeFile(configPath(), raw, { encoding: "utf-8", mode: 0o600 });
}

/** Mevcut feature flags'leri okur. Eksik field'lar default ile doldurulur. */
export async function readFeatures(): Promise<FeatureFlags> {
  const file = await loadConfigFile();
  return { ...DEFAULT_FEATURES, ...(file.features ?? {}) };
}

/**
 * v15.8: rol başına backend'i config.json'a yazar (merge). Settings → Modeller'den
 * her ajan için API/Abonelik seçimi kaydedilir.
 */
export async function persistAgentBackends(
  backends: Partial<AgentBackends>,
): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const existing = await loadConfigFile();
  const next: ConfigFile = {
    ...existing,
    agent_backends: { ...DEFAULT_BACKENDS, ...(existing.agent_backends ?? {}), ...backends },
  };
  const raw = JSON.stringify(next, null, 2) + "\n";
  await fs.writeFile(configPath(), raw, { encoding: "utf-8", mode: 0o600 });
}

/** Mevcut rol-backend'lerini okur (migration uygulanmış). Settings'te göstermek için. */
export async function readAgentBackends(): Promise<AgentBackends> {
  return resolveAgentBackends(await loadConfigFile());
}
