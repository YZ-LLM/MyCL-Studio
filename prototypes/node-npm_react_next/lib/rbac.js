// Server-side role-based access control (AC4). The single source of truth for
// what each role may do. UI hiding is never a substitute — every mutating path
// asks these helpers before changing state.
//
// Per this iteration's assumption: Admin has full catalog CRUD; Dealer and
// Service technician have read-only catalog access.
const CATALOG_WRITERS = new Set(['admin']);

export function canReadCatalog(role) {
  return role === 'admin' || role === 'dealer' || role === 'service_technician';
}

export function canManageCatalog(role) {
  return CATALOG_WRITERS.has(role);
}

// Returns null when allowed, otherwise an { status, code } describing the denial
// (401 when unauthenticated, 403 when the role lacks permission).
export function checkCatalogWrite(user) {
  if (!user) return { status: 401, code: 'UNAUTHENTICATED' };
  if (!canManageCatalog(user.role)) return { status: 403, code: 'FORBIDDEN' };
  return null;
}
