import { describe, it, expect } from 'vitest';
import { createDal } from '@/lib/db/dal';

// ADIM 0 — SMOKE: end-to-end happy path through the real data-access layer.
// seed/create a user -> authenticate -> create a product as that user -> it lists.
// This proves the skeleton (DAL + password hashing + product persistence) is wired.
describe('smoke: auth + catalog happy path', () => {
  it('creates a user, authenticates, persists a product, and lists it', () => {
    const dal = createDal(':memory:');

    const admin = dal.createUser({
      username: 'admin',
      password: 'Sifre-123!',
      role: 'admin',
      displayName: 'Sistem Yöneticisi',
    });
    expect(admin.id).toBeGreaterThan(0);
    expect(admin.role).toBe('admin');

    // correct credentials authenticate
    const authed = dal.verifyCredentials('admin', 'Sifre-123!');
    expect(authed).not.toBeNull();
    expect(authed.username).toBe('admin');

    // a server-managed session can be established
    const token = dal.createSession(admin.id);
    expect(typeof token).toBe('string');
    expect(dal.getSessionUser(token)?.id).toBe(admin.id);

    // create a product -> it persists and appears on a subsequent read
    const created = dal.createProduct({
      code: 'ARC-9000',
      name: 'No-Frost Buzdolabı',
      category: 'Beyaz Eşya',
      price: 28999.9,
      stock: 42,
      description: 'A++ enerji sınıfı.',
    });
    expect(created.id).toBeGreaterThan(0);

    const list = dal.listProducts();
    expect(list).toHaveLength(1);
    expect(list[0].code).toBe('ARC-9000');
    expect(list[0].price).toBe(28999.9);
  });
});
