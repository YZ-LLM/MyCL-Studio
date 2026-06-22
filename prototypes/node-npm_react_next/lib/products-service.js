// Framework-agnostic product catalog service. Transport-independent: the Next.js
// route handlers and Server Actions both call this, so RBAC (AC4), validation,
// and persistence through the DAL (AC6/AC7) live in exactly one place and are
// directly testable without booting a server.
import { getDal } from '@/lib/db/dal';
import { validateProduct } from '@/lib/validation';
import { checkCatalogWrite } from '@/lib/rbac';

function err(status, code, extra) {
  return { status, body: { error: { code, message: code, ...extra } } };
}

// { method, user, id?, body?, dal? } -> { status, body }
export function handleProductRequest({ method, user, id, body, dal = getDal() }) {
  if (!user) return err(401, 'UNAUTHENTICATED');

  switch (method) {
    case 'GET': {
      if (id != null) {
        const product = dal.getProduct(id);
        if (!product) return err(404, 'NOT_FOUND');
        return { status: 200, body: { product } };
      }
      return { status: 200, body: { products: dal.listProducts() } };
    }

    case 'POST': {
      const denied = checkCatalogWrite(user);
      if (denied) return err(denied.status, denied.code);
      const { values, errors, ok } = validateProduct(body || {});
      if (!ok) return err(400, 'VALIDATION', { fields: errors });
      if (dal.productCodeExists(values.code)) return err(409, 'CONFLICT', { field: 'code' });
      const product = dal.createProduct(values);
      return { status: 201, body: { product } };
    }

    case 'PUT': {
      const denied = checkCatalogWrite(user);
      if (denied) return err(denied.status, denied.code);
      if (!dal.getProduct(id)) return err(404, 'NOT_FOUND');
      const { values, errors, ok } = validateProduct(body || {});
      if (!ok) return err(400, 'VALIDATION', { fields: errors });
      if (dal.productCodeExists(values.code, id)) return err(409, 'CONFLICT', { field: 'code' });
      const product = dal.updateProduct(id, values);
      return { status: 200, body: { product } };
    }

    case 'DELETE': {
      const denied = checkCatalogWrite(user);
      if (denied) return err(denied.status, denied.code);
      const removed = dal.deleteProduct(id);
      if (!removed) return err(404, 'NOT_FOUND');
      return { status: 200, body: { ok: true } };
    }

    default:
      return err(405, 'METHOD_NOT_ALLOWED');
  }
}
