// claude-api — Anthropic SDK doğrudan API. Subprocess YOK.
//
// Neden subprocess kaldırıldı?
// API key kullandığımız için `claude` CLI'ya ihtiyaç yok. SDK direkt:
//   - 1M context beta `betas: [...]` parameter ile (CLI'da warning veriyordu)
//   - AskUserQuestion'a benzer custom tool'lar tool_use definitions ile
//   - Multi-turn conversation in-process — bridge management yok
//   - Streaming via client.messages.stream(), full control
//
// Spec §5.3 yerine: bu modül conversation runner. Phase 1, 4, 9 hepsi
// kendi tool set'i, system prompt'u, gate logic'iyle bu wrapper'ı çağırır.

import Anthropic from "@anthropic-ai/sdk";
import {
  ZAI_BASE_URL,
  resolveProvider,
  zaiKeyForRole,
  type AgentRole,
  type MyclConfig,
} from "./config.js";
import { findModel, glmModelForTier } from "./model-catalog.js";
import { emitChatMessage, emitClaudeStream, recordTokenUsage } from "./ipc.js";
import { log } from "./logger.js";

/**
 * Claude (veya keyfi) model id'sini provider=z.ai turu için GEÇERLİ bir GLM modeline çevirir (z.ai Aşama 2 ⑤).
 * findModel ile DOĞRULAR (canlı-bug 2026-06-22): config'te eski/SAHTE bir `glm-` id'si kalmış olabilir
 * (örn. katalogdan silinen glm-4-plus) → körü körüne geçirmek z.ai 404'üne yol açar. Kurallar:
 *  - katalogdaki GERÇEK GLM modeli → kendisi (kullanıcı dropdown'dan seçti)
 *  - tanınan claude modeli → tier-eş GLM (strong→glm-5.2, balanced→glm-4.6, cheap→glm-4.5-air)
 *  - tanınmayan (boş/sahte-glm/bilinmeyen) → tier'dan güvenli GLM (balanced) — 404 önlenir
 */
function glmModelFor(model: string | undefined): string {
  const known = model ? findModel(model) : undefined;
  if (known?.id.startsWith("glm-")) return known.id;
  return glmModelForTier(known?.tier ?? "balanced");
}

/**
 * Anthropic API error'ını kullanıcıya gösterilecek **Türkçe + anlamlı** mesaja
 * çevirir. SDK error body'sini parse eder; tanımlı error tiplerini özel mesaja,
 * tanımsız olanları ham mesaja düşürür. request_id varsa ekler.
 *
 * Tipik error body:
 *   {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_..."}
 */
export function humanizeAnthropicError(err: unknown): string {
  const raw = String(err);

  // request_id'yi çıkar (debug için kullanıcıya gösterilir)
  const reqIdMatch = raw.match(/"request_id":"(req_[^"]+)"/);
  const reqId = reqIdMatch ? ` (request_id=${reqIdMatch[1].trim()})` : "";

  // error type'ı çıkar
  const typeMatch = raw.match(/"error":\{[^}]*?"type":"([^"]+)"/);
  const errorType = typeMatch?.[1];

  switch (errorType) {
    case "overloaded_error":
      return `Anthropic API geçici olarak aşırı yüklü (overloaded_error). Birkaç dakika sonra tekrar deneyin.${reqId}`;
    case "rate_limit_error":
      return `Anthropic API rate limit aşıldı. Bir süre bekleyip tekrar deneyin.${reqId}`;
    case "authentication_error":
      return `Anthropic API anahtarı geçersiz veya yetersiz. Ayarlar → API Keys'i kontrol edin.${reqId}`;
    case "permission_error":
      return `Anthropic API anahtarınız bu modele veya beta'ya erişim izni vermiyor.${reqId}`;
    case "not_found_error":
      return `Anthropic API: istek hedefi bulunamadı (yanlış model id?).${reqId}`;
    case "invalid_request_error": {
      const msgMatch = raw.match(/"error":\{[^}]*?"message":"([^"]+)"/);
      return `Anthropic API isteği geçersiz: ${msgMatch?.[1] ?? "(detay yok)"}${reqId}`;
    }
    case "api_error":
      return `Anthropic API sunucu hatası.${reqId}`;
    case undefined:
      // Anthropic dışı: network, timeout, vs.
      return `Claude API çağrısı başarısız: ${raw.slice(0, 200)}`;
    default:
      return `Anthropic API hatası (${errorType}).${reqId}`;
  }
}

/**
 * HESAP/ORTAM hatası mı? (YZLLM 2026-06-11: kredi bitti → MyCL Faz 8 başarısızlığı sanıp modeli opus·max'a tırmandırdı
 * + analiz denedi, ikisi de daha fazla API çağrısı = aynı hata.) Kredi/bakiye yetersiz, fatura, auth/permission,
 * kota — bunlar PROJE hatası DEĞİL, model zayıflığı DEĞİL. Her API çağrısı bu hatayı verir → escalation/analiz
 * ANLAMSIZ. Caller: dur + net söyle ("kredi yükle"), tırmanma/analiz/fix YAPMA. SAF.
 */
export function isApiAccountError(text: string): boolean {
  return /credit balance|too low to access|purchase credits|plans ?& ?billing|\bbilling\b|insufficient (credit|quota|fund|balance)|quota (exceeded|exhausted)|authentication_error|anahtarı geçersiz veya yetersiz|erişim izni vermiyor|permission_error/i.test(
    text,
  );
}

/**
 * ORTAM hatası mı? (YZLLM 2026-06-11: "sadece PROJE hatalarında tırman".) Hesap/kredi (isApiAccountError) + dev-ortam
 * (E2BIG/env çok büyük, port dolu, komut yok, spawn) — bunlar model zayıflığı DEĞİL → escalation merdiveni tırmanmamalı
 * (daha güçlü/pahalı model bu hatayı çözmez). Yalnız genuine proje/kod hatasında tırman. SAF.
 */
export function isEnvironmentError(text: string): boolean {
  if (isApiAccountError(text)) return true;
  // OS/kaynak errno'ları (YZLLM 2026-06-22, tıkanma-envanteri): OOM/disk-dolu/fd-limiti/izin/symlink-döngü
  // — bunlar PROJE kodu hatası DEĞİL (kod kurcalayarak çözülmez) ve mechanical-runner.isSpawnEnvFailure bunları
  // zaten tanıyordu ama merkezi text-sınıflandırıcı KAÇIRIYORDU → faz-hatası proje-fix döngüsüne sızıyordu.
  // Yanlış-pozitif riski düşük (errno'lar test-iddiası metninde nadir) + sonuç SESLİ escalate (sessiz stall değil).
  return /E2BIG|argument list too long|EADDRINUSE|address already in use|port \d+.*(in use|busy|kullan)|spawn \w+ ENOENT|command not found|: not found|EACCES|\bEPERM\b|ECONNREFUSED|ENOTFOUND|\bENOMEM\b|\bENOSPC\b|\bEMFILE\b|\bENFILE\b|\bEAGAIN\b|\bELOOP\b|out of memory|no space left|too many open files|\[ENV\] (command timed out|spawn failed)/i.test(
    text,
  );
}

/** Ortam hatasına özel Türkçe rehber (proje hatası değil — döngüye girmeden kullanıcıya ne yapacağını söyle). SAF. */
export function environmentErrorAdvice(text: string): string {
  if (/E2BIG|argument list too long/i.test(text)) {
    return "Ortam değişkenleri (env) çok büyük → işlem başlatılamadı (E2BIG). Bu bir PROJE hatası DEĞİL. MyCL'i yeni bir terminal/oturumda yeniden açın (env'i küçültür), sonra 'Çalıştır' ile devam edin.";
  }
  if (/EADDRINUSE|address already in use|port \d+.*(in use|busy|kullan)/i.test(text)) {
    return "Port dolu (başka bir süreç kullanıyor) — proje hatası DEĞİL. Portu tutan süreci kapatın (ya da dev sunucusu otomatik boş port seçecek), sonra 'Çalıştır' ile devam edin.";
  }
  if (/command not found|: not found|spawn \w+ ENOENT/i.test(text)) {
    return "Gerekli bir araç/komut kurulu değil (ortam eksiği, proje hatası DEĞİL). Aracı kurun, sonra 'Çalıştır' ile devam edin.";
  }
  if (/ECONNREFUSED|ENOTFOUND/i.test(text)) {
    return "Ağ/bağlantı sorunu (ortam, proje hatası DEĞİL). Bağlantıyı kontrol edip 'Çalıştır' ile devam edin.";
  }
  if (/\bENOSPC\b|no space left/i.test(text)) {
    return "Diskte yer kalmadı (ENOSPC) — proje hatası DEĞİL. Disk alanı açın, sonra 'Çalıştır' ile devam edin.";
  }
  if (/\bENOMEM\b|out of memory|\bEAGAIN\b/i.test(text)) {
    return "Sistem kaynağı tükendi (bellek/proses — ENOMEM/EAGAIN), proje hatası DEĞİL. Ağır süreçleri kapatıp belleği boşaltın, sonra 'Çalıştır' ile devam edin.";
  }
  if (/\b(EMFILE|ENFILE)\b|too many open files/i.test(text)) {
    return "Açık dosya tanıtıcısı limiti aşıldı (EMFILE) — proje hatası DEĞİL. Süreçleri azaltın ya da `ulimit -n` artırın, sonra 'Çalıştır' ile devam edin.";
  }
  if (/\bEPERM\b/i.test(text)) {
    return "İzin reddedildi (EPERM — işletim sistemi/sandbox/TCC) — proje hatası DEĞİL. Gerekli izni verin, sonra 'Çalıştır' ile devam edin.";
  }
  if (/\bELOOP\b/i.test(text)) {
    return "Sembolik bağlantı döngüsü (ELOOP) — proje hatası DEĞİL. Bozuk symlink'i düzeltin, sonra 'Çalıştır' ile devam edin.";
  }
  if (/\[ENV\] command timed out|command timed out \/ process killed/i.test(text)) {
    return "Gate komutu zaman aşımına uğradı / süreç asıldı (çıkış kodu yok). Bu genelde ORTAM sorunudur (yavaş makine / ağır yük / asılan araç) — ama asılan bir test PROJE kaynaklı sonsuz döngü de olabilir. Kör otomatik düzeltme YAPMADIM (asılmayı çözmez, sahte-yeşile kaydırabilir). Yükü azaltıp tekrar deneyin; sürerse asılan komutu elle inceleyin.";
  }
  if (/\[ENV\] spawn failed/i.test(text)) {
    return "Komut başlatılamadı (spawn faultu — bellek/işlem kaynağı). Proje hatası DEĞİL. Ağır süreçleri kapatıp 'Çalıştır' ile devam edin.";
  }
  return "Bu bir ORTAM sorunu (proje/kod hatası DEĞİL) — kod kurcalayarak çözülmez. Ortamı düzeltip 'Çalıştır' ile devam edin. Otomatik tırmanma/düzeltme YAPMADIM (boşuna olurdu).";
}

/**
 * Hatanın geçici (transient) olup olmadığını döndürür. Transient hatalar
 * exponential backoff ile retry edilir; kalıcı hatalar (auth, permission,
 * invalid_request) anında bubble up eder. Translator pattern'ı (translator.ts)
 * ile tutarlı; orada da overloaded + rate_limit + 5xx retry'lı.
 */
function isTransientError(err: unknown): boolean {
  const raw = String(err);
  const typeMatch = raw.match(/"error":\{[^}]*?"type":"([^"]+)"/);
  const type = typeMatch?.[1];
  if (
    type === "overloaded_error" ||
    type === "rate_limit_error" ||
    type === "api_error"
  ) {
    return true;
  }
  // Anthropic SDK'nın bazen "error" payload'ı olmadan network/timeout hatası
  // fırlatması mümkün — string match ile yakala (defensive). KÖK FİX (kod-analiz 2026-06-07):
  // SDK 0.102'nin APIConnectionTimeoutError/APIConnectionError'ı + "Request timed out" eklendi;
  // eskiden bunlar NON-transient sayılıp uzun Opus/ultracode turu attempt 1'de sert fail ediyordu.
  if (
    /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|timed out|Request timed out|Connection error|APIConnectionError|APIConnectionTimeoutError/i.test(
      raw,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * TEK Anthropic SDK client factory'si (kod-analiz 2026-06-07). SDK 0.102'nin kısa-default-timeout
 * regresyonu list_models'ı (models.ts) vurmuştu ama runTurn/translator/conversation-context hâlâ
 * açıktı; tek yerde topla ki bir daha yarım yamanmasın. Varsayılan timeout uzun turlar için cömert;
 * dış retry loop'u olan çağrı (runTurn) `maxRetries:0` geçer (çift-retry önler).
 */
export function makeAnthropicClient(
  apiKey: string,
  opts?: { timeoutMs?: number; maxRetries?: number; betas?: readonly string[]; baseURL?: string },
): Anthropic {
  return new Anthropic({
    apiKey,
    // z.ai (GLM) gibi Anthropic-uyumlu sağlayıcılar: baseURL override → AYNI SDK, AYNI protokol
    // (tool_use/system/cache_control birebir). Adapter YOK. undefined → Anthropic default endpoint.
    ...(opts?.baseURL ? { baseURL: opts.baseURL } : {}),
    timeout: opts?.timeoutMs ?? 600_000,
    maxRetries: opts?.maxRetries ?? 3,
    defaultHeaders:
      opts?.betas && opts.betas.length > 0
        ? { "anthropic-beta": opts.betas.join(",") }
        : undefined,
  });
}

/**
 * Sağlayıcı-aware SDK client (z.ai Aşama 2 ⑤b) — runTurn DIŞINDA `makeAnthropicClient`'ı doğrudan
 * kullanan raw-SDK siteleri için (translator/llm-reasoning/error-analysis/intake/...). resolveProvider
 * ile rolü çözer: Sağlayıcı=Z.AI ise z.ai key+endpoint+GLM model döner (betas strip); claude ise GEÇEN
 * `apiKey` AYNEN korunur + model değişmez → sıfır regresyon (kritik-path güvenliği). Dönen `model`'i
 * `messages.create({ model })`'a geçir. NOT: bu yol claude→z.ai auto-fallback YAPMAZ (yalnız runTurn yapar);
 * birincil sağlayıcı seçimini uygular.
 */
export function resolveLlmClient(
  config: MyclConfig,
  role: AgentRole,
  apiKey: string,
  model: string,
  opts?: { timeoutMs?: number; maxRetries?: number; betas?: readonly string[] },
): { client: Anthropic; model: string; isZai: boolean } {
  const prov = resolveProvider(config, role);
  const isZai = prov.isZai;
  const client = makeAnthropicClient(isZai ? prov.apiKey : apiKey, {
    timeoutMs: opts?.timeoutMs,
    maxRetries: opts?.maxRetries,
    betas: isZai ? undefined : opts?.betas,
    baseURL: prov.baseURL, // claude → undefined (Anthropic default)
  });
  return { client, model: isZai ? glmModelFor(model) : model, isZai };
}

/**
 * Forced-CLI siteleri için sağlayıcı-aware CLI parametreleri (z.ai Aşama 2 ⑥). `runClaudeCli`'yi (claude
 * subprocess) doğrudan kullanan + backendForRole(zai)→"api" yüzünden SDK yoluna düşmeyen yollar için
 * (visual-design/debate/module-stock/living-docs/devs-spec-refresh/parallel-codegen). Rolün Sağlayıcı=Z.AI
 * seçimi varsa: claude CLI'yi z.ai endpoint'ine yönlendiren extraEnv (ANTHROPIC_BASE_URL+AUTH_TOKEN+API_KEY)
 * + GLM model döner; claude ise extraEnv=undefined + model değişmez (sıfır regresyon). CANLI DOĞRULANDI
 * (2026-06-22): `claude -p` + bu env → z.ai GLM yanıt verdi. NOT: müfettiş (inspector) BİLEREK çapraz-aile
 * (claude) kalır — bu helper'ı oraya UYGULAMA (z.ai-main'de bile bağımsız aile gerek).
 */
export function resolveCliProvider(
  config: MyclConfig,
  role: AgentRole,
  model: string,
): { extraEnv?: Record<string, string>; model: string } {
  const prov = resolveProvider(config, role);
  if (prov.isZai && prov.apiKey) {
    const base = prov.baseURL ?? ZAI_BASE_URL;
    return {
      extraEnv: {
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_AUTH_TOKEN: prov.apiKey,
        ANTHROPIC_API_KEY: prov.apiKey,
      },
      model: glmModelFor(model),
    };
  }
  return { model };
}


// Anthropic API "Overloaded" (529) yoğun günlerde sık görülüyor. Phase 6 fix
// turn'leri uzun + paralel kullanım yüksek → daha sabırlı retry kullanıcı için
// daha az "API geçici yoğun" mesajı görür. 1s, 3s, 9s, 18s, 36s ≈ 67s toplam.
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;
const RETRY_DELAYS_MS = [1000, 3000, 9000, 18000, 36000];

export type Role = "user" | "assistant";

export interface ApiMessage {
  role: Role;
  content: Anthropic.MessageParam["content"];
}

/**
 * Tool definition — Claude API'nin tool format'ı.
 * `input_schema` JSON Schema; model bunu doldurarak tool_use yayar.
 */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Stream event handler — runner her event'te çağırır.
 * Tip-discriminated:
 *   - text: incremental assistant text
 *   - tool_use: model'in tool çağrısı (input parsed JSON)
 *   - message_start / message_end: mesaj sınırları
 *   - finalize: turn tamamen bitti (stop_reason ile)
 */
export type StreamHandlerEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "message_start" }
  | { type: "message_end"; stop_reason?: string };

export type StreamHandler = (ev: StreamHandlerEvent) => void | Promise<void>;

export interface RunTurnOptions {
  /** Tüm önceki + şimdiki user message'lar conversation history. */
  messages: ApiMessage[];
  /**
   * String verirsen runTurn otomatik olarak tek bir text block'a sarar ve
   * `cache_control: ephemeral` ekler → prompt caching aktif. Detaylı kontrol
   * gerekirse direkt TextBlockParam[] de geçilebilir (advanced).
   */
  system: string | Array<Anthropic.TextBlockParam>;
  model: string;
  max_tokens?: number;
  temperature?: number;
  tools?: ToolDef[];
  /**
   * Tool seçim zorlaması. Default `auto` (model serbest karar verir).
   * - `{type:"any"}`: model herhangi bir tool çağırmak ZORUNDA (düz metin yok)
   * - `{type:"tool", name:"X"}`: spesifik tool X çağırmak ZORUNDA
   * Strict JSON output gereken classifier/extractor call'ları için kritik;
   * tool_choice set edilmezse küçük modeller (Haiku) end_turn'le düz metin
   * dönerek tool_use yaymayabilir.
   */
  tool_choice?: { type: "auto" | "any" } | { type: "tool"; name: string };
  betas?: string[];
  /** Tool result vermeden conversation finalize ediliyorsa stop_reason burada. */
  stopOnToolUse?: boolean;
  /**
   * Escalation efor override (YZLLM 2026-06-11): set ise `config.claude_code_flags.effort` YERİNE bu kullanılır →
   * API modunda da merdiven eforu (low→medium→high→xhigh→max) `output_config.effort`'a yansır (CLI paritesi).
   */
  effortOverride?: string;
  /** Anthropic-uyumlu sağlayıcı endpoint override (z.ai/GLM). undefined → Anthropic. */
  baseURL?: string;
  /** Bu tur z.ai/GLM mi (provider=zai). true → betas strip (GLM Anthropic-beta'yı bilmez). */
  isZai?: boolean;
  /**
   * Ajan rolü (z.ai Aşama 2 ⑤): verilirse runTurn merkezi `resolveProvider` ile sağlayıcıyı çözer —
   * o rolün Sağlayıcı=Z.AI seçimi varsa çağrı GLM'e yönlenir (key+endpoint+model otomatik). Verilmezse
   * davranış aynen (geçen apiKey+model claude'a gider). claude→z.ai fallback'ı da rolün z.ai key'ini kullanır.
   */
  role?: AgentRole;
}

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  /** Prompt caching aktifse: bu turda cache'e yazılan token miktarı (ilk turn). */
  cache_creation_input_tokens?: number;
  /** Prompt caching aktifse: bu turda cache'ten okunan token miktarı (turn 2+). */
  cache_read_input_tokens?: number;
}

export interface TurnResult {
  /** Tam assistant mesaj content (tool_use bloklar dahil). History'ye eklenmek için. */
  assistantContent: Anthropic.MessageParam["content"];
  stop_reason: string | null;
  usage: TurnUsage;
  /** Bu turda yayılan tool_use'lar — caller'in tool_result yazması için. */
  toolUses: Array<{ id: string; name: string; input: unknown }>;
}

export class ClaudeApiError extends Error {
  override readonly name = "ClaudeApiError";
}

/** Legacy (adaptive-öncesi model) ultracode API modunda extended-thinking budget (token). */
export const ULTRACODE_THINKING_BUDGET = 16000;
/** Adaptive yolda max_tokens tabanı — derin düşünmeye yer aç (yalnız TAVAN; üretilmeyen token ücretsiz). */
export const ADAPTIVE_MAX_TOKENS_FLOOR = 32000;

type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORT_LEVELS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

export interface ThinkingPlan {
  /** Adaptive (Opus 4.7+) VEYA enabled-budget (eski model ultracode). */
  thinking?: { type: "adaptive" } | { type: "enabled"; budget_tokens: number };
  /** Yalnız adaptive yolda — output effort seviyesi (thinking:adaptive ile etkili). */
  output_config?: { effort: EffortLevel };
  /** Effektif max_tokens. */
  max_tokens: number;
  /** Extended/adaptive thinking temperature unset/1 ister → caller temperature GÖNDERMEZ. */
  dropTemperature: boolean;
}

/**
 * Model adaptive-thinking + output_config.effort destekliyor mu (Opus 4.7+).
 * Opus 4.8 (MyCL varsayılanı) `thinking:{type:"enabled",budget_tokens}`'i 400 ile REDDEDER →
 * adaptive ZORUNLU. Eski modeller (opus 4.6/4.5/.., sonnet, haiku) budget_tokens'ı kabul eder →
 * legacy yol (mevcut davranış korunur). İleriye-dönük: opus-4-(7+) regex + mythos preview.
 */
export function modelSupportsAdaptive(model: string): boolean {
  const m = (model ?? "").toLowerCase();
  if (m.includes("mythos")) return true;
  const opus = m.match(/opus-4-(\d+)/);
  if (opus) return Number(opus[1]) >= 7;
  return false;
}

/**
 * SAF (test edilebilir): prompt cache_control bloğu (F2). flags.cache_ttl="1h" → 1 saatlik
 * TTL (uzun koşularda cache-hit ↑, maliyet ↓); aksi → 5dk (varsayılan, ttl alanı yok = mevcut
 * davranış). SDK 0.102+ `cache_control.ttl: "5m"|"1h"` destekler (beta header gerekmez).
 */
export function buildCacheControl(flags?: {
  cache_ttl?: "5m" | "1h";
}): { type: "ephemeral"; ttl?: "1h" } {
  return flags?.cache_ttl === "1h"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };
}

/**
 * SAF (test edilebilir): effort + tool_choice + model'den API thinking/effort planı.
 * ADAPTIVE (Opus 4.7+): forced-OLMAYAN call'larda `thinking:{type:"adaptive"}` + `output_config.effort`
 *   (ultracode → "max"); FORCED (classifier/extractor) → İKİSİ DE YOK (mevcut davranış = 0 risk; effort
 *   zaten yalnız adaptive ile etkili, forced'ta adaptive yasak). max_tokens tavanı yükseltilir (ücretsiz).
 * LEGACY (eski model): mevcut davranış BİREBİR — ultracode+!forced → budget_tokens enabled; aksi boş.
 */
export function thinkingConfigFor(
  effort: string | undefined,
  toolChoice: { type: string } | undefined,
  baseMaxTokens: number,
  supportsAdaptive: boolean,
): ThinkingPlan {
  const forced = toolChoice?.type === "any" || toolChoice?.type === "tool";

  if (supportsAdaptive) {
    if (forced) return { max_tokens: baseMaxTokens, dropTemperature: false };
    const eff: EffortLevel | undefined =
      effort === "ultracode"
        ? "max"
        : effort && EFFORT_LEVELS.has(effort)
          ? (effort as EffortLevel)
          : undefined;
    if (!eff) return { max_tokens: baseMaxTokens, dropTemperature: false };
    return {
      thinking: { type: "adaptive" },
      output_config: { effort: eff },
      max_tokens: Math.max(baseMaxTokens, ADAPTIVE_MAX_TOKENS_FLOOR),
      dropTemperature: true,
    };
  }

  // Legacy (adaptive-öncesi modeller) — mevcut davranış korunur (regresyon yok).
  if (effort === "ultracode" && !forced) {
    const budget = ULTRACODE_THINKING_BUDGET;
    return {
      thinking: { type: "enabled", budget_tokens: budget },
      max_tokens: Math.max(baseMaxTokens, budget + 4096),
      dropTemperature: true,
    };
  }
  return { max_tokens: baseMaxTokens, dropTemperature: false };
}

/**
 * Tek bir API turunu stream eder. Tool_use yayılırsa caller tool_result
 * yazıp aynı conversation history ile tekrar çağırarak multi-turn devam eder.
 */
// Tek-tur (tek sağlayıcı). runTurn (aşağıda) bunu önce claude, gerekirse z.ai ile sarar.
async function runTurnOnce(
  config: MyclConfig,
  apiKey: string,
  opts: RunTurnOptions,
  onEvent: StreamHandler,
): Promise<TurnResult> {
  // Dış retry loop (MAX_RETRY_ATTEMPTS, isTransientError) zaten var → SDK kendi retry'ını
  // KAPAT (maxRetries:0) ki çift-retry olmasın; timeout uzun Opus/ultracode turları için cömert.
  const client = makeAnthropicClient(apiKey, {
    timeoutMs: 600_000,
    maxRetries: 0,
    // z.ai/GLM Anthropic-beta header'larını (context-1m/prompt-caching vb.) BİLMEZ → strip.
    // thinking/effort KALIR: GLM'in Deep Think'i (thinking:{type:enabled}+reasoning_effort)
    // Anthropic'in param şeklini birebir yansıtır → endpoint map'ler.
    betas: opts.isZai ? undefined : opts.betas,
    baseURL: opts.baseURL, // z.ai/GLM → Anthropic-uyumlu endpoint
  });

  log.info("claude-api", "runTurn", {
    model: opts.model,
    messages_count: opts.messages.length,
    has_tools: !!opts.tools?.length,
    betas: opts.betas,
  });

  const startTs = Date.now();

  // Prompt caching: caller string verirse otomatik tek text block'a sarıp
  // cache_control:ephemeral ekle. Sonraki turn'lerde aynı system → cache hit.
  // Bu hesaplamalar attempt'lere bağımlı değil, dış scope'ta bir kez.
  const systemParam: Array<Anthropic.TextBlockParam> = typeof opts.system === "string"
    ? [
        {
          type: "text" as const,
          text: opts.system,
          cache_control: buildCacheControl(config.claude_code_flags),
        },
      ]
    : opts.system;

  // Tools cache_control: Anthropic kuralı — son tool'a cache_control koyunca
  // tüm tools listesi tek block olarak cache'lenir. Tools listesi faz boyunca
  // sabit olduğu için cache invalidate olmaz; system'le birlikte refresh.
  const toolsParam: Anthropic.Tool[] | undefined = opts.tools && opts.tools.length > 0
    ? (opts.tools.map((t, i) =>
        i === opts.tools!.length - 1
          ? { ...t, cache_control: buildCacheControl(config.claude_code_flags) }
          : t,
      ) as unknown as Anthropic.Tool[])
    : undefined;

  // Effort/thinking (F3): Opus 4.7+ → adaptive thinking + output_config.effort (eski
  // budget_tokens yolu Opus 4.8'de 400 verir); eski modeller → legacy budget yolu. Forced
  // tool_choice (any/tool) → thinking YOK (mevcut davranış). ultracode → effort:"max" + reminder.
  // ultracode DIŞI effort ARTIK API'ye geçer (eskiden sessizce düşüyordu).
  // Escalation: opts.effortOverride set ise (merdiven aktif) config eforunu EZER → API'da da efor tırmanır.
  const effort = opts.effortOverride ?? config.claude_code_flags?.effort;
  const thinkingPlan = thinkingConfigFor(
    effort,
    opts.tool_choice,
    opts.max_tokens ?? 4096,
    modelSupportsAdaptive(opts.model),
  );
  const systemEffective: Array<Anthropic.TextBlockParam> =
    effort === "ultracode"
      ? [
          ...systemParam,
          {
            type: "text" as const,
            text:
              "Ultracode mode is ON: reason deeply and exhaustively before acting. " +
              "Prefer thoroughness, correctness, and full edge-case coverage over speed.",
          },
        ]
      : systemParam;

  // Retry loop: transient hatalar (overloaded, rate_limit, api_error, network)
  // exponential backoff ile yeniden denenir. Translator pattern'ı (translator.ts
  // attempts:1 log'da görünür) ile tutarlı. Relevance call'ları için kritik:
  // "MyCL unutmaz" iddiası fail-safe sentinel'e düşürülmemeli.
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    // State her attempt'te temiz başlar — önceki attempt'in kısmi sonuçları
    // taşınmaz (stream yarıda kesilmiş olabilir).
    const toolUses: TurnResult["toolUses"] = [];
    let stop_reason: string | null = null;
    let usage: TurnUsage = { input_tokens: 0, output_tokens: 0 };

    try {
      const stream = client.messages.stream({
        model: opts.model,
        max_tokens: thinkingPlan.max_tokens,
        // Extended thinking aktifken temperature unset (API kuralı: 1/unset).
        temperature: thinkingPlan.dropTemperature ? undefined : opts.temperature,
        system: systemEffective,
        messages: opts.messages,
        tools: toolsParam,
        tool_choice: opts.tool_choice as
          | Anthropic.MessageCreateParams["tool_choice"]
          | undefined,
        ...(thinkingPlan.output_config ? { output_config: thinkingPlan.output_config } : {}),
        ...(thinkingPlan.thinking ? { thinking: thinkingPlan.thinking } : {}),
      });

      // Stream event'lerini handler'a feed et.
      stream.on("text", (delta: string) => {
        void Promise.resolve(onEvent({ type: "text_delta", text: delta })).catch(
          (err) => log.error("claude-api", "handler text threw", err),
        );
      });

      stream.on("message", (_msg: Anthropic.Message) => {
        void Promise.resolve(onEvent({ type: "message_start" })).catch(() => {});
      });

      stream.on("inputJson", (_partial, snapshot) => {
        // Her tool_use input chunk'ında — biz final mesajdan alacağız.
        void snapshot; // unused
      });

      const finalMessage = await stream.finalMessage();
      stop_reason = finalMessage.stop_reason ?? null;
      // SDK usage shape: prompt-caching beta aktifken cache_creation_input_tokens
      // ve cache_read_input_tokens da gelir. SDK tipi henüz expose etmiyor olabilir
      // → bilinçli `as` ile okuyoruz; yoksa undefined.
      const rawUsage = finalMessage.usage as Anthropic.Usage & {
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      };
      usage = {
        input_tokens: rawUsage.input_tokens,
        output_tokens: rawUsage.output_tokens,
        cache_creation_input_tokens: rawUsage.cache_creation_input_tokens ?? undefined,
        cache_read_input_tokens: rawUsage.cache_read_input_tokens ?? undefined,
      };
      // UI banner'ına token usage gönder — cumulative toplamı App.tsx tutuyor.
      emitClaudeStream({
        sub: "token_usage",
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
        },
        model: opts.model,
      });
      // v15.7 (2026-05-26): Session-wide token totals accumulator (madde 13).
      // F1: model ekle (per-model döküm). API yolu USD vermez → total_cost_usd undefined
      // (uydurma $ yok). cache token'ları zaten usage'da.
      recordTokenUsage({ ...usage, model: opts.model });

      // Tool_use blocklarını topla.
      for (const block of finalMessage.content) {
        if (block.type === "tool_use") {
          toolUses.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
          await Promise.resolve(
            onEvent({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            }),
          ).catch((err) =>
            log.error("claude-api", "handler tool_use threw", err),
          );
        }
      }

      await Promise.resolve(
        onEvent({ type: "message_end", stop_reason: stop_reason ?? undefined }),
      ).catch(() => {});

      log.info("claude-api", "turn done", {
        stop_reason,
        tool_uses: toolUses.length,
        elapsed_ms: Date.now() - startTs,
        attempt,
        usage,
      });

      return {
        assistantContent: finalMessage.content as Anthropic.MessageParam["content"],
        stop_reason,
        usage,
        toolUses,
      };
    } catch (err) {
      log.warn("claude-api", `attempt ${attempt}/${MAX_RETRY_ATTEMPTS} failed`, err);

      // Kalıcı hata (auth, permission, invalid_request) veya son attempt → fail.
      if (!isTransientError(err) || attempt === MAX_RETRY_ATTEMPTS) {
        log.error("claude-api", "turn failed (final)", err);
        const userMsg = humanizeAnthropicError(err);
        emitChatMessage("error", userMsg);
        throw new ClaudeApiError(userMsg);
      }

      // Transient → custom backoff curve (1s, 3s, 9s, 18s, 36s) ile retry.
      // RETRY_BASE_MS legacy fallback (RETRY_DELAYS_MS index out of bounds).
      const backoffMs =
        RETRY_DELAYS_MS[attempt - 1] ??
        RETRY_BASE_MS * Math.pow(2, attempt - 1);
      log.info("claude-api", "transient error — retrying", {
        attempt,
        next_attempt: attempt + 1,
        backoff_ms: backoffMs,
      });
      emitClaudeStream({
        sub: "retry",
        text: `Anthropic geçici hata (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}); ${backoffMs / 1000}sn sonra tekrar deneniyor…`,
      });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // For loop her path'ten ya return ya throw eder; bu satıra ulaşılmaz.
  // TS exhaustive narrow için defensive throw.
  throw new ClaudeApiError("runTurn retry loop exhausted unexpectedly");
}

/**
 * Fallback ladder'ın 3. halkası (claude-CLI → claude-API → z.ai). runTurn'ü claude ile dener;
 * HESAP/ERİŞİM hatası (isApiAccountError: kredi/limit/auth — transient DEĞİL, runTurn onları zaten retry'ladı)
 * + z.ai key varsa → AYNI turu z.ai (GLM, Anthropic-uyumlu endpoint) ile tekrarlar. GÖRÜNÜR mesaj
 * (sessiz fallback yasağı). z.ai DE account-error/başka hata verirse YUKARI fırlatır (dürüst hata; sessiz
 * yutma yok). z.ai turuna Anthropic-spesifik `betas` geçilmez (GLM bilmez). Diğer hatalar → claude'a aittir.
 */
export async function runTurn(
  config: MyclConfig,
  apiKey: string,
  opts: RunTurnOptions,
  onEvent: StreamHandler,
): Promise<TurnResult> {
  // ⑤ PROVIDER ROUTING (z.ai Aşama 2): rol verilmişse merkezi resolveProvider çözer.
  // Rolün Sağlayıcı=Z.AI seçimi varsa BİRİNCİL çağrı doğrudan GLM'e gider (key+endpoint+model swap).
  // Sağlayıcı claude ise geçen apiKey + opts AYNEN korunur (sıfır davranış değişikliği — kritik path güvenliği).
  let primaryKey = apiKey;
  let primaryOpts = opts;
  if (opts.role) {
    const prov = resolveProvider(config, opts.role);
    if (prov.isZai) {
      primaryKey = prov.apiKey;
      primaryOpts = {
        ...opts,
        baseURL: prov.baseURL,
        isZai: true,
        model: glmModelFor(opts.model),
        betas: undefined,
      };
    }
  }
  try {
    return await runTurnOnce(config, primaryKey, primaryOpts, onEvent);
  } catch (err) {
    // FALLBACK (ladder 3. halka): birincil claude idiyse + HESAP/erişim hatası (kredi/limit/auth) →
    // AYNI turu z.ai (GLM) ile tekrarla. Rol varsa rolün z.ai key'i (per-rol ?? default), yoksa default zai.
    // Birincil ZATEN z.ai idiyse fallback YOK (z.ai son halka; hatasını dürüstçe fırlat — sessiz yutma yok).
    const zaiKey = opts.role ? zaiKeyForRole(config.api_keys, opts.role) : config.api_keys.zai;
    if (!primaryOpts.isZai && zaiKey && err instanceof ClaudeApiError && isApiAccountError(err.message)) {
      const fallbackModel = glmModelFor(opts.model);
      emitChatMessage(
        "system",
        `⚠️ Claude API erişilemedi (kredi/limit) → z.ai (GLM \`${fallbackModel}\`) fallback deneniyor.`,
      );
      log.warn("claude-api", "claude API account-error → z.ai fallback", { model: fallbackModel });
      return await runTurnOnce(
        config,
        zaiKey,
        { ...opts, model: fallbackModel, baseURL: ZAI_BASE_URL, isZai: true, betas: undefined },
        onEvent,
      );
    }
    throw err;
  }
}
