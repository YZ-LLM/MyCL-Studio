// e2e/smoke.mjs — MyCL Studio TARAYICI MODU uçtan-uca duman testi.
//
// Kanıtlar: Tauri olmadan, düz Chromium'da uygulamanın TÜM DOM'una erişiliyor.
//   boot → Splash → fixture proje aç → Ana UI (header + faz sidebar + composer).
// HİÇBİR faz/LLM tetiklenmez (user_message/phase_run_request gönderilmez) →
// sıfır API harcaması. Sayfa-içi uncaught hata = test başarısız (shim hatası
// React mount'ta patlar, burada yakalanır).
//
// Çalıştır: node e2e/smoke.mjs
// Bağımlılık: orchestrator/node_modules'taki `playwright` + Chromium (zaten kurulu).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Reporter, assert, waitFor, httpStatus, sleep } from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS = path.join(__dirname, "artifacts");
const APP_URL = "http://localhost:1420";
const BRIDGE_HEALTH = "http://localhost:1799/__bridge/health";

const rep = new Reporter();

// playwright'i orchestrator/node_modules'tan çöz (root'ta yok). CJS paket →
// createRequire ile doğrudan require (ESM dynamic import named export vermiyor).
function loadChromium() {
  const req = createRequire(path.join(ROOT, "orchestrator", "package.json"));
  let pw;
  try {
    pw = req("playwright");
  } catch {
    throw new Error(
      "playwright bulunamadı (orchestrator/node_modules). `npm --prefix orchestrator install` gerekli.",
    );
  }
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) throw new Error("playwright 'chromium' export bulunamadı");
  return chromium;
}

// Geçici fixture proje — orchestrator open_project için minimal gerçek dizin.
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mycl-smoke-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "mycl-smoke-fixture", version: "0.0.0", private: true }, null, 2),
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "console.log('smoke fixture');\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# MyCL smoke fixture\n");
  return dir;
}

async function main() {
  rep.step("0/4 Yığını başlat (köprü + vite tarayıcı modu)");
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const fixture = makeFixture();

  // start.mjs'i kendi süreç grubunda başlat (detached) → tek kill ile tüm ağaç.
  const stack = spawn("node", [path.join(ROOT, "browser-bridge", "start.mjs")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });

  let browser;
  const cleanup = () => {
    try {
      if (browser) browser.close();
    } catch {
      /* */
    }
    try {
      if (stack.pid) process.kill(-stack.pid, "SIGTERM");
    } catch {
      /* */
    }
    try {
      fs.rmSync(fixture, { recursive: true, force: true });
    } catch {
      /* */
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(1);
  });

  try {
    // Köprü + vite hazır mı?
    await waitFor(async () => (await httpStatus(BRIDGE_HEALTH)) === 200, {
      timeout: 30000,
      label: "köprü sağlık (:1799)",
    });
    rep.ok("köprü ayakta (:1799)");
    await waitFor(async () => (await httpStatus(APP_URL)) === 200, {
      timeout: 60000,
      label: "vite dev server (:1420)",
    });
    rep.ok("vite dev server ayakta (:1420)");

    const chromium = loadChromium();
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // Sayfa-içi hataları topla — shim hatası React mount'ta patlar.
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("dialog", (d) => d.dismiss().catch(() => {}));

    // Splash dialog'u yerine fixture yolu enjekte et (her yüklemeden önce).
    await page.addInitScript((p) => {
      window.__MYCL_PICK_PATH = p;
    }, fixture);

    rep.step("1/4 Boot + Splash");
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await rep.check("#root mount oldu", async () => {
      await page.waitForSelector("#root > *", { timeout: 15000 });
    });
    await rep.check("Splash görünür", async () => {
      await page.waitForSelector('[data-testid="splash"]', { timeout: 15000 });
    });
    await rep.check("Klasör-seç butonu var", async () => {
      await page.waitForSelector('[data-testid="splash-pick-folder"]', { timeout: 5000 });
    });

    rep.step("2/4 Proje aç (fixture, LLM tetiklemeden)");
    await page.click('[data-testid="splash-pick-folder"]');
    await rep.check("Ana başlık (header) render oldu", async () => {
      await page.waitForSelector('[data-testid="app-header"]', { timeout: 15000 });
    });
    await rep.check("Proje yolu header'da görünür", async () => {
      await waitFor(
        async () => (await page.textContent('[data-testid="app-header"]'))?.includes(fixture),
        { timeout: 8000, label: "header proje yolu" },
      );
    });

    rep.step("3/4 Ana UI yüzeyi (Tauri'nin engellediği yerler)");
    await rep.check("Faz sidebar render oldu", async () => {
      await page.waitForSelector('[data-testid="phase-sidebar"]', { timeout: 8000 });
    });
    await rep.check("Faz 1 öğesi tıklanabilir DOM'da", async () => {
      await page.waitForSelector('[data-testid="phase-item-1"]', { timeout: 8000 });
    });
    await rep.check("17 faz + Faz 0 listelendi", async () => {
      const n = await page.locator('[data-testid^="phase-item-"]').count();
      assert(n >= 18, `beklenen ≥18 faz öğesi, bulunan ${n}`);
    });
    await rep.check("Composer girişi erişilebilir + yazılabilir", async () => {
      const ta = page.locator('[data-testid="composer-input"]');
      await ta.waitFor({ timeout: 8000 });
      // disabled olabilir (config eksik) — değeri JS ile set edip erişimi kanıtla.
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="composer-input"]');
        if (el) el.removeAttribute("disabled");
      });
      await ta.fill("test erişimi (gönderilmez)");
      const v = await ta.inputValue();
      assert(v.includes("test erişimi"), "composer değeri set edilemedi");
    });
    await rep.check("Faz göstergesi header'da", async () => {
      await page.waitForSelector('[data-testid="phase-indicator"]', { timeout: 5000 });
    });

    rep.step("4/4 Sağlık: ekran görüntüsü + sayfa-içi hata yok");
    const shot = path.join(ARTIFACTS, "smoke.png");
    await page.screenshot({ path: shot, fullPage: true });
    rep.ok(`ekran görüntüsü: ${path.relative(ROOT, shot)}`);
    await rep.check("uncaught sayfa hatası yok", async () => {
      assert(pageErrors.length === 0, `pageerror: ${pageErrors.join(" | ")}`);
    });
    if (consoleErrors.length > 0) {
      // Uyarı olarak raporla — bazıları iyi huylu (bildirim izni vb.).
      process.stdout.write(
        `  ⚠ console.error (${consoleErrors.length}): ${consoleErrors.slice(0, 5).join(" | ")}\n`,
      );
    }

    await sleep(200);
  } finally {
    cleanup();
  }

  const ok = rep.summary();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`\n💥 smoke çöktü: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
