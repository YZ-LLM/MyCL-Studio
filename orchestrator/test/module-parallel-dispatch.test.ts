import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  runParallelModules,
  type ModuleWork,
  type RunWorker,
} from "../src/module-parallel/dispatch.js";

function git(dir: string, args: string[]): void {
  spawnSync("git", args, { cwd: dir, stdio: "ignore" });
}
function setupRepo(dir: string): void {
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "t@e.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["commit", "--allow-empty", "-m", "init"]);
}

// Mock worker: her modülün belirtilen dosyalarını kendi worktree'sine yazar.
const writingWorker =
  (filesByModule: Record<string, string[]>): RunWorker =>
  async (m, wtPath) => {
    for (const f of filesByModule[m.id] ?? []) {
      const dest = join(wtPath, f);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, `// ${m.id}\n`);
    }
    return { ok: true };
  };

describe("runParallelModules (paralel codegen dispatch motoru)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mycl-par-"));
    setupRepo(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const A: ModuleWork = { id: "auth", scope_paths: ["src/auth/"], brief: "auth" };
  const B: ModuleWork = { id: "ui", scope_paths: ["src/ui/"], brief: "ui" };

  it("gate geçmezse parallel:false (flag kapalı → caller seri)", async () => {
    const r = await runParallelModules(dir, [A, B], { enabled: false }, writingWorker({}));
    expect(r.parallel).toBe(false);
  });

  it("happy path: 2 disjoint modül paralel yazar + ana ağaca entegre olur", async () => {
    const worker = writingWorker({
      auth: ["src/auth/login.ts"],
      ui: ["src/ui/page.tsx"],
    });
    const r = await runParallelModules(dir, [A, B], { enabled: true }, worker);
    expect(r.parallel).toBe(true);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, "src/auth/login.ts"))).toBe(true);
    expect(existsSync(join(dir, "src/ui/page.tsx"))).toBe(true);
    expect(r.integratedFiles?.slice().sort()).toEqual([
      "src/auth/login.ts",
      "src/ui/page.tsx",
    ]);
    // worktree'ler temizlendi
    expect(existsSync(join(dir, ".mycl/worktrees/auth"))).toBe(false);
  });

  it("worker hatası → ok:false (seri fallback) + worktree temizlenir", async () => {
    const worker: RunWorker = async (m) =>
      m.id === "ui" ? { ok: false, error: "boom" } : { ok: true };
    const r = await runParallelModules(dir, [A, B], { enabled: true }, worker);
    expect(r.parallel).toBe(true);
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir, ".mycl/worktrees/ui"))).toBe(false);
  });

  it("kapsam-DIŞI yazım → entegrasyon reddeder (defense-in-depth)", async () => {
    const worker = writingWorker({
      auth: ["src/auth/login.ts"],
      ui: ["src/auth/sneak.ts"], // ui kendi kapsamı dışına yazdı
    });
    const r = await runParallelModules(dir, [A, B], { enabled: true }, worker);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("kapsam-dışı");
    // ana ağaca sızıntı yok
    expect(existsSync(join(dir, "src/auth/sneak.ts"))).toBe(false);
  });
});
