import { headers } from 'next/headers';
import { t } from '@/lib/i18n';
import { LoginForm } from '@/app/login/LoginForm';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';

export const metadata = { title: 'Giriş — Arçelik Back-Office' };

export default function LoginPage({ searchParams }) {
  const lang = headers().get('x-lang') || 'tr';
  const hasError = searchParams?.error === '1';

  return (
    <div className="auth-wrap">
      <div className="auth-card stack">
        <div className="row">
          <div className="shell-brand">
            {t(lang, 'app.name')}
            <small>{t(lang, 'app.tagline')}</small>
          </div>
          <div className="shell-spacer" />
          <LanguageSwitcher />
          <ThemeToggle />
        </div>

        <div className="card stack">
          <h1>{t(lang, 'login.title')}</h1>
          <p className="muted">{t(lang, 'login.subtitle')}</p>
          <LoginForm initialError={hasError} />
        </div>
      </div>
    </div>
  );
}
