import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLogger } from '@/lib/logger';
import { createApp } from '@/backend/app.js';

// Group E — Observability (structured logging + health) and the concurrent dev
// tiers (AC13).
beforeAll(() => {
  process.env.MYCL_ERRORS_DB = ':memory:';
});

describe('structured logger', () => {
  it('produces a record with level, msg, ts and extra fields via an injected sink', () => {
    const lines = [];
    const records = [];
    const logger = createLogger((line, record) => {
      lines.push(line);
      records.push(record);
    });
    logger.info('serving request', { requestId: 'abc', path: '/x' });
    logger.warn('slow', { ms: 12 });
    logger.error('boom', { code: 'E' });

    expect(records.map((r) => r.level)).toEqual(['info', 'warn', 'error']);
    expect(records[0]).toMatchObject({ level: 'info', msg: 'serving request', requestId: 'abc', path: '/x' });
    expect(typeof records[0].ts).toBe('number');
    // machine-readable JSON line
    expect(JSON.parse(lines[0]).msg).toBe('serving request');
  });
});

describe('health endpoint + leak-safe errors (observability)', () => {
  it('GET /health returns 200 { status: "ok" } with no side effects', () => {
    const recorded = [];
    const app = createApp({ recordError: (e) => recorded.push(e), logger: createLogger(() => {}) });
    const res = app.dispatch({ method: 'GET', path: '/health' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(recorded).toHaveLength(0); // read-only, nothing logged to the catalog
  });

  it('a thrown handler returns a generic 500 that leaks no internal detail', () => {
    const app = createApp({
      recordError: () => {},
      logger: createLogger(() => {}),
      routes: {
        'GET /x': () => {
          throw new Error('db password=hunter2 leaked');
        },
      },
    });
    const res = app.dispatch({ method: 'GET', path: '/x' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});

describe('concurrent dev scripts (AC13)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  it('npm run dev starts both tiers via concurrently', () => {
    expect(pkg.scripts.dev).toContain('concurrently');
    expect(pkg.scripts.dev).toContain('npm:dev:backend');
    expect(pkg.scripts.dev).toContain('npm:dev:frontend');
    expect(pkg.devDependencies.concurrently).toBeTruthy();
  });

  it('each tier can start alone', () => {
    expect(pkg.scripts['dev:backend']).toContain('backend/index.js');
    expect(pkg.scripts['dev:frontend']).toContain('next dev'); // the web UI dev server
  });
});

describe('backend tier serves requests through its node:http handler', () => {
  it('the request handler answers GET /health with 200 { status: "ok" }', async () => {
    const { createRequestHandler } = await import('@/backend/index.js');
    const handler = createRequestHandler();
    let captured = { status: 0, headers: null, body: '' };
    const res = {
      writeHead(status, headers) {
        captured.status = status;
        captured.headers = headers;
      },
      end(payload) {
        captured.body = payload;
      },
    };
    handler({ method: 'GET', url: '/health?ping=1' }, res);
    expect(captured.status).toBe(200);
    expect(captured.headers['content-type']).toBe('application/json');
    expect(JSON.parse(captured.body)).toEqual({ status: 'ok' });
  });

  it('the request handler answers an unknown path with a 404 envelope', async () => {
    const { createRequestHandler } = await import('@/backend/index.js');
    const handler = createRequestHandler();
    let captured = { status: 0, body: '' };
    handler(
      { method: 'GET', url: '/nope' },
      { writeHead: (s) => (captured.status = s), end: (b) => (captured.body = b) },
    );
    expect(captured.status).toBe(404);
    expect(JSON.parse(captured.body).error.code).toBe('NOT_FOUND');
  });
});
