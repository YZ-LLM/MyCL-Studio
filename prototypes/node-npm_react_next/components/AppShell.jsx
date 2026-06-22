'use client';

// Uygulama kabuğu — header (kullanıcı, rol, dil, tema, yardım, çıkış) + role-aware
// sidebar + main. Mobilde sidebar kapanabilir.
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/lib/i18n-context';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { HelpButton } from '@/components/HelpButton';

export function AppShell({ user, navItems, helpPages, children }) {
  const t = useT();
  const pathname = usePathname() || '/';
  const [navOpen, setNavOpen] = useState(false);

  function isActive(href) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        {t('common.skipToContent')}
      </a>
      <header className="shell-header">
        <button
          type="button"
          className="btn btn-icon nav-toggle"
          aria-label={t('nav.menu')}
          aria-expanded={navOpen}
          aria-controls="sidebar-nav"
          onClick={() => setNavOpen((o) => !o)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <div className="shell-brand">
          {t('app.name')}
          <small>{t('app.tagline')}</small>
        </div>
        <div className="shell-spacer" />
        <HelpButton helpPages={helpPages} />
        <LanguageSwitcher />
        <ThemeToggle />
        <span className="badge" title={t(`role.${user.role}`)}>
          {t(`role.${user.role}`)}
        </span>
        <span className="muted">{user.displayName}</span>
        <form action="/api/auth/logout" method="post">
          <button type="submit" className="btn btn-sm">
            {t('nav.logout')}
          </button>
        </form>
      </header>
      <div className="shell-body">
        <nav
          id="sidebar-nav"
          className={navOpen ? 'sidebar open' : 'sidebar'}
          aria-label={t('nav.primary')}
        >
          <ul>
            {navItems.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  onClick={() => setNavOpen(false)}
                >
                  {t(item.labelKey)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" className="shell-main">
          {children}
        </main>
      </div>
    </div>
  );
}
