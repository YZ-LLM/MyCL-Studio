import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotBeforeAutofix } from "../src/fix-snapshot.js";

describe("snapshotBeforeAutofix (git yoksa .mycl/backups kopya)", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mycl-snap-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("git olmayan projede kaynağı yedekler, node_modules'ı HARİÇ tutar", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.js"), "export const x = 1;\n");
    await mkdir(join(dir, "node_modules", "junk"), { recursive: true });
    await writeFile(join(dir, "node_modules", "junk", "big.js"), "x".repeat(1000));
    const snap = await snapshotBeforeAutofix(dir, 1781000000000);
    expect(snap.method).toBe("copy");
    expect(snap.dir).toBeTruthy();
    // kaynak kopyalandı
    const copied = await readFile(join(snap.dir!, "src", "app.js"), "utf8");
    expect(copied).toContain("export const x = 1");
    // node_modules KOPYALANMADI (ağır dizin hariç)
    expect(existsSync(join(snap.dir!, "node_modules"))).toBe(false);
  });
});
