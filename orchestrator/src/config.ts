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
import { modelForTier } from "./model-catalog.js";

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
   * Çoklu Ajan Seçimi (2026-06-09): develop akışında, niyet ≥2 GERÇEKTEN bağımsız (dosya paylaşmayan)
   * modüle bölünebiliyorsa, bunları izole git worktree'lerde PARALEL yazdırır (seri yerine → hız). Kapı
   * (module-parallel/independence) ayrıklığı zorlar; bölünemezse/ayrık değilse SERİ (fail-closed). Varsayılan
   * KAPALI → açık değilse normal akış hiç etkilenmez. Luke Alvoeiro tezi: paralel-yazma yalnız kanıtlı-bağımsız.
   */
  multi_agent_selection?: boolean;
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
  // NOT (2026-07-16): z.ai (GLM) sağlayıcısı KALDIRILDI (YZLLM kararı: "sadece claude abonelik
  // ve claude API kalsın"). secrets.json'da kalmış eski zai_* anahtarları okunmaz (zararsız).
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
   * Plan modu planını yazan model (YZLLM 2026-08-04: "plan moduna aldığımda planı Fable 5 yapsın").
   * Opsiyonel — BOŞSA bugünkü davranış aynen sürer (orkestrasyon iş türü → dengeli katman). Doluysa
   * plan üretimi/revizyonu bu modelle ve efor tavanı uygulanmadan koşar. Yalnız plan METNİNİ etkiler;
   * onaylanan planı UYGULAYAN fazlar her zamanki gibi kendi iş türlerinin katmanını kullanır.
   */
  plan_model?: string;
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
   * subprocess (CLI_ELIGIBLE_TAGS kapsamı — phase-5 + verify-feature + phase-8 +
   * parallel-module + gate-autofix; Faz 0 CLI'da phase-0.ts'in ayrı text-JSON yolundan geçer).
   * `claude` binary yoksa görünür hata + faz fail (API'ye sessizce düşülmez).
   * Aktifse `claude_code_flags.effort` CLI'a `--effort` olarak geçer.
   */
  claude_code_cli_enabled: boolean;
  /**
   * v15.13 (YZLLM isteği): MyCL açılışında claude CLI'yı otomatik güncelle (`claude update`,
   * non-blocking). `true` (default): her açılışta arka planda günceller. `false`: kapalı.
   * Resmi + güvenli işlem; hata yutulur, boot'u bloklamaz. Bkz claude-updater.ts.
   */
  auto_update_claude?: boolean;
  /**
   * v15.14 (YZLLM isteği 2026-06-20): "Over Engineering Kontrolü". `true` iken kod-yazan
   * fazlara (Faz 5/8/parallel-module/verify/gate-autofix) sessiz bir gereksiz-mühendislik
   * eleme talimatı enjekte edilir → ajan, o fazda GERÇEKTEN gerekeni düşünür, gold-plating /
   * erken soyutlama / istenmeyen özellik / spekülatif jenerikliği ATLAR (gerekli işi ASLA kesmez).
   * `false` (default): davranış değişmez. Settings'ten açılır/kapanır.
   */
  over_engineering_control?: boolean;
  /**
   * v15.15 (kendi-yeterlilik mekanizması): bağımsız MÜFETTİŞ (Sonnet, çapraz-aile) orkestratörü
   * checkpoint'lerde izler + kanıt-temelli tartışır (inspector.ts). `false` (default): kapalı —
   * orkestratör-döngüsü hiç etkilenmez. `true`: müdahale-seçimi (inspector-trigger) tetikleyince
   * müfettiş koşar. DENEYSEL, flag-arkası geliştirme.
   */
  inspector_enabled?: boolean;
  /**
   * Faz-Katkı Mahkemesi (YZLLM 2026-06-22): pipeline-end'de her fazın katkı yüzdesini mahkeme değerlendirir →
   * Türkçe rapor chat'e (kullanıcı gereksiz fazı görüp KENDİ budar). Tek runReasoning çağrısı; varsayılan AÇIK.
   */
  phase_contribution_report?: boolean;
  /**
   * Bağımsız DÜŞMAN TESTİ yazarı (adversarial-test.ts): Faz 8 yeşilinde kodu KIRMAYA çalışan ayrı bir ajan.
   * Güven-sağlamlaştırma (sahte-yeşil panzehiri) — varsayılan AÇIK. `false`: "hızlı mod" — atlanır (kuyruğu kısaltır,
   * ama düşman-test güvencesi düşer). YZLLM 2026-07-07 (zaman-kaybı planı): her Faz 8 yeşilinde 2. tam ajan koşuyordu.
   */
  adversarial_tester?: boolean;
  /**
   * Faz 9 PARALEL risk düzeltme (risk-fix-parallel.ts): ≥2 kod-fix İZOLE KOPYALARDA aynı anda koşulur (git'e
   * dokunulmaz), çakışan dosya çapraz-aile mahkemesiyle birleştirilir, konsolide test kırmızıysa seri (tam
   * test-odaklı) yola düşülür. Varsayılan AÇIK (YZLLM 2026-07-07 "varsayılan açık olsun"). `false`: her zaman seri.
   */
  parallel_risk_fixes?: boolean;
  /**
   * Advisor (danışman) — YZLLM 2026-07-11 ("Claude Code Advisor'ı ekle"): GÜVENLİ kalite-takviye modu.
   * `true` iken strong-ALTI CLI reasoning ajanları (mahkeme/müfettiş, tasarım fan-out) `claude --advisor <strong>`
   * ile güçlü (Opus) bir danışmana karar anlarında danışır — executor tier'i DEĞİŞMEZ (kaliteyi düşürmez, ek maliyet
   * + ek kalite). Yalnız CLI arka ucu + gerçek Anthropic + `claude` ≥ v2.1.98 + strong-altı executor'da
   * uygulanır; aksi halde sessizce-görünür atlanır (agent normal koşar). `false` (default): davranış değişmez.
   */
  advisor_enabled?: boolean;
  /**
   * Katman-Maliyet Raporu (YZLLM 2026-07-12): pipeline-end'de her doğrulama katmanının {süre, token, ne-yakaladı}
   * DETERMİNİSTİK olarak (LLM yok) chat'e basılır → kullanıcı çok maliyetli/az değerli katmanı görüp KENDİ budar
   * (otomatik budama YOK). Faz-Katkı Raporu'nun (faz düzeyi) katman-düzeyi kardeşi. Varsayılan AÇIK; sıcak yola dokunmaz.
   */
  layer_cost_report?: boolean;
  /**
   * codebase-memory-mcp (YZLLM 2026-07-13): hedef-proje YAPISAL kod grafiği (158 tree-sitter + 12 dil LSP) — codegen
   * ajanları grep yerine deterministik çağrı-zinciri/import/route/ölü-kod sorgular (~%99 token tasarrufu). Stdio MCP
   * server, Claude Code CLI'ye `--mcp-config` ile bağlanır (yalnız CLI backend; SDK yolu bu yoldan almaz). Opt-in
   * default KAPALI (dış bağımlılık; kurulamazsa görünür fallback → grep, KATI #4). Kurulum: `ensureCodebaseMemoryMcp`.
   */
  codebase_memory_mcp?: boolean;
  /**
   * cognee kalıcı çapraz-oturum hafızası (YZLLM 2026-07-13, Phase B): remember/recall/forget bilgi grafiği (gömülü
   * SQLite+Kuzu+LanceDB, Docker'sız); codegen ajanına --mcp-config ile bağlanır; LLM = MyCL sağlayıcısı
   * (anthropic — yalnız Claude). Opt-in default KAPALI (AĞIR: kaynak-klon+uv sync; salt-abonelik modunda key yok → görünür
   * fallback, KATI #4). Kurulum: `ensureCognee`. codebase-memory-mcp'nin (yapısal) semantik-kalıcı kardeşi.
   */
  cognee_memory?: boolean;
  /**
   * ⚡ Paralel iş kümeleme (YZLLM 2026-07-16, "orta yol"): kuyrukta ≥2 BAĞIMSIZ iş beklerken kod yazma
   * kısımları izole worktree'lerde PARALEL koşar, birleştirme sonrası kalite fazları 9-17 (risk incelemesi
   * + mekanik kapılar + E2E) birleşik sonuçta TEK SEFER koşar. Faz 6 (kullanıcı UI incelemesi) bu birleşik
   * koşuda otomatik AÇILMAZ — kullanıcıya görünür söylenir (mahkeme dürüstlük düzeltmesi; emsal
   * multi_agent_selection yalnız 10-17 koşuyordu, burada 9 da dahil). FAIL-CLOSED: git yok/kirli ağaç/
   * kapsam çakışması/worker hatası → GÖRÜNÜR sıralı akış (iş kaybolmaz). Opt-in default KAPALI. En çok 3 iş.
   */
  parallel_task_batching?: boolean;
}

const DEFAULT_FEATURES: FeatureFlags = {
  playwright_enabled: true,
  claude_code_cli_enabled: false,
  auto_update_claude: true,
  over_engineering_control: false,
  adversarial_tester: true,
  parallel_risk_fixes: true,
  // YZLLM 2026-06-21: "mahkeme varsayılan olarak açık olsun." Müfettiş↔orkestratör mahkemesi
  // varsayılan AÇIK (Ayarlar'dan kapatılabilir). Test config'leri inspector_enabled'ı kendileri
  // ayarlar (DEFAULT_FEATURES spread etmeyenler etkilenmez); gate/fix yollarındaki çağrı flag-arkası.
  inspector_enabled: true,
  phase_contribution_report: true,
  advisor_enabled: false, // opt-in (ek maliyet — kullanıcı kral); Ayarlar'dan açılır.
  layer_cost_report: true, // deterministik + ucuz (LLM yok); katman-maliyet görünürlüğü — kullanıcı budamayı KENDİ yapar.
  codebase_memory_mcp: false, // opt-in (dış bağımlılık: codebase-memory-mcp binary); Ayarlar'dan açılır, kurulamazsa grep fallback.
  cognee_memory: false, // opt-in (AĞIR dış bağımlılık: cognee Python kaynak+uv); Ayarlar'dan açılır, key/kurulum yoksa görünür fallback.
  parallel_task_batching: false, // opt-in (makine yükü + abonelik limiti); Ayarlar'dan açılır — fail-closed sıralı fallback.
};

/**
 * v15.8 (2026-05-31): Her ajan rolü ayrı ayrı API (Anthropic SDK) veya CLI
 * (Claude Code aboneliği — `claude` subprocess, oauthAccount auth, API faturası
 * YOK) ile koşabilir. "api" = mevcut SDK yolu (default, davranış korunur). "cli"
 * = `claude` CLI (abonelik). Eski `features.claude_code_cli_enabled:true` →
 * `main:"cli"` migration'ı resolveAgentBackends'te yapılır.
 */
/** Efektif (çözülmüş) backend — dispatch noktalarının tükettiği. Yalnız iki değer:
 *  "api" = Anthropic SDK (Claude API), "cli" = `claude` subprocess (Claude aboneliği).
 *  NOT (2026-07-16): "zai" (z.ai/GLM) sağlayıcısı KALDIRILDI — config'te kalmış eski
 *  "zai" seçimi resolveAgentBackends'te "api"ye göç ettirilir (z.ai zaten SDK yoluydu). */
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
// YZLLM 2026-06-12: "her zaman auto olsun — sistem hangisine ulaşabilirse onu çalıştırır." Varsayılan hepsi
// "auto" (eskiden "api"): CLI ile başla, abonelik limitliyse API'ye çöz (backendForRole/resolveAuto). Kullanıcı
// yine de UI'dan API/CLI'ye sabitleyebilir (kullanıcı ayarı kral) — bu yalnız out-of-the-box varsayılan.
const DEFAULT_BACKENDS: AgentBackends = {
  orchestrator: "auto",
  translator: "auto",
  main: "auto",
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
    // (claude_subprocess_spawn + claude_first_event KALDIRILDI — mahkeme denetimi 2026-07-11: 0 okuma,
    //  hiçbir kod bu değerleri kullanmıyordu. Eski config.json'larda kalmış anahtarlar zararsız yok sayılır.)
  };
  /** YZLLM 2026-06-13: kullanıcının kalıcı reddettiği model-upgrade id'leri (bir kez sor, "hayır"ı hatırla). */
  declined_model_upgrades: string[];
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
  // Çoklu Ajan Seçimi (2026-06-09): ≥2 bağımsız modülü paralel yazdırma. Default KAPALI (opt-in) →
  // açık değilse normal develop akışı hiç değişmez.
  multi_agent_selection: false,
  // v15.14 (F2): prompt cache ömrü default 5dk (mevcut davranış; geriye uyum). "1h" opt-in.
  cache_ttl: "5m",
  // v15.15: pre-hoc kör-nokta merceği — açık ama gate'li (yalnız consequential + geri-dönülemez;
  // tek ucuz tur; trivial atlanır; non-blocking). "off" ile tamamen kapatılır.
  blindspot_lens: "consequential",
};

const DEFAULT_TIMEOUTS = {
  translator: 30_000,
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

export interface ConfigFile {
  selected_models?: Partial<SelectedModels>;
  claude_code_flags?: ClaudeCodeFlags;
  agent_backends?: Partial<AgentBackends>;
  features?: Partial<FeatureFlags>;
  timeouts_ms?: Partial<MyclConfig["timeouts_ms"]>;
  /** YZLLM 2026-06-13: kullanıcının "Hayır, kalsın" dediği model-upgrade id'leri — KALICI
   *  (eskiden bellek-içiydi → her oturum tekrar soruyordu = "kafasına göre seçiyor" hissi). */
  declined_model_upgrades?: string[];
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
  // ZAMAN-KAYBI (YZLLM 2026-07-07, canlı trace kanıtı): relevance/dedup UCUZ bir sınıflandırma işi (chunk'ları
  // "alakalı mı" diye 0-10 puanla). Eskiden `?? main`e düşüyordu → `relevance` set değilse ana model (Opus 4.8) ile
  // koşup Faz 1 önsözünde ~27s yakıyordu. classifier.ts yorumu + TASK_RELEVANCE (classification → balanced) daha
  // ucuz model der. Artık `translator`a düş (dengeli/ucuz tier, Sonnet) → aynı iş çok daha hızlı, kalite tier'ı doğru.
  return models.relevance ?? models.translator ?? models.main;
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
 * Orkestrator agent model id. YZLLM 2026-06-12: orkestratör ajanı MERDİVEN DIŞI — beyin (karar/teşhis/routing)
 * rolü; düşük modelde başlayınca yanlış kök-neden/routing üretiyor (gözlemlendi: bir hata-analizi gerçek testleri
 * okumadan E2BIG/stub uydurdu). HER ZAMAN en yüksek KABUL EDİLEN model = `strong` tier (örn. Opus 4.8). Fable 5
 * gibi kabul EDİLMEMİŞ model strong'a yalnız kullanıcı onayı (adoption) ile girer → otomatik gelmez. modelForTier
 * config.model_tiers.strong'u (yoksa katalog default'u) çözer. Eski orchestrator/main override'ı artık kullanılmaz.
 */
export function orchestratorModelId(models: SelectedModels): string {
  return modelForTier("strong", models.model_tiers).id;
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
  // model_tiers ayarsız (legacy config) → iş-seviyesine göre KATALOG varsayılanı: balanced roller (ux/security/
  // data/hypothesis) Sonnet, strong roller (architect/synthesizer/verifier) Opus. Eski `models.main` fallback'i
  // TÜM rolleri Opus'a düşürüyordu (relevance-Opus ile AYNI sınıf bug; Faz 0 hipotez fan-out + Faz 5 tasarım paneli
  // gereksiz pahalıya koşuyordu). orchestratorModelId ile aynı `modelForTier` mekanizması → 
  return modelForTier(ROLE_TIER[role], models.model_tiers).id;
}

/**
 * Diskteki `selected_models`'ı runtime tipine çevirir. DİKKAT: bu bir AÇIK İZİN LİSTESİ — burada
 * sayılmayan alan diskte dursa bile runtime'a HİÇ ulaşmaz. Yeni bir opsiyonel model alanı eklerken
 * buraya da eklenmezse sessizce yok sayılır (test bunu kilitler). Export: saf, test edilebilir.
 */
export function resolveSelectedModels(file: ConfigFile): SelectedModels {
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
    ...(sel.plan_model ? { plan_model: sel.plan_model } : {}),
    ...(sel.subagent_models ? { subagent_models: sel.subagent_models } : {}),
    ...(sel.model_tiers ? { model_tiers: sel.model_tiers } : {}),
  };
}

/**
 * Rol başına backend'i çözer. Default hepsi "auto" (YZLLM 2026-06-12). Migration: eski
 * `features.claude_code_cli_enabled:true` + main backend'i explicit set değilse
 * → main:"cli" (geriye uyum; eski kullanıcının main-CLI tercihi korunur).
 */
export function resolveAgentBackends(file: ConfigFile): AgentBackends {
  const ab = file.agent_backends ?? {};
  const merged: AgentBackends = { ...DEFAULT_BACKENDS, ...ab };
  if (ab.main === undefined && file.features?.claude_code_cli_enabled === true) {
    merged.main = "cli";
  }
  // z.ai GÖÇÜ (2026-07-16, YZLLM: "z.ai'ı çıkar"): eski config'te kalmış "zai" seçimi
  // "api"ye çevrilir (z.ai zaten SDK/API yoluydu — kullanıcı Claude API'ye döner; sessiz
  // bilinmeyen-değer bırakılmaz). Kayıt dosyasına dokunulmaz; her okuma burada normalize olur.
  for (const role of ["orchestrator", "translator", "main"] as const) {
    if ((merged[role] as string) === "zai") merged[role] = "api";
  }
  return merged;
}

/**
 * Bir rol için EFEKTİF backend ("api" | "cli"). "auto" → runtime'da çözülür:
 * abonelik limiti aktifse "api", değilse "cli" (cli-rate-limit.ts). loadConfig her
 * zaman agent_backends'i doldurur; partial/cast config'lere karşı savunmacı — eksikse
 * "auto" (YZLLM 2026-06-12: varsayılan auto). Tek çözüm-noktası: 9 dispatch yeri bunu çağırır.
 */
export function backendForRole(config: MyclConfig, role: AgentRole): "api" | "cli" {
  const configured = config.agent_backends?.[role] ?? "auto";
  return resolveAuto(configured, configured === "auto" ? cliCurrentlyLimited() : false);
}

/** Rolün claude key'i. */
export function claudeKeyForRole(keys: ApiKeys, role: AgentRole): string {
  return role === "translator"
    ? keys.translator
    : role === "orchestrator"
    ? orchestratorApiKey(keys)
    : keys.main;
}

/** Merkezi LLM hedefi: rolün backend'i + key. (z.ai sağlayıcısı 2026-07-16'da kaldırıldı —
 *  yalnız Claude: "api" = Anthropic SDK, "cli" = abonelik.) */
export interface LlmTarget {
  backend: AgentBackend; // api | cli
  apiKey: string;
}

/**
 * MERKEZİ provider çözücü: rolün backend'ini + Claude key'ini TEK yerden döndürür.
 * Tüm LLM call-site'lar ham config.api_keys.* yerine bunu kullanmalı.
 */
export function resolveProvider(config: MyclConfig, role: AgentRole): LlmTarget {
  return {
    backend: backendForRole(config, role), // api | cli
    apiKey: claudeKeyForRole(config.api_keys, role),
  };
}

/** Rol Auto Mode'da mı (factory'ler görünür CLI→API fallback'i yalnız auto'da uygular). */
export function isAutoMode(config: MyclConfig, role: AgentRole): boolean {
  return (config.agent_backends?.[role] ?? "auto") === "auto";
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
    claude_code_flags: {
      ...DEFAULT_FLAGS,
      ...(fileConfig.claude_code_flags ?? {}),
      // SABİT (YZLLM 2026-06-22): bu 3 ayar kullanıcı-değiştirilemez (Settings'ten kaldırıldı) → her
      // config-yüklemede ZORLANIR (kayıtlı değer EZİLİR). create-only tasarım paneli + Çoklu Ajan Seçimi açık.
      design_workflow: "create-only",
      agent_teams_optin: false,
      multi_agent_selection: true,
    },
    agent_backends: resolveAgentBackends(fileConfig),
    features: { ...DEFAULT_FEATURES, ...(fileConfig.features ?? {}) },
    timeouts_ms: { ...DEFAULT_TIMEOUTS, ...(fileConfig.timeouts_ms ?? {}) },
    declined_model_upgrades: Array.isArray(fileConfig.declined_model_upgrades)
      ? fileConfig.declined_model_upgrades.filter((m): m is string => typeof m === "string")
      : [],
  };
}

/**
 * YZLLM 2026-06-13: kullanıcının "Hayır, kalsın" dediği model-upgrade id'sini KALICI kaydeder
 * (config.json declined_model_upgrades). Böylece keşif o modeli bir daha ASLA sormaz —
 * bellek-içi Set yalnız oturum süresince tutuyordu (her oturum yeniden dürtüyordu).
 */
export async function persistDeclinedModelUpgrade(model: string): Promise<void> {
  if (!model || typeof model !== "string") return;
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const existing = await loadConfigFile();
  const prev = Array.isArray(existing.declined_model_upgrades)
    ? existing.declined_model_upgrades.filter((m) => typeof m === "string")
    : [];
  if (prev.includes(model)) return; // zaten var → no-op
  const next: ConfigFile = { ...existing, declined_model_upgrades: [...prev, model] };
  const raw = JSON.stringify(next, null, 2) + "\n";
  await fs.writeFile(configPath(), raw, { encoding: "utf-8", mode: 0o600 });
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

export async function persistApiKeys(keys: Partial<ApiKeys>): Promise<void> {
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
 * SAF (IO'suz, test edilebilir) merge-validasyon: mevcut secrets + patch birleştiğinde kullanılabilir
 * Claude key'leri (translator+main) var mı? Kayıt bir PATCH'tir: persistApiKeys mevcut secrets'ı korur +
 * sadece dolu alanları merge'ler (boş alan mevcut key'i SİLMEZ). Boş string/undefined dolu sayılmaz.
 */
export function hasUsableKeys(existing: Partial<ApiKeys>, patch: Partial<ApiKeys>): boolean {
  const has = (v: string | undefined): boolean => !!v && v.trim().length > 0;
  return (has(patch.translator) || has(existing.translator)) && (has(patch.main) || has(existing.main));
}

export async function hasUsableKeysAfterMerge(patch: Partial<ApiKeys>): Promise<boolean> {
  const existing = await loadSecrets();
  return hasUsableKeys((existing.api_keys ?? {}) as Partial<ApiKeys>, patch);
}

/**
 * Seçili modelleri config.json'a yazar. Mevcut config'i merge'ler (claude_code_flags,
 * timeouts korunur).
 */
export async function persistSelectedModels(
  sel: SelectedModels,
  opts?: { clear?: Array<keyof SelectedModels> },
): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  const existing = await loadConfigFile();
  // MERGE (kod-analiz 2026-06-07): selected_models'ı tam-replace etme — UI payload relevance/
  // subagent_models taşımadığında bu alanlar sessizce silinip main'e düşüyordu. Alan-bazlı merge.
  const merged = mergeDefinedFields(
    existing.selected_models as Record<string, unknown> | undefined,
    sel as unknown as Record<string, unknown>,
  ) as Partial<SelectedModels>;
  // AÇIK TEMİZLEME (YZLLM 2026-08-04): merge boş değeri "koru" saydığı için opsiyonel bir alan bir kez
  // set edildikten sonra arayüzden GERİ ALINAMIYORDU. Plan modeli "boş bırakılırsa bugünkü davranış"
  // sözü bunu zorunlu kılıyor. Silme yalnız çağıranın AÇIKÇA istediği alanlarda olur — eksik payload
  // hâlâ hiçbir şeyi silmez (o korumanın kendisi bozulmuyor).
  for (const k of opts?.clear ?? []) delete merged[k];
  const next: ConfigFile = { ...existing, selected_models: merged };
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
  return {
    ...DEFAULT_FLAGS,
    ...(file.claude_code_flags ?? {}),
    // SABİT (YZLLM 2026-06-22): kullanıcı-değiştirilemez (Settings'ten kaldırıldı) — kayıtlı değer EZİLİR.
    design_workflow: "create-only",
    agent_teams_optin: false,
    multi_agent_selection: true,
  };
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
