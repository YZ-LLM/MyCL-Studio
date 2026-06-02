// fix/scope — computeChangedScope testleri (gerçek temp git repo + dep-graph).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { computeChangedScope } from "../../src/fix/scope.js";

function gitInit(dir: string) {
  spawnSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
}
async function write(root: string, rel: string, content: string) {
  const full = join(root, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf-8");
}

describe("fix/scope · computeChangedScope", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-scope-"));
    gitInit(root);
    // hub.ts <- a.ts (a, hub'ı import eder)
    await write(root, "src/hub.ts", "export const h = 1;\n");
    await write(root, "src/a.ts", "import { h } from './hub';\nexport const a = h;\n");
    spawnSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "seed"], { cwd: root, stdio: "ignore" });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("değişen dosya + blast-radius (onu import eden) birleşir", async () => {
    await write(root, "src/hub.ts", "export const h = 2; // changed\n");
    const scope = await computeChangedScope(root);
    expect(scope.available).toBe(true);
    expect(scope.files.sort()).toEqual(["src/a.ts", "src/hub.ts"]); // hub + onu import eden a
  });

  it("değişiklik yok → available false (tüm-proje fallback sinyali)", async () => {
    const scope = await computeChangedScope(root);
    expect(scope.available).toBe(false);
    expect(scope.files).toEqual([]);
  });

  it("kaynak-dışı değişiklik (README) → kapsam dışı", async () => {
    await write(root, "README.md", "# changed\n");
    const scope = await computeChangedScope(root);
    expect(scope.available).toBe(false); // kaynak dosya değişmedi
  });

  it("yeni (untracked) kaynak dosya kapsama girer", async () => {
    await write(root, "src/new.ts", "export const n = 1;\n");
    const scope = await computeChangedScope(root);
    expect(scope.files).toContain("src/new.ts");
  });
});
