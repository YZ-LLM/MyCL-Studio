// headers-check — güvenlik-header static kontrolü exit-kodu sözleşmesi (csp-check deseni).
// 0 = geçti/uygulanamaz, 1 = backend var ama header yok (bulgu), 2 = araç hatası.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "headers-check.mjs");

function run(dir: string): number {
  return spawnSync("node", [SCRIPT, "--project", dir], { encoding: "utf-8" }).status ?? -1;
}

describe("headers-check · exit-kodu sözleşmesi", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hdr-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function pkg(deps: Record<string, string>): Promise<void> {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: deps }));
  }

  it("HTTP backend yok (statik SPA) → uygulanamaz, exit 0", async () => {
    await pkg({ vite: "^5", react: "^18" });
    expect(run(dir)).toBe(0);
  });

  it("express + helmet → geçti, exit 0", async () => {
    await pkg({ express: "^4", helmet: "^7" });
    expect(run(dir)).toBe(0);
  });

  it("fastify + @fastify/helmet → geçti, exit 0", async () => {
    await pkg({ fastify: "^4", "@fastify/helmet": "^11" });
    expect(run(dir)).toBe(0);
  });

  it("express, helmet YOK, manuel header YOK → bulgu, exit 1", async () => {
    await pkg({ express: "^4" });
    expect(run(dir)).toBe(1);
  });

  it("express, helmet YOK ama kaynakta manuel güvenlik-header → geçti, exit 0", async () => {
    await pkg({ express: "^4" });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "server.ts"), 'res.setHeader("Strict-Transport-Security", "max-age=31536000");');
    expect(run(dir)).toBe(0);
  });

  // KAÇIŞ YOLU AVI (2026-11-26): kapı "adı geçiyor" durumunu geçti sayıyordu.
  it("helmet yalnız devDependencies'te → koruma sayılmaz, exit 1", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { express: "^4" }, devDependencies: { helmet: "^7" } }),
    );
    expect(run(dir)).toBe(1);
  });

  it("başlık adı yalnız TEST dosyasında ya da YORUMDA geçiyor → kanıt değil, exit 1", async () => {
    await pkg({ express: "^4" });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "server.test.js"), "// strict-transport-security\nexpect(1).toBe(1);");
    await writeFile(join(dir, "src", "app.js"), "// TODO: x-frame-options ekle\n/* referrer-policy\n   permissions-policy */\nexport const a = 1;");
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "tests", "h.js"), 'res.setHeader("X-Frame-Options", "DENY");');
    expect(run(dir)).toBe(1);
  });

  it("gerçek kullanım yorumla AYNI dosyada olsa da geçer (yanlış engel yok)", async () => {
    await pkg({ express: "^4" });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "server.js"),
      '// güvenlik başlıkları\nconst docs = "https://example.com/a"; res.setHeader("X-Content-Type-Options", "nosniff");',
    );
    expect(run(dir)).toBe(0);
  });

  it("package.json yok → uygulanamaz, exit 0", async () => {
    expect(run(dir)).toBe(0);
  });
});
