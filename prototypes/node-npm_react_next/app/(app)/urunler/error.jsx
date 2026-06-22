'use client';

// Ürün listesi error boundary — content-load hatası mesajı + retry (reset).
import { useEffect } from 'react';
import { reportClientError } from '@/lib/api-client';
import { useT } from '@/lib/i18n-context';

export default function ProductsError({ error, reset }) {
  const t = useT();
  useEffect(() => {
    reportClientError({
      error_code: 'CLIENT_RENDER_ERROR',
      location: '/urunler',
      description_tr: 'Ürün listesi render hatası.',
      stack: error?.stack || String(error),
    });
  }, [error]);

  return (
    <div className="state error" role="alert">
      <p>{t('products.loadError')}</p>
      <button type="button" className="btn btn-primary" onClick={() => reset()}>
        {t('common.retry')}
      </button>
    </div>
  );
}
