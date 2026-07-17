'use client';

// Dil seçici (TR / EN) — gerçek linkler, JS olmadan da çalışır. ?lang middleware
// tarafından cookie'ye kalıcılaştırılır ve sayfa yeni dilde SSR edilir.
import { usePathname } from 'next/navigation';
import { useLang } from '@/lib/i18n-context';

export function LanguageSwitcher() {
  const pathname = usePathname() || '/';
  const lang = useLang();
  return (
    <div className="lang-switch" role="group" aria-label="Dil / Language">
      <a href={`${pathname}?lang=tr`} hrefLang="tr" aria-current={lang === 'tr' ? 'true' : undefined}>
        TR
      </a>
      <a href={`${pathname}?lang=en`} hrefLang="en" aria-current={lang === 'en' ? 'true' : undefined}>
        EN
      </a>
    </div>
  );
}
