// arch-check — "taranacak dosya yok" durumunun çıkış kodu sözleşmesi (gerçek süreç, tmpdir).
// Eskiden 0 dosyada "katman ihlali yok" deyip çıkış 0 veriyordu → ölçmeden "geçti" (ör. JS olmayan proje).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "arch-check.mjs");
let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arch-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const run = (...args: string[]) => spawnSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf-8" }).status;

describe("arch-check · ölçülemeyen proje", () => {
  it("kaynak dosyası olmayan proje (ör. yalnız Python) → çıkış 3 (ölçülmedi), 0 değil", async () => {
    await writeFile(join(dir, "main.py"), "print('x')\n");
    expect(run("--project", ".")).toBe(3);
  });

  it("temiz JS kaynağı olan proje → çıkış 0", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
    expect(run("--project", ".")).toBe(0);
  });

  it("kapsamlı (scoped) modda eşleşen dosya yoksa → çıkış 0 (değişen dosyalar arasında kaynak yok, meşru)", async () => {
    await writeFile(join(dir, "README.md"), "# x\n");
    expect(run("README.md")).toBe(0);
  });
});
