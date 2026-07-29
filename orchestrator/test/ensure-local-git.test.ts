// ensureLocalGitRepo — git olmayan projede yerel depo başlatma (OE denetimi 2026-07-29).
// Gerçek git binary'siyle tmpdir'de: init + .gitignore güvencesi + baseline commit + idempotenlik.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ensureLocalGitRepo, isGitRepo } from "../src/git.js";

let root: string;
beforeEach(async () => {
  // ÖNEMLİ: macOS'ta /tmp sembolik; git üst dizinlerde depo ararsa yanılmasın diye gerçek path kullan.
  root = await mkdtemp(join(tmpdir(), "mycl-gitinit-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ensureLocalGitRepo", () => {
  it("git olmayan projede: init + .gitignore kritik girişleri + baseline commit", async () => {
    await writeFile(join(root, "app.js"), "console.log('x');\n");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "i.js"), "junk\n");
    await writeFile(join(root, ".env"), "SECRET=1\n");

    const r = await ensureLocalGitRepo(root);
    expect(r.status).toBe("initialized");
    expect(await isGitRepo(root)).toBe(true);

    // .gitignore kritik girişleri içeriyor
    const gi = await readFile(join(root, ".gitignore"), "utf-8");
    for (const e of ["node_modules/", ".mycl/", ".env"]) expect(gi).toContain(e);

    // baseline commit var + node_modules/.env İZLENMİYOR (sızmadı)
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf-8" });
    expect(files).toContain("app.js");
    expect(files).not.toContain("node_modules");
    expect(files).not.toMatch(/^\.env$/m);
    const subject = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: root, encoding: "utf-8" });
    expect(subject).toContain("MyCL baseline");
  });

  it("zaten git'liyse no-op ('already') — mevcut depoya dokunmaz", async () => {
    execFileSync("git", ["init"], { cwd: root });
    await writeFile(join(root, "a.txt"), "x\n");
    const r = await ensureLocalGitRepo(root);
    expect(r.status).toBe("already");
    // dokunulmadı: hâlâ commit'siz + a.txt untracked
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" });
    expect(status).toContain("a.txt");
  });

  it("idempotent: ikinci çağrı 'already' döner", async () => {
    await writeFile(join(root, "a.txt"), "x\n");
    expect((await ensureLocalGitRepo(root)).status).toBe("initialized");
    expect((await ensureLocalGitRepo(root)).status).toBe("already");
  });

  it("boş dizinde de depo kurulur (nothing-to-commit kabul)", async () => {
    const r = await ensureLocalGitRepo(root);
    expect(r.status).toBe("initialized");
    expect(await isGitRepo(root)).toBe(true);
  });
});
