// pause — operatör "Duraklat/Devam" denetimi (Ümit 2026-06-13: "sen çalışırken
// MyCL gereksiz token yakmasın").
//
// Semantik: Duraklat → bir sonraki LLM-çağrı SINIRINDA durur (yeni çağrı
// başlatılmaz). IN-FLIGHT çağrı İPTAL EDİLMEZ — mevcut tur tamamlanır ("LLM
// cevabı bekliyorsa, alınca bekletir"). Devam → kaldığı yerden sürer.
//
// Gate: tüm ağır LLM giriş noktaları (runClaudeCli / persistent send /
// claude-api stream / runReasoningTurn) başında `await waitIfPaused()` çağırır.
// Runtime-only (kalıcı değil) — canlı operatör denetimi; app restart'ta sıfırlanır.

let _paused = false;
/** Devam'ı bekleyen LLM-çağrı sınırlarının resolve'cıları. */
let _waiters: Array<() => void> = [];
/** UI'ye durum bildirimi için opsiyonel kanca (ipc emit; döngüsel import'tan kaçınmak için setter). */
let _onChange: ((paused: boolean) => void) | null = null;

/** Şu an duraklatılmış mı. */
export function isPaused(): boolean {
  return _paused;
}

/** Durum değişiminde UI'ye haber veren kancayı kur (ipc, boot'ta bir kez). */
export function setPauseListener(fn: (paused: boolean) => void): void {
  _onChange = fn;
}

/** Duraklat/Devam ayarla. Devam → bekleyen tüm LLM sınırlarını serbest bırak. */
export function setPaused(paused: boolean): void {
  if (paused === _paused) return;
  _paused = paused;
  if (!paused) {
    const waiters = _waiters;
    _waiters = [];
    for (const resolve of waiters) {
      try {
        resolve();
      } catch {
        /* yut */
      }
    }
  }
  _onChange?.(paused);
}

/**
 * LLM-çağrı sınırı: duraklatılmışsa DEVAM edilene kadar bekle. Duraklatılmamışsa
 * anında döner (sıfır maliyet). In-flight çağrı bu noktadan ÖNCE geçtiyse beklemez.
 */
export function waitIfPaused(): Promise<void> {
  if (!_paused) return Promise.resolve();
  return new Promise<void>((resolve) => {
    _waiters.push(resolve);
  });
}
