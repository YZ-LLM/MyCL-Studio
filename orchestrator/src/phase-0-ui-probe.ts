// phase-0-ui-probe — Pre-D1 deterministic UI probe via Playwright.
//
// v15.7 (2026-05-27): Kullanıcı kuralı: "debug moduna girdiği zaman, problem
// UI tarafında kullanılan bişeyle alakalı ise playwright ile test etsin."
//
// LLM ana ajan prompt-following zayıflığı → soft hint yetmez. Kod-seviyesi
// deterministik kapı: önkoşullar tatmin ise probe ÇALIŞIR, çıktı D1 initial
// message'a inject edilir. Ana ajan kaçınamaz.
//
// Akış:
//   1. UI keyword check (bug text)
//   2. Playwright dep check (package.json @playwright/test)
//   3. Dev server alive check (audit'ten son port + kill -0 PID)
//   4. Temp probe spec yaz → npx playwright test → çıktıyı capture → spec sil
//   5. Formatted markdown blok döndür (D1 prompt'a inject için)
//
// Skip durumlarında null döner — caller bunu prompt'a eklemez.

import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readAuditLog } from "./audit.js";
import { log } from "./logger.js";
import { emitChatMessage } from "./ipc.js";
import { ensurePlaywrightInstalled } from "./playwright-setup.js";
import { isProcessAlive } from "./process-utils.js";

const execAsync = promisify(exec);

// v15.7 (2026-05-27): UI keyword gate KALDIRILDI. Eski UI_PATTERNS regex'i
// bug text'inin "UI ile ilgili" olup olmadığını natural language tahmini ile
// karar veriyordu — kullanıcı kuralı: "regex güvenilir değil". False negative
// gerçek UI bug'larını probe'suz bıraktı; false positive ucuz (probe ~5sn).
//
// Yeni mantık: dev_server alive + Playwright kurulu ise probe ÇALIŞIR; probe
// çıktısı DOM gerçeğini gösterir — UI-related olup olmadığı LLM'e bırakılır
// (D1 ana ajan probe markdown'ını okur, gerçek davranışa göre karar verir).

async function hasPlaywrightDep(projectRoot: string): Promise<boolean> {
  try {
    const pkg = await fs.readFile(
      join(projectRoot, "package.json"),
      "utf-8",
    );
    return /@playwright\/test/.test(pkg);
  } catch {
    return false;
  }
}

/**
 * Audit'ten son `command-dev-server-start` event'ini bul, port + pid çıkar.
 * Sonra `kill -0 <pid>` ile process alive doğrula.
 *
 * Detail format: `cmd="npm run dev" pid=22304 port=5173 prior_attempts=0`
 */
async function findAliveDevServer(
  projectRoot: string,
): Promise<{ pid: number; port: number } | null> {
  try {
    const audit = await readAuditLog(projectRoot);
    // Son dev-server-start event (reverse iterate)
    for (let i = audit.length - 1; i >= 0; i--) {
      const e = audit[i];
      if (!e || e.event !== "command-dev-server-start") continue;
      const detail = e.detail ?? "";
      const pidMatch = detail.match(/pid=(\d+)/);
      const portMatch = detail.match(/port=(\d+)/);
      if (!pidMatch || !portMatch) continue;
      const pid = Number(pidMatch[1]);
      const port = Number(portMatch[1]);
      // v15.8 (2026-05-28): Cross-platform process existence check
      // (POSIX: kill -0; Windows: tasklist). Async helper.
      const alive = await isProcessAlive(pid);
      if (alive) {
        return { pid, port };
      }
      // PID dead, eski event — sonraki üzerinden geriye git
    }
    return null;
  } catch (err) {
    // Audit okuma hatası (sessiz-fallback denetimi): null = dev-server keşfi İPTAL → UI probe atlanır.
    // Sessiz null "sunucu yok" ile karışır → görünür kıl (gerçek hata, "yok" değil).
    log.error("phase-0-ui-probe", "audit okuma hatası — dev-server keşfi iptal edildi", err);
    return null;
  }
}

/**
 * Tek-seferlik Playwright probe spec dosyası — minimal: navigate, title +
 * body text + console errors capture.
 */
function generateProbeSpec(url: string): string {
  return `import { test, expect } from '@playwright/test';

test('d1-probe', async ({ page }) => {
  const consoleMessages: string[] = [];
  page.on('console', (msg) => {
    consoleMessages.push(\`[\${msg.type()}] \${msg.text()}\`);
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  try {
    await page.goto('${url}', { timeout: 15000, waitUntil: 'domcontentloaded' });
  } catch (err) {
    console.log('NAV_ERROR:', (err as Error).message);
  }
  console.log('---PROBE-RESULTS---');
  console.log('TITLE:', await page.title());
  const url2 = page.url();
  console.log('FINAL_URL:', url2);
  const bodyText = await page.locator('body').textContent().catch(() => '(no body)');
  console.log('BODY_TEXT_PREVIEW:', (bodyText ?? '').slice(0, 500));
  console.log('CONSOLE_MESSAGES:', JSON.stringify(consoleMessages.slice(0, 20)));
  console.log('PAGE_ERRORS:', JSON.stringify(pageErrors.slice(0, 10)));
  console.log('---PROBE-END---');
});
`;
}

/**
 * Ana entry — pre-D1 hook. Önkoşullar tatmin değilse null döner.
 * Tatmin ise probe çalıştırır, formatted markdown blok döner.
 *
 * Çıktı formatı:
 * ```
 * ## Pre-D1 Playwright Probe (otomatik)
 *
 * Bug raporu UI-related olarak sınıflandırıldı; dev server alive
 * (pid=X port=Y); Playwright kurulu. Probe çıktısı:
 *
 * <pre>
 * [stdout snippet]
 * </pre>
 *
 * **Bu çıktıyı root cause analizine input olarak kullan**...
 * ```
 */
export async function runPreD1UiProbe(
  projectRoot: string,
  _bugReport: string,
  stack?: string,
): Promise<string | null> {
  // 1. Dev server alive — probe için zorunlu (UI yoksa probe'un anlamı yok)
  const server = await findAliveDevServer(projectRoot);
  if (!server) {
    log.info("phase-0-ui-probe", "skip: no alive dev server in audit");
    return null;
  }
  // 2. Playwright kurulu mu? Değilse kullanıcı kuralı uyarınca otomatik kur
  // (v15.7, 2026-05-27: "playwright yoksa yüklesin"). Hâlâ kurulu değilse
  // skip — install fail durumunda probe denemenin anlamı yok.
  const hasDep = await hasPlaywrightDep(projectRoot);
  if (!hasDep) {
    log.info("phase-0-ui-probe", "playwright missing — attempting install");
    const ensure = await ensurePlaywrightInstalled(projectRoot, stack);
    if (!ensure.ok) {
      // Load-bearing skip (sessiz-fallback denetimi): UI probe atlanıyor → kullanıcı NEDEN bilmeli (sessiz null değil).
      log.warn("phase-0-ui-probe", "playwright install failed — UI probe skipped", {
        action: ensure.action,
        error: ensure.error?.slice(0, 200),
      });
      emitChatMessage(
        "system",
        `ℹ️ UI ön-incelemesi atlandı — Playwright kurulamadı (${ensure.action ?? "hata"}). Debug yine de devam ediyor.`,
      );
      return null;
    }
    log.info("phase-0-ui-probe", "playwright installed", { action: ensure.action });
  }
  // 4. Probe spec yaz + çalıştır
  const tmpDir = tmpdir();
  const specPath = join(tmpDir, `mycl-d1-probe-${Date.now()}.spec.ts`);
  const url = `http://localhost:${server.port}`;
  await fs.writeFile(specPath, generateProbeSpec(url), "utf-8");
  log.info("phase-0-ui-probe", "running probe", { url, pid: server.pid });
  let output = "";
  let probeStatus: "ok" | "timeout" | "error" = "ok";
  try {
    const { stdout, stderr } = await execAsync(
      `npx --no-install playwright test ${specPath} --reporter=line --quiet 2>&1`,
      {
        cwd: projectRoot,
        timeout: 35_000,
        maxBuffer: 1_000_000,
      },
    );
    output = (stdout || "") + (stderr ? "\n" + stderr : "");
  } catch (err) {
    const e = err as { killed?: boolean; stdout?: string; stderr?: string; message?: string };
    if (e.killed) probeStatus = "timeout";
    else probeStatus = "error";
    output = (e.stdout || "") + (e.stderr ? "\n" + e.stderr : "") + (e.message ? `\n${e.message}` : "");
  }
  // 5. Cleanup
  await fs.unlink(specPath).catch(() => {});

  // Probe çıktısının önemli kısmını kes (PROBE-RESULTS arası)
  const slice = extractProbeOutput(output);

  return [
    "## Pre-D1 Playwright Probe (otomatik gözlem)",
    "",
    `Bug raporu UI-related: dev server alive (pid=${server.pid}, port=${server.port}), Playwright kurulu. Probe yapıldı.`,
    `Probe durumu: \`${probeStatus}\`.`,
    "",
    "```",
    slice.slice(0, 4000), // prompt token cap
    "```",
    "",
    "**Bu çıktıyı root cause analizinde kullan**: navigation hatası, console error, sayfa boş gelmesi, redirect bekleyen, vs. gibi sinyaller root_cause_en içinde yer almalı. Probe sayfanın gerçekte ne ürettiğini gösterir; spekülasyon yapma — bu veri üzerinden konuş.",
  ].join("\n");
}

function extractProbeOutput(raw: string): string {
  const start = raw.indexOf("---PROBE-RESULTS---");
  const end = raw.indexOf("---PROBE-END---");
  if (start >= 0 && end > start) {
    return raw.slice(start, end + "---PROBE-END---".length).trim();
  }
  // Fallback: tail
  return raw.slice(-3000).trim();
}
