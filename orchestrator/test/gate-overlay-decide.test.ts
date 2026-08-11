// gate-overlay/decide — tool_deny kararının SAF ikizi + GERÇEK muhafızla PARİTE kilidi.
//
// Buradaki asıl garanti: `orchestrator/overlay-guard.mjs` (ayrı süreç, dist'ten import etmez)
// ile `decideWrite` (TS) aynı durumda AYNI kararı verir. İki kopya bilinçli (fail-closed
// bütünlüğü derlenmiş çıktıya bağlı olamaz) — kopyanın sessizce ayrışmasını bu tablo engeller.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGuardRules,
  decideWrite,
  encodeGuardRules,
  isWriteTool,
  writeToolTargetPath,
  type GuardRules,
} from "../src/gate-overlay/decide.js";
import type { CompiledOverlay } from "../src/gate-overlay/compile.js";

const GUARD = resolve(dirname(fileURLToPath(import.meta.url)), "..", "overlay-guard.mjs");

let root = "";
let rules: GuardRules;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mycl-decide-"));
  await fs.mkdir(join(root, "src", "nested"), { recursive: true });
  await fs.mkdir(join(root, "docs"), { recursive: true });
  await fs.writeFile(join(root, "src", "config.ts"), "export const x = 1;\n");
  await fs.writeFile(join(root, "src", "app.ts"), "export const y = 2;\n");
  await fs.writeFile(join(root, "package.json"), "{}\n");
  rules = {
    project_root: root,
    immutable: ["src/config.ts"],
    no_new_files: ["src"],
    dependency_file_names: ["package.json", "Cargo.toml"],
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Gerçek muhafız sürecini koştur (Claude Code PreToolUse sözleşmesi: 0 = izin, 2 = engel). */
function runGuard(toolInput: Record<string, unknown>): { blocked: boolean; stderr: string } {
  const res = spawnSync("node", [GUARD, "--rules", encodeGuardRules(rules)], {
    input: JSON.stringify({ tool_name: "Write", tool_input: toolInput }),
    encoding: "utf-8",
  });
  return { blocked: res.status === 2, stderr: res.stderr };
}

interface Fixture {
  name: string;
  input: Record<string, unknown>;
  expectBlocked: boolean;
}

const FIXTURES: Fixture[] = [
  { name: "dondurulmus dosya (goreli)", input: { file_path: "src/config.ts" }, expectBlocked: true },
  { name: "dondurulmus dosya (mutlak)", input: { file_path: "__ROOT__/src/config.ts" }, expectBlocked: true },
  { name: "dondurulmus dosya (dolambac)", input: { file_path: "src/nested/../config.ts" }, expectBlocked: true },
  { name: "notebook_path alani da denetlenir", input: { notebook_path: "src/config.ts" }, expectBlocked: true },
  { name: "var olan baska dosya serbest", input: { file_path: "src/app.ts" }, expectBlocked: false },
  { name: "kok bagimlilik dosyasi", input: { file_path: "package.json" }, expectBlocked: true },
  { name: "alt dizindeki bagimlilik dosyasi", input: { file_path: "packages/web/package.json" }, expectBlocked: true },
  { name: "bagimlilik adi olmayan dosya", input: { file_path: "paketleme-notu.md" }, expectBlocked: false },
  { name: "yasakli dizinde YENI dosya", input: { file_path: "src/yeni.ts" }, expectBlocked: true },
  { name: "yasakli dizinde ic ice YENI dosya", input: { file_path: "src/nested/yeni.ts" }, expectBlocked: true },
  { name: "serbest dizinde yeni dosya", input: { file_path: "docs/yeni.md" }, expectBlocked: false },
  { name: "proje DISI mutlak yol", input: { file_path: "/tmp/mycl-disari.txt" }, expectBlocked: false },
  { name: "proje DISINA cikan dolambac", input: { file_path: "../disari.txt" }, expectBlocked: false },
  { name: "proje kokunun kendisi", input: { file_path: "." }, expectBlocked: false },
  { name: "yol alani hic yok (fail-closed)", input: {}, expectBlocked: true },
  { name: "bos yol (fail-closed)", input: { file_path: "   " }, expectBlocked: true },
];

describe("decideWrite ↔ overlay-guard.mjs PARİTESİ", () => {
  for (const fx of FIXTURES) {
    it(`aynı karar: ${fx.name}`, () => {
      const input = Object.fromEntries(
        Object.entries(fx.input).map(([k, v]) => [
          k,
          typeof v === "string" ? v.split("__ROOT__").join(root) : v,
        ]),
      );
      const target = writeToolTargetPath(input);
      const fileExists = target.trim() !== "" && existsSync(resolve(root, target));
      const ts = decideWrite(rules, target, fileExists);
      const guard = runGuard(input);

      expect(ts.allow).toBe(!fx.expectBlocked);
      expect(guard.blocked).toBe(fx.expectBlocked);
      // Engelde mesaj da birebir olmalı: model iki yolda AYNI geri bildirimi almalı.
      if (!ts.allow) expect(guard.stderr).toContain(ts.message);
    });
  }
});

describe("decideWrite — kural sırası", () => {
  it("hem dondurulmus hem bagimlilik ise ONCE file_immutable bildirilir (muhafızla aynı sıra)", () => {
    const both: GuardRules = { ...rules, immutable: ["package.json"] };
    const d = decideWrite(both, "package.json", true);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.gate_id).toBe("file_immutable");
  });

  it("gecersiz project_root → fail-closed", () => {
    const d = decideWrite({ ...rules, project_root: "goreli/yol" }, "src/app.ts", true);
    expect(d.allow).toBe(false);
  });
});

describe("buildGuardRules", () => {
  const overlay = (selections: CompiledOverlay["selections"]): CompiledOverlay => ({
    overlay_version: 1,
    pool_version: 1,
    iteration_key: "iter1-1",
    compiled_at: 1,
    selections,
    baselines: {},
  });

  it("tool_deny seçimi YOKSA null (kanca da kanarya da eklenmez)", () => {
    expect(buildGuardRules(overlay([{ gate_id: "file_must_change", params: { path: "a.ts" } }]), "/p")).toBeNull();
    expect(buildGuardRules(null, "/p")).toBeNull();
  });

  it("file_immutable + forbid_new_files + bağımlılık kilidi kurala çevrilir", () => {
    const r = buildGuardRules(
      overlay([
        { gate_id: "file_immutable", params: { path: "src/b.ts" } },
        { gate_id: "file_immutable", params: { path: "src/a.ts" } },
        { gate_id: "forbid_new_files", params: { dir: "src" } },
        { gate_id: "forbid_dependency_change", params: {} },
      ]),
      "/p",
    );
    expect(r).not.toBeNull();
    // Sıralı + tekil → aynı seçim kümesi her zaman aynı base64 (determinizm).
    expect(r!.immutable).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r!.no_new_files).toEqual(["src"]);
    expect(r!.dependency_file_names).toContain("package.json");
    expect(r!.dependency_file_names).toContain("go.sum");
  });

  it("bağımlılık kilidi yoksa dependency_file_names BOŞ (yanlış engel üretme)", () => {
    const r = buildGuardRules(overlay([{ gate_id: "file_immutable", params: { path: "a.ts" } }]), "/p");
    expect(r!.dependency_file_names).toEqual([]);
  });

  it("aynı seçim kümesi → bayt aynı base64 (AD-5)", () => {
    const sel: CompiledOverlay["selections"] = [
      { gate_id: "forbid_new_files", params: { dir: "src" } },
      { gate_id: "file_immutable", params: { path: "a.ts" } },
    ];
    const a = encodeGuardRules(buildGuardRules(overlay(sel), "/p")!);
    const b = encodeGuardRules(buildGuardRules(overlay([...sel].reverse()), "/p")!);
    expect(a).toBe(b);
  });
});

describe("isWriteTool", () => {
  it("yazma araçları tanınır, okuma araçları tanınmaz", () => {
    expect(isWriteTool("Write")).toBe(true);
    expect(isWriteTool("Edit")).toBe(true);
    expect(isWriteTool("MultiEdit")).toBe(true);
    expect(isWriteTool("NotebookEdit")).toBe(true);
    expect(isWriteTool("Read")).toBe(false);
    expect(isWriteTool("Bash")).toBe(false);
  });
});

// Kök seçimi ("dir": ".") — mahkeme öncesi gözden geçirme bulgusu (2026-08-11): envanter kökü dizin
// olarak sunar ve model bunu seçebilirken, eski kural `rel.startsWith("./")` aradığı için kök seçimi
// HİÇBİR ŞEYİ engellemiyordu — kullanıcı korunduğunu sanırken korunmazdı. İki taraf birlikte düzeltildi.
describe('forbid_new_files kök seçimi (".") — iki tarafta da tüm projeyi kapsar', () => {
  beforeEach(() => {
    rules = { ...rules, no_new_files: ["."] };
  });

  const CASES: Fixture[] = [
    { name: "kokte YENI dosya engellenir", input: { file_path: "yepyeni.md" }, expectBlocked: true },
    { name: "alt dizinde YENI dosya engellenir", input: { file_path: "docs/yepyeni.md" }, expectBlocked: true },
    { name: "VAR OLAN dosya duzenlemesi serbest", input: { file_path: "src/app.ts" }, expectBlocked: false },
  ];

  for (const fx of CASES) {
    it(`aynı karar: ${fx.name}`, () => {
      const target = writeToolTargetPath(fx.input);
      const fileExists = target.trim() !== "" && existsSync(resolve(root, target));
      const ts = decideWrite(rules, target, fileExists);
      const guard = runGuard(fx.input);
      expect(ts.allow).toBe(!fx.expectBlocked);
      expect(guard.blocked).toBe(fx.expectBlocked);
      if (!ts.allow) expect(guard.stderr).toContain(ts.message);
    });
  }
});
