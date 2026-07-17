import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { t } from '@/lib/i18n';
import { getCurrentUser } from '@/lib/session';
import { HataKodlariTable } from './HataKodlariTable';

// Hata Kodları — mycl_errors.db kayıtları (AC11). Admin-only (least privilege).
export default function HataKodlariPage() {
  const lang = headers().get('x-lang') || 'tr';
  const user = getCurrentUser();
  if (user?.role !== 'admin') redirect('/urunler');

  return (
    <div>
      <div className="page-head">
        <h1>{t(lang, 'errors.title')}</h1>
      </div>
      <div className="card">
        <HataKodlariTable />
      </div>
    </div>
  );
}
