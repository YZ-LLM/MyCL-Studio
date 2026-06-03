// cli-rate-limit — Auto Mode için Claude Code ABONELİĞİ (CLI) usage-limit takibi.
//
// Kullanıcı (2026-06-03): "Auto Mode: CLI ile başla; CLI limiti dolunca API kullan;
// limit açılınca CLI'ye dön." Limit = Claude Code aboneliğinin kullanım kapağı
// (API rate-limit'i DEĞİL). Reset zamanı `claude -p --output-format stream-json`
// çıktısındaki özel event'ten gelir (canlı doğrulandı, claude 2.1.158):
//
//   {"type":"rate_limit_event","rate_limit_info":{
//      "status":"allowed",          // istek servis edildi; limitte "allowed" DEĞİL
//      "resetsAt":1780504200,       // ← Unix epoch SANİYE: pencere ne zaman açılır
//      "rateLimitType":"five_hour", // 5 saatlik / 7 günlük pencere
//      "isUsingOverage":false}}
//
// Yani "resets in 1h" metnini parse etmeye gerek yok — resetsAt mutlak timestamp.
// Bu modül global state tutar (abonelik tüm rollerde ortak); backendForRole "auto"
// rolünü bu state'e göre çözer. Her geçiş GÖRÜNÜR mesajla (sessiz fallback yasağı).

import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";

export interface RateLimitInfo {
  status?: string;
  resetsAt?: number; // Unix epoch SANİYE
  rateLimitType?: string;
  isUsingOverage?: boolean;
}

// ───────────────────────── Saf çekirdek (test edilebilir) ─────────────────────────

/**
 * Abonelik isteği servis edildi mi? `status==="allowed"` → servis edildi (limit yok).
 * Başka her (boş olmayan) status → servis EDİLMEDİ = limit doldu. Gözlem: served
 * isteklerde status hep "allowed"; tükenince "rejected"/"blocked" vb. Bilinmeyen
 * non-allowed status loglanır (ileride daraltmak için) ama bloklu sayılır.
 */
export function isBlockedStatus(status: string | undefined): boolean {
  return typeof status === "string" && status.length > 0 && status.toLowerCase() !== "allowed";
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
    if (info.status?.toLowerCase() !== "rejected" && info.status?.toLowerCase() !== "blocked") {
      log.warn("cli-rate-limit", "bilinmeyen non-allowed status — bloklu sayıldı", { status: info.status });
    }
    const until = untilCandidate ?? _lastResetsAtMs ?? nowMs + 15 * 60_000; // reset bilinmiyorsa kısa backoff
    enterLimited(until, info.rateLimitType);
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

/**
 * Auto Mode faz-içi kesintisiz retry: CLI backend'i çalıştır; abonelik limiti
 * faz ORTASINDA dolup CLI başarısız olursa (kind:"failed" + cliCurrentlyLimited)
 * AYNI faz içinde API backend'ine geçip YENİDEN dener. Yalnız limit-kaynaklı
 * failure'da fallback yapar — başka hatada fallback YOK (sessiz API kaçışı değil).
 * submitAskqAnswer/abort aktif backend'e yönlendirilir (geçişte pending askq yok:
 * CLI run bitmiş olur). Yalnız Auto Mode'da çağrılır (explicit "cli" sarmalanmaz).
 */
export function autoFallbackBackend<O extends { kind: string }, B extends FallbackableBackend<O>>(
  makeCli: () => B,
  makeApi: () => B,
): B {
  let active: B = makeCli();
  let fellBack = false;
  const wrapper: FallbackableBackend<O> = {
    run: async (): Promise<O> => {
      const r = await active.run();
      if (!fellBack && r.kind === "failed" && cliCurrentlyLimited()) {
        fellBack = true;
        emitChatMessage(
          "system",
          "↪️ Abonelik limiti faz ortasında doldu — bu faz API ile kesintisiz yeniden deneniyor (Auto Mode).",
        );
        log.info("cli-rate-limit", "in-phase auto fallback CLI → API");
        active = makeApi();
        return active.run();
      }
      return r;
    },
    abort: () => active.abort?.(),
    submitAskqAnswer: (id: string, sel: string) => active.submitAskqAnswer?.(id, sel),
  };
  return wrapper as unknown as B;
}
