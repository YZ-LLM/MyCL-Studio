// smoke-test — Faz 6 UI incelemesi için dev server garantisi: canlı mı bak →
// değilse yeniden başlat → tarayıcıyı aç.
//   1. Dev server ayakta mı (pid canlı mı)?
//   2. Değilse Vite runtime-error injection'ı tazele + stack'e göre başlat.
//   3. Başladıysa watcher'ı bağla + tarayıcıyı aç; başlamadıysa GÖRÜNÜR teşhis.
//
// Kullanıcı UI'yi ancak uygulama ayaktayken inceleyebilir → Phase6Controller ve
// handleUserMessage Faz 6 reask yolu ikisi de buradan geçer (tek doğruluk kaynağı).

import type { MyclConfig } from "./config.js";
import {
  buildDevServerFailMessage,
  openBrowser,
  stopActiveDevServer,
  tryDevServerChain,
} from "./dev-server-launcher.js";
import {
  detectStack,
  expectedPortsFor,
  readNodeScripts,
} from "./intent-router/handlers/command.js";
import { devServerCandidates } from "./dev-server-command.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { replaceActiveWatcher } from "./runtime-error-watcher.js";
import { ensureViteRuntimeInjection, viteSourceEditAllowed } from "./vite-runtime-injector.js";
import { isProcessAliveSync } from "./process-utils.js";
import type { State } from "./types.js";

export interface RestartResult {
  ok: boolean;
  port?: number;
  reason?: string;
}

/**
 * Faz 6 UI incelemesi (controller VEYA orkestratör reask yolu) "UI'yi onayla" derken uygulama tarayıcıda
 * AÇIK olmalı. dev-server canlı mı bak; değilse restartDevServerSimple ile başlat + tarayıcıyı aç. TEK
 * doğruluk kaynağı → Phase6Controller + handleUserMessage Faz 6 reask ikisi de bunu çağırır (DRY).
 * YZLLM 2026-06-17: reask yolu bu kontrolü ATLADIĞI için boot-resume Faz 6'da (Faz 5 koşmamış → dev-server yok)
 * "UI'yi onayla" deniyordu ama UI gösterilmiyordu — kullanıcı neyi onaylayacağını göremiyordu.
 */
export async function ensureDevServerForReview(
  state: State,
  config: MyclConfig,
): Promise<{ ok: boolean; alreadyAlive: boolean; port?: number }> {
  const alive =
    state.dev_server_pid !== undefined && isProcessAliveSync(state.dev_server_pid);
  if (alive) return { ok: true, alreadyAlive: true, port: await deriveDevPort(state) };
  const restart = await restartDevServerSimple(state, config);
  return { ok: restart.ok, alreadyAlive: false, port: restart.port };
}

/**
 * Çalışan dev-server'ın portunu en-iyi-çaba türet (zaten ayakta → handle yok).
 * Stack komutu + script'lerden beklenen portu; bulunamazsa 5173 (yaygın Vite). Erişilebilirlik
 * taraması için URL kurmaya yeter; yanlışsa tarama görünür şekilde "taranamadı" der (blocking değil).
 */
async function deriveDevPort(state: State): Promise<number | undefined> {
  try {
    const stack = detectStack(state.project_root);
    const scripts = readNodeScripts(state.project_root);
    const cmd = (await devServerCandidates(stack, scripts))[0];
    if (!cmd) return undefined;
    return expectedPortsFor(cmd, scripts, state.project_root)[0];
  } catch {
    return undefined;
  }
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
  stopActiveDevServer(state);
  // YZLLM 2026-06-15: dev-server'dan ÖNCE Vite runtime-error injection'ını GARANTİLE (idempotent).
  // Önceden bu yalnız Faz 5'te (UI üretimi) yapılıyordu; Faz 6 artık ZORUNLU (Faz 5 atlansa bile koşar)
  // → Faz 5 atlanan işlerde `.mycl/runtime-error-plugin.cjs` yoktu ama vite.config.js onu import ediyordu
  // → "Could not resolve ./.mycl/runtime-error-plugin.cjs" ile vite başlangıçta crash ediyordu. Burada
  // her dev-server başlatmadan önce ensure → fresh-clone / .mycl temizliği / Faz-5-atlama hepsinde kendini onarır.
  try {
    await ensureViteRuntimeInjection(state.project_root, {
      allowSourceEdit: viteSourceEditAllowed(state),
      gitignoreOnlyIfExists: state.origin === "foreign",
    });
  } catch (err) {
    log.warn("smoke-test", "ensureViteRuntimeInjection failed (non-fatal, dev-server yine denenecek)", err);
  }
  const stack = detectStack(state.project_root);
  const scripts = readNodeScripts(state.project_root);
  const cmds = await devServerCandidates(stack, scripts);
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
      dbPath: `${state.project_root}/error_folder/mycl_errors.db`,
      config,
    });
    emitChatMessage(
      "system",
      `✅ Dev server hazır: http://localhost:${result.handle.port}. Tarayıcı açılıyor.`,
    );
    // Faz 6 incelemesi DARK modda açılır (YZLLM: responsive+dark/light zorunlu). App `?theme=dark`'ı
    // okur (phase-05-ui mandate); desteklemeyen app param'ı yoksayar → zararsız.
    openBrowser(`http://localhost:${result.handle.port}?theme=dark`);
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
