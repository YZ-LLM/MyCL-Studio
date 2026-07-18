// liveness-watchdog — CANLILIK GARANTİSİ bekçisi (YZLLM 2026-07-18: "genel olarak hiç bir zaman
// durmayacağını ve döngüye girmeyeceğini garanti etmeliyiz").
//
// İki taraflı garanti, iki ayrı mekanizmayla sağlanır:
//  - DONMAMA: bilinen her dur noktası bir devam mekanizmasına bağlıdır (kuyruk merdiveni /
//    bekle-ve-devam / park-askq). Bu bekçi BİLİNMEYEN/kaçırılmış dur noktaları için yapısal
//    emniyet ağıdır: sistem tamamen boşta + bekleyen iş var + hiçbir devam mekanizması kurulu
//    değilse kuyruğu GÖRÜNÜR şekilde sürdürür (en kötü donma süresi = bekçi aralığı).
//  - DÖNGÜYE GİRMEME: bekçinin kendisi döngü üretemez — yalnız nextPendingTask'ın seçebildiği
//    işleri tetikler; deneme tavanını doldurmuş işler seçilemediğinden (attempts kapısı) kuyruk
//    "hep aynı işi tekrar tekrar" döndüremez; iş kalmayınca bekçi sessizce boşta döner.
//
// SAF karar + ince zamanlayıcı: koşul mantığı test edilebilir (shouldKickQueue), yan etki
// (kuyruğu sürme) index.ts'ten enjekte edilir. KATI #4: bekçi tetiklenince görünür mesaj basar
// (sessiz kurtarma yok — kullanıcı neyin neden devam ettiğini görür).

import { log } from "./logger.js";

export interface LivenessSnapshot {
  /** Sistem meşgul mü (mesaj işleniyor / pipeline koşuyor / controller aktif / drain sürüyor). */
  busy: boolean;
  /** Kullanıcıdan cevap bekleyen açık soru ya da park var mı (bekleme MEŞRU — kullanıcı sürüyor). */
  askqOpen: boolean;
  /** LLM kesintisi bekle-ve-devam zamanlayıcısı kurulu mu (bekleme MEŞRU — o sürdürecek). */
  outageWaiting: boolean;
  /** Otomatik seçilebilir bekleyen iş var mı (attempts tavanını doldurmuşlar HARİÇ). */
  hasPending: boolean;
}

/** SAF: bekçi kuyruğu sürmeli mi? Yalnız "tamamen boşta + meşru bekleme yok + iş var" durumunda. */
export function shouldKickQueue(s: LivenessSnapshot): boolean {
  return !s.busy && !s.askqOpen && !s.outageWaiting && s.hasPending;
}

export const WATCHDOG_INTERVAL_MS = 3 * 60_000;

let _timer: NodeJS.Timeout | null = null;

/**
 * Bekçiyi başlat (süreç başına bir kez; yeniden çağrı eskisini değiştirir). `tick` her aralıkta
 * çağrılır — anlık görüntüyü toplayıp shouldKickQueue derse kuyruğu sürer (index.ts sağlar).
 */
export function startLivenessWatchdog(tick: () => Promise<void>, intervalMs = WATCHDOG_INTERVAL_MS): void {
  if (_timer !== null) clearInterval(_timer);
  const t = setInterval(() => {
    void tick().catch((e) => log.warn("liveness", "bekçi turu hata verdi (non-fatal)", { error: String(e) }));
  }, intervalMs);
  t.unref?.(); // süreç kapanışını engelleme
  _timer = t;
  log.info("liveness", "canlılık bekçisi başladı", { intervalMs });
}

/** Test/teşhis: bekçiyi durdur. */
export function stopLivenessWatchdog(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
}
