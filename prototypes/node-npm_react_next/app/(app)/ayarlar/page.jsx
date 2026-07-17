import { headers } from 'next/headers';
import { t } from '@/lib/i18n';
import { SettingsPanel } from './SettingsPanel';

export default function SettingsPage() {
  const lang = headers().get('x-lang') || 'tr';
  return (
    <div>
      <div className="page-head">
        <h1>{t(lang, 'settings.title')}</h1>
      </div>
      <div className="card">
        <SettingsPanel />
      </div>
    </div>
  );
}
