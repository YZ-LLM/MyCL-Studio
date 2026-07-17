import './globals.css';
import { headers } from 'next/headers';
import { LanguageProvider } from '@/lib/i18n-context';
import { getMessages } from '@/lib/i18n';
import { ThemeInit } from '@/components/ThemeInit';

export const metadata = {
  title: 'Arçelik Back-Office',
  description: 'Arçelik on-premise back-office yönetim paneli',
};

export default function RootLayout({ children }) {
  // Dil + tema middleware tarafından çözülüp request header'a yazıldı (SSR'da doğru ilk boyama).
  const h = headers();
  const lang = h.get('x-lang') || 'tr';
  const theme = h.get('x-theme') || '';
  const htmlClass = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : undefined;

  return (
    <html lang={lang} className={htmlClass}>
      <body>
        <ThemeInit hasCookieTheme={theme === 'dark' || theme === 'light'} />
        <LanguageProvider lang={lang} messages={getMessages(lang)}>
          {children}
        </LanguageProvider>
      </body>
    </html>
  );
}
