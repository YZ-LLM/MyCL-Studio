// llm-outage — İKİ Claude kanalı da (abonelik + API) kapalıyken uzun ufuklu bekle-ve-devam.
//
// YZLLM 2026-07-17 (canlı: cave, 2 saat donma): "5 dakikada bir denesin. ya da zaten aboneliğin
// ne zaman açılacağını biliyorsa o zaman devam etsin." Tur içi CLI↔API döngüsü (autoFallbackBackend,
// 6 deneme, ~30 sn) DOĞRU çalışıp dürüstçe pes ediyordu; sorun sonrasında KİMSENİN yeniden
// denememesiydi — z.ai sökümünden önce üçüncü halka bu durumu örtüyordu, söküm "dürüst dur"u
// getirdi ama otomatik devamı getirmemişti (davranış regresyonu; bu modül onu kapatır).
//
// Tek zamanlayıcı (tek uçuş): abonelik reset saati biliniyorsa (rate_limit_event resetsAt —
// cli-rate-limit.getKnownResetMs) o saatte + 1 dk tampon; bilinmiyorsa 5 dakikada bir resume()
// çağrılır. Görünür (KATI #4): kurulum + her deneme mesajlı. resume en-son-kazanır (yeni kesinti
// eski işi değil son kesilen işi devam ettirir). Başarısız devam denemesi kaybolmaz: çağrı zinciri
// yeniden arm eder ya da buradaki catch 5 dk sonra tekrar kurar.

import { getKnownResetMs } from "./cli-rate-limit.js";
import { emit, emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";

/** ⏸️ Şerit görünürlüğü (YZLLM 2026-07-23 ekran: şerit "boşta" derken bekleme sürüyordu — banner-yok ≠ boşta):
 *  bekleme kuruldu/çözüldü → UI'ya olay; ActivityBar "LLM erişimi bekleniyor — ~HH:MM'de otomatik devam" gösterir. */
function emitOutageWait(active: boolean, resetMs?: number): void {
  emit("outage_wait", { active, reset_ms: resetMs, ts: Date.now() });
}

export const OUTAGE_RETRY_INTERVAL_MS = 5 * 60_000;
/** Uzun beklemede ara yoklama (YZLLM 2026-07-17 "evet ekle"): reset 1 saatten uzaksa (örn. 7 günlük
 *  pencere) o saate körü körüne kilitlenme — saatte bir yokla (erken açılma/kredi yükleme yakalanır);
 *  reset yaklaşınca min() doğal olarak reset saatine kilitlenir. */
export const LONG_WAIT_PROBE_INTERVAL_MS = 60 * 60_000;
/** Reset saatine eklenen tampon — pencere açılırken sınırda yakalanmamak için. */
const RESET_BUFFER_MS = 60_000;
/** setTimeout alt sınırı — reset "hemen şimdi" görünse bile çok sık ateşleme olmasın. */
const MIN_DELAY_MS = 5_000;

/** SAF: bir sonraki deneme zamanı — reset gelecekteyse min(reset+tampon, şimdi+1 saat); değilse şimdi+5 dk. */
export function computeRetryAtMs(knownResetMs: number | undefined, nowMs: number): number {
  if (typeof knownResetMs === "number" && knownResetMs > nowMs) {
    return Math.min(knownResetMs + RESET_BUFFER_MS, nowMs + LONG_WAIT_PROBE_INTERVAL_MS);
  }
  return nowMs + OUTAGE_RETRY_INTERVAL_MS;
}

/** Resume sonucu (MAHKEME CRITICAL 2026-07-23): "skipped" = sistem meşgul/askq asılı olduğu için GERÇEK
 *  deneme YAPILMADI → bekleme SONA ERMEZ (sessizce yeniden kurulur). Void dönüş = "resumed" (geriye uyum). */
export type OutageResumeResult = "resumed" | "skipped";

let _timer: NodeJS.Timeout | null = null;
let _resume: (() => Promise<OutageResumeResult | void>) | null = null;

export function isLlmOutageWaiting(): boolean {
  return _timer !== null;
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function schedule(delayMs: number): void {
  const t = setTimeout(() => void fire(), Math.max(MIN_DELAY_MS, delayMs));
  // Zamanlayıcı süreç kapanışını engellemesin (orchestrator kapanırken bekleme sarkmasın).
  t.unref?.();
  _timer = t;
}

async function fire(): Promise<void> {
  _timer = null;
  const resume = _resume;
  _resume = null;
  if (!resume) return;
  // "🔄 deneniyor" mesajı BURADA BASILMAZ (MAHKEME 2026-07-23): resume "skipped" dönebilir (meşgul/askq —
  // gerçek deneme yok) ve bekleme sessizce yeniden kurulur; her 5 dk mesaj basmak spam olurdu. Gerçek
  // deneme yapan resume yolları mesajı KENDİ basar (görünürlük orada).
  try {
    const r = await resume();
    if (r === "skipped") {
      // Gerçek deneme YAPILMADI (sistem meşgul / askq asılı) → bekleme SONA ERMEZ. Eski davranış burada
      // sessizce sonlanıyordu → kuyruksuz faz-vuruş köşesinde (watchdog hasPending şartına takılır) kalıcı
      // durma + şeride yanlış "boşta" (MAHKEME CRITICAL). Sessiz yeniden kur (ilk atlama resume'da görünür).
      _resume = resume;
      schedule(OUTAGE_RETRY_INTERVAL_MS);
      return;
    }
    // resume içinde yeniden kesinti olduysa çağrı zinciri armLlmOutageWait'i tekrar kurmuştur
    // (_timer dolu olur). Gerçek sonlanmada şerit bekleme durumu kapanır.
    if (_timer === null) {
      emitOutageWait(false);
    }
  } catch (e) {
    log.warn("llm-outage", "devam denemesi hata verdi", { error: String(e) });
    if (_timer === null) {
      // Çağrı zinciri yeniden kurmadıysa deneme KAYBOLMASIN → 5 dk sonra tekrar (görünür).
      emitChatMessage("system", "⏸️ Devam denemesi yine başarısız — 5 dakika sonra tekrar deneyeceğim.");
      _resume = resume;
      schedule(OUTAGE_RETRY_INTERVAL_MS);
    }
  }
}

/**
 * Bekle-ve-devam kur. Tek uçuş: zaten bekleniyorsa zamanlayıcı korunur, yalnız resume güncellenir
 * (en son kesilen iş devam ettirilir; mesaj tekrarı yok). reason kullanıcıya kısaca gösterilir.
 */
export function armLlmOutageWait(reason: string, resume: () => Promise<OutageResumeResult | void>): void {
  _resume = resume;
  if (_timer !== null) return;
  const now = Date.now();
  const resetMs = getKnownResetMs(now);
  const at = computeRetryAtMs(resetMs, now);
  const farReset = resetMs !== undefined && resetMs - now > LONG_WAIT_PROBE_INTERVAL_MS;
  emitChatMessage(
    "system",
    resetMs !== undefined
      ? farReset
        ? `⏸️ İki Claude kanalı da şu an kapalı (${reason.slice(0, 140)}). Abonelik limiti ${fmtClock(resetMs)} civarı açılacak (uzun pencere) — saatte bir yoklayacağım; erken açılırsa hemen, en geç o saatte kaldığım yerden OTOMATİK devam ederim.`
        : `⏸️ İki Claude kanalı da şu an kapalı (${reason.slice(0, 140)}). Abonelik limiti ${fmtClock(resetMs)} civarı açılacak — o saatte kaldığım yerden OTOMATİK devam edeceğim (beklemeden sürdürmek istersen 'Çalıştır').`
      : `⏸️ İki Claude kanalı da şu an kapalı (${reason.slice(0, 140)}). 5 dakikada bir yeniden deneyeceğim — açılınca kaldığım yerden OTOMATİK devam ederim.`,
  );
  log.info("llm-outage", "bekle-ve-devam kuruldu", { at, resetKnown: resetMs !== undefined });
  emitOutageWait(true, resetMs);
  schedule(at - now);
}

/** Beklemeyi iptal et (kullanıcı iptali / proje değişimi / manuel devam). */
export function cancelLlmOutageWait(): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
    log.info("llm-outage", "bekle-ve-devam iptal edildi");
    emitOutageWait(false); // yalnız gerçekten aktifken (kickWorkQueue her tetikte çağırır — boşta event spam'i olmasın)
  }
  _resume = null;
}
