import { describe, it, expect, beforeEach } from 'vitest';
import { createDal } from '@/lib/db/dal';
import { handleProductRequest } from '@/lib/products-service';

// Group B — RBAC + product catalog CRUD via the reusable DAL (AC4, AC6, AC7).
describe('products: RBAC + CRUD persisted through the DAL', () => {
  let dal;
  let admin;
  let dealer;
  let service;

  beforeEach(() => {
    dal = createDal(':memory:');
    admin = dal.createUser({ username: 'admin', password: 'p1', role: 'admin', displayName: 'A' });
    dealer = dal.createUser({ username: 'bayi', password: 'p2', role: 'dealer', displayName: 'B' });
    service = dal.createUser({
      username: 'servis',
      password: 'p3',
      role: 'service_technician',
      displayName: 'S',
    });
  });

  const sample = {
    code: 'ARC-100',
    name: 'Buzdolabı',
    category: 'Beyaz Eşya',
    price: 1999.5,
    stock: 10,
    description: 'demo',
  };

  // AC7 — full CRUD persists and is reflected on subsequent reads.
  it('AC7: create -> list -> read -> update -> delete all persist', () => {
    const created = handleProductRequest({ method: 'POST', user: admin, body: sample, dal });
    expect(created.status).toBe(201);
    const id = created.body.product.id;

    const listed = handleProductRequest({ method: 'GET', user: dealer, dal });
    expect(listed.status).toBe(200);
    expect(listed.body.products.map((p) => p.id)).toContain(id);

    const read = handleProductRequest({ method: 'GET', user: service, id, dal });
    expect(read.status).toBe(200);
    expect(read.body.product.code).toBe('ARC-100');

    const updated = handleProductRequest({
      method: 'PUT',
      user: admin,
      id,
      body: { ...sample, price: 2500, stock: 3 },
      dal,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.product.price).toBe(2500);
    // persisted, not just echoed
    expect(dal.getProduct(id).price).toBe(2500);

    const removed = handleProductRequest({ method: 'DELETE', user: admin, id, dal });
    expect(removed.status).toBe(200);
    expect(dal.getProduct(id)).toBeNull();
    const afterDelete = handleProductRequest({ method: 'GET', user: admin, dal });
    expect(afterDelete.body.products.map((p) => p.id)).not.toContain(id);
  });

  it('AC7: reading a missing product returns 404', () => {
    const res = handleProductRequest({ method: 'GET', user: admin, id: 9999, dal });
    expect(res.status).toBe(404);
  });

  // AC4 — non-admin roles cannot write, even calling the API directly; 403 + no state change.
  it('AC4: dealer create is forbidden (403) and writes nothing', () => {
    const res = handleProductRequest({ method: 'POST', user: dealer, body: sample, dal });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(dal.listProducts()).toHaveLength(0);
  });

  it('AC4: service technician update/delete is forbidden (403) and changes nothing', () => {
    const created = handleProductRequest({ method: 'POST', user: admin, body: sample, dal });
    const id = created.body.product.id;
    const before = dal.getProduct(id);

    const upd = handleProductRequest({
      method: 'PUT',
      user: service,
      id,
      body: { ...sample, price: 9 },
      dal,
    });
    expect(upd.status).toBe(403);
    expect(dal.getProduct(id).price).toBe(before.price);

    const del = handleProductRequest({ method: 'DELETE', user: service, id, dal });
    expect(del.status).toBe(403);
    expect(dal.getProduct(id)).not.toBeNull();
  });

  it('AC4: an unauthenticated write is rejected with 401', () => {
    const res = handleProductRequest({ method: 'POST', user: null, body: sample, dal });
    expect(res.status).toBe(401);
    expect(dal.listProducts()).toHaveLength(0);
  });

  // AC4 — all three roles may read.
  it('AC4: every role may read the catalog', () => {
    for (const u of [admin, dealer, service]) {
      expect(handleProductRequest({ method: 'GET', user: u, dal }).status).toBe(200);
    }
  });

  // API contract — validation and conflict status codes.
  it('contract: invalid body -> 400 with field errors', () => {
    const res = handleProductRequest({
      method: 'POST',
      user: admin,
      body: { code: 'x', name: '', category: '', price: 'abc', stock: -1 },
      dal,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.fields).toBeTruthy();
  });

  it('contract: duplicate product code -> 409', () => {
    handleProductRequest({ method: 'POST', user: admin, body: sample, dal });
    const dup = handleProductRequest({ method: 'POST', user: admin, body: sample, dal });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
    expect(dal.listProducts()).toHaveLength(1);
  });

  // AC6 — parameterized queries: a SQL-injection-style value is stored literally,
  // proving no string-concatenated SQL.
  it('AC6: values with SQL metacharacters persist literally (parameterized)', () => {
    const evil = {
      code: "ARC-'; DROP TABLE products;--",
      name: "Robert'); DROP TABLE products;--",
      category: 'x',
      price: 1,
      stock: 1,
      description: "1' OR '1'='1",
    };
    const res = handleProductRequest({ method: 'POST', user: admin, body: evil, dal });
    expect(res.status).toBe(201);
    const back = dal.getProduct(res.body.product.id);
    expect(back.name).toBe("Robert'); DROP TABLE products;--");
    // table still intact
    expect(dal.listProducts()).toHaveLength(1);
  });
});
