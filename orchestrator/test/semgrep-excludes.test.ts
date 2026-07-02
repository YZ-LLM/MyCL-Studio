import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { SEMGREP_EXCLUDE_FLAGS } from "../src/semgrep-excludes.js";
import { ensureSemgrepIgnore } from "../src/ensure-gate-configs.js";

describe("SEMGREP_EXCLUDE_FLAGS (tek kaynak)", () => {
  it("build-dir + vendor + minified/bundle desenlerini içerir", () => {
    // Mevcut (regresyon): build çıktısı + paket dizinleri.
    for (const d of [".next", "dist", "build", "node_modules", "vendor", "target", "mycl-audit*"]) {
      expect(SEMGREP_EXCLUDE_FLAGS).toContain(`--exclude='${d}'`);
    }
    // YENİ (cave5 false-positive fix): minified + bundle vendor globları.
    // `*.min*.js` (yalnız `.min.js` değil) → minified KOPYALARI da (`table.min - Copy.js`) yakalar.
    for (const g of ["*.min*.js", "*.min*.css", "*.bundle.js", "*.chunk.js", "*.vendor.js"]) {
      expect(SEMGREP_EXCLUDE_FLAGS).toContain(`--exclude='${g}'`);
    }
  });
});

describe("ensureSemgrepIgnore (vendor/bundle false-positive önleme)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-semgrepignore-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("yoksa yazar; minified + bundles/ + gerçek paket dizinleri içerir", async () => {
    expect(await ensureSemgrepIgnore(root)).toBe("written");
    const body = await readFile(join(root, ".semgrepignore"), "utf-8");
    expect(body).toContain("*.min*.js");
    expect(body).toContain("**/bundles/**");
    expect(body).toContain("**/jspm_packages/**");
    // MAHKEME: riskli genel vendor desenleri (kendi kodu eleyebilir) DAHİL EDİLMEZ.
    expect(body).not.toContain("**/vendor/**");
    expect(body).not.toContain("**/vendors/**");
    // Görünür başlık (kullanıcı silebilsin — false-green güvenliği).
    expect(body).toMatch(/MyCL Studio tarafından üretildi/);
  });

  it("VAR olana DOKUNMAZ (kullanıcı .semgrepignore'u korunur — idempotent)", async () => {
    const custom = "# benim kuralım\nsrc/legacy/**\n";
    await writeFile(join(root, ".semgrepignore"), custom, "utf-8");
    expect(await ensureSemgrepIgnore(root)).toBe("present");
    expect(await readFile(join(root, ".semgrepignore"), "utf-8")).toBe(custom);
  });
});
