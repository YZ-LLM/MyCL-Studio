import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { withFileLock, LockError } from "../src/state-lock.js";

describe("state-lock (v15.2 Core)", () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mycl-lock-"));
    target = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("withFileLock runs fn and releases lock", async () => {
    let ran = false;
    await withFileLock(target, async () => {
      ran = true;
      // Lock dosyası mevcut olmalı
      const lockExists = await fs
        .access(`${target}.lock`)
        .then(() => true)
        .catch(() => false);
      expect(lockExists).toBe(true);
    });
    expect(ran).toBe(true);
    // Lock dosyası temizlenmiş olmalı
    const lockExists = await fs
      .access(`${target}.lock`)
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(false);
  });

  it("withFileLock serializes concurrent calls", async () => {
    // İki paralel call — second call first call bittikten sonra başlamalı
    let inside = 0;
    let maxConcurrent = 0;
    const work = async () => {
      await withFileLock(target, async () => {
        inside++;
        maxConcurrent = Math.max(maxConcurrent, inside);
        await new Promise((r) => setTimeout(r, 50));
        inside--;
      });
    };
    await Promise.all([work(), work(), work()]);
    expect(maxConcurrent).toBe(1); // Aynı anda max 1 fn içeride
  });

  it("withFileLock cleans up stale lock (>5s old)", async () => {
    // Manuel olarak eski lock yarat
    const lockPath = `${target}.lock`;
    await fs.writeFile(lockPath, "stale-pid\n");
    // mtime'ı 10 saniye geçmişe ayarla
    const oldTs = (Date.now() - 10_000) / 1000;
    await fs.utimes(lockPath, oldTs, oldTs);

    let ran = false;
    await withFileLock(target, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("withFileLock throws LockError on acquire timeout", async () => {
    // Lock dosyası fresh — temizlenmemeli
    const lockPath = `${target}.lock`;
    await fs.writeFile(lockPath, "blocking-pid\n");

    await expect(
      withFileLock(target, async () => {
        // hiç ulaşmamalı
      }),
    ).rejects.toThrow(LockError);

    // Cleanup test sonu
    await fs.unlink(lockPath).catch(() => {});
  }, 10_000);

  it("withFileLock releases lock even if fn throws", async () => {
    await expect(
      withFileLock(target, async () => {
        throw new Error("inside error");
      }),
    ).rejects.toThrow("inside error");
    // Lock dosyası temizlenmiş olmalı
    const lockExists = await fs
      .access(`${target}.lock`)
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(false);
  });
});
