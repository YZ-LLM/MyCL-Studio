import Link from 'next/link';
import { headers } from 'next/headers';
import { t } from '@/lib/i18n';
import { getCurrentUser } from '@/lib/session';
import { listProducts } from '@/lib/db/products';
import { ProductTable } from './ProductTable';
import { deleteProductAction } from './actions';

// Ürün listesi — server-fetch (tüm roller okur). Mutasyon Server Action + revalidate.
export default function ProductsPage() {
  const lang = headers().get('x-lang') || 'tr';
  const user = getCurrentUser();
  const isAdmin = user?.role === 'admin';
  const products = listProducts();

  return (
    <div>
      <div className="page-head">
        <h1>{t(lang, 'products.title')}</h1>
        <div className="shell-spacer" />
        {isAdmin ? (
          <Link className="btn btn-primary" href="/urunler/yeni">
            {t(lang, 'products.new')}
          </Link>
        ) : null}
      </div>
      <div className="card">
        <ProductTable products={products} isAdmin={isAdmin} deleteAction={deleteProductAction} />
      </div>
    </div>
  );
}
