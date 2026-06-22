// Node.js backend tier (zero-dependency). Owns request handling for the backend
// process and, crucially, the central error middleware (AC9): every uncaught
// exception and every 4xx/5xx response is recorded to the MyCL error catalog and
// logged via the structured logger, while the client only ever sees a generic
// message — the stack/internal detail is never leaked (observability).
import { recordError as defaultRecordError } from '../error_folder/init-errors-db.js';
import { logger as defaultLogger } from '../lib/logger.js';

const GENERIC_500 = { error: { code: 'INTERNAL', message: 'Sunucu hatası. Lütfen tekrar deneyin.' } };

// Dependency-injected so tests can supply fakes. `routes` maps "METHOD /path" to a
// handler returning { status, body }; a handler may also throw to simulate an
// uncaught exception.
export function createApp({ recordError = defaultRecordError, logger = defaultLogger, routes } = {}) {
  const table =
    routes ||
    {
      'GET /health': () => ({ status: 200, body: { status: 'ok' } }),
      'GET /api/errors': () => ({ status: 200, body: { ok: true } }),
    };

  function record(code, location, description, stack) {
    try {
      recordError({ error_code: code, location, description_tr: description, stack: stack || null });
    } catch (e) {
      // Best-effort: the error catalog being unavailable must not crash the handler.
      logger.error('error-catalog write failed', { location, message: String(e) });
    }
  }

  function dispatch({ method, path }) {
    const handler = table[`${method} ${path}`];

    if (!handler) {
      record('HTTP_404', path, 'İstenen kaynak bulunamadı (404).');
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Bulunamadı' } } };
    }

    let result;
    try {
      result = handler();
    } catch (err) {
      // Uncaught exception -> record with stack, log, return generic 500 (no leak).
      record('UNCAUGHT_EXCEPTION', path, 'Sunucuda beklenmeyen bir hata oluştu.', err?.stack || String(err));
      logger.error('uncaught exception', { path, message: err?.message || String(err) });
      return { status: 500, body: GENERIC_500 };
    }

    // A 4xx/5xx result from a handler is also catalogued (no stack available).
    if (result.status >= 400) {
      record(`HTTP_${result.status}`, path, `İstek ${result.status} durum koduyla sonuçlandı.`);
      logger.warn('error response', { path, status: result.status });
    }
    return result;
  }

  return { dispatch, routes: table };
}
