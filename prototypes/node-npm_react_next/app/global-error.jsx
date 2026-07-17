'use client';

// Kök layout hatası için son-çare boundary (provider'lar dışında olduğu için i18n yok;
// minimal iki-dilli sabit mesaj). /api/log-error'a best-effort bildirir.
import { useEffect } from 'react';
import './globals.css';

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    try {
      fetch('/api/log-error', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error_code: 'CLIENT_ROOT_ERROR',
          location: 'root-layout',
          description_tr: 'Kök layout render hatası.',
          stack: error?.stack || String(error),
        }),
      });
    } catch {
      /* best-effort: logging must never throw, retry, or recurse */
    }
  }, [error]);

  return (
    <html lang="tr">
      <body>
        <div className="state error" role="alert">
          <h1>Bir hata oluştu</h1>
          <p>Bir hata oluştu. Sayfayı yenileyin. / Something went wrong. Please refresh.</p>
          <button type="button" className="btn btn-primary" onClick={() => reset()}>
            Sayfayı yenile / Refresh
          </button>
        </div>
      </body>
    </html>
  );
}
