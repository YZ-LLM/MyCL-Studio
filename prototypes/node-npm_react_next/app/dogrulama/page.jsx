import { headers } from 'next/headers';
import Link from 'next/link';
import { t } from '@/lib/i18n';
import { VerificationForm } from '@/app/dogrulama/VerificationForm';

export const metadata = { title: 'Doğrulama — Arçelik Back-Office' };

// Step-up verification page (used when visitor fingerprint differs) — deferred to a
// later iteration as advanced auth is out of scope here. It leaks no protected data
// (no panel shown) — only the code entry form.
export default function VerifyPage() {
  const lang = headers().get('x-lang') || 'tr';
  return (
    <div className="auth-wrap">
      <div className="auth-card stack">
        <div className="card stack">
          <h1>{t(lang, 'verify.title')}</h1>
          <p className="muted">{t(lang, 'verify.desc')}</p>
          <VerificationForm />
        </div>
        <Link href="/login">{t(lang, 'common.back')}</Link>
      </div>
    </div>
  );
}
