// overlay-guard — araç anı muhafızının sözleşme testleri (gerçek süreç, tmpdir; LLM yok).
//
// Sözleşme (Claude Code PreToolUse): exit 0 = izin, exit 2 = engel (stderr modele döner).
// GÜVENLİK: kurallar argv'de base64 gömülü (ajan dosyayla değiştiremez); hata = ENGEL (fail-closed).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// ESM'de __dirname yok — depodaki desen (tauri-resources.test.ts) fileURLToPath.
const GUARD = resolve(dirname(fileURLToPath(import.meta.url)), "..", "overlay-guard.mjs");

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mycl-guard-"));
  await fs.mkdir(join(root, "src"), { recursive: true });
  await fs.writeFile(join(root, "src", "config.ts"), "export const x = 1;\n");
  await fs.writeFile(join(root, "src", "app.ts"), "export const y = 2;\n");
  await fs.writeFile(join(root, "package.json"), "{}\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function rulesB64(over?: Partial<Record<string, unknown>>): string {
  const rules = {
    project_root: root,
    immutable: ["src/config.ts"],
    no_new_files: ["src"],
    dependency_file_names: ["package.json", "Cargo.toml"],
    ...over,
  };
  return Buffer.from(JSON.stringify(rules), "utf-8").toString("base64");
}

function runGuard(
  toolInput: Record<string, unknown>,
  opts?: { rules?: string; toolName?: string },
): { status: number | null; stderr: string } {
  const res = spawnSync("node", [GUARD, "--rules", opts?.rules ?? rulesB64()], {
    input: JSON.stringify({ tool_name: opts?.toolName ?? "Write", tool_input: toolInput }),
    encoding: "utf-8",
  });
  return { status: res.status, stderr: res.stderr };
}

describe("file_immutable — dondurulmuş dosya", () => {
  it("dondurulmuş dosyaya yazma ENGELLENİR (exit 2) ve stderr gerekçeyi söyler", () => {
    const r = runGuard({ file_path: "src/config.ts" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("file_immutable");
    expect(r.stderr).toContain("src/config.ts");
  });

  it("MUTLAK yolla da engellenir", () => {
    const r = runGuard({ file_path: join(root, "src", "config.ts") });
    expect(r.status).toBe(2);
  });

  it("dolambaçlı yol (sub/../) engeli AŞAMAZ", () => {
    const r = runGuard({ file_path: "src/nested/../config.ts" });
    expect(r.status).toBe(2);
  });

  it("başka dosyaya yazma serbest (exit 0)", () => {
    const r = runGuard({ file_path: "src/app.ts" });
    expect(r.status).toBe(0);
  });

  it("NotebookEdit'in notebook_path alanı da denetlenir", () => {
    const r = runGuard({ notebook_path: "src/config.ts" }, { toolName: "NotebookEdit" });
    expect(r.status).toBe(2);
  });
});

describe("forbid_new_files — dizinde yeni dosya yasağı", () => {
  it("dizin altında OLMAYAN dosya (yeni oluşturma) engellenir", () => {
    const r = runGuard({ file_path: "src/yeni-dosya.ts" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("forbid_new_files");
  });

  it("dizin altında VAR OLAN dosyayı düzenlemek serbest", () => {
    const r = runGuard({ file_path: "src/app.ts" });
    expect(r.status).toBe(0);
  });

  it("dizin dışında yeni dosya serbest", () => {
    const r = runGuard({ file_path: "docs-yeni.md" });
    expect(r.status).toBe(0);
  });
});

describe("forbid_dependency_change — bağımlılık dosyaları", () => {
  it("kökteki package.json engellenir", () => {
    const r = runGuard({ file_path: "package.json" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("forbid_dependency_change");
  });

  it("ALT dizindeki package.json da engellenir (monorepo çalışma alanları)", () => {
    const r = runGuard({ file_path: "packages/web/package.json" });
    expect(r.status).toBe(2);
  });

  it("ad listesinde olmayan dosya serbest", () => {
    const r = runGuard({ file_path: "paketleme-notu.md" });
    expect(r.status).toBe(0);
  });
});

describe("fail-closed — hata = engel", () => {
  it("bozuk base64 kurallar → exit 2", () => {
    const r = runGuard({ file_path: "src/app.ts" }, { rules: "bozuk!!!" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("failing closed");
  });

  it("stdin'de bozuk JSON → exit 2", () => {
    const res = spawnSync("node", [GUARD, "--rules", rulesB64()], {
      input: "bu json degil",
      encoding: "utf-8",
    });
    expect(res.status).toBe(2);
  });

  it("yol alanı olmayan yazma aracı → exit 2", () => {
    const r = runGuard({});
    expect(r.status).toBe(2);
  });

  it("--rules hiç verilmemiş → exit 2", () => {
    const res = spawnSync("node", [GUARD], {
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "x" } }),
      encoding: "utf-8",
    });
    expect(res.status).toBe(2);
  });

  it("project_root göreli/boş → exit 2", () => {
    const r = runGuard({ file_path: "src/app.ts" }, { rules: rulesB64({ project_root: "goreli/yol" }) });
    expect(r.status).toBe(2);
  });
});

describe("kapsam sınırı", () => {
  it("proje DIŞI yol overlay'in işi değil → serbest (kum havuzu yönetir)", () => {
    const r = runGuard({ file_path: "/tmp/baska-yer.txt" });
    expect(r.status).toBe(0);
  });
});

describe("kanarya (--ack)", () => {
  it("işaret dosyasını yazar ve exit 0 döner", async () => {
    const marker = join(root, ".mycl", "overlay-ack.json");
    const res = spawnSync("node", [GUARD, "--ack", marker], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    const body = JSON.parse(await fs.readFile(marker, "utf-8"));
    expect(typeof body.at).toBe("number");
  });
});
