// sound — cevap-bekleme sesi (asset'siz Web Audio bip).
//
// Amaç (YZLLM 2026-07-03): MyCL kullanıcıdan cevap beklerken (askq) duyulur bir bip çalsın →
// kullanıcı başka işle uğraşırken kaçırmasın. Dosya/asset YOK → mevcut CSP değişmez
// (tauri.conf.json'da media-src tanımsız; data:/dosya sesi CSP genişletmesi gerektirirdi,
// oscillator gerektirmez). Tamamen bellek-içi; "unsafe-* yok" kuralına dokunmaz.
//
// Fail-soft (KATI #4 uyumlu ama akış-kritik değil): ses altyapısı yoksa/başarısızsa akışı BOZMAZ,
// yalnız console.warn ile görünür bırakır — ses bir bildirim ipucu, işlevsel bir kapı değil.

let ctx: AudioContext | null = null;

/** Tek bir AudioContext'i lazy döndürür (yoksa null). */
function audioContext(): AudioContext | null {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    return ctx;
  } catch (e) {
    console.warn("[sound] AudioContext oluşturulamadı", e);
    return null;
  }
}

/** İki-ton bip'i verilen context zamanında zamanlar (gain zarfı ile "click" engelli). */
function scheduleBeep(ac: AudioContext): void {
  try {
    const now = ac.currentTime;
    const tones: Array<{ freq: number; at: number; dur: number }> = [
      { freq: 660, at: 0, dur: 0.12 },
      { freq: 990, at: 0.13, dur: 0.14 },
    ];
    for (const t of tones) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = t.freq;
      const t0 = now + t.at;
      const t1 = t0 + t.dur;
      // exponentialRamp 0'a inemez → küçük pozitif taban (0.0001) kullan.
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.015); // hızlı fade-in
      gain.gain.exponentialRampToValueAtTime(0.0001, t1); // fade-out
      osc.connect(gain).connect(ac.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
  } catch (e) {
    console.warn("[sound] bip zamanlanamadı", e);
  }
}

/** Kısa, nazik cevap-bekleme bip'i. Autoplay için context suspended ise önce resume dener. */
export function playAnswerBeep(): void {
  const ac = audioContext();
  if (!ac) return;
  if (ac.state === "suspended") {
    ac.resume()
      .then(() => scheduleBeep(ac))
      .catch((e) => console.warn("[sound] AudioContext resume başarısız", e));
  } else {
    scheduleBeep(ac);
  }
}

/** Bir user-gesture içinde (ör. sesi aç toggle'ı) çağrılır → AudioContext'i garanti açar,
 *  böylece ilk askq bip'i autoplay politikasına takılmaz. */
export function primeAudio(): void {
  const ac = audioContext();
  if (ac && ac.state === "suspended") void ac.resume().catch(() => {});
}
