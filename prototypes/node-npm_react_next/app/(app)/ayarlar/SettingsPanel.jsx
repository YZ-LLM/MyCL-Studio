'use client';

// Ayarlar paneli — dil değiştirici (TR/EN, anında + kalıcı) + tema seçici.
import { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n-context';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';

export function SettingsPanel() {
  const t = useT();
  const [theme, setTheme] = useState('light');

  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  function applyTheme(next) {
    const root = document.documentElement;
    root.classList.remove('dark', 'light');
    root.classList.add(next);
    setTheme(next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* best-effort: localStorage gizli modda yazılamayabilir */
    }
    document.cookie = `theme=${next}; path=/; max-age=31536000; samesite=lax`;
  }

  return (
    <div className="stack">
      <section className="stack">
        <h2>{t('settings.language')}</h2>
        <p className="muted">{t('settings.languageDesc')}</p>
        <LanguageSwitcher />
      </section>
      <section className="stack">
        <h2>{t('settings.theme')}</h2>
        <p className="muted">{t('settings.themeDesc')}</p>
        <div className="row" role="group" aria-label={t('settings.theme')}>
          <button
            type="button"
            className={theme === 'light' ? 'btn btn-primary' : 'btn'}
            aria-pressed={theme === 'light'}
            onClick={() => applyTheme('light')}
          >
            {t('settings.themeLight')}
          </button>
          <button
            type="button"
            className={theme === 'dark' ? 'btn btn-primary' : 'btn'}
            aria-pressed={theme === 'dark'}
            onClick={() => applyTheme('dark')}
          >
            {t('settings.themeDark')}
          </button>
        </div>
      </section>
    </div>
  );
}
