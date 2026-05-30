// smoke-test — Phase 6 AC fix sonrası mecburi doğrulama: build → restart →
// probe. Claude "düzeltme tamamlandı" diyor, ama gerçekten:
//   1. TypeScript/Vite build kırılmadı mı?
//   2. Dev server yeni kodla yeniden başladı mı?
//   3. Anasayfa 2xx döner mi (5xx middleware çöküntüsü yok mu)?
//
// Bunlardan biri fail ederse Phase 6 controller fix turn'ünü "fail" sayar ve
// Claude'a structured feedback ile yeni fix turn'ü tetikler — kullanıcıya AC
// sormadan.

import { exec, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { MyclConfig } from "./config.js";
import {
  buildDevServerFailMessage,
  killProcessTree,
  openBrowser,
  tryDevServerChain,
  waitForDevServer,
} from "./dev-server-launcher.js";
import {
  commandsFor,
  detectStack,
  expectedPortsFor,
  NODE_STACKS,
  readNodeScripts,
} from "./intent-router/handlers/command.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import {
  detachActiveWatcher,
  replaceActiveWatcher,
} from "./runtime-error-watcher.js";
import { safeEnv } from "./safe-env.js";
import type { State } from "./types.js";

export interface BuildResult {
  ok: boolean;
  skipped: boolean;
  stderr: string;
  durationMs: number;
}

export interface RestartResult {
  ok: boolean;
  port?: number;
  reason?: string;
}

/**
 * Phase 6 AC fix sonrası `npm run build` (veya stack-eşdeğer) çalıştırır.
 * Node/Vite dışı stack'ler için skipped=true döner (build adımı atlanır).
 * 60sn hard timeout; aşılırsa child SIGKILL.
 */
export async function runQuickBuild(
  projectRoot: string,
  timeoutMs: number = 60_000,
): Promise<BuildResult> {
  const t0 = Date.now();
  const stack = detectStack(projectRoot);
  if (!NODE_STACKS.has(stack)) {
    log.info("smoke-test", "build skipped (non-node stack)", { stack });
    return { ok: true, skipped: true, stderr: "", durationMs: Date.now() - t0 };
  }

  const scripts = readNodeScripts(projectRoot);
  // package.json'da "build" varsa onu kullan; yoksa fallback tsc --noEmit.
  // "build" script'i Vite/Next/Remix vb. için stack-aware build yapar.
  const cmd = scripts.build ? "npm run build" : "npx tsc --noEmit";

  // package.json yoksa build atla (uncommon ama defensive).
  try {
    await fs.access(join(projectRoot, "package.json"));
  } catch {
    log.info("smoke-test", "build skipped (no package.json)", { projectRoot });
    return { ok: true, skipped: true, stderr: "", durationMs: Date.now() - t0 };
  }

  return await new Promise<BuildResult>((resolve) => {
    let stderrBuf = "";
    let stdoutBuf = "";
    let timedOut = false;
    let resolved = false;
    const finish = (r: BuildResult): void => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };

    let child: ChildProcess | null = null;
    try {
      child = exec(
        cmd,
        {
          cwd: projectRoot,
          env: safeEnv(),
          timeout: timeoutMs,
          maxBuffer: 5 * 1024 * 1024, // 5MB
        },
        (err) => {
          const elapsed = Date.now() - t0;
          if (timedOut) {
            finish({
              ok: false,
              skipped: false,
              stderr:
                `Build ${Math.round(timeoutMs / 1000)}sn'de tamamlanamadı (timeout).\n` +
                `Son stdout:\n${stdoutBuf.slice(-800)}\n\nSon stderr:\n${stderrBuf.slice(-800)}`,
              durationMs: elapsed,
            });
            return;
          }
          if (err) {
            const stderr =
              stderrBuf.length > 0
                ? stderrBuf.slice(-1500)
                : stdoutBuf.slice(-1500) || String(err).slice(0, 800);
            finish({ ok: false, skipped: false, stderr, durationMs: elapsed });
            return;
          }
          finish({ ok: true, skipped: false, stderr: "", durationMs: elapsed });
        },
      );
    } catch (err) {
      finish({
        ok: false,
        skipped: false,
        stderr: `Build spawn failed: ${String(err)}`,
        durationMs: Date.now() - t0,
      });
      return;
    }
    if (!child) return;
    child.stdout?.on("data", (d) => {
      stdoutBuf += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderrBuf += String(d);
    });
    // Hard kill — exec'in `timeout` opsiyonu SIGTERM gönderiyor, bazı build
    // tool'ları (tsc) bunu ignore edebiliyor → SIGKILL ile takip et.
    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs + 2000);
    child.on("exit", () => clearTimeout(killTimer));
  });
}

/**
 * Phase 6 AC fix sonrası dev server'ı yeniden başlatır + 2xx-only HTTP probe
 * ile sayfanın açılabildiğini doğrular. Zincir: detach watcher → kill old →
 * tryDevServerChain → reattach watcher → openBrowser.
 *
 * Probe okOnly2xx=true: 5xx response → false döner; Phase 6 controller bunu
 * Claude'a feedback olarak iletir.
 */
export async function restartDevServerForPhase7(
  state: State,
  config: MyclConfig,
): Promise<RestartResult> {
  detachActiveWatcher();
  if (state.dev_server_pid) {
    killProcessTree(state.dev_server_pid);
    state.dev_server_pid = undefined;
  }
  const stack = detectStack(state.project_root);
  const scripts = readNodeScripts(state.project_root);
  const cmds = commandsFor(stack, "run", scripts);
  if (cmds.length === 0) {
    return {
      ok: false,
      reason: "Dev server için komut türetilemedi (stack belirsiz)",
    };
  }
  const candidates = cmds.map((cmd) => ({
    cmd,
    ports: expectedPortsFor(cmd, scripts, state.project_root),
  }));
  const result = await tryDevServerChain(state.project_root, candidates, 20_000);
  if (!result.ok || !result.handle) {
    const diag = await buildDevServerFailMessage(
      state.project_root,
      -1,
      candidates[0]?.ports[0] ?? 5173,
      20_000,
    );
    return { ok: false, reason: diag };
  }

  state.dev_server_pid = result.handle.pid;
  replaceActiveWatcher({
    pid: result.handle.pid,
    stdout: result.handle.stdout,
    stderr: result.handle.stderr,
    projectRoot: state.project_root,
    dbPath: `${state.project_root}/error_folder/errors.db`,
    config,
  });

  // 2xx-only probe — fix sonrası sayfa gerçekten açılıyor mu?
  const probeOk = await waitForDevServer(result.handle.port, 20_000, {
    okOnly2xx: true,
  });

  if (probeOk) {
    // Tarayıcı zaten açıksa HMR yeniler; ilk açılışta openBrowser.
    openBrowser(`http://localhost:${result.handle.port}`);
    return { ok: true, port: result.handle.port };
  }

  return {
    ok: false,
    port: result.handle.port,
    reason: `Dev server başlatıldı (pid=${result.handle.pid}, port=${result.handle.port}) ama anasayfa 2xx yanıt vermiyor. Muhtemelen runtime crash veya middleware hatası — errors.db'de yeni satır olabilir.`,
  };
}

/**
 * Phase 6 dışında basit dev server restart. 2xx-only probe yapmaz (mevcut
 * davranış: any HTTP response). Restart başarılı olursa state.dev_server_pid
 * güncellenir.
 */
export async function restartDevServerSimple(
  state: State,
  config: MyclConfig,
): Promise<RestartResult> {
  detachActiveWatcher();
  if (state.dev_server_pid) {
    killProcessTree(state.dev_server_pid);
    state.dev_server_pid = undefined;
  }
  const stack = detectStack(state.project_root);
  const scripts = readNodeScripts(state.project_root);
  const cmds = commandsFor(stack, "run", scripts);
  if (cmds.length === 0) {
    emitChatMessage(
      "system",
      "⚠ Dev server yeniden başlatılamadı — komut türetilemedi. Terminalde `npm run dev` çalıştır.",
    );
    return { ok: false, reason: "no command" };
  }
  const candidates = cmds.map((cmd) => ({
    cmd,
    ports: expectedPortsFor(cmd, scripts, state.project_root),
  }));
  emitChatMessage("system", "🔄 Dev server yeniden başlatılıyor…");
  const result = await tryDevServerChain(state.project_root, candidates, 20_000);
  if (result.ok && result.handle) {
    state.dev_server_pid = result.handle.pid;
    replaceActiveWatcher({
      pid: result.handle.pid,
      stdout: result.handle.stdout,
      stderr: result.handle.stderr,
      projectRoot: state.project_root,
      dbPath: `${state.project_root}/error_folder/errors.db`,
      config,
    });
    emitChatMessage(
      "system",
      `✅ Dev server hazır: http://localhost:${result.handle.port}. Tarayıcı açılıyor.`,
    );
    openBrowser(`http://localhost:${result.handle.port}`);
    return { ok: true, port: result.handle.port };
  }
  const diag = await buildDevServerFailMessage(
    state.project_root,
    -1,
    candidates[0]?.ports[0] ?? 5173,
    20_000,
  );
  emitChatMessage(
    "error",
    `${diag}\n\nNot: Fix'ler uygulandı. Sadece dev server otomatik başlamadı.`,
  );
  return { ok: false, reason: diag };
}
