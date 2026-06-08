// cli-rate-limit — Auto Mode için Claude Code ABONELİĞİ (CLI) usage-limit takibi.
//
// Kullanıcı (2026-06-03): "Auto Mode: CLI ile başla; CLI limiti dolunca API kullan;
// limit açılınca CLI'ye dön." Limit = Claude Code aboneliğinin kullanım kapağı
// (API rate-limit'i DEĞİL). Reset zamanı `claude -p --output-format stream-json`
// çıktısındaki özel event'ten gelir (canlı doğrulandı, claude 2.1.158):
//
//   {"type":"rate_limit_event","rate_limit_info":{
//      "status":"allowed",          // allowed | allowed_warning (İKİSİ DE servis edildi) | rejected (BLOKLANDI)
//      "resetsAt":1780504200,       // ← Unix epoch SANİYE: pencere ne zaman açılır
//      "rateLimitType":"five_hour", // five_hour | seven_day | seven_day_opus | seven_day_sonnet
//      "isUsingOverage":false}}     // overageStatus ile birlikte YANILTICI — blok kararında kullanma
//
// Yani "resets in 1h" metnini parse etmeye gerek yok — resetsAt mutlak timestamp.
// Bu modül global state tutar (abonelik tüm rollerde ortak); backendForRole "auto"
// rolünü bu state'e göre çözer. Her geçiş GÖRÜNÜR mesajla (sessiz fallback yasağı).

import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";

export interface RateLimitInfo {
  /** "allowed" | "allowed_warning" (ikisi de SERVİS EDİLDİ) | "rejected" (BLOKLANDI). */
  status?: string;
  resetsAt?: number; // Unix epoch SANİYE
  rateLimitType?: string; // five_hour | seven_day | seven_day_opus | seven_day_sonnet
  isUsingOverage?: boolean;
}

// ───────────────────────── Saf çekirdek (test edilebilir) ─────────────────────────

/**
 * Abonelik isteği BLOKLANDI mı (servis EDİLMEDİ)? Claude Code status sözlüğü (doğrulandı):
 * "allowed" (servis edildi) | "allowed_warning" (servis edildi + "limite yaklaşıyorsun" uyarısı) |
 * "rejected" (BLOKLANDI). YALNIZ "rejected" = bloklu → API'ye geç. "allowed_warning" SERVİS
 * EDİLMİŞTİR → API'ye DÜŞME (eski "allowed-olmayan-her-şey-bloklu" mantığı yanlış pozitif
 * veriyordu: seven_day allowed_warning'i "limit doldu" sanıp gereksiz fallback yapıyordu).
 * Bilinmeyen status → bloklanma (noteRateLimitEvent gözlem için loglar). overageStatus YANILTICI.
 */
export function isBlockedStatus(status: string | undefined): boolean {
  return typeof status === "string" && status.toLowerCase() === "rejected";
}

/** resetsAt (saniye) → gelecekteyse limitedUntil (ms); geçmiş/yoksa undefined. */
export function computeLimitedUntilMs(
  resetsAtSec: number | undefined,
  nowMs: number,
): number | undefined {
  if (typeof resetsAtSec !== "number" || !Number.isFinite(resetsAtSec)) return undefined;
  const ms = resetsAtSec * 1000;
  return ms > nowMs ? ms : undefined;
}

/** Şu an CLI limitli mi (saf): limitedUntil var ve henüz geçmedi. */
export function isLimited(limitedUntilMs: number | undefined, nowMs: number): boolean {
  return typeof limitedUntilMs === "number" && nowMs < limitedUntilMs;
}

/**
 * Yapılandırılmış backend + limit durumu → efektif backend. "auto": limitliyse
 * "api", değilse "cli". "api"/"cli" aynen döner. Bilinmeyen → "api" (güvenli default).
 */
export function resolveAuto(configured: string, limited: boolean): "api" | "cli" {
  if (configured === "auto") return limited ? "api" : "cli";
  if (configured === "cli") return "cli";
  return "api";
}

// ───────────────────────── Impure global state ─────────────────────────

let _limitedUntilMs: number | undefined;
let _lastResetsAtMs: number | undefined; // en son görülen resetsAt (servis edilmiş event'lerden de)
let _switchEmittedUntil: number | undefined; // hangi pencere için "API'ye geçildi" mesajı verildi
let _resumeArmed = false; // limit set edildi → reset geçince "CLI'ye dönüldü" mesajı verilecek

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function enterLimited(untilMs: number, rateLimitType?: string): void {
  _limitedUntilMs = untilMs;
  _resumeArmed = true;
  if (_switchEmittedUntil !== untilMs) {
    _switchEmittedUntil = untilMs;
    const mins = Math.max(1, Math.round((untilMs - Date.now()) / 60000));
    const win = rateLimitType ? ` (${rateLimitType})` : "";
    emitChatMessage(
      "system",
      `🔁 Claude Code aboneliği limiti doldu${win}. API'ye geçildi; limit ~${mins} dk sonra (${fmtClock(untilMs)}) açılacak — sonra otomatik CLI'ye dönülür.`,
    );
    log.info("cli-rate-limit", "entered limited (auto → API)", { untilMs, rateLimitType });
  }
}

/**
 * stream-json `rate_limit_event`'ini işle. resetsAt her zaman saklanır (servis
 * edilmiş event'lerden bile — limit dolunca reset'i bilmek için). status bloklu
 * ise Auto modda API'ye geçilir.
 */
export function noteRateLimitEvent(info: RateLimitInfo | undefined): void {
  if (!info) return;
  const nowMs = Date.now();
  const untilCandidate = computeLimitedUntilMs(info.resetsAt, nowMs);
  if (untilCandidate !== undefined) _lastResetsAtMs = untilCandidate;

  if (isBlockedStatus(info.status)) {
    const until = untilCandidate ?? _lastResetsAtMs ?? nowMs + 15 * 60_000; // reset bilinmiyorsa kısa backoff
    enterLimited(until, info.rateLimitType);
  } else if (
    typeof info.status === "string" &&
    info.status.length > 0 &&
    info.status.toLowerCase() !== "allowed" &&
    info.status.toLowerCase() !== "allowed_warning"
  ) {
    // Bilinmeyen status (allowed/allowed_warning/rejected dışı) → BLOKLAMA (yanlış-pozitif
    // riski; servis edilmiş olabilir). Yalnız gözlem için logla — yeni bir hard-block status
    // çıkarsa burada görülür ve bilinçli eklenir.
    log.warn("cli-rate-limit", "bilinmeyen status — bloklanmadı (gözlem)", { status: info.status });
  }
}

/**
 * CLI run'ı usage-limit hatasıyla bitti (result event is_error + rate-limit imzası).
 * resetsAt bilinmiyorsa son bilinen reset ya da kısa backoff kullanılır.
 */
export function noteCliRateLimitError(rateLimitType?: string): void {
  const nowMs = Date.now();
  const until = (_lastResetsAtMs && _lastResetsAtMs > nowMs ? _lastResetsAtMs : undefined) ?? nowMs + 15 * 60_000;
  enterLimited(until, rateLimitType);
}

/**
 * CLI HATA metninde abonelik usage / rate-limit imzası var mı? SAF + DAR — yalnız net
 * usage/rate-limit ifadeleri eşleşir (genel bir hatayı yanlışlıkla "limit" sanıp gereksiz
 * API'ye düşmemek için). Eşleşirse tip ("usage-limit"/"rate-limit") döner, yoksa null.
 * `noteCliRateLimitError` ile birlikte: result is_error yolunda çağrılır (auto-mode fallback'i besler).
 */
export function detectCliRateLimit(text: string): string | null {
  const t = (text ?? "").toLowerCase();
  if (!t) return null;
  if (/usage[ _-]?limit/.test(t)) return "usage-limit";
  // NOT: çıplak "429" eklenmedi — satır no ("file.ts:429") yanlış-pozitifi; "too many requests" gerçek 429'u kapsar.
  if (/rate[ _-]?limit|too many requests/.test(t)) return "rate-limit";
  return null;
}

/**
 * Şu an CLI limitli mi (impure — Date.now). Limit geçtiyse temizler + bir kez
 * "CLI'ye dönüldü" mesajı verir (görünür reset). backendForRole "auto" bunu çağırır.
 */
export function cliCurrentlyLimited(): boolean {
  const nowMs = Date.now();
  if (isLimited(_limitedUntilMs, nowMs)) return true;
  // Limit geçti / hiç yoktu:
  if (_limitedUntilMs !== undefined) {
    _limitedUntilMs = undefined;
    _switchEmittedUntil = undefined;
    if (_resumeArmed) {
      _resumeArmed = false;
      emitChatMessage("system", "✅ Claude Code aboneliği limiti açıldı — CLI'ye geri dönüldü.");
      log.info("cli-rate-limit", "limit reset (auto → CLI)");
    }
  }
  return false;
}

/** Test/teşhis: state'i sıfırla. */
export function resetCliRateLimitState(): void {
  _limitedUntilMs = undefined;
  _lastResetsAtMs = undefined;
  _switchEmittedUntil = undefined;
  _resumeArmed = false;
}

/** Test/teşhis: aktif limitedUntil (ms) veya undefined. */
export function getCliLimitedUntilMs(): number | undefined {
  return _limitedUntilMs;
}

// ───────────────────────── Faz-içi kesintisiz retry (Auto Mode) ─────────────────────────

export interface FallbackableBackend<O extends { kind: string }> {
  run(): Promise<O>;
  abort?(): void;
  submitAskqAnswer?(askqId: string, selected: string): void;
}

/** Auto fallback görünür mesajı için yön etiketleri. */
export interface AutoFallbackLabels {
  from: string;
  to: string;
}

/**
 * Auto Mode SİMETRİK faz-içi kesintisiz retry: birincil backend'i çalıştır; KALICI
 * `failed` dönerse (geçici hatalar — overloaded/5xx — zaten backend içinde retry'lı)
 * AYNI faz içinde ikincil backend'e BİR KEZ geçip yeniden dener. Yön caller'a göre:
 *   - limit yokken birincil=CLI, ikincil=API  → CLI başarısızsa API (case 2)
 *   - limit penceresinde birincil=API, ikincil=CLI → API başarısızsa CLI (case 1)
 * `aborted`/başarı → geçiş YOK. submitAskqAnswer/abort aktif backend'e yönlenir
 * (geçişte pending askq yok: önceki run bitmiş olur). Yalnız Auto Mode'da çağrılır
 * (explicit "api"/"cli" sarmalanmaz → strict, sessiz fallback yok). Tek geçiş (loop yok).
 */
export function autoFallbackBackend<O extends { kind: string }, B extends FallbackableBackend<O>>(
  makePrimary: () => B,
  makeSecondary: () => B,
  labels: AutoFallbackLabels,
): B {
  let active: B = makePrimary();
  let fellBack = false;
  const wrapper: FallbackableBackend<O> = {
    run: async (): Promise<O> => {
      const r = await active.run();
      if (!fellBack && r.kind === "failed") {
        fellBack = true;
        emitChatMessage(
          "system",
          `↪️ ${labels.from} başarısız oldu — ${labels.to} ile kesintisiz yeniden deneniyor (Auto Mode).`,
        );
        log.info("cli-rate-limit", "auto fallback (symmetric)", { from: labels.from, to: labels.to });
        active = makeSecondary();
        return active.run();
      }
      return r;
    },
    abort: () => active.abort?.(),
    submitAskqAnswer: (id: string, sel: string) => active.submitAskqAnswer?.(id, sel),
  };
  return wrapper as unknown as B;
}

export const CLI_LABEL = "Abonelik (CLI)";
export const API_LABEL = "API";

/**
 * Auto Mode yön seçimi: çözülmüş efektif backend'e göre birincil/ikincil sırala +
 * doğru yön etiketleriyle autoFallbackBackend döndür. effective="cli" → CLI birincil
 * (API fallback); "api" (limit penceresi) → API birincil (CLI fallback). 3 factory bunu çağırır.
 */
export function autoBackendPair<O extends { kind: string }, B extends FallbackableBackend<O>>(
  effective: "api" | "cli",
  makeCli: () => B,
  makeApi: () => B,
): B {
  return effective === "cli"
    ? autoFallbackBackend<O, B>(makeCli, makeApi, { from: CLI_LABEL, to: API_LABEL })
    : autoFallbackBackend<O, B>(makeApi, makeCli, { from: API_LABEL, to: CLI_LABEL });
}
