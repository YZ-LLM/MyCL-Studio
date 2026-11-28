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
  extractErrorLines,
  openBrowser,
  stopActiveDevServer,
} from "./dev-server-launcher.js";
import {
  installFailureReason,
  launchWithProvision,
  projectDepsMissing,
  salientInstallError,
} from "./service-provision.js";
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
  /** Başarısızsa sürecin bildirdiği ilk hata satırı (yakalanan çıktıdan; yoksa undefined). */
  firstError?: string;
  /**
   * Başarısızsa düzeltme yoluna giden asıl neden (2026-11-28, koşu 34/35): kurulum komutu + çıktının son satırları,
   * ya da başlatma çıktısı. Faz 6 bunu Faz 5'in düşüşü olarak `failPhase(5)`'e verir.
   */
  failReason?: string;
}

/** SAF: başlatma düşüşünün düzeltme yoluna giden metni (çıktının başı + sonu). */
export function startFailureReason(output: string): string {
  const shown = output.length > 1500 ? `${output.slice(0, 700)}\n…\n${output.slice(-800)}` : output;
  return (
    "dev server could not be started for the UI review (the app did not open)" +
    (shown.trim() ? `\n\nSpawn output (the actual error — diagnose THIS, not generic causes):\n${shown}` : "")
  );
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
  /** `openBrowser: false` → sunucu ayağa kalkar ama tarayıcı açılmaz (E2E gibi insan-dışı tüketiciler).
   *  `phaseLabel` → başlatma hatası iletisindeki faz adı (varsayılan "Faz 6"; 2026-11-28: Faz 12/16/17 de çağırıyor). */
  opts: { openBrowser?: boolean; phaseLabel?: string } = {},
): Promise<{ ok: boolean; alreadyAlive: boolean; port?: number; firstError?: string; failReason?: string }> {
  const alive =
    state.dev_server_pid !== undefined && isProcessAliveSync(state.dev_server_pid);
  if (alive) return { ok: true, alreadyAlive: true, port: await deriveDevPort(state) };
  const restart = await restartDevServerSimple(state, config, opts);
  return {
    ok: restart.ok,
    alreadyAlive: false,
    port: restart.port,
    firstError: restart.firstError,
    failReason: restart.failReason,
  };
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
  opts: { openBrowser?: boolean; phaseLabel?: string } = {},
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
    return {
      ok: false,
      reason: "no command",
      failReason: `dev server command not derivable (stack=${stack}) — check the project's run scripts`,
    };
  }
  const candidates = cmds.map((cmd) => ({
    cmd,
    ports: expectedPortsFor(cmd, scripts, state.project_root),
  }));
  emitChatMessage("system", "🔄 Dev server yeniden başlatılıyor…");
  // KURULUM GARANTİSİ (2026-09-16, canlı kanıt: cüzdan projesi). Eskiden burada doğrudan
  // `tryDevServerChain` çağrılıyordu; bağımlılıkları kuran proaktif kontrol yalnız
  // `launchWithProvision` içinde olduğu için bu yol onu hiç görmüyordu. Bağımlılık kurulumunu
  // garanti eden TEK yer Faz 5'ti ve Faz 5 dört kez `degraded` ile düşünce (kurulum bloğundan önce
  // `return "fail"`) kurulum hiç koşmadı; beşinci turda Faz 5 kapsam dışı kalınca ihtimal bitti.
  // Sonuç: `node_modules` hiç oluşmadı, ZORUNLU olan Faz 6 incelemesi uygulamayı hiç açamadı ve
  // kullanıcı günlerce çalışan bir uygulama göremedi. Artık dev server'ı başlatan bu yol da
  // kurulumu kendi garanti ediyor — "Faz 5 koşmadı → kurulum yok" boşluğu yapısal olarak kapandı.
  // `depsOnly`: yalnız bağımlılık; servis (docker-compose) tamamlama BU yolda yapılmaz.
  const { result, installFailed } = await launchWithProvision(state.project_root, candidates, 20_000, {
    stackId: stack,
    depsOnly: true,
  });
  if (installFailed) {
    // 2026-11-28 (koşu 33): kurulum düştü → uygulama başlatılmadı (yardımcı çıktıyı sohbete yazdı). Tanı, başlatma
    // hatası değil kurulum düşüşüdür; "command not found" satırları asıl neden değildi.
    emitChatMessage(
      "error",
      `❌ Dev server başlatılmadı: bağımlılık kurulumu (\`${installFailed.cmd}\`) başarısız. Asıl neden kurulum çıktısında (yukarıda).`,
    );
    return {
      ok: false,
      reason: `dependency install failed: ${installFailed.cmd}`,
      // 2026-11-28 (koşu 34/35): son satır npm'de günlük dosyasının yoluydu, neden değil → anlamlı satır.
      firstError: `${installFailed.cmd}: ${salientInstallError(installFailed.outputTail)}`,
      failReason: installFailureReason(installFailed),
    };
  }
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
    if (opts.openBrowser === false) {
      emitChatMessage("system", `✅ Dev server hazır: http://localhost:${result.handle.port}.`);
    } else {
      emitChatMessage(
        "system",
        `✅ Dev server hazır: http://localhost:${result.handle.port}. Tarayıcı açılıyor.`,
      );
      // Faz 6 incelemesi DARK modda açılır (YZLLM: responsive+dark/light zorunlu). App `?theme=dark`'ı
      // okur (phase-05-ui mandate); desteklemeyen app param'ı yoksayar → zararsız.
      openBrowser(`http://localhost:${result.handle.port}?theme=dark`);
    }
    return { ok: true, port: result.handle.port };
  }
  // Tanı, ÇAĞIRAN fazın adıyla ve gerçek bağımlılık durumuyla üretilir: Faz 6 incelemesinden gelen
  // hata "Faz 5" dememeli, ve bağımlılıklar hiç kurulmamışsa sebep script yapısı diye gösterilmemeli.
  const output = result.attempts
    .map((a) => a.output)
    .filter((o): o is string => !!o)
    .join("\n---\n");
  const diag = await buildDevServerFailMessage(
    state.project_root,
    -1,
    candidates[0]?.ports[0] ?? 5173,
    20_000,
    false,
    { phaseLabel: opts.phaseLabel ?? "Faz 6", depsMissing: await projectDepsMissing(state.project_root, stack), output },
  );
  emitChatMessage(
    "error",
    `${diag}\n\nNot: Fix'ler uygulandı. Sadece dev server otomatik başlamadı.`,
  );
  return {
    ok: false,
    reason: diag,
    firstError: output ? extractErrorLines(output, 1)[0] : undefined,
    failReason: startFailureReason(output),
  };
}
