'use client';

// Giriş formu — JS varsa fetch ile inline hata/loading; JS yoksa form POST → redirect.
// Hata mesajı AKSİYON bağlamlıdır (login.invalid / login.failed), içerik-yükleme değil.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n-context';

export function LoginForm({ initialError }) {
  const t = useT();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError ? t('login.invalid') : '');
  const [fieldErr, setFieldErr] = useState({});
  const [pending, setPending] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    const fe = {};
    if (username.trim().length < 3) fe.username = true;
    if (password.length < 8) fe.password = true;
    setFieldErr(fe);
    if (Object.keys(fe).length > 0) {
      setError(t('login.invalid'));
      return;
    }
    setError('');
    setPending(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (res.status === 401) {
        setError(t('login.invalid'));
        setPending(false);
        return;
      }
      if (!res.ok) {
        setError(t('login.failed'));
        setPending(false);
        return;
      }
      router.push('/');
      router.refresh();
    } catch {
      setError(t('login.failed'));
      setPending(false);
    }
  }

  return (
    <form action="/api/auth/login" method="post" onSubmit={onSubmit} noValidate className="stack">
      <div className="field">
        <label htmlFor="username">{t('login.username')}</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          aria-invalid={fieldErr.username ? 'true' : undefined}
          aria-describedby={error ? 'login-error' : undefined}
          disabled={pending}
        />
      </div>
      <div className="field">
        <label htmlFor="password">{t('login.password')}</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={fieldErr.password ? 'true' : undefined}
          aria-describedby={error ? 'login-error' : undefined}
          disabled={pending}
        />
      </div>
      {error ? (
        <p id="login-error" className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? t('login.submitting') : t('login.submit')}
        </button>
      </div>
    </form>
  );
}
