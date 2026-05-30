import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDevServerFailMessage,
  isProcessAlive,
} from "../src/dev-server-launcher.js";

describe("dev-server-launcher · isProcessAlive", () => {
  it("PID 0 → false (geçersiz)", () => {
    expect(isProcessAlive(0)).toBe(false);
  });

  it("Current process PID → true", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("Çok yüksek geçersiz PID → false", () => {
    // 99999999 sistemde olma olasılığı çok düşük
    expect(isProcessAlive(99_999_999)).toBe(false);
  });
});

describe("dev-server-launcher · buildDevServerFailMessage", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-devmsg-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("package.json yok → '(yok)' + manuel başlat önerisi", async () => {
    const msg = await buildDevServerFailMessage(projectRoot, 99_999_999, 5173, 15_000);
    expect(msg).toContain("Faz 5: Dev server başlatılamadı");
    expect(msg).toContain("pid=99999999");
    expect(msg).toContain("port=5173");
    expect(msg).toContain("(yok)");
    expect(msg).toContain("npx vite");
    expect(msg).toContain("devam et");
  });

  it("scripts.dev backend node script → 'Vite başlatmıyor' uyarısı", async () => {
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({
        scripts: { dev: "NODE_ENV=development node dist/backend/src/index.js" },
      }),
    );
    const msg = await buildDevServerFailMessage(projectRoot, 99_999_999, 5173, 15_000);
    expect(msg).toContain('"npm run dev" Vite/Next/Webpack-dev-server başlatmıyor');
    expect(msg).toContain('"dev:frontend": "vite"');
    expect(msg).toContain(`cd ${projectRoot}`);
  });

  it("scripts.dev vite içeriyor + process öldü → 'crash' tanısı", async () => {
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    const msg = await buildDevServerFailMessage(projectRoot, 99_999_999, 5173, 15_000);
    expect(msg).toContain("Process durumu: ✗ ÖLDÜ");
    expect(msg).toContain("node_modules");
    expect(msg).toContain("Backend bağımlılığı");
  });

  it("scripts.dev vite içeriyor + process canlı → 'port mismatch' tanısı", async () => {
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ scripts: { dev: "vite dev" } }),
    );
    // Current process PID = canlı
    const msg = await buildDevServerFailMessage(projectRoot, process.pid, 5173, 15_000);
    expect(msg).toContain("Process durumu: ✓ canlı");
    expect(msg).toContain("Port 5173 dolu");
    expect(msg).toContain("vite.config");
    expect(msg).toContain("port mismatch");
  });

  it("scripts.dev 'next dev' (Next.js) → hasVite true (Next de Vite-class)", async () => {
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev -p 3000" } }),
    );
    const msg = await buildDevServerFailMessage(projectRoot, process.pid, 3000, 15_000);
    // Next pattern hasVite regex'te yakalanır; "Vite başlatmıyor" uyarısı OLMAMALI
    expect(msg).not.toContain("Vite/Next/Webpack-dev-server başlatmıyor");
    expect(msg).toContain("Process durumu: ✓ canlı");
  });

  it("bozuk package.json → '(yok)' fallback, mesaj yine üretilir", async () => {
    await writeFile(
      join(projectRoot, "package.json"),
      "{ not valid json",
    );
    const msg = await buildDevServerFailMessage(projectRoot, 0, 5173, 15_000);
    expect(msg).toContain("(yok)");
    expect(msg).toContain("Faz 5: Dev server başlatılamadı");
  });

  it("resume talimatı her zaman var", async () => {
    const msg = await buildDevServerFailMessage(projectRoot, 0, 5173, 15_000);
    expect(msg).toContain('"devam et"');
    expect(msg).toContain("Faz 5 yeniden başlar");
  });
});
