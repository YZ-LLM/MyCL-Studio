// gitignore-util — idempotent .gitignore girdi ekleme (fix checkpoint clean-tree
// koruması). v15.10 bug: `error_folder/*` varken `error_folder/` tekrar eklenip
// tree'yi kirletiyordu → checkpoint fail → scoped-gate devre dışı.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureGitignoreEntry } from "../src/gitignore-util.js";

describe("ensureGitignoreEntry (idempotent)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gi-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const gi = () => join(dir, ".gitignore");

  it("aynı dizin başka kalıpla (error_folder/*) varsa error_folder/ EKLEMEZ (bug fix)", async () => {
    writeFileSync(gi(), "node_modules/\nerror_folder/*\n");
    const wrote = await ensureGitignoreEntry(dir, "error_folder/");
    expect(wrote).toBe(false);
    expect(readFileSync(gi(), "utf-8")).toBe("node_modules/\nerror_folder/*\n"); // değişmedi
  });

  it("/** kalıbı da kapsar — error_folder/** varsa error_folder eklemez", async () => {
    writeFileSync(gi(), "error_folder/**\n");
    expect(await ensureGitignoreEntry(dir, "error_folder")).toBe(false);
  });

  it("kapsanmayan yeni girdi → ekler", async () => {
    writeFileSync(gi(), "node_modules/\n");
    expect(await ensureGitignoreEntry(dir, "dist/")).toBe(true);
    expect(readFileSync(gi(), "utf-8")).toContain("dist/");
  });

  it("tam duplikat → no-op", async () => {
    writeFileSync(gi(), ".mycl/\n");
    expect(await ensureGitignoreEntry(dir, ".mycl/")).toBe(false);
  });

  it(".gitignore yoksa oluşturur", async () => {
    expect(existsSync(gi())).toBe(false);
    expect(await ensureGitignoreEntry(dir, ".mycl/")).toBe(true);
    expect(readFileSync(gi(), "utf-8")).toBe(".mycl/\n");
  });

  it("trailing newline yoksa düzgün ekler", async () => {
    writeFileSync(gi(), "node_modules/"); // newline yok
    await ensureGitignoreEntry(dir, "dist/");
    expect(readFileSync(gi(), "utf-8")).toBe("node_modules/\ndist/\n");
  });
});
