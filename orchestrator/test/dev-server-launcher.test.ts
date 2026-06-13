import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  augmentPortFlag,
  buildDevServerFailMessage,
  findFreePort,
  isPortFree,
  isProcessAlive,
  killProcessTree,
  stopActiveDevServer,
  tryDevServerChain,
  waitForDevServer,
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

// stopActiveDevServer: tek doğruluk kaynağı — kill + watcher detach + pid temizle.
// Regresyon: iterasyon-reset / Faz-2-abandon / Faz-5-respawn site'leri pid'i
// SADECE undefined yapıyordu → eski process orphan kalıyordu (port çakışması).
describe("dev-server-launcher · stopActiveDevServer", () => {
  // Gerçek detached child spawn et (process-group lideri) → kill -pid çalışsın.
  function spawnSleeper(): number {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    return child.pid!;
  }

  async function waitDead(pid: number, timeoutMs = 3000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!isProcessAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !isProcessAlive(pid);
  }

  it("canlı pid → process öldürülür + state.dev_server_pid temizlenir", async () => {
    const pid = spawnSleeper();
    // spawn anında canlı (kill(pid,0) OS pid'i görür görmez true).
    expect(isProcessAlive(pid)).toBe(true);
    const state: { dev_server_pid?: number } = { dev_server_pid: pid };
    stopActiveDevServer(state);
    expect(state.dev_server_pid).toBeUndefined();
    expect(await waitDead(pid)).toBe(true);
  });

  it("pid yok → no-op, throw etmez, pid undefined kalır", () => {
    const state: { dev_server_pid?: number } = {};
    expect(() => stopActiveDevServer(state)).not.toThrow();
    expect(state.dev_server_pid).toBeUndefined();
  });

  it("idempotent — iki kez çağrı throw etmez", async () => {
    const pid = spawnSleeper();
    const state: { dev_server_pid?: number } = { dev_server_pid: pid };
    stopActiveDevServer(state);
    expect(() => stopActiveDevServer(state)).not.toThrow();
    expect(state.dev_server_pid).toBeUndefined();
    expect(await waitDead(pid)).toBe(true);
  });
});

// ───────────────── Port false-match fix (2026-06-04) ─────────────────
describe("dev-server-launcher · augmentPortFlag (SAF flag matrisi)", () => {
  it("leaf vite → --port + --strictPort", () => {
    expect(augmentPortFlag("vite", 5180)).toBe("vite --port 5180 --strictPort");
    expect(augmentPortFlag("npx vite", 5180)).toBe("npx vite --port 5180 --strictPort");
    expect(augmentPortFlag("bunx vite", 5180)).toBe("bunx vite --port 5180 --strictPort");
  });
  it("next dev → --port (strictPort yok)", () => {
    expect(augmentPortFlag("next dev", 5180)).toBe("next dev --port 5180");
  });
  it("wrapper (npm run dev): viteHint=false → null, true → -- --port", () => {
    expect(augmentPortFlag("npm run dev", 5180, false)).toBeNull();
    expect(augmentPortFlag("npm run dev", 5180, true)).toBe(
      "npm run dev -- --port 5180 --strictPort",
    );
    expect(augmentPortFlag("pnpm dev", 5180, true)).toBe(
      "pnpm dev -- --port 5180 --strictPort",
    );
  });
  it("tanınmayan leaf (node server.js) → null (kör --port crash riski)", () => {
    expect(augmentPortFlag("node server.js", 5180)).toBeNull();
  });
  it("idempotent: explicit port zaten varsa dokunma", () => {
    expect(augmentPortFlag("vite --port 5173 --strictPort", 5180)).toBe(
      "vite --port 5173 --strictPort",
    );
    expect(augmentPortFlag("next dev -p 3000", 5180)).toBe("next dev -p 3000");
  });
  it("geçersiz port → null", () => {
    expect(augmentPortFlag("vite", 0)).toBeNull();
    expect(augmentPortFlag("vite", 99999)).toBeNull();
  });
});

describe("dev-server-launcher · isPortFree + findFreePort", () => {
  let srv: Server | null = null;
  afterEach(async () => {
    if (srv) await new Promise<void>((r) => srv!.close(() => r()));
    srv = null;
  });

  it("boş port → true; dolu port → false", async () => {
    const free = await findFreePort(49200);
    expect(free).not.toBeNull();
    expect(await isPortFree(free!)).toBe(true);
    srv = createServer((_q, s) => s.end("x"));
    await new Promise<void>((r) => srv!.listen(free!, "127.0.0.1", () => r()));
    expect(await isPortFree(free!)).toBe(false); // artık dolu
  });

  it("findFreePort: preferred doluysa farklı (boş) port döner", async () => {
    const p = (await findFreePort(49300))!;
    srv = createServer((_q, s) => s.end("x"));
    await new Promise<void>((r) => srv!.listen(p, "127.0.0.1", () => r()));
    const next = await findFreePort(p, 64, new Set());
    expect(next).not.toBeNull();
    expect(next).not.toBe(p); // dolu olanı atladı
  });
});

// Ümit 2026-06-13 (trace kökü): Vite default `localhost`'a bind eder; macOS'ta localhost→::1
// (IPv6) → eski IPv4-only probe ECONNREFUSED alıp "port_timeout" derdi (Faz 5 false-fail →
// tüm cascade). Çift-stack probe (127.0.0.1 + ::1) bind tercihinden bağımsız tespit eder.
describe("dev-server-launcher · waitForDevServer çift-stack (IPv6 localhost) probe", () => {
  let srv: Server | null = null;
  afterEach(async () => {
    if (srv) await new Promise<void>((r) => srv!.close(() => r()));
    srv = null;
  });

  it("`localhost`-bind sunucu (Vite default; macOS'ta ::1) tespit edilir — IPv4-only probe kaçırırdı", async () => {
    const port = (await findFreePort(49500))!;
    srv = createServer((_q, s) => s.end("ok"));
    // "localhost" → macOS ::1 / Linux 127.0.0.1; çift-stack probe hangisi olursa bulur.
    await new Promise<void>((r) => srv!.listen(port, "localhost", () => r()));
    expect(await waitForDevServer(port, 4000)).toBe(true);
  }, 8000);

  it("sunucu yok → false (gerçek timeout korunur, false-positive yok)", async () => {
    const free = (await findFreePort(49600))!;
    expect(await waitForDevServer(free, 1500)).toBe(false);
  }, 5000);
});

describe("dev-server-launcher · tryDevServerChain FALSE-MATCH fix", () => {
  let foreign: Server | null = null;
  let spawnedPid: number | null = null;
  afterEach(async () => {
    if (spawnedPid && spawnedPid > 0) killProcessTree(spawnedPid);
    spawnedPid = null;
    if (foreign) await new Promise<void>((r) => foreign!.close(() => r()));
    foreign = null;
  });

  it("expected port BAŞKA app'te → chain onu BİZİM sanmaz, boş porta zorlar (adminpanel senaryosu)", async () => {
    // 1. "Foreign" app (adminpanel gibi) expected portu tutsun.
    const squatPort = (await findFreePort(49400))!;
    foreign = createServer((_q, s) => s.end("FOREIGN_ADMINPANEL"));
    await new Promise<void>((r) => foreign!.listen(squatPort, "127.0.0.1", () => r()));

    // 2. PORT env'i okuyup dinleyen bir stub dev server (Express benzeri).
    const stub =
      "node -e \"require('http').createServer((q,s)=>s.end('TODO_APP')).listen(process.env.PORT,'127.0.0.1')\"";

    // 3. Chain: primary = squatPort (DOLU). Eski bug: squatPort'a yanıt (foreign) →
    //    'hazır' false-match. Fix: squatPort dolu → boş porta zorla + orayı probe.
    const res = await tryDevServerChain(
      "/tmp",
      [{ cmd: stub, ports: [squatPort] }],
      15_000,
    );
    spawnedPid = res.handle?.pid ?? null;

    expect(res.ok).toBe(true);
    expect(res.handle).toBeDefined();
    // KRİTİK: foreign portu BİZİM sanılmadı — başka (boş) porta gidildi.
    expect(res.handle!.port).not.toBe(squatPort);
    // Foreign sunucu DOKUNULMADI (hâlâ ayakta + kendi cevabı).
    const foreignAlive = await isPortFree(squatPort);
    expect(foreignAlive).toBe(false); // hâlâ dolu (foreign yaşıyor)
  }, 20_000);
});
