import Link from 'next/link';
import { headers } from 'next/headers';
import { t } from '@/lib/i18n';

export default function NotFound() {
  const lang = headers().get('x-lang') || 'tr';
  return (
    <div className="auth-wrap">
      <div className="card auth-card stack">
        <h1>{t(lang, 'notfound.title')}</h1>
        <p className="muted">{t(lang, 'notfound.message')}</p>
        <Link className="btn btn-primary" href="/">
          {t(lang, 'notfound.home')}
        </Link>
      </div>
    </div>
  );
}
