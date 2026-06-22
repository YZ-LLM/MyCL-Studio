import 'server-only';
import { getDal } from '@/lib/db/dal';

// Thin product read helpers for Server Components — delegate to the default DAL
// instance so pages don't reach into the data-access internals directly.
export function listProducts() {
  return getDal().listProducts();
}

export function getProduct(id) {
  return getDal().getProduct(id);
}
