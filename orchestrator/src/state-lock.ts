// state-lock — state.json concurrent-write koruması (v15.2 Core).
//
// Multi-instance senaryosunda (aynı projeyi iki MyCL Studio açarsa, ya da
// orchestrator subprocess paralel save denerse) atomic-rename last-write-wins
// olur. POSIX file lock veya proper-lockfile npm paketi yerine minimal
// dependency-free implementation: `<state.json>.lock` dosyası `open(wx)` ile
// atomik yaratılır (path zaten varsa EEXIST → fail). Stale lock (process
// crash sonrası kalan) 5 saniyeden eski ise temizlenir.
//
// Kullanım: `await withFileLock(statePath, async () => { ... yazma ... })`.

import { open, stat, unlink } from "node:fs/promises";
import { log } from "./logger.js";

const STALE_MS = 5_000;
const ACQUIRE_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 50;

export class LockError extends Error {
  override readonly name = "LockError";
}

/**
 * v15.2.3 QC borç D1: `withFileLock` üzerine retry wrapper. LockError
 * timeout durumunda exponential backoff (100ms, 200ms, 500ms) ile
 * `retries` kadar tekrar dener. Caller (örn `state.save()`) tek nokta'da
 * yazma retry'sını yönetir; her retry öncesi opsiyonel `onRetry` callback
 * çağrılır (UI toast/log için).
 */
export async function withFileLockRetry<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts?: {
    retries?: number;
    delaysMs?: number[];
    onRetry?: (attempt: number, maxAttempts: number) => void;
  },
): Promise<T> {
  const retries = opts?.retries ?? 3;
  const delays = opts?.delaysMs ?? [100, 200, 500];
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withFileLock(targetPath, fn);
    } catch (err) {
      if (!(err instanceof LockError)) throw err;
      lastErr = err;
      if (attempt < retries) {
        opts?.onRetry?.(attempt + 1, retries + 1);
        const delay = delays[Math.min(attempt, delays.length - 1)];
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * `<path>.lock` dosyası ile mutex etrafında `fn`'i çalıştırır. Aynı anda
 * iki çağrı varsa biri bekler (max ACQUIRE_TIMEOUT_MS), sonra LockError.
 * Stale lock (5s+ eski mtime) silinir → process crash recovery.
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    try {
      await unlink(lockPath);
    } catch (err) {
      // Best effort — lock dosyası gitmiş olabilir
      log.warn("state-lock", "unlink failed (best effort)", err);
    }
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const startTs = Date.now();
  while (true) {
    // Stale lock temizliği
    try {
      const s = await stat(lockPath);
      if (Date.now() - s.mtimeMs > STALE_MS) {
        log.warn("state-lock", "stale lock cleanup", { lockPath, ageMs: Date.now() - s.mtimeMs });
        try {
          await unlink(lockPath);
        } catch {
          // race ile silen başka biri olabilir
        }
      }
    } catch {
      // lock yok — try create
    }

    try {
      const fd = await open(lockPath, "wx");
      try {
        await fd.write(`${process.pid}\n${Date.now()}\n`);
      } finally {
        await fd.close();
      }
      return; // acquired
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw new LockError(
          `lock acquire failed (non-EEXIST): ${lockPath}: ${String(err)}`,
        );
      }
      // Lock var, bekle
      if (Date.now() - startTs > ACQUIRE_TIMEOUT_MS) {
        throw new LockError(
          `lock acquire timeout (${ACQUIRE_TIMEOUT_MS}ms): ${lockPath}`,
        );
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}
