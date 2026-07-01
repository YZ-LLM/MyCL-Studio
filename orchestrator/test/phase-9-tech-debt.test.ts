import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectIterationTechDebt,
  MAX_SCAN_FILES,
  renderChangedFilesList,
  renderTechDebtFindings,
  scanFiles,
  type IterationTechDebt,
} from "../src/phase-9-tech-debt.js";
import type { State } from "../src/types.js";

// Saf çekirdek testleri — scanFiles + render'lar IO'suz. collectIterationTechDebt
// (git/fs impure) entegrasyon kapsamında; burada deterministik mantık doğrulanır.

function td(partial: Partial<IterationTechDebt>): IterationTechDebt {
  return {
    files: [],
    scannedFiles: [],
    scannedCount: 0,
    totalFindings: 0,
    truncated: false,
    gitAvailable: true,
    ...partial,
  };
}

describe("phase-9-tech-debt · scanFiles (saf)", () => {
  it("TODO/empty-catch/credential bulgularını yakalar; temiz dosya bulgu üretmez", () => {
    const { files, totalFindings } = scanFiles([
      { path: "src/a.ts", content: "// TODO: sonra düzelt\nconst x = 1;\n" },
      { path: "src/clean.ts", content: "export const ok = 1;\n" },
      { path: "src/b.ts", content: 'const password = "supersecret123";\ntry { run(); } catch {}\n' },
    ]);
    // a.ts (1 todo) + b.ts (1 credential + 1 empty-catch) = 2 dosya, 3 bulgu
    expect(files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(totalFindings).toBe(3);
    const a = files.find((f) => f.path === "src/a.ts")!;
    expect(a.findings[0].category).toBe("todo_comment");
    expect(a.findings[0].line).toBe(1);
  });

  it("hepsi temizse boş dönerge (0 bulgu)", () => {
    const { files, totalFindings } = scanFiles([
      { path: "src/a.ts", content: "export const a = 1;\n" },
    ]);
    expect(files).toEqual([]);
    expect(totalFindings).toBe(0);
  });

  // FIX D (mahkeme 2026-07-01): Faz 8'de KALICI kabul edilen bulgu Faz 9'da da atlanır (tutarsızlık yok).
  it("acceptedKeys ile Faz 8'de kabul edilen bulgu Faz 9'da da atlanır", async () => {
    const { acceptedFindingKey } = await import("../src/tech-debt-scanner.js");
    const entries = [
      { path: "src/seed.ts", content: 'const password = "dev-only-seed12";\n' },
    ];
    // acceptedKeys yok → bulgu çıkar
    expect(scanFiles(entries).totalFindings).toBe(1);
    // aynı (dosya+kategori+snippet) kabul edildi → Faz 9 da atlar
    const all = scanFiles(entries);
    const f = all.files[0].findings[0];
    const accepted = new Set([acceptedFindingKey("src/seed.ts", f.category, f.excerpt)]);
    expect(scanFiles(entries, accepted).totalFindings).toBe(0);
  });
});

describe("phase-9-tech-debt · renderTechDebtFindings (saf)", () => {
  it("git deposu yoksa dürüst not (sessiz boş değil)", () => {
    const out = renderTechDebtFindings(td({ gitAvailable: false }));
    expect(out).toMatch(/git deposu değil/);
    expect(out).toMatch(/atlandı/);
  });

  it("taranan dosya yoksa açık mesaj", () => {
    const out = renderTechDebtFindings(td({ scannedCount: 0 }));
    expect(out).toMatch(/taranacak değişen üretim dosyası yok/);
  });

  it("taranan var ama bulgu yoksa 'No deterministic markers'", () => {
    const out = renderTechDebtFindings(td({ scannedCount: 3, totalFindings: 0, files: [] }));
    expect(out).toMatch(/Scanned 3 changed production file/);
    expect(out).toMatch(/No deterministic markers/);
  });

  it("bulgular dosya + satır + kategori ile listelenir", () => {
    const out = renderTechDebtFindings(
      td({
        scannedCount: 1,
        totalFindings: 1,
        files: [
          {
            path: "src/x.ts",
            findings: [{ category: "todo_comment", line: 7, excerpt: "// TODO: x", reason: "todo marker" }],
          },
        ],
      }),
    );
    expect(out).toMatch(/### src\/x\.ts/);
    expect(out).toMatch(/L7 \[todo_comment\]/);
  });

  it("truncated → görünür NOTE (sessiz kesme yok)", () => {
    const out = renderTechDebtFindings(td({ scannedCount: MAX_SCAN_FILES, totalFindings: 0, truncated: true }));
    expect(out).toMatch(new RegExp(`exceeded ${MAX_SCAN_FILES}`));
  });
});

describe("phase-9-tech-debt · renderChangedFilesList (saf)", () => {
  it("boşsa açık '(none...)'", () => {
    expect(renderChangedFilesList(td({ scannedFiles: [] }))).toMatch(/none/);
  });

  it("liste madde madde", () => {
    const out = renderChangedFilesList(td({ scannedFiles: ["src/a.ts", "src/b.ts"] }));
    expect(out).toBe("- src/a.ts\n- src/b.ts");
  });
});

function gitInit(dir: string) {
  spawnSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
}
function gitAddCommit(dir: string, msg: string) {
  spawnSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", msg], { cwd: dir, stdio: "ignore" });
}
const asState = (project_root: string, fix_checkpoint_ref?: string): State =>
  ({ project_root, fix_checkpoint_ref }) as unknown as State;

describe("phase-9-tech-debt · collectIterationTechDebt (git entegrasyon)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mycl-p9td-"));
    await mkdir(join(dir, "src"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("git deposu değilse gitAvailable:false (sessiz boş değil)", async () => {
    await writeFile(join(dir, "src", "x.ts"), "// TODO: x\n");
    const td = await collectIterationTechDebt(asState(dir));
    expect(td.gitAvailable).toBe(false);
    expect(renderTechDebtFindings(td)).toMatch(/git deposu değil/);
  });

  it("YALNIZ bu iterasyonun değişen dosyasını tarar — önceki commit'li borç gündeme gelmez", async () => {
    gitInit(dir);
    // Baseline: içinde TODO olan bir dosya — COMMIT'lenir (önceki iş, bu iterasyon değil).
    await writeFile(join(dir, "src", "old.ts"), "// TODO: eski borç\nexport const a = 1;\n");
    gitAddCommit(dir, "baseline");
    // Bu iterasyon: YENİ dosya, FIXME içerir (untracked → working tree değişikliği).
    await writeFile(join(dir, "src", "new.ts"), "export function f() {}\n// FIXME: yeni borç\n");

    const td = await collectIterationTechDebt(asState(dir)); // create-benzeri: ref yok → HEAD baseline
    expect(td.gitAvailable).toBe(true);
    const paths = td.files.map((f) => f.path);
    expect(paths).toContain("src/new.ts"); // bu iterasyonun işi → taranır
    expect(paths).not.toContain("src/old.ts"); // önceki commit → kapsam dışı
    expect(td.totalFindings).toBe(1);
    expect(td.scannedFiles).toContain("src/new.ts");
  });

  it("test dosyaları taranmaz (mock/skip orada meşru)", async () => {
    gitInit(dir);
    gitAddCommit(dir, "empty"); // HEAD oluştur
    await writeFile(join(dir, "src", "feature.test.ts"), "it.skip('x', () => {});\n// TODO: t\n");
    const td = await collectIterationTechDebt(asState(dir));
    expect(td.files.map((f) => f.path)).not.toContain("src/feature.test.ts");
  });
});
