'use client';

// Tema başlatma — cookie ile tema gelmediyse localStorage / OS tercihini uygular.
// Öncelik (Dil/Tema sistemi): ?theme (cookie'ye yazıldı) > localStorage > prefers-color-scheme.
import { useEffect } from 'react';

export function ThemeInit({ hasCookieTheme }) {
  useEffect(() => {
    try {
      const root = document.documentElement;
      if (hasCookieTheme) {
        // Server zaten cookie'ye göre sınıfı bastı; localStorage'ı senkron tut.
        if (root.classList.contains('dark')) localStorage.setItem('theme', 'dark');
        else if (root.classList.contains('light')) localStorage.setItem('theme', 'light');
        return;
      }
      let theme = localStorage.getItem('theme');
      if (theme !== 'dark' && theme !== 'light') {
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      root.classList.remove('dark', 'light');
      root.classList.add(theme);
    } catch {
      /* best-effort: tema başlatma kritik değil, sessiz geç */
    }
  }, [hasCookieTheme]);
  return null;
}
