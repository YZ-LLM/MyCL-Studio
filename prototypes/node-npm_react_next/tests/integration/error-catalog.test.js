import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Group D — MyCL error catalog (AC8, AC9, AC10, AC11, AC12).
const ERRORS_DB = join(tmpdir(), `mycl_errors_${randomUUID()}.db`);

beforeAll(() => {
  process.env.MYCL_ERRORS_DB = ERRORS_DB;
  process.env.APP_DB_PATH = ':memory:';
});

describe('error catalog: schema, recording, endpoints', () => {
  // AC8 — db has the exact errors schema and holds ONLY the error catalog.
  it('AC8: initializes mycl_errors.db with the errors table and nothing else', async () => {
    const { initErrorsDb } = await import('@/error_folder/init-errors-db');
    const db = initErrorsDb(ERRORS_DB);
    const cols = db.prepare('PRAGMA table_info(errors)').all().map((c) => c.name);
    expect(cols).toEqual([
      'id',
      'ts',
      'error_code',
      'location',
      'description_tr',
      'stack',
      'resolved',
      'solution_tr',
    ]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((t) => t.name);
    // ONLY the error catalog — no users / products tables here.
    expect(tables).toEqual(['errors']);
  });

  // AC8/AC9 — recordError writes a runtime row (resolved=0, solution_tr=NULL).
  it('recordError writes a row with resolved=0 and no solution yet', async () => {
    const { recordError, listErrors } = await import('@/error_folder/init-errors-db');
    const id = recordError({
      error_code: 'TEST_CODE',
      location: '/api/things',
      description_tr: 'Bir hata oluştu.',
      stack: 'Error: boom\n  at x',
    });
    expect(id).toBeGreaterThan(0);
    const row = listErrors().find((r) => r.id === id);
    expect(row.error_code).toBe('TEST_CODE');
    expect(row.location).toBe('/api/things');
    expect(row.resolved).toBe(0);
    expect(row.solution_tr).toBeNull();
  });

  // AC9 — backend error middleware records uncaught exceptions AND 4xx/5xx,
  // with location set to the endpoint path; never leaks the stack to the client.
  it('AC9: middleware records a thrown error with location=path + stack, returns generic 500', async () => {
    const { createApp } = await import('@/backend/app.js');
    const recorded = [];
    const app = createApp({
      recordError: (e) => recorded.push(e),
      logger: { info() {}, warn() {}, error() {} },
      routes: {
        'GET /boom': () => {
          throw new Error('kaboom-secret-internal');
        },
      },
    });
    const res = app.dispatch({ method: 'GET', path: '/boom' });
    expect(res.status).toBe(500);
    // no stack / internal message leaks to the client
    expect(JSON.stringify(res.body)).not.toContain('kaboom-secret-internal');
    expect(JSON.stringify(res.body)).not.toContain('at ');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].location).toBe('/boom');
    expect(recorded[0].stack).toContain('kaboom-secret-internal');
  });

  it('AC9: middleware catalogs a 4xx response with the endpoint path', async () => {
    const { createApp } = await import('@/backend/app.js');
    const recorded = [];
    const app = createApp({
      recordError: (e) => recorded.push(e),
      logger: { info() {}, warn() {}, error() {} },
      routes: { 'GET /bad': () => ({ status: 422, body: { error: { code: 'X' } } }) },
    });
    const res = app.dispatch({ method: 'GET', path: '/bad' });
    expect(res.status).toBe(422);
    expect(recorded[0].location).toBe('/bad');
    expect(recorded[0].error_code).toBe('HTTP_422');
  });

  it('AC9: health is not treated as an error', async () => {
    const { createApp } = await import('@/backend/app.js');
    const recorded = [];
    const app = createApp({ recordError: (e) => recorded.push(e), logger: { info() {}, warn() {}, error() {} } });
    const res = app.dispatch({ method: 'GET', path: '/health' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(recorded).toHaveLength(0);
  });

  // AC10 — /api/log-error writes a row and returns 201.
  it('AC10: POST /api/log-error persists the reported error (201)', async () => {
    const { POST } = await import('@/app/api/log-error/route');
    const { listErrors } = await import('@/error_folder/init-errors-db');
    const before = listErrors().length;
    const req = new Request('http://localhost/api/log-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error_code: 'CLIENT_RENDER_ERROR',
        location: '/urunler',
        description_tr: 'İstemci render hatası.',
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(listErrors().length).toBe(before + 1);
  });

  it('AC10: POST /api/log-error rejects a body missing required fields (400)', async () => {
    const { POST } = await import('@/app/api/log-error/route');
    const req = new Request('http://localhost/api/log-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ location: '/x' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // AC10 — the client fetch wrapper POSTs to /api/log-error on a non-2xx response.
  it('AC10: apiFetch reports a failed response to /api/log-error', async () => {
    const { apiFetch } = await import('@/lib/api-client');
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      if (url === '/api/data') return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 201, json: async () => ({}) };
    });
    await expect(apiFetch('/api/data')).rejects.toThrow();
    globalThis.fetch = realFetch;
    const reported = calls.find((c) => c.url === '/api/log-error');
    expect(reported).toBeTruthy();
    expect(reported.opts.method).toBe('POST');
  });

  // AC11 — the Hata Kodları data source returns all catalog rows for an admin,
  // and is admin-only (least privilege).
  it('AC11: GET /api/errors returns catalog rows for an admin', async () => {
    const { GET } = await import('@/app/api/errors/route');
    const { getDal } = await import('@/lib/db/dal');
    const { COOKIE_SESSION } = await import('@/lib/auth-constants');
    const dal = getDal();
    const admin = dal.createUser({ username: 'admin', password: 'pw', role: 'admin', displayName: 'A' });
    const token = dal.createSession(admin.id);
    const req = new Request('http://localhost/api/errors', { headers: { cookie: `${COOKIE_SESSION}=${token}` } });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.errors)).toBe(true);
    expect(data.errors.length).toBeGreaterThan(0);
  });

  it('AC11: GET /api/errors forbids a non-admin (403) and an anonymous caller (401)', async () => {
    const { GET } = await import('@/app/api/errors/route');
    const { getDal } = await import('@/lib/db/dal');
    const { COOKIE_SESSION } = await import('@/lib/auth-constants');
    const dal = getDal();
    const dealer = dal.createUser({ username: 'bayi', password: 'pw', role: 'dealer', displayName: 'B' });
    const token = dal.createSession(dealer.id);

    const forbidden = await GET(
      new Request('http://localhost/api/errors', { headers: { cookie: `${COOKIE_SESSION}=${token}` } }),
    );
    expect(forbidden.status).toBe(403);

    const anon = await GET(new Request('http://localhost/api/errors'));
    expect(anon.status).toBe(401);
  });

  // AC12 — error_folder/ is gitignored.
  it('AC12: .gitignore ignores error_folder/', () => {
    const gi = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
    expect(gi).toMatch(/^\/?error_folder\/?$/m);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
