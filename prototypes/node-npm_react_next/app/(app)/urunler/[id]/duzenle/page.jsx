import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import Link from 'next/link';
import { t } from '@/lib/i18n';
import { getCurrentUser } from '@/lib/session';
import { getProduct } from '@/lib/db/products';
import { ProductForm } from '@/components/ProductForm';
import { updateProductAction } from '../../actions';

// Ürün düzenle — yalnız Admin (server-side guard).
export default function EditProductPage({ params }) {
  const lang = headers().get('x-lang') || 'tr';
  const user = getCurrentUser();
  if (user?.role !== 'admin') redirect('/urunler');

  const product = getProduct(params.id);
  if (!product) notFound();

  return (
    <div>
      <div className="page-head">
        <h1>{t(lang, 'products.editTitle')}</h1>
      </div>
      <div className="card">
        <ProductForm action={updateProductAction} initial={product} submitLabel={t(lang, 'common.save')} />
      </div>
      <p>
        <Link href="/urunler">{t(lang, 'products.backToList')}</Link>
      </p>
    </div>
  );
}
