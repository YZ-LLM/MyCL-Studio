import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDal, seedDefaultUsers } from '@/lib/db/dal';
import { hashPassword, verifyPassword } from '@/lib/password';

// Group A — Authentication & password security (AC1, AC2, AC3).
describe('auth: credentials, sessions, password storage', () => {
  let dal;
  beforeEach(() => {
    dal = createDal(':memory:');
    dal.createUser({
      username: 'admin',
      password: 'Dogru-Sifre-1',
      role: 'admin',
      displayName: 'Yönetici',
    });
  });

  // AC1 — valid credentials authenticate and a session can be established.
  it('AC1: accepts correct credentials and establishes a session', () => {
    const user = dal.verifyCredentials('admin', 'Dogru-Sifre-1');
    expect(user).not.toBeNull();
    expect(user.role).toBe('admin');

    const token = dal.createSession(user.id);
    const sessionUser = dal.getSessionUser(token);
    expect(sessionUser).not.toBeNull();
    expect(sessionUser.username).toBe('admin');
  });

  // AC2 — wrong password or unknown username is rejected, no session.
  it('AC2: rejects a wrong password with no session', () => {
    expect(dal.verifyCredentials('admin', 'wrong-password')).toBeNull();
  });

  it('AC2: rejects an unknown username with no session', () => {
    expect(dal.verifyCredentials('nobody', 'Dogru-Sifre-1')).toBeNull();
  });

  it('AC2: an invalid/forged token resolves to no user', () => {
    expect(dal.getSessionUser('not-a-real-token')).toBeNull();
    expect(dal.getSessionUser('')).toBeNull();
  });

  it('AC1: a deleted session no longer authenticates', () => {
    const user = dal.verifyCredentials('admin', 'Dogru-Sifre-1');
    const token = dal.createSession(user.id);
    expect(dal.deleteSession(token)).toBe(true);
    expect(dal.getSessionUser(token)).toBeNull();
  });

  // AC3 — password persisted only as a salted one-way hash; plaintext never stored.
  it('AC3: stores only a salted one-way hash, never the plaintext', () => {
    const row = dal.db.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin');
    expect(row.password_hash).not.toContain('Dogru-Sifre-1');
    expect(row.password_hash.startsWith('scrypt$')).toBe(true);
    // and the hash actually verifies the original plaintext
    expect(verifyPassword('Dogru-Sifre-1', row.password_hash)).toBe(true);
  });

  it('AC3: the same password yields different hashes (per-password salt)', () => {
    const a = hashPassword('same-input');
    const b = hashPassword('same-input');
    expect(a).not.toBe(b);
    expect(verifyPassword('same-input', a)).toBe(true);
    expect(verifyPassword('same-input', b)).toBe(true);
    expect(verifyPassword('other', a)).toBe(false);
  });
});

describe('account seeding', () => {
  afterEach(() => {
    delete process.env.SEED_ADMIN_PASSWORD;
  });

  it('seeds the three role accounts idempotently, honouring an env password', () => {
    process.env.SEED_ADMIN_PASSWORD = 'env-admin-secret';
    const dal = createDal(':memory:');

    const created = seedDefaultUsers(dal);
    expect(created.sort()).toEqual(['admin', 'bayi', 'servis']);
    expect(dal.findUserByUsername('admin').role).toBe('admin');
    expect(dal.findUserByUsername('servis').role).toBe('service_technician');
    // the env-provided password authenticates (AC1 path), and is stored hashed
    expect(dal.verifyCredentials('admin', 'env-admin-secret')).not.toBeNull();

    // running it again creates nothing (idempotent)
    expect(seedDefaultUsers(dal)).toEqual([]);
  });
});
