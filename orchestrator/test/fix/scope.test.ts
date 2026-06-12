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

  // Ümit 2026-06-12 "yalnız değişen dosyaları denetle": NON-GIT projede git diff boş → audit write-event'lerinden
  // değişen-dosya türetilmeli (yoksa scoped hiç uygulanmaz → full → alakasız flag). iteration_started_at zaman sınırı.
  it("non-git proje: git diff boş → audit write-event'lerinden scope + blast-radius türetir", async () => {
    const ng = await mkdtemp(join(tmpdir(), "mycl-scope-ng-")); // git init YOK
    try {
      await write(ng, "src/hub.ts", "export const h = 1;\n");
      await write(ng, "src/a.ts", "import { h } from './hub';\nexport const a = h;\n");
      // codegen bu iterasyonda src/hub.ts'i yazdı (audit) — ts iteration_started_at (500) SONRASI.
      // GERÇEK senaryo (adminpanel): Claude Code Write/Edit file_path MUTLAK → detail mutlak yol gelir;
      // changedFilesFromAudit projectRoot'u kırpıp relative'e indirmeli. Bunu mutlak detail ile kanıtla.
      const auditLines = [
        { ts: 400, phase: 8, event: "tdd-prod-write", caller: "x", detail: "src/eski.ts" }, // sinceTs ÖNCESİ → atla
        { ts: 1000, phase: 8, event: "tdd-prod-write", caller: "x", detail: join(ng, "src/hub.ts") }, // MUTLAK → relative'e inmeli
      ]
        .map((e) => JSON.stringify(e))
        .join("\n");
      await write(ng, ".mycl/audit.log", auditLines + "\n");
      const scope = await computeChangedScope(ng, undefined, 500); // sinceTs=500
      expect(scope.available).toBe(true);
      // hub (audit'ten) + a (blast-radius: hub'ı import eder); eski.ts (sinceTs öncesi) DAHİL DEĞİL.
      expect(scope.files.sort()).toEqual(["src/a.ts", "src/hub.ts"]);
    } finally {
      await rm(ng, { recursive: true, force: true });
    }
  });

  // Under-scope açığı: Faz-5 tweak Edit'i `ui-tweak-applied` üretir (tdd/code-edit DEĞİL). Eskiden listede yoktu →
  // tweak'lenmiş güvenlik-dosyası scope DIŞI → Faz 13 onu atlardı (false-green). Artık kapsamda olmalı.
  it("non-git: ui-tweak-applied (Faz-5 tweak Edit) da kapsama girer (eksik-kapsam tehlikeli)", async () => {
    const ng = await mkdtemp(join(tmpdir(), "mycl-scope-tw-"));
    try {
      await write(ng, "src/widget.ts", "export const w = 1;\n");
      const line = JSON.stringify({
        ts: 1000,
        phase: 5,
        event: "ui-tweak-applied",
        caller: "x",
        detail: join(ng, "src/widget.ts"),
      });
      await write(ng, ".mycl/audit.log", line + "\n");
      const scope = await computeChangedScope(ng, undefined, 500);
      expect(scope.available).toBe(true);
      expect(scope.files).toContain("src/widget.ts");
    } finally {
      await rm(ng, { recursive: true, force: true });
    }
  });

  it("non-git + iterationStartTs verilmezse → eski davranış (full fallback, available false)", async () => {
    const ng = await mkdtemp(join(tmpdir(), "mycl-scope-ng2-"));
    try {
      await write(ng, "src/x.ts", "export const x = 1;\n");
      const scope = await computeChangedScope(ng); // iterationStartTs YOK
      expect(scope.available).toBe(false);
    } finally {
      await rm(ng, { recursive: true, force: true });
    }
  });
});
