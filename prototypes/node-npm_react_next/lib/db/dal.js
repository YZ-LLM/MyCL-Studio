// Reusable data-access layer (AC6). Every read/write of application data goes
// through here using parameterized queries (`?` placeholders) — there is no
// inline string-concatenated SQL anywhere in the app. Backed by node:sqlite in
// this on-prem build; because all SQL is centralized here, swapping the driver
// (e.g. to PostgreSQL) is localized to this module.
import { randomUUID, randomBytes } from 'node:crypto';
import { openDatabase } from '@/lib/db/sqlite';
import { hashPassword, verifyPassword } from '@/lib/password';
import { log } from '@/lib/log';

export const ROLES = ['admin', 'dealer', 'service_technician'];

// Default accounts so an operator can sign in on a fresh install (the spec's
// "minimum needed to seed accounts"). Passwords come from env — never hardcoded;
// when an env value is absent a random one is generated and logged once.
const SEED_DEFS = [
  { username: 'admin', role: 'admin', displayName: 'Sistem Yöneticisi', envVar: 'SEED_ADMIN_PASSWORD' },
  { username: 'bayi', role: 'dealer', displayName: 'Bayi Kullanıcı', envVar: 'SEED_DEALER_PASSWORD' },
  { username: 'servis', role: 'service_technician', displayName: 'Servis Teknisyeni', envVar: 'SEED_SERVICE_PASSWORD' },
];

const SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24h server-managed session

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL,
      stock INTEGER NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    displayName: row.display_name,
  };
}

function publicProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    price: row.price,
    stock: row.stock,
    description: row.description ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Factory — each call opens an independent database (tests use ':memory:').
export function createDal(dbPath) {
  const db = openDatabase(dbPath);
  ensureSchema(db);

  function now() {
    return Date.now();
  }

  return {
    db,

    // --- users ---
    createUser({ username, password, role, displayName }) {
      if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
      const password_hash = hashPassword(password);
      const res = db
        .prepare(
          'INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(username, password_hash, role, displayName ?? username, now());
      return publicUser({
        id: Number(res.lastInsertRowid),
        username,
        role,
        display_name: displayName ?? username,
      });
    },

    findUserByUsername(username) {
      return publicUser(db.prepare('SELECT * FROM users WHERE username = ?').get(username));
    },

    getUserById(id) {
      return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)));
    },

    // Verifies a plaintext password against the stored salted hash (AC1/AC2).
    verifyCredentials(username, password) {
      const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!row) return null;
      if (!verifyPassword(password, row.password_hash)) return null;
      return publicUser(row);
    },

    // --- sessions (server-managed) ---
    createSession(userId) {
      const token = randomUUID();
      db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
        token,
        Number(userId),
        now() + SESSION_TTL_MS,
      );
      return token;
    },

    getSessionUser(token) {
      if (!token) return null;
      const row = db
        .prepare(
          `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token = ? AND s.expires_at > ?`,
        )
        .get(token, now());
      return publicUser(row);
    },

    deleteSession(token) {
      if (!token) return false;
      const res = db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return res.changes > 0;
    },

    // --- products ---
    listProducts() {
      return db.prepare('SELECT * FROM products ORDER BY id ASC').all().map(publicProduct);
    },

    getProduct(id) {
      return publicProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id)));
    },

    productCodeExists(code, exceptId) {
      const row = db
        .prepare('SELECT id FROM products WHERE code = ? AND id != ?')
        .get(code, exceptId == null ? -1 : Number(exceptId));
      return Boolean(row);
    },

    createProduct(values) {
      const ts = now();
      const res = db
        .prepare(
          `INSERT INTO products (code, name, category, price, stock, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          values.code,
          values.name,
          values.category,
          values.price,
          values.stock,
          values.description ?? '',
          ts,
          ts,
        );
      return this.getProduct(Number(res.lastInsertRowid));
    },

    updateProduct(id, values) {
      const existing = this.getProduct(id);
      if (!existing) return null;
      db.prepare(
        `UPDATE products SET code = ?, name = ?, category = ?, price = ?, stock = ?, description = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        values.code,
        values.name,
        values.category,
        values.price,
        values.stock,
        values.description ?? '',
        now(),
        Number(id),
      );
      return this.getProduct(id);
    },

    deleteProduct(id) {
      const res = db.prepare('DELETE FROM products WHERE id = ?').run(Number(id));
      return res.changes > 0;
    },
  };
}

// Idempotently creates the three role accounts. Returns the usernames created.
export function seedDefaultUsers(dal) {
  const created = [];
  for (const def of SEED_DEFS) {
    if (dal.findUserByUsername(def.username)) continue;
    let password = process.env[def.envVar];
    if (!password) {
      password = randomBytes(9).toString('hex');
      log.warn('seed', 'generated random password (set env to control it)', {
        username: def.username,
        envVar: def.envVar,
        password,
      });
    }
    dal.createUser({ username: def.username, password, role: def.role, displayName: def.displayName });
    created.push(def.username);
  }
  return created;
}

// Lazily-initialized default instance for production code (pages / route handlers).
// Reads APP_DB_PATH at first use so tests can point it at a throwaway database.
// When SEED_ON_INIT=1 (set by the dev script) a fresh database is seeded so the
// app is loginable out of the box; tests never set the flag, so they control the
// data themselves.
let defaultDal = null;
export function getDal() {
  if (!defaultDal) {
    defaultDal = createDal(process.env.APP_DB_PATH || './data/app.db');
    if (process.env.SEED_ON_INIT === '1') seedDefaultUsers(defaultDal);
  }
  return defaultDal;
}
