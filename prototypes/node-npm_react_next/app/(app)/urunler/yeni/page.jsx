import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import Link from 'next/link';
import { t } from '@/lib/i18n';
import { getCurrentUser } from '@/lib/session';
import { ProductForm } from '@/components/ProductForm';
import { createProductAction } from '../actions';

// Ürün oluştur — yalnız Admin (server-side guard; UI gizleme tek başına yetmez).
export default function NewProductPage() {
  const lang = headers().get('x-lang') || 'tr';
  const user = getCurrentUser();
  if (user?.role !== 'admin') redirect('/urunler');

  return (
    <div>
      <div className="page-head">
        <h1>{t(lang, 'products.createTitle')}</h1>
      </div>
      <div className="card">
        <ProductForm action={createProductAction} submitLabel={t(lang, 'common.create')} />
      </div>
      <p>
        <Link href="/urunler">{t(lang, 'products.backToList')}</Link>
      </p>
    </div>
  );
}
