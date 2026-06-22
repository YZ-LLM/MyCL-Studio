'use client';

// Segment error boundary — yakalanan render hatasını /api/log-error'a düşürür (AC10),
// tam-sayfa hata mesajı + yenile butonu gösterir.
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { reportClientError } from '@/lib/api-client';
import { useT } from '@/lib/i18n-context';

export default function Error({ error, reset }) {
  const t = useT();
  const pathname = usePathname() || 'unknown';

  useEffect(() => {
    reportClientError({
      error_code: 'CLIENT_RENDER_ERROR',
      location: pathname,
      description_tr: 'React render hatası (error boundary tarafından yakalandı).',
      stack: error?.stack || String(error),
    });
  }, [error, pathname]);

  return (
    <div className="state error" role="alert">
      <h1>{t('boundary.title')}</h1>
      <p>{t('boundary.message')}</p>
      <button type="button" className="btn btn-primary" onClick={() => reset()}>
        {t('boundary.refresh')}
      </button>
    </div>
  );
}
