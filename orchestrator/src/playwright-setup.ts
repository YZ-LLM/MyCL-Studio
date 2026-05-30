// playwright-setup — Playwright auto-install yardımcısı.
//
// v15.7 (2026-05-27): Kullanıcı kuralı: "playwright yoksa yüklesin".
//
// Önceki davranış:
//   - Pre-D1 UI probe: `@playwright/test` yoksa sessizce skip (kullanıcı
//     araştırma çıktısı göremiyordu)
//   - Phase 16: `npx --no-install playwright test` fail oluyordu (paket
//     yüklü değilse `--no-install` flag'i auto-install'ı engelliyor)
//
// Yeni davranış: bu yardımcı `@playwright/test`'i package.json + node_modules
// içinde dener; eksikse stack'e göre doğru package manager ile kurar (npm /
// pnpm / yarn / bun). Sonra `playwright install chromium` ile browser
// bundle'ı kurulur (test runner için zorunlu).
//
// İdempotent: zaten kurulu ise no-op + `already` döner. Hata: `failed` +
// stderr text.
//
// Audit: caller event yazar (`playwright-installed` veya `playwright-install-failed`).

import { exec } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "./logger.js";
import { safeEnv } from "./safe-env.js";

const execp = promisify(exec);
const INSTALL_TIMEOUT_MS = 180_000;
const BROWSER_INSTALL_TIMEOUT_MS = 240_000;

export type EnsureAction = "already" | "installed" | "failed" | "unsupported";

export interface EnsureResult {
  ok: boolean;
  action: EnsureAction;
  /** Kullanıcıya gösterilecek kısa açıklama (TR). */
  message: string;
  /** Fail durumunda stderr/error snippet. */
  error?: string;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const PLAYWRIGHT_PKG = "@playwright/test";

/**
 * Stack id → install komut + browser komut. node dışındaki stack'lerde
 * "unsupported" döner (kullanıcının zaten Playwright kullanmaması beklenir).
 */
function commandsForStack(
  stack: string | undefined,
): { install: string; browser: string } | null {
  switch (stack) {
    case "node-npm":
      return {
        install: `npm install -D ${PLAYWRIGHT_PKG}`,
        browser: "npx playwright install chromium",
      };
    case "node-pnpm":
      return {
        install: `pnpm add -D ${PLAYWRIGHT_PKG}`,
        browser: "pnpm exec playwright install chromium",
      };
    case "node-yarn":
      return {
        install: `yarn add -D ${PLAYWRIGHT_PKG}`,
        browser: "yarn playwright install chromium",
      };
    case "node-bun":
      return {
        install: `bun add -d ${PLAYWRIGHT_PKG}`,
        browser: "bunx playwright install chromium",
      };
    default:
      return null;
  }
}

async function hasPackageJsonEntry(projectRoot: string): Promise<boolean> {
  try {
    const raw = await readFile(join(projectRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as PackageJson;
    return Boolean(
      pkg.dependencies?.[PLAYWRIGHT_PKG] ?? pkg.devDependencies?.[PLAYWRIGHT_PKG],
    );
  } catch {
    return false;
  }
}

async function hasNodeModulesEntry(projectRoot: string): Promise<boolean> {
  try {
    await access(join(projectRoot, "node_modules", "@playwright", "test", "package.json"));
    return true;
  } catch {
    return false;
  }
}

async function runShell(
  cmd: string,
  cwd: string,
  timeout_ms: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execp(cmd, {
      cwd,
      timeout: timeout_ms,
      env: { ...safeEnv(), LC_ALL: "C" },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? "unknown error"),
    };
  }
}

/**
 * Playwright'ın projede kurulu olduğundan emin ol. İdempotent.
 *
 * Akış:
 *   1. package.json + node_modules zaten varsa → `already`
 *   2. Stack komut bilinmiyorsa → `unsupported`
 *   3. Install komutunu çalıştır; başarısızsa `failed`
 *   4. Browser bundle indir (`playwright install chromium`); browser fail
 *      olursa yine `installed` döner (test koşumunda browser launch fail
 *      olursa kullanıcı görür) ama log uyarısı yazılır.
 */
export async function ensurePlaywrightInstalled(
  projectRoot: string,
  stack: string | undefined,
): Promise<EnsureResult> {
  const inPkg = await hasPackageJsonEntry(projectRoot);
  const inNm = inPkg ? await hasNodeModulesEntry(projectRoot) : false;
  if (inPkg && inNm) {
    return {
      ok: true,
      action: "already",
      message: "Playwright zaten kurulu.",
    };
  }

  const cmds = commandsForStack(stack);
  if (!cmds) {
    return {
      ok: false,
      action: "unsupported",
      message: `Playwright otomatik kurulumu bu stack için desteklenmiyor (${stack ?? "unknown"}).`,
    };
  }

  log.info("playwright-setup", "installing playwright", { stack, projectRoot });
  const installRes = await runShell(cmds.install, projectRoot, INSTALL_TIMEOUT_MS);
  if (!installRes.ok) {
    log.warn("playwright-setup", "install failed", {
      stderr: installRes.stderr.slice(0, 300),
    });
    return {
      ok: false,
      action: "failed",
      message: `Playwright kurulumu başarısız: ${cmds.install}`,
      error: installRes.stderr.slice(0, 400),
    };
  }

  log.info("playwright-setup", "installing chromium browser");
  const browserRes = await runShell(
    cmds.browser,
    projectRoot,
    BROWSER_INSTALL_TIMEOUT_MS,
  );
  if (!browserRes.ok) {
    log.warn("playwright-setup", "browser install failed (non-fatal)", {
      stderr: browserRes.stderr.slice(0, 300),
    });
    return {
      ok: true,
      action: "installed",
      message:
        "Playwright kuruldu ama Chromium browser indirilemedi (test koşumunda manuel `playwright install chromium` gerekebilir).",
      error: browserRes.stderr.slice(0, 400),
    };
  }
  return {
    ok: true,
    action: "installed",
    message: "Playwright kuruldu (Chromium dahil).",
  };
}

// ---------------------------------------------------------------------------
// Scaffold detect + auto-init (v15.7, 2026-05-27)
//
// Kullanıcı kuralı: Playwright kurulu ama config + test dosyası yoksa
// "yazdı ama yapmadı" sorunu yaşanıyor. AskUserQuestion ile karar: otomatik
// init. `npx create-playwright`'in non-interactive flag desteği sürüm-bağımlı
// + TTY hang riski → minimal custom scaffold (config + smoke test) yazılır.
// ---------------------------------------------------------------------------

export interface ScaffoldCheck {
  hasConfig: boolean;
  hasTests: boolean;
  configPath?: string;
}

export type ScaffoldAction = "already" | "scaffolded" | "failed";

export interface ScaffoldResult {
  ok: boolean;
  action: ScaffoldAction;
  message: string;
  error?: string;
}

const CONFIG_CANDIDATES = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
];

const TEST_DIRS = ["tests", "e2e", "playwright"];
const TEST_FILE_RE = /\.(?:spec|test)\.(?:ts|tsx|js|mjs|cjs)$/i;
// v15.7 (2026-05-27): @playwright/test import imzası — Vitest/Jest/Mocha
// dosyalarını Playwright testi sanmamak için. ESM `from '@playwright/test'`
// ve CJS `require('@playwright/test')` formlarını yakalar.
const PLAYWRIGHT_IMPORT_RE = /['"`]@playwright\/test['"`]/;
// Dosya okuma bütçesi — büyük monorepo'larda scan'i sınırla.
const MAX_FILE_READS = 30;
const CONTENT_PREFIX_BYTES = 4096;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Dosya içeriği gerçekten Playwright testi mi? İlk 4KB'a bakar. */
async function isPlaywrightSpec(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, "utf-8");
    return PLAYWRIGHT_IMPORT_RE.test(content.slice(0, CONTENT_PREFIX_BYTES));
  } catch {
    return false;
  }
}

/**
 * Bir dizini depth ≤ maxDepth ile tara; içeriği Playwright testi olan bir
 * dosya bulunca true döner. budget reads'i takip eder; aşıldığında file
 * okumayı bırakır (false döner).
 */
async function scanForTests(
  dir: string,
  maxDepth: number,
  budget: { reads: number },
): Promise<boolean> {
  if (maxDepth < 0 || budget.reads <= 0) return false;
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    const raw = await readdir(dir, { withFileTypes: true });
    entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    if (!e.isDir && TEST_FILE_RE.test(e.name)) {
      if (budget.reads <= 0) continue;
      budget.reads--;
      if (await isPlaywrightSpec(join(dir, e.name))) return true;
    }
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    if (e.isDir) {
      const found = await scanForTests(
        join(dir, e.name),
        maxDepth - 1,
        budget,
      );
      if (found) return true;
    }
  }
  return false;
}

/**
 * Playwright scaffold durumunu döner. Sıfır mutation; sadece okur.
 */
export async function checkPlaywrightScaffold(
  projectRoot: string,
): Promise<ScaffoldCheck> {
  let configPath: string | undefined;
  for (const candidate of CONFIG_CANDIDATES) {
    if (await pathExists(join(projectRoot, candidate))) {
      configPath = candidate;
      break;
    }
  }
  const hasConfig = Boolean(configPath);
  // Test dosyası ara — önce TEST_DIRS, sonra project root shallow.
  // İçerik kontrolü ile Playwright olmayan testler (Vitest/Jest) sayılmaz.
  const budget = { reads: MAX_FILE_READS };
  let hasTests = false;
  for (const dir of TEST_DIRS) {
    if (await scanForTests(join(projectRoot, dir), 2, budget)) {
      hasTests = true;
      break;
    }
  }
  if (!hasTests && budget.reads > 0) {
    // Project root shallow (sadece direct children .spec.ts vb) — yine
    // içerik kontrolü ile Playwright tespit.
    try {
      const raw = await readdir(projectRoot, { withFileTypes: true });
      for (const e of raw) {
        if (budget.reads <= 0) break;
        if (e.isFile() && TEST_FILE_RE.test(e.name)) {
          budget.reads--;
          if (await isPlaywrightSpec(join(projectRoot, e.name))) {
            hasTests = true;
            break;
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return { hasConfig, hasTests, configPath };
}

// v15.7 (2026-05-27): Scaffold dosyalarına imza markeri. Mevcut imzalı bir
// dosyayı MyCL "kendi yazdığı" olarak görür → refresh tarafından üzerine
// yazılabilir. Kullanıcı manuel düzenlerse imzayı kaldırır → MyCL bir daha
// dokunmaz.
const MYCL_SCAFFOLD_MARKER = "// MyCL scaffold v15.8";

function renderPlaywrightConfig(defaultPort: number): string {
  return `${MYCL_SCAFFOLD_MARKER} — bu dosya MyCL Studio tarafından oluşturuldu.
// Düzenlemek için bu satırı silin; MyCL bir daha üzerine yazmaz.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  // v15.7 (2026-05-27): Kullanıcı kuralı — MyCL desktop ortamında çalışıyor,
  // browser görünür olsun ("uygulamayı çalıştırıp playwright ile test
  // yapmıyor" şikâyeti). Headless'i kapat — kullanıcı testi gözleyebilsin.
  use: {
    baseURL: 'http://localhost:${defaultPort}',
    headless: false,
    trace: 'off',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
`;
}

function renderSmokeSpec(): string {
  return `${MYCL_SCAFFOLD_MARKER} — bu dosya MyCL Studio tarafından oluşturuldu.
// Düzenlemek için bu satırı silin; MyCL bir daha üzerine yazmaz.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// v15.8 (2026-05-28): Auth-aware smoke. .mycl/auth.json varsa login flow
// uygulanır (kullanıcı kuralı: "login sayfasını geçsin"). Yoksa direkt /
// ziyaret edilir.
//
// auth.json şeması:
//   {
//     "username": "admin@example.com",
//     "password": "secret",
//     "loginPath": "/login",            // opsiyonel, default "/login"
//     "usernameSelector": "...",        // opsiyonel, default email/user input
//     "passwordSelector": "...",        // opsiyonel, default input[type=password]
//     "submitSelector": "...",          // opsiyonel, default button[type=submit]
//     "successUrlPattern": "/dashboard" // opsiyonel; URL change beklemek için
//   }
interface AuthConfig {
  username?: string;
  password?: string;
  loginPath?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  successUrlPattern?: string;
}

function loadAuth(): AuthConfig | null {
  const cwd = process.cwd();
  const authPath = join(cwd, '.mycl', 'auth.json');
  if (!existsSync(authPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(authPath, 'utf-8');
  } catch (e) {
    console.warn('[MyCL] auth.json okunamadı:', (e as Error).message);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // v15.8 (2026-05-28): Sessiz fail yerine açık sinyal — kullanıcı bozuk
    // JSON'u fark etsin. Smoke yine login'siz devam eder ama log görünür.
    console.warn(
      '[MyCL] auth.json bozuk JSON, login flow atlanıyor:',
      (e as Error).message,
    );
    return null;
  }
  // v15.8 (2026-05-28): Şema validation — credentials'lar string olmalı.
  // Yanlış tip → sessiz null değil, açık uyarı + skip.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn('[MyCL] auth.json kök objesi nesne değil; login atlanıyor.');
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const stringFields = ['username', 'password', 'loginPath', 'usernameSelector', 'passwordSelector', 'submitSelector', 'successUrlPattern'];
  for (const k of stringFields) {
    if (obj[k] !== undefined && typeof obj[k] !== 'string') {
      console.warn(\`[MyCL] auth.json "\${k}" field'ı string olmalı (tip: \${typeof obj[k]}); login atlanıyor.\`);
      return null;
    }
  }
  const cfg = obj as unknown as AuthConfig;
  // Placeholder values'ı YOKSAY — gerçek credentials yoksa login skip
  if (!cfg.username || cfg.username.startsWith('<') || cfg.username === 'PLACEHOLDER') return null;
  if (!cfg.password || cfg.password.startsWith('<') || cfg.password === 'PLACEHOLDER') return null;
  return cfg;
}

test('smoke: app loads (auth-aware) with content and no console errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  const auth = loadAuth();

  if (auth) {
    // Login flow — .mycl/auth.json'dan credentials
    const loginPath = auth.loginPath ?? '/login';
    const userSel =
      auth.usernameSelector ??
      'input[type=email], input[name=email], input[id=email], input[name=username], input[id=username]';
    const passSel = auth.passwordSelector ?? 'input[type=password]';
    const submitSel =
      auth.submitSelector ??
      'button[type=submit], button:has-text("Giriş"), button:has-text("Login")';

    await page.goto(loginPath, { waitUntil: 'networkidle', timeout: 20000 });
    await page.locator(userSel).first().fill(auth.username!);
    await page.locator(passSel).first().fill(auth.password!);
    await page.locator(submitSel).first().click();

    // Login sonrası URL change veya networkidle bekle
    if (auth.successUrlPattern) {
      // v15.8 (2026-05-28): User-input regex — invalid pattern throw'unu yakala,
      // networkidle fallback ile devam et. ReDoS riski düşük (smoke test'i tek
      // çalışmalı çalıştırılır).
      let urlPattern: RegExp | null = null;
      try {
        urlPattern = new RegExp(auth.successUrlPattern);
      } catch (e) {
        console.warn('successUrlPattern invalid regex, fallback to networkidle:', e);
      }
      if (urlPattern) {
        await page.waitForURL(urlPattern, { timeout: 15000 });
      } else {
        await page.waitForLoadState('networkidle', { timeout: 15000 });
      }
    } else {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    }
  } else {
    // No auth — direkt / (anonim erişim varsayımı)
    await page.goto('/', { waitUntil: 'networkidle', timeout: 20000 });
  }

  // Title gerçek bir değer içermeli
  await expect(page).toHaveTitle(/.+/);

  // Body render edilmiş olmalı — beyaz ekran fail sinyali
  await expect(page.locator('body')).not.toBeEmpty();

  // Auth flow sonrası login sayfasında DEĞİL olmalı (başarılı giriş garantisi)
  if (auth) {
    const currentUrl = page.url();
    const loginPathStr = auth.loginPath ?? '/login';
    expect(currentUrl).not.toContain(loginPathStr);
  }

  // Console error toleransı: 0 ideal; rapor için yazılır
  if (consoleErrors.length > 0) {
    console.log('Console errors detected:', consoleErrors.slice(0, 5));
  }
});
`;
}

/** Bir dosyanın MyCL tarafından scaffold edilmiş olup olmadığını kontrol. */
async function isMyclScaffolded(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf-8");
    return raw.slice(0, 400).includes(MYCL_SCAFFOLD_MARKER);
  } catch {
    return false;
  }
}

/**
 * v15.7 (2026-05-28): Eski MyCL-generated scaffold tespiti (imza markeri
 * eklenmeden önce yazılmış dosyalar). 5 invariant + size cap; user-written
 * config'i yanlışlıkla refresh etmemek için çoklu match gerekli.
 *
 * Match kriterleri (config):
 *   - testDir: './tests'
 *   - chromium project (single)
 *   - baseURL: http://localhost:NNNN
 *   - retries: 0
 *   - reporter: 'list'
 *   - size < 800 char (kullanıcı-genişletilmiş config büyük olur)
 */
function isLegacyMyclConfig(content: string): boolean {
  if (content.length > 800) return false;
  const hasTestDir = /testDir:\s*['"]\.\/tests['"]/.test(content);
  const hasChromium = /name:\s*['"]chromium['"]/.test(content);
  const hasBaseUrl = /baseURL:\s*['"]http:\/\/localhost:\d+['"]/.test(content);
  const hasRetries0 = /retries:\s*0/.test(content);
  const hasListReporter = /reporter:\s*['"]list['"]/.test(content);
  return hasTestDir && hasChromium && hasBaseUrl && hasRetries0 && hasListReporter;
}

/**
 * v15.7 (2026-05-28): Eski MyCL smoke test tespiti.
 *
 * Match kriterleri:
 *   - @playwright/test import
 *   - page.goto('/')
 *   - toHaveTitle(/.+/)
 *   - size < 400 char
 */
function isLegacyMyclSmoke(content: string): boolean {
  if (content.length > 400) return false;
  return (
    /@playwright\/test/.test(content) &&
    /page\.goto\(['"]\/['"]\)/.test(content) &&
    /toHaveTitle\(\/\.\+\/\)/.test(content)
  );
}

/**
 * Dosya içeriklerinin "MyCL şablonu açısından eşit" olup olmadığını kontrol.
 * Line ending (CRLF/LF), satır sonu boşluk, BOM gibi platformlar arası
 * farkları normalize eder. Aksi halde Windows checkout LF↔CRLF dönüşümünde
 * her çalıştırmada gereksiz refresh ederdi.
 */
function scaffoldContentEqual(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/^﻿/, "") // BOM
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n+$/g, "\n");
  return norm(a) === norm(b);
}

/**
 * Scaffold yoksa minimal config + smoke test yazar. Idempotent: zaten varsa
 * `already` döner ve dosyalara dokunmaz.
 *
 * Dev server `defaultPort`'ta çalışıyorsa smoke pass; çalışmıyorsa anlamlı
 * fail (kullanıcıya "dev server'ı başlat" sinyali).
 */
export async function ensurePlaywrightScaffold(
  projectRoot: string,
  defaultPort: number,
): Promise<ScaffoldResult> {
  const check = await checkPlaywrightScaffold(projectRoot);
  const configPath = join(projectRoot, "playwright.config.ts");
  const specPath = join(projectRoot, "tests", "smoke.spec.ts");

  // v15.7 (2026-05-27): MyCL-imzalı eski scaffold tespit edilirse şablon
  // güncellendiyse refresh et. Kullanıcı manuel düzenlerse imza kaybolur →
  // bir daha dokunulmaz (user-edited respected).
  //
  // v15.7 (2026-05-28): Legacy fallback — imza marker eklenmeden önce
  // yazılmış MyCL scaffold'unu çoklu invariant heuristic ile tespit et,
  // bir kerelik refresh et (imzalı yeni sürüm ile değiştir).
  let configIsStale = false;
  let specIsStale = false;
  let legacyRefresh = false;
  if (check.hasConfig) {
    const existingConfig = check.configPath
      ? join(projectRoot, check.configPath)
      : configPath;
    try {
      const existing = await readFile(existingConfig, "utf-8");
      if (await isMyclScaffolded(existingConfig)) {
        const currentRendered = renderPlaywrightConfig(defaultPort);
        configIsStale = !scaffoldContentEqual(existing, currentRendered);
      } else if (isLegacyMyclConfig(existing)) {
        configIsStale = true;
        legacyRefresh = true;
        log.info("playwright-setup", "legacy config detected — will refresh", {
          path: existingConfig,
        });
      }
    } catch {
      configIsStale = false;
    }
  }
  if (check.hasTests && (await pathExists(specPath))) {
    try {
      const existing = await readFile(specPath, "utf-8");
      if (await isMyclScaffolded(specPath)) {
        const currentRendered = renderSmokeSpec();
        specIsStale = !scaffoldContentEqual(existing, currentRendered);
      } else if (isLegacyMyclSmoke(existing)) {
        specIsStale = true;
        legacyRefresh = true;
        log.info("playwright-setup", "legacy smoke detected — will refresh", {
          path: specPath,
        });
      }
    } catch {
      specIsStale = false;
    }
  }

  if (check.hasConfig && check.hasTests && !configIsStale && !specIsStale) {
    return {
      ok: true,
      action: "already",
      message: "Playwright scaffold zaten mevcut.",
    };
  }
  try {
    if (!check.hasConfig || configIsStale) {
      await writeFile(configPath, renderPlaywrightConfig(defaultPort), "utf-8");
      log.info("playwright-setup", "wrote playwright.config.ts", {
        configPath,
        refresh: configIsStale,
      });
    }
    if (!check.hasTests || specIsStale) {
      const testsDir = join(projectRoot, "tests");
      await mkdir(testsDir, { recursive: true });
      // Test dosyası başka isimle varsa (user-written) ona dokunma; sadece
      // smoke.spec.ts'i MyCL kendi imzasıyla yönetir. specIsStale durumunda
      // imzalı dosya üzerine yazılır; pathExists false ise yeni yazılır.
      if (specIsStale || !(await pathExists(specPath))) {
        await writeFile(specPath, renderSmokeSpec(), "utf-8");
        log.info("playwright-setup", "wrote tests/smoke.spec.ts", { specPath });
      }
    }
    return {
      ok: true,
      action: "scaffolded",
      message: legacyRefresh
        ? "Playwright test dosyaları güncellendi (yeni sürüme yükseltildi)."
        : "Playwright test kurulumu otomatik yapıldı (ayar dosyası + örnek test).",
    };
  } catch (err) {
    const e = err as { message?: string };
    log.warn("playwright-setup", "scaffold write failed", err);
    return {
      ok: false,
      action: "failed",
      message: "Playwright test dosyaları oluşturulamadı.",
      error: String(e.message ?? err).slice(0, 400),
    };
  }
}

// ---------------------------------------------------------------------------
// Auth template (v15.8, 2026-05-28)
//
// Smoke test login flow için credentials okur. Bu helper `<project>/.mycl/
// auth.json` template'i yazar (placeholder values). Kullanıcı dosyayı düzenler
// → smoke test loginPath'e gider, formu doldurur, devam eder.
//
// Güvenlik: dosya chmod 0600 yazılır. `.mycl/.gitignore`'a otomatik ekleme
// `ensureMyclGitignore` ile yapılır (auth.json secret'leri leak etmesin).
// ---------------------------------------------------------------------------

export type AuthTemplateAction = "written" | "exists" | "failed";

export interface AuthTemplateResult {
  ok: boolean;
  action: AuthTemplateAction;
  message: string;
  error?: string;
}

function renderAuthTemplate(): string {
  return `{
  "_comment": "MyCL Studio auth.json — Phase 16 smoke test login flow için credentials. Bu dosya .gitignore'da olmalı. chmod 0600.",
  "_marker": "MyCL auth template v15.8 — placeholders are detected; replace them with real values to enable login.",
  "username": "<EMAIL_OR_USERNAME>",
  "password": "<PASSWORD>",
  "loginPath": "/login",
  "usernameSelector": "input[type=email], input[name=email], input[id=email], input[name=username], input[id=username]",
  "passwordSelector": "input[type=password]",
  "submitSelector": "button[type=submit], button:has-text(\\"Giriş\\"), button:has-text(\\"Login\\")",
  "successUrlPattern": ""
}
`;
}

/**
 * `.mycl/auth.json` template yaz (yoksa). chmod 0600. .gitignore guard.
 */
export async function ensureAuthTemplate(
  projectRoot: string,
): Promise<AuthTemplateResult> {
  const myclDir = join(projectRoot, ".mycl");
  const authPath = join(myclDir, "auth.json");
  try {
    await mkdir(myclDir, { recursive: true });
    // v15.8 (2026-05-28): .gitignore koruması HER ÇAĞRIDA çalıştırılır
    // (QC bulgusu: manuel auth.json yazılırsa gitignore'a eklenmiyordu →
    // secret leak riski). Idempotent — dup entry eklemez.
    await ensureMyclGitignore(projectRoot).catch((err: unknown) =>
      log.warn("playwright-setup", "gitignore write failed (non-fatal)", err),
    );
    if (await pathExists(authPath)) {
      return {
        ok: true,
        action: "exists",
        message: ".mycl/auth.json mevcut.",
      };
    }
    // v15.8 (2026-05-28): Cross-platform chmod — Windows'ta `mode` field
    // no-op olduğu için writeFile sonrası `chmod` ile explicit set ederiz.
    // Windows'ta yine no-op olur (NTFS POSIX permission tanımıyor) ama bu
    // platforma özgü; auth.json kullanıcı dizinde + .gitignore ile korunur.
    const writeOpts: Parameters<typeof writeFile>[2] =
      process.platform === "win32"
        ? { encoding: "utf-8" }
        : { encoding: "utf-8", mode: 0o600 };
    await writeFile(authPath, renderAuthTemplate(), writeOpts);
    if (process.platform !== "win32") {
      // Mac/Linux'ta umask write'ı bozabilir; explicit chmod ile garanti et.
      try {
        const fs = await import("node:fs/promises");
        await fs.chmod(authPath, 0o600);
      } catch (err) {
        log.warn("playwright-setup", "chmod 0600 failed (non-fatal)", err);
      }
    }
    log.info("playwright-setup", "wrote .mycl/auth.json template", {
      authPath,
      platform: process.platform,
    });
    return {
      ok: true,
      action: "written",
      message:
        process.platform === "win32"
          ? "🔐 `.mycl/auth.json` oluşturuldu — login varsa username/password alanlarını gerçek değerlerle güncelleyin, sonra Phase 16'yı tekrar çalıştırın. (Windows: dosya izinleri korunamıyor; secret'i public repo'ya commit etmeyin.)"
          : "🔐 `.mycl/auth.json` oluşturuldu — login varsa username/password alanlarını gerçek değerlerle güncelleyin, sonra Phase 16'yı tekrar çalıştırın.",
    };
  } catch (err) {
    const e = err as { message?: string };
    log.warn("playwright-setup", "auth template write failed", err);
    return {
      ok: false,
      action: "failed",
      message: ".mycl/auth.json yazılamadı.",
      error: String(e.message ?? err).slice(0, 400),
    };
  }
}

/**
 * `.mycl/.gitignore` dosyası — auth.json + state backup'lar secret leak'ini
 * engelle. Idempotent — mevcut dosyaya append eder, dup kontrol yapar.
 */
async function ensureMyclGitignore(projectRoot: string): Promise<void> {
  const myclDir = join(projectRoot, ".mycl");
  const gitignorePath = join(myclDir, ".gitignore");
  const required = ["auth.json", "state.json.backup.*", "*.tmp"];
  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf-8");
  } catch {
    /* dosya yok — sıfırdan yazılır */
  }
  const lines = new Set(
    existing.split("\n").map((l) => l.trim()).filter(Boolean),
  );
  let changed = false;
  for (const entry of required) {
    if (!lines.has(entry)) {
      lines.add(entry);
      changed = true;
    }
  }
  if (!changed) return;
  const header =
    "# MyCL Studio — auto-managed gitignore. Don't commit secrets (auth.json).\n";
  const content = header + Array.from(lines).join("\n") + "\n";
  await writeFile(gitignorePath, content, "utf-8");
  log.info("playwright-setup", "wrote .mycl/.gitignore", { gitignorePath });
}

// ---------------------------------------------------------------------------
// Faz 16 doğrulama değerlendirmesi (v15.8, 2026-05-30)
//
// "Dürüst raporlama" için: Faz 16 (E2E) geçince MyCL'in ne doğruladığını
// dürüstçe söyleyebilmek lazım. İki sinyal:
//   - smokeKind: çalışan Playwright testi MyCL'in yer tutucu duman testi mi
//     yoksa kullanıcının gerçek testi mi.
//   - authStatus: .mycl/auth.json gerçek mi, yer tutucu mu, yok mu (giriş
//     gerçekten yapıldı mı sinyali).
//
// ÖNEMLİ: test framework'ü dosya adından DEĞİL içerikten ayırt edilir
// (`@playwright/test` imzası). Vitest `.test.js` dosyaları yanlışlıkla
// "gerçek e2e testi" sayılmaz (eski memory kuralı).
// ---------------------------------------------------------------------------

const MYCL_MARKER_ANY = /\/\/ MyCL scaffold v/;

export type SmokeKind = "placeholder" | "real" | "none";
export type AuthStatus = "configured" | "placeholder" | "none";

export interface Phase16Verification {
  smokeKind: SmokeKind;
  authStatus: AuthStatus;
}

/** Test dizinlerini + root shallow tara, test dosyası yollarını topla. */
async function collectTestFiles(projectRoot: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2 || out.length > 50) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await visit(full, depth + 1);
      else if (TEST_FILE_RE.test(e.name) && !seen.has(full)) {
        seen.add(full);
        out.push(full);
      }
    }
  };
  for (const d of TEST_DIRS) await visit(join(projectRoot, d), 0);
  try {
    const entries = await readdir(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && TEST_FILE_RE.test(e.name)) {
        const full = join(projectRoot, e.name);
        if (!seen.has(full)) {
          seen.add(full);
          out.push(full);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

async function assessSmokeKind(projectRoot: string): Promise<SmokeKind> {
  const files = await collectTestFiles(projectRoot);
  let anyPlaywright = false;
  let anyReal = false;
  for (const f of files) {
    let content: string;
    try {
      content = await readFile(f, "utf-8");
    } catch {
      continue;
    }
    // Sadece gerçek Playwright testleri sayılır (içerik imzası — Vitest hariç).
    if (!/@playwright\/test/.test(content)) continue;
    anyPlaywright = true;
    if (!MYCL_MARKER_ANY.test(content.slice(0, 400))) anyReal = true;
  }
  if (!anyPlaywright) return "none";
  // Kullanıcının gerçek (MyCL imzası olmayan) Playwright testi varsa "real".
  // Yalnızca MyCL yer tutucu(lar) varsa "placeholder".
  return anyReal ? "real" : "placeholder";
}

async function assessAuthStatus(projectRoot: string): Promise<AuthStatus> {
  const authPath = join(projectRoot, ".mycl", "auth.json");
  try {
    const raw = await readFile(authPath, "utf-8");
    const cfg = JSON.parse(raw) as { username?: string; password?: string };
    const u = cfg.username ?? "";
    const p = cfg.password ?? "";
    const isPlaceholder = (v: string) =>
      v.trim() === "" || v.startsWith("<") || v === "PLACEHOLDER";
    return isPlaceholder(u) || isPlaceholder(p) ? "placeholder" : "configured";
  } catch {
    return "none";
  }
}

/**
 * Faz 16 (E2E) geçtikten sonra "gerçekte ne doğrulandı" değerlendirmesi.
 * Sıfır mutation; sadece okur. Fail-safe (hata → temkinli "real"/"none").
 */
export async function assessPhase16Verification(
  projectRoot: string,
): Promise<Phase16Verification> {
  const [smokeKind, authStatus] = await Promise.all([
    assessSmokeKind(projectRoot),
    assessAuthStatus(projectRoot),
  ]);
  return { smokeKind, authStatus };
}
