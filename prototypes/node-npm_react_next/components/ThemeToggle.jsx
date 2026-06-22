'use client';

// Tema değiştirici — açık/koyu arası geçer, localStorage + cookie'ye yazar (SSR senkron).
import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n-context';

export function ThemeToggle() {
  const t = useT();
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  function toggle() {
    const root = document.documentElement;
    const next = root.classList.contains('dark') ? 'light' : 'dark';
    root.classList.remove('dark', 'light');
    root.classList.add(next);
    setDark(next === 'dark');
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* best-effort: localStorage gizli modda yazılamayabilir */
    }
    document.cookie = `theme=${next}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <button
      type="button"
      className="btn btn-icon"
      onClick={toggle}
      aria-label={t('theme.toggle')}
      aria-pressed={dark}
      title={t('theme.toggle')}
    >
      <span aria-hidden="true">{dark ? '☀' : '☾'}</span>
    </button>
  );
}
