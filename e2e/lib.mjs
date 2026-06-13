// e2e/lib.mjs — minik test yardımcıları (sıfır bağımlılık).

import http from "node:http";

export class Reporter {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.lines = [];
  }
  ok(msg) {
    this.passed++;
    this.lines.push(`  ✓ ${msg}`);
    process.stdout.write(`  ✓ ${msg}\n`);
  }
  bad(msg) {
    this.failed++;
    this.lines.push(`  ✗ ${msg}`);
    process.stdout.write(`  ✗ ${msg}\n`);
  }
  step(msg) {
    process.stdout.write(`\n── ${msg} ──\n`);
  }
  async check(msg, fn) {
    try {
      await fn();
      this.ok(msg);
    } catch (e) {
      this.bad(`${msg} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  summary() {
    process.stdout.write("\n");
    if (this.failed === 0) {
      process.stdout.write(`✅ e2e: HEPSİ GEÇTİ (${this.passed})\n`);
    } else {
      process.stdout.write(`❌ e2e: ${this.failed} BAŞARISIZ / ${this.passed} geçti\n`);
    }
    return this.failed === 0;
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

export async function waitFor(fn, { timeout = 15000, interval = 200, label = "koşul" } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error(`zaman aşımı (${timeout}ms): ${label}${lastErr ? ` — ${lastErr.message}` : ""}`);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// http 200 mi (GET) — fetch yerine yerleşik http (proxy/keep-alive sürprizi yok).
export function httpStatus(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on("error", () => resolve(0));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(0);
    });
  });
}
