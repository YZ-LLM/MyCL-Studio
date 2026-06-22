'use client';

// İstemci fetch sarmalayıcısı — başarısız istekleri /api/log-error'a düşürür (AC10).
import { log } from '@/lib/log';

// KRİTİK: log-error POST'u KENDİ hatasını ASLA loglamaz (aksi halde sonsuz döngü /
// 404 sel). Sessiz best-effort yutma — retry yok, recurse yok.
export async function reportClientError(payload) {
  try {
    await fetch('/api/log-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* best-effort: logging must never throw, retry, or recurse */
  }
}

// Başarısızlıkta logla + /api/log-error'a bildir, sonra throw et. Çağıran taraf
// hata+retry durumuna geçer (resilience).
export async function apiFetch(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
  } catch (err) {
    log.error('api-client', 'network failure', { url, message: String(err) });
    await reportClientError({
      error_code: 'CLIENT_FETCH_NETWORK',
      location: url,
      description_tr: 'Ağ hatası: istek tamamlanamadı.',
      stack: String(err),
    });
    throw new Error('network');
  }
  if (!res.ok) {
    log.warn('api-client', 'non-ok response', { url, status: res.status });
    await reportClientError({
      error_code: `CLIENT_FETCH_${res.status}`,
      location: url,
      description_tr: `İstek ${res.status} durum koduyla başarısız oldu.`,
    });
    const error = new Error(`http_${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res;
}
