// csp-check — Faz 13 CSP değerlendirici exit-kodu sözleşmesi (güvenlik-baseline Unit 1).
// Script'i gerçek alt-process olarak çağırır (csp_evaluator'ı orchestrator/
// node_modules'tan import eder — CI'da npm ci kurar). Severity eşiği (<=40 blocking,
// "MEDIUM da bloklasın") + web-tespiti + fail-closed mantığını sözleşme düzeyinde kanıtlar.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "csp-check.mjs");

function runCsp(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [SCRIPT, ...args], { encoding: "utf-8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("csp-check · --policy (severity eşiği)", () => {
  it("zayıf policy (default-src *) → blocking, exit 1", () => {
    const r = runCsp(["--policy", "default-src *"]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/blocking/i);
  });

  it("güçlü policy (nonce>=8 + strict-dynamic) → yeşil, exit 0", () => {
    const r = runCsp([
      "--policy",
      "default-src 'self'; object-src 'none'; base-uri 'self'; script-src 'nonce-abcdefgh' 'strict-dynamic'",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/yeşil/i);
  });

  it("'self' tabanlı policy (MEDIUM_MAYBE=50 > 40) → bloklamaz, exit 0", () => {
    // STRICT_CSP(45)/MEDIUM_MAYBE(50) önerileri fail değil — inverted-threshold
    // tuzağına düşmediğimizin kanıtı (güçlü/makul policy yanlış fail etmez).
    const r = runCsp(["--policy", "default-src 'self'; object-src 'none'; base-uri 'self'"]);
    expect(r.code).toBe(0);
  });
});

describe("csp-check · --auto (web tespiti)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "csp-check-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("web-UI olmayan proje (express backend, index.html yok) → not-applicable, exit 0", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { express: "^4" } }));
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/uygulanamaz|atlandı/i);
  });

  it("web-UI + index.html meta KÖTÜ CSP → blocking, exit 1", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { vite: "^5" } }));
    await writeFile(
      join(dir, "index.html"),
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>',
    );
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(1);
  });

  it("web-UI ama statik CSP yok → görünür atlama (false-fail YOK), exit 0", async () => {
    // index.html'i CSP'siz + meta'sız bırak (önceki testteki meta'yı sil).
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { vite: "^5" } }));
    await writeFile(join(dir, "index.html"), "<html><head></head><body></body></html>");
    const r = runCsp(["--project", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/atlama|değerlendirilemedi/i);
  });
});
