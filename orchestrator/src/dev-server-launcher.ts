// dev-server-launcher — Faz 5 sonrası veya intent-router command handler için
// dev server'ı arka planda başlat ve tarayıcıyı aç. handleBash kullanılmaz:
//   - Bash handler 60s timeout ile bekler; dev server uzun ömürlü.
//   - Bash stdio pipe'lı, child orchestrator'a bağlı kalır.
// Burada detached + unref kullanılır → child orchestrator'dan bağımsız yaşar,
// orchestrator çıkışında otomatik öldürülmez (kullanıcının elinde).
//
// Stack-agnostic: cmd parametresi ile herhangi bir dev server komutu spawn
// edilebilir (`npm run dev`, `uvicorn main:app`, `bundle exec rails server`,
// `mix phx.server`, `php artisan serve`, ...). Spawn `shell: true` ile yapılır
// → cross-platform (Unix sh, Windows cmd.exe) shell parsing.
//
// Mimari yasak: subprocess spawn kullanıcının kendi projesindeki bir komuta
// yapılır; Claude CLI'a değil. Bu mimari yasak ihlali değildir (spec.md §v14).

import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import type { Readable } from "node:stream";
import { promises as fs } from "node:fs";
import { get as httpGet } from "node:http";
import { platform } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";
import { isProcessAliveSync } from "./process-utils.js";
import { safeEnv } from "./safe-env.js";
import { detachActiveWatcher } from "./runtime-error-watcher.js";

export interface DevServerHandle {
  pid: number;
  port: number;
  /** Child stdout — runtime-error-watcher tüketir. null = stdio ignore eski mod. */
  stdout: Readable | null;
  /** Child stderr — backend Express 4xx/5xx logları, Vite proxy hataları burada. */
  stderr: Readable | null;
  /** Event-driven exit bayrağı (child.on("exit")). shell:true olduğu için pid-poll
   *  güvenilmez (handle.pid = SHELL wrapper'ı; alttaki vite strictPort-exit etse de
   *  wrapper canlı kalabilir). waitForDevServer bunu kontrol edip erken çıkar. */
  exited: boolean;
  /**
   * 2026-06-10 (Ümit: "bu kadar kolay bişeyi çözemedi" — kör teşhis kökü): spawn'ın
   * GERÇEK çıktısı (stderr+stdout son ~4KB + spawn 'error' olayı = E2BIG/ENOENT).
   * Eskiden hiç okunmuyordu → çöküş "timeout" diye raporlanıp ajan yanlış yeri tamir
   * ediyordu. Drain ayrıca OS-buffer-dolu hang'ini de önler.
   */
  recentOutput: () => string;
}

/**
 * Arka planda dev server komutu başlatır. Process detached; orchestrator çıksa
 * bile yaşar. stdout/stderr `pipe` — runtime-error-watcher backend log'larını
 * okur, errors.db'ye yazar. Stream'leri kimse tüketmezse OS buffer'ı dolup
 * child hang olabilir; spawn site'lerinde watcher attach edilmesi ŞART.
 *
 * Default `cmd = "npm run dev"` ve `port = 5173` — Phase 5 (Node/Vite) için
 * backward compat. Diğer stack'ler için command handler `cmd` ve `port`'u
 * stack'e göre geçer.
 *
 * NOT: bu fonksiyon dev server'ın gerçekten dinlemeye başladığını DOĞRULAMAZ.
 * Caller `waitForDevServer` + `openBrowser`'ı çağırmalı.
 */
export function spawnDevServer(
  projectRoot: string,
  cmd: string = "npm run dev",
  port: number = 5173,
): DevServerHandle {
  const child = spawn(cmd, {
    cwd: projectRoot,
    detached: true,
    // ["ignore", "pipe", "pipe"] — stdin yok, stdout/stderr pipe.
    // Watcher consume etmezse OS buffer dolar, child hang olur.
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    // Güvenlik: hassas env'leri filtrele — kullanıcı projesinin script'i sadece
    // güvenli env + PORT görür. PORT env çoğu framework'ün (Next.js, Rails,
    // Flask) override sinyali; Vite görmezden gelir (kendi config'i kullanır).
    env: { ...safeEnv(), PORT: String(port) },
  });
  child.unref();
  log.info("dev-server-launcher", "spawned", {
    pid: child.pid,
    cwd: projectRoot,
    cmd,
    port,
  });
  // GERÇEK çıktı yakalama (kör-teşhis fix): stderr+stdout son ~4KB ring buffer'a +
  // spawn 'error' (E2BIG "argument list too long" / ENOENT "command not found").
  // Drain ayrıca pipe-buffer-dolu hang'ini önler (stdio:pipe tüketilmezse child asılır).
  let outputBuf = "";
  const MAX_OUTPUT = 4000;
  const capture = (chunk: Buffer | string) => {
    outputBuf = (outputBuf + (typeof chunk === "string" ? chunk : chunk.toString("utf8"))).slice(-MAX_OUTPUT);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const handle: DevServerHandle = {
    pid: child.pid ?? -1,
    port,
    stdout: child.stdout ?? null,
    stderr: child.stderr ?? null,
    exited: false,
    recentOutput: () => outputBuf.trim(),
  };
  // Event-driven exit — strictPort-exit / crash'i KESİN yakala (pid-poll değil;
  // shell:true wrapper pid'i yanıltıcı). waitForDevServer her turda kontrol eder.
  child.on("exit", () => {
    handle.exited = true;
  });
  // KRİTİK: spawn HATASI ('error' olayı) — E2BIG/ENOENT burada gelir, stderr'de DEĞİL.
  // Handler yoksa hata yutulur (süreç sadece "öldü" görünür → kör teşhis). Yakala + işaretle.
  child.on("error", (err) => {
    capture(`\n[spawn error] ${String((err as { message?: string }).message ?? err)}`);
    handle.exited = true;
  });
  return handle;
}

/**
 * Belirtilen porta HTTP GET ile probe atar; 200/3xx/4xx (her tür HTTP yanıt)
 * dönerse server "hazır" sayılır. Connect refused → henüz başlamamış, bekle.
 *
 * 500 ms polling, max bekleme süresi `maxMs` (default 15 sn). Hazır olunca
 * true, timeout'ta false döner. Hata fırlatmaz — caller true/false ile karar
 * verir (kullanıcıya uygun uyarı göstermek için).
 */
export async function waitForDevServer(
  port: number,
  maxMs = 15_000,
  opts: { okOnly2xx?: boolean; handle?: { exited: boolean } } = {},
): Promise<boolean> {
  const okOnly2xx = opts.okOnly2xx ?? false;
  const startTs = Date.now();
  const interval = 500;
  while (Date.now() - startTs < maxMs) {
    // Spawn edilen süreç öldüyse (strictPort-exit / crash) beklemeyi bırak —
    // başka bir app porta yanıt verse bile O BİZİM DEĞİL (false-match önle).
    if (opts.handle?.exited) {
      log.warn("dev-server-launcher", "spawned process exited before ready", { port });
      return false;
    }
    const ready = await new Promise<boolean>((resolve) => {
      const req = httpGet(
        // 127.0.0.1 (localhost DEĞİL): Node 18+ ::1'i önce deneyip vite'ın
        // 127.0.0.1 listener'ını kaçırabilir → false-negative. IPv4'e sabitle.
        { host: "127.0.0.1", port, path: "/", timeout: 1000 },
        (res) => {
          // Default: her HTTP yanıtı "server dinliyor" sayılır. Phase 6 smoke
          // test okOnly2xx=true geçer → SADECE 2xx/3xx response başarı; 4xx/5xx
          // → çöküntü/middleware crash; probe fail döner, Claude'a feedback.
          res.resume();
          const status = res.statusCode ?? 0;
          const ok = okOnly2xx ? status >= 200 && status < 400 : true;
          resolve(ok);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ready) {
      log.info("dev-server-launcher", "ready detected", {
        port,
        elapsed_ms: Date.now() - startTs,
      });
      return true;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  log.warn("dev-server-launcher", "ready timeout", { port, maxMs });
  return false;
}

/**
 * Cross-platform tarayıcı açıcı. macOS=`open`, Linux=`xdg-open`, Windows=`start`.
 * Stdio ignore + unref — orchestrator'a bağlı kalmaz.
 */
export function openBrowser(url: string): void {
  const plat = platform();
  let cmd: string;
  let args: string[];
  if (plat === "darwin") {
    cmd = "open";
    args = [url];
  } else if (plat === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    log.info("dev-server-launcher", "browser opened", { url, cmd });
  } catch (err) {
    log.error("dev-server-launcher", "browser open failed", err);
  }
}

/**
 * Process'in canlı olup olmadığını OS-bağımsız kontrol et. `kill(pid, 0)`
 * UNIX semantiği: sinyal göndermez, sadece "process var ve sahibim" check.
 * Crashed → ESRCH (process bulunamadı); kill exception throw eder → false.
 *
 * NOT: POSIX'te `kill(0, sig)` mevcut process group'a sinyal gönderir (özel
 * semantik) — bizim için anlamsız. pid <= 0 defensive false dönerek "geçersiz
 * pid" durumunu netçe işaretler.
 *
 * v15.8 (2026-05-28): Sync API tutar (call site'lar boot path'inde sync
 * bekliyor); Windows'ta `isProcessAliveSync` ile delegate. Windows için
 * async tercih edilir → yeni call site'lar `process-utils.isProcessAlive`
 * (async) çağırmalı.
 */
export function isProcessAlive(pid: number): boolean {
  // v15.8 (2026-05-30): process-utils tek otorite — duplicate raw process.kill
  // kaldırıldı. Bu wrapper backward-compat (dahili call site'lar 287/333).
  // Yeni call site'lar async `process-utils.isProcessAlive` kullanmalı
  // (Windows'ta tasklist ile doğru sonuç verir; bu sync versiyon Windows'ta
  // pessimistic false döner).
  return isProcessAliveSync(pid);
}

/**
 * Detached process'i ve alt sürecini öldür. POSIX: process group kill
 * (`process.kill(-pid, SIGTERM)`) detached spawn'in alt sürecini de yakalar.
 * Windows: `taskkill /F /T /PID` tree kill. Hata yutulur (best-effort).
 */
export function killProcessTree(pid: number): void {
  if (pid <= 0) return;
  if (platform() === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      }).unref();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    // Negative pid → process group; detached spawn process group leader yapar.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

/**
 * Aktif dev server'ı TEMİZ kapat: runtime-error watcher'ı detach et + process
 * ağacını öldür + `state.dev_server_pid`'i sıfırla. Tek doğruluk kaynağı —
 * yeniden-spawn / iterasyon-reset / niyet-vazgeçme / Faz 2 abandon öncesi
 * çağrılır. Aksi halde eski process orphan kalır (port çakışması + zombi pid).
 *
 * Idempotent: pid yoksa yalnız watcher detach (no-op kill). `state` referans ile
 * mutasyona uğrar (pid=undefined) — controller/engine aynı state nesnesini
 * paylaştığından fail/complete yollarının ikisinde de tutarlı kalır.
 */
export function stopActiveDevServer(state: { dev_server_pid?: number }): void {
  detachActiveWatcher();
  if (state.dev_server_pid !== undefined) {
    killProcessTree(state.dev_server_pid);
    state.dev_server_pid = undefined;
  }
}

export interface DevServerAttempt {
  cmd: string;
  port: number;
  reason:
    | "process_died"
    | "port_timeout"
    | "port_occupied_unforceable" // hedef port başka app'te + bu komutta port zorlanamıyor → false-match yerine dürüst fail
    | "no_free_port"; // hiç boş port bulunamadı
  /** Spawn'ın GERÇEK çıktısı (stderr/stdout son ~4KB + spawn-error). Kör-teşhis fix — analiz buna bakar. */
  output?: string;
}

// ───────────────── SAF: port sahiplik / boş-port / komut-augment ─────────────────
// Port false-match fix (2026-06-04): MyCL spawn ettiği sunucunun SAHİBİ olduğunu
// kanıtlamalı. Kanıt = port spawn ÖNCESİ BOŞTU (connect-refused) + spawn SONRASI
// DOLDU + child exit ETMEDİ. Başka app expected-portu tutuyorsa todo app BOŞ porta
// zorlanır (--port flag); zorlanamazsa dürüst fail (false-match ASLA).

/** Port BOŞ mu? 127.0.0.1'e connect dener — ECONNREFUSED → boş(true); bağlanırsa
 *  başka süreç dinliyor → dolu(false). Bind-test DEĞİL (listen-release TOCTOU yok). */
export function isPortFree(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port });
    let done = false;
    const finish = (free: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(free);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(false)); // bağlandı → dolu
    sock.once("timeout", () => finish(true)); // yanıt yok → muhtemelen boş
    sock.once("error", () => finish(true)); // ECONNREFUSED → boş
  });
}

/** preferred'dan başlayıp yukarı ilk BOŞ portu bul (connect-probe). skip set'i
 *  bilinen-dolu portları atlar. Bulamazsa null (→ caller dürüst fail). */
export async function findFreePort(
  preferred: number,
  maxTries = 64,
  skip: ReadonlySet<number> = new Set(),
): Promise<number | null> {
  for (let i = 0; i < maxTries; i++) {
    const port = preferred + i;
    if (port < 1 || port > 65535) break;
    if (skip.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  return null;
}

/**
 * SAF: dev komutunu belirli bir porta ZORLA (CLI bayrağı; PORT env DEĞİL — vite
 * onu yok sayar). null = bu komutta port zorlanamaz (fail-closed sinyali). Komutta
 * zaten explicit port varsa idempotent: olduğu gibi döner. viteHint: proje vite mı
 * (vite.config var) — npm/pnpm/yarn wrapper'ına `-- --port` ile zorlamayı açar.
 */
export function augmentPortFlag(
  cmd: string,
  port: number,
  viteHint = false,
): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const c = cmd.trim();
  // Idempotent: explicit port (kullanıcı/komut belirlemiş) → dokunma.
  if (/--port[=\s]+\d{2,5}|(^|\s)-p[=\s]+\d{2,5}|-S\s+\S*?:\d{2,5}/.test(c)) return c;
  // Leaf frontend dev sunucuları
  if (/(^|\s)(npx |bunx |pnpm exec )?vite(\s|$)/.test(c))
    return `${c} --port ${port} --strictPort`;
  if (/(^|\s)next\s+dev(\s|$)/.test(c)) return `${c} --port ${port}`;
  if (/webpack(-dev-server| serve)|vue-cli-service\s+serve/.test(c))
    return `${c} --port ${port}`;
  // Python / Ruby leaf
  if (/(^|\s)(uvicorn|hypercorn)(\s|$)/.test(c)) return `${c} --port ${port}`;
  if (/(^|\s)flask\s+run(\s|$)/.test(c)) return `${c} --port ${port}`;
  if (/(^|\s)(rails\s+(server|s)|puma)(\s|$)/.test(c)) return `${c} -p ${port}`;
  // Package-manager wrapper (npm run dev / pnpm dev / yarn dev / bun run dev) —
  // alttaki leaf bilinmez; YALNIZ vite-projesinde `-- --port` ile zorla.
  if (/(^|\s)(npm run|pnpm|yarn|bun run)\s+\S+/.test(c))
    return viteHint ? `${c} -- --port ${port} --strictPort` : null;
  return null; // tanınmayan → zorlanamaz
}

export interface DevServerChainResult {
  ok: boolean;
  handle?: DevServerHandle;
  cmd?: string;
  /** Başarısız tüm denemeler (success'te ekteki sondan önceki olanlar). */
  attempts: DevServerAttempt[];
}

/**
 * Aday komutları sırayla dener: her aday için spawn → waitForDevServer
 * (multi-port probe). Başarılı olanı döner; tüm adaylar fail ise attempt
 * log'lu fail sonucu. Fail eden her spawn'in process tree'sini öldürür
 * (orphan bırakmaz). Cross-platform (POSIX/Windows).
 *
 * Motivasyon: todomaster gibi full-stack projelerde `npm run dev` backend
 * başlatıyor → port 5173 boş. Chain ikinci adayı (`npm run dev:frontend` veya
 * `npx vite`) dener → Vite 5173 dinler → success.
 *
 * Backward compat: `spawnDevServer` + `waitForDevServer` ayrı API'lar
 * korunuyor; chain runner sadece yeni call site'larda kullanılır.
 */
export async function tryDevServerChain(
  projectRoot: string,
  candidates: Array<{ cmd: string; ports: number[] }>,
  timeoutMsPerAttempt = 20_000,
): Promise<DevServerChainResult> {
  const attempts: DevServerAttempt[] = [];
  // viteHint: aday komutlardan biri vite içeriyorsa proje vite-tabanlı → wrapper
  // komutlarına `-- --port` ile zorlamayı aç (vite PORT env'i yok sayar).
  const viteHint = candidates.some((c) =>
    /(^|\s)(npx |bunx |pnpm exec )?vite(\s|$)/.test(c.cmd),
  );
  for (const cand of candidates) {
    const primary = cand.ports[0] ?? 5173;
    // FALSE-MATCH FIX: yalnız spawn-ÖNCESİ BOŞ olan bir portu hedefle + probe et.
    // primary boşsa onu; doluysa (başka app tutuyor) yukarı ilk boş portu bul.
    // Böylece probe'a gelen yanıt YA bizim sunucumuzdur YA hiç — foreign app'in
    // tuttuğu expected-port ASLA "bizimki" sayılmaz (önceki bug buydu).
    const target = (await isPortFree(primary))
      ? primary
      : await findFreePort(primary + 1, 64, new Set([primary]));
    if (target === null) {
      attempts.push({ cmd: cand.cmd, port: primary, reason: "no_free_port" });
      log.warn("dev-server-launcher", "no free port for candidate", {
        cmd: cand.cmd,
        primary,
      });
      continue;
    }
    // Sunucuyu hedef porta ZORLA (vite --port / next -p; PORT env spawnDevServer'da).
    // augment null → flag eklenmez ama PORT env Express/Next/Flask'i yine yönlendirir;
    // vite landingi başarısızsa target BOŞ kalır → dürüst timeout (false-match değil).
    const cmd = augmentPortFlag(cand.cmd, target, viteHint) ?? cand.cmd;
    const forced = cmd !== cand.cmd;
    const handle = spawnDevServer(projectRoot, cmd, target);
    const ready = await waitForDevServer(target, timeoutMsPerAttempt, { handle });

    if (ready && !handle.exited) {
      log.info("dev-server-launcher", "chain attempt success", {
        cmd,
        port: target,
        forced,
        prior_attempts: attempts.length,
      });
      return { ok: true, handle, cmd, attempts };
    }

    // Bu aday fail — process tree'sini öldür, sonraki adaya geç. GERÇEK çıktıyı sakla.
    const output = handle.recentOutput();
    attempts.push({
      cmd: cand.cmd,
      port: target,
      reason: handle.exited ? "process_died" : "port_timeout",
      ...(output ? { output } : {}),
    });
    killProcessTree(handle.pid);
    log.warn("dev-server-launcher", "chain attempt failed", {
      cmd,
      port: target,
      exited: handle.exited,
      output: output.slice(-500),
      next: attempts.length < candidates.length ? "trying next" : "exhausted",
    });
  }

  return { ok: false, attempts };
}

/**
 * Pure helper: dev server fail durumunda kullanıcıya gösterilecek **net,
 * eyleme dönüştürülebilir** hata mesajı üretir. Tanı bileşenleri:
 *   1. Olayın somut özeti (pid, port, timeout)
 *   2. Process canlı mı (crashed vs port yanıt vermedi ayırımı)
 *   3. `package.json:scripts.dev` parse — Vite çağırıyor mu?
 *   4. Olası nedenler + manuel çözüm yolu
 *   5. Resume talimatı
 *
 * Test edilebilir (saf fonksiyon, sadece fs.readFile + isProcessAlive yan
 * etkileri); SDK call yok.
 */
export async function buildDevServerFailMessage(
  projectRoot: string,
  pid: number,
  port: number,
  timeoutMs: number,
): Promise<string> {
  // package.json scripts.dev oku — parse fail veya dosya yoksa boş
  let devScript = "";
  try {
    const pkgRaw = await fs.readFile(join(projectRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    devScript = String(pkg.scripts?.dev ?? "");
  } catch {
    // package.json yok veya bozuk — devScript = ""
  }
  const hasVite = /(^|\s|"|')(vite|next|webpack-dev-server|wmr|astro\s+dev)(\s|$)/.test(devScript);
  const alive = pid > 0 ? isProcessAlive(pid) : false;

  const lines: string[] = [];
  lines.push(`❌ Faz 5: Dev server başlatılamadı.`);
  lines.push(`   pid=${pid}, beklenen port=${port}, timeout=${Math.floor(timeoutMs / 1000)}s.`);
  lines.push(``);
  lines.push(
    `Process durumu: ${alive ? "✓ canlı (port'ta yanıt yok — port mismatch veya cold-start yavaş)" : "✗ ÖLDÜ (npm run dev başlangıçta crash etti)"}`,
  );
  lines.push(`package.json "dev" script: \`${devScript || "(yok)"}\``);
  lines.push(``);

  if (!devScript) {
    lines.push(`⚠ package.json'da "dev" script tanımlı değil veya okunamadı.`);
    lines.push(`Frontend dev için: \`cd ${projectRoot} && npx vite\` veya proje toolchain'ine uygun komut.`);
  } else if (!hasVite) {
    lines.push(`⚠ "npm run dev" Vite/Next/Webpack-dev-server başlatmıyor.`);
    lines.push(`Bu script muhtemelen backend veya farklı bir process; MyCL frontend HMR'ı bekliyor.`);
    lines.push(``);
    lines.push(`Çözüm A: package.json'a frontend dev script ekleyin:`);
    lines.push(`  "dev:frontend": "vite"`);
    lines.push(`Çözüm B: Yeni terminalde manuel başlatın:`);
    lines.push(`  cd ${projectRoot} && npx vite`);
  } else if (!alive) {
    lines.push(`Olası nedenler:`);
    lines.push(`  • Bağımlılık eksik (örn. node_modules yok) → \`npm install\` çalıştırın`);
    lines.push(`  • Backend bağımlılığı down (DB, env vars vb.) — script çıktısına bakın`);
    lines.push(`  • Yeni terminalde manuel başlatın ve gerçek hatayı görün:`);
    lines.push(`    cd ${projectRoot} && npm run dev`);
  } else {
    lines.push(`Olası nedenler:`);
    // v15.8 (2026-05-30): Platform-aware port-check hint (Windows'ta lsof yok).
    const portCheckHint =
      platform() === "win32"
        ? `netstat -ano | findstr :${port}`
        : `lsof -i :${port}`;
    lines.push(`  • Port ${port} dolu — başka bir process kullanıyor olabilir (\`${portCheckHint}\`)`);
    lines.push(`  • vite.config'inde farklı port (örn. \`server.port: 5174\`) — port mismatch`);
    lines.push(`  • Cold-start ${Math.floor(timeoutMs / 1000)} saniyeyi aştı`);
    lines.push(``);
    lines.push(`Çözüm: vite.config'i kontrol edin; veya manuel başlatıp gerçek URL'i alın:`);
    lines.push(`  cd ${projectRoot} && npm run dev`);
  }

  lines.push(``);
  lines.push(`Sorunu çözdükten sonra MyCL'e **"devam et"** yazın — Faz 5 yeniden başlar.`);

  return lines.join("\n");
}
