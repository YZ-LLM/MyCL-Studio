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
      const ts = decideWrite(rules, target);
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
    const d = decideWrite(both, "package.json");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.gate_id).toBe("file_immutable");
  });

  it("gecersiz project_root → fail-closed", () => {
    const d = decideWrite({ ...rules, project_root: "goreli/yol" }, "src/app.ts");
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
      const ts = decideWrite(rules, target);
      const guard = runGuard(fx.input);
      expect(ts.allow).toBe(!fx.expectBlocked);
      expect(guard.blocked).toBe(fx.expectBlocked);
      if (!ts.allow) expect(guard.stderr).toContain(ts.message);
    });
  }
});

// MAHKEME KRİTİK BULGUSU (güvenlik müfettişi, PoC'li, 2026-08-11): eski karşılaştırma yalnız yol
// METNİNE bakıyordu — aynı fiziksel dosyaya farklı metinle ulaşan dört yol kilidi geçti: sembolik
// bağlantı, dizin bağlantısı, macOS büyük küçük harf duyarsızlığı, Unicode NFD. Karşılaştırma artık
// dosyanın KİMLİĞİNE iner (realpath + NFC + duyarsız platformda katlama). Bu tablo dört atlatmayı
// İKİ tarafta birden kilitler.
describe("mahkeme: kanonik yol — takma adla atlatma kapalı", () => {
  it("dosya sembolik bağlantısı: serbest görünen ada yazmak dondurulmuşu değiştiremez", async () => {
    await fs.symlink(join(root, "src", "config.ts"), join(root, "serbest-gorunen.ts"));
    const ts = decideWrite(rules, "serbest-gorunen.ts");
    const guard = runGuard({ file_path: "serbest-gorunen.ts" });
    expect(ts.allow).toBe(false);
    expect(guard.blocked).toBe(true);
    if (!ts.allow) {
      expect(ts.gate_id).toBe("file_immutable");
      expect(guard.stderr).toContain(ts.message);
    }
  });

  it("dizin sembolik bağlantısı: kısayoldan içeri YENİ dosya yazmak yasağı aşamaz", async () => {
    await fs.symlink(join(root, "src"), join(root, "kisayol"));
    const ts = decideWrite(rules, "kisayol/gizlice-yeni.ts");
    const guard = runGuard({ file_path: "kisayol/gizlice-yeni.ts" });
    expect(ts.allow).toBe(false);
    expect(guard.blocked).toBe(true);
    if (!ts.allow) expect(ts.gate_id).toBe("forbid_new_files");
  });

  it("bağımlılık dosyası takma adı: package.json bağlantısına yazmak engellenir", async () => {
    await fs.symlink(join(root, "package.json"), join(root, "pkg-takma.json"));
    const ts = decideWrite(rules, "pkg-takma.json");
    const guard = runGuard({ file_path: "pkg-takma.json" });
    expect(ts.allow).toBe(false);
    expect(guard.blocked).toBe(true);
    if (!ts.allow) expect(ts.gate_id).toBe("forbid_dependency_change");
  });

  it("Unicode NFD yazımı NFC kilidini aşamaz (her platformda — NFC normalizasyonu iki tarafta)", async () => {
    const nfc = "a\u00e7.ts"; // "aç.ts" tek kod noktası (NFC)
    // Bilinçli kaçış dizisi: iki sabit kaynak dosyada aynı bayta düşmesin, test gerçekten iki
    // FARKLI yazımı karşılaştırsın (ilk sürümde ikisi aynı bayttı → test boşuna geçiyordu).
    const nfd = "a\u0063\u0327.ts".normalize("NFD"); // ayrık aksan
    expect(nfc).not.toBe(nfd);
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));
    await fs.writeFile(join(root, nfc), "x\n");
    const r: GuardRules = { ...rules, immutable: [nfc], no_new_files: [] };
    const ts = decideWrite(r, nfd);
    const res = spawnSync("node", [GUARD, "--rules", encodeGuardRules(r)], {
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: nfd } }),
      encoding: "utf-8",
    });
    expect(ts.allow).toBe(false);
    expect(res.status).toBe(2);
  });

  it("büyük küçük harf: duyarsız platformda (macOS/Windows) farklı büyüklük kilidi aşamaz", () => {
    const expectBlocked = process.platform === "darwin" || process.platform === "win32";
    const ts = decideWrite(rules, "SRC/Config.ts");
    const res = spawnSync("node", [GUARD, "--rules", encodeGuardRules(rules)], {
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "SRC/Config.ts" } }),
      encoding: "utf-8",
    });
    // Linux'ta katlama YOK (farklı büyüklük gerçekten farklı dosyadır — engellemek yanlış alarm olurdu).
    expect(ts.allow).toBe(!expectBlocked);
    expect(res.status === 2).toBe(expectBlocked);
  });

  it("kök bağlantılı proje kökü (macOS /var → /private/var) engeli düşürmez", () => {
    // tmpdir macOS'ta sembolik kökten geçer; kural kökü realpath'lenmemiş halde verilse bile karar aynı.
    const viaTmp = { ...rules, project_root: root.replace(/^\/private\/var\//, "/var/") };
    const ts = decideWrite(viaTmp, "src/config.ts");
    expect(ts.allow).toBe(false);
  });
});
