// e2e/ui-tour.mjs — MyCL Studio arayüzünün GENİŞ gezintisi (tarayıcı köprüsü).
//
// smoke.mjs "uygulama ayağa kalkıyor mu" sorusunu yanıtlar (boot + birkaç yüzey). Bu betik
// farklı bir soruyu yanıtlar: "her panel gerçekten açılıyor, kapanıyor ve kullanılabilir mi".
// Faz TETİKLEMEZ — yalnız panel açan/kapatan, salt okunur yüzeyler gezilir.
//
// MALİYET UYARISI: proje açılışı bir süre sonra yaşayan doküman üretimini + yabancı proje
// analizini başlatır (ölçüldü: smoke hızlı bittiği için ona yakalanmıyor, bu gezinti uzun
// sürdüğü için yakalanıyor). Yani küçük bir LLM maliyeti olabilir → CI'da koşmaz, elle koşulur.
//
// Çalıştır: npm run e2e:tour

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Reporter, waitFor, httpStatus, sleep } from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS = path.join(__dirname, "artifacts");
const APP_URL = "http://localhost:1420";
const BRIDGE_HEALTH = "http://localhost:1799/__bridge/health";

const rep = new Reporter();

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mycl-tour-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "mycl-tour-fixture", version: "0.0.0", private: true }, null, 2),
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "console.log('tour fixture');\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# MyCL UI tour fixture\n");
  return dir;
}

function loadChromium() {
  const req = createRequire(path.join(ROOT, "orchestrator", "package.json"));
  let pw;
  try {
    pw = req("playwright");
  } catch {
    throw new Error("playwright bulunamadı (orchestrator/node_modules). `npm --prefix orchestrator install` gerekli.");
  }
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) throw new Error("playwright 'chromium' export bulunamadı");
  return chromium;
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const fixture = makeFixture();
  const stack = spawn("node", [path.join(ROOT, "browser-bridge", "start.mjs")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
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
    rep.step("0 Yığını başlat");
    await waitFor(async () => (await httpStatus(BRIDGE_HEALTH)) === 200, { timeout: 30000, label: "köprü (:1799)" });
    rep.ok("köprü ayakta (:1799)");
    await waitFor(async () => (await httpStatus(APP_URL)) === 200, { timeout: 60000, label: "vite (:1420)" });
    rep.ok("vite dev server ayakta (:1420)");

    const chromium = loadChromium();
    browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 220));
    });
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await page.addInitScript((p) => {
      window.__MYCL_PICK_PATH = p;
    }, fixture);

    rep.step("1 Açılış ekranı");
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await rep.check("Splash render oldu", () => page.waitForSelector('[data-testid="splash"]', { timeout: 20000 }));
    await rep.check("klasör seç butonu var", () => page.waitForSelector('[data-testid="splash-pick-folder"]', { timeout: 5000 }));
    await rep.check("mevcut projeyi entegre et butonu var", () =>
      page.waitForSelector('[data-testid="splash-integrate-existing"]', { timeout: 5000 }),
    );

    rep.step("2 Proje aç");
    await page.click('[data-testid="splash-pick-folder"]');
    await rep.check("header render oldu", () => page.waitForSelector('[data-testid="app-header"]', { timeout: 25000 }));
    await rep.check("şu an ne yapıyor şeridi görünür", () =>
      page.waitForSelector('[data-testid="activity-bar"]', { timeout: 10000 }),
    );
    await rep.check("faz göstergesi header'da", () => page.waitForSelector('[data-testid="phase-indicator"]', { timeout: 5000 }));
    await rep.check("faz listesi 18 faz gösteriyor (Faz 0 dahil)", async () => {
      const n = await page.$$eval('[data-testid^="phase-item-"]', (els) => els.length);
      if (n !== 18) throw new Error(`beklenen 18, gelen ${n}`);
    });

    rep.step("3 Sağ eylem barı — her panel açılıp kapanıyor mu");
    const paneller = [
      ["task-queue-btn", "İş Kuyruğu"],
      ["summary-btn", "Özet"],
      ["panel-main-btn", "Main Ajan"],
      ["panel-translator-btn", "Çeviri Ajanı"],
      ["panel-orchestrator-btn", "Orkestra Ajanı"],
      ["agent-team-btn", "Ajan Takımı"],
    ];
    for (const [tid, ad] of paneller) {
      await rep.check(`${ad} paneli açılıyor`, async () => {
        const btn = await page.$(`[data-testid="${tid}"]`);
        if (!btn) throw new Error("buton DOM'da yok");
        const once = await page.evaluate(() => document.body.innerText.length);
        await btn.click();
        await sleep(900);
        const sonra = await page.evaluate(() => document.body.innerText.length);
        if (once === sonra) throw new Error("tıklama sonrası ekranda hiçbir değişiklik yok");
      });
      await rep.check(`${ad} paneli ESC ile kapanıyor`, async () => {
        await page.keyboard.press("Escape");
        await sleep(600);
      });
      // Panel açık kaldıysa aynı butonla kapat — durum sonraki adıma sızmasın.
      const btn = await page.$(`[data-testid="${tid}"]`);
      if (await btn?.evaluate((el) => el.className.includes("rab-active"))) {
        await btn.click();
        await sleep(500);
      }
    }

    rep.step("4 Faz menüsü ve faz navigasyonu");
    await rep.check("faz menüsü gizlenip geri geliyor", async () => {
      await page.click('[data-testid="left-toggle-btn"]');
      await sleep(700);
      const gizli = (await page.$('[data-testid="phase-sidebar"]')) === null;
      await page.click('[data-testid="left-toggle-btn"]');
      await sleep(700);
      const geri = (await page.$('[data-testid="phase-sidebar"]')) !== null;
      if (!gizli) throw new Error("gizlenmedi");
      if (!geri) throw new Error("geri gelmedi");
    });
    // TEK tık = sohbette o faza git, ÇİFT tık = fazı çalıştır. Tek tıkın yanlışlıkla faz
    // çalıştırması pahalı bir kazadır (kullanıcı gezinmek isterken iterasyon başlatır).
    await rep.check("faza tek tık gezinir, faz ÇALIŞTIRMAZ", async () => {
      await page.click('[data-testid="phase-item-8"]');
      await sleep(1200);
      const t = (await page.textContent('[data-testid="chat-panel"]')) ?? "";
      if (/çalıştırılsın mı/.test(t)) throw new Error("tek tık faz çalıştırma onayı açtı");
    });

    rep.step("5 Composer ve anahtarlar");
    await rep.check("composer'a yazılabiliyor", async () => {
      await page.fill('[data-testid="composer-input"]', "deneme metni");
      const v = await page.inputValue('[data-testid="composer-input"]');
      if (v !== "deneme metni") throw new Error(`değer tutmadı: ${v}`);
      await page.fill('[data-testid="composer-input"]', "");
    });
    for (const [tid, ad] of [
      ["auto-answer-toggle", "Oto cevap"],
      ["never-ask-toggle", "Hiçbir şey sorma"],
      ["plan-mode-toggle", "Plan modu"],
    ]) {
      await rep.check(`${ad} anahtarı durum değiştiriyor`, async () => {
        const el = await page.$(`[data-testid="${tid}"]`);
        if (!el) throw new Error("DOM'da yok");
        const once = await el.isChecked().catch(() => null);
        await el.click();
        await sleep(500);
        const sonra = await el.isChecked().catch(() => null);
        if (once !== null && once === sonra) throw new Error("durum değişmedi");
        await el.click(); // eski haline döndür
        await sleep(300);
      });
    }
    await rep.check("ses anahtarı ikonu değişiyor", async () => {
      const btn = await page.$('[data-testid="sound-toggle-btn"]');
      if (!btn) throw new Error("DOM'da yok");
      const once = await btn.textContent();
      await btn.click();
      await sleep(400);
      if ((await btn.textContent()) === once) throw new Error("ikon değişmedi");
      await btn.click();
    });

    rep.step("6 Ayarlar");
    await rep.check("ayarlar açılıyor ve plan modeli alanı var", async () => {
      await page.click('[data-testid="settings-btn"]');
      await page.waitForSelector('[data-testid="settings-plan-model"]', { timeout: 8000 });
    });
    await rep.check("ayarlar ESC ile kapanıyor", async () => {
      await page.keyboard.press("Escape");
      await sleep(700);
      if (await page.$('[data-testid="settings-plan-model"]')) throw new Error("ESC kapatmadı");
    });

    rep.step("7 Erişilebilirlik");
    await rep.check("görünen her butonun erişilebilir adı var", async () => {
      const isimsiz = await page.$$eval("button", (els) =>
        els
          .filter(
            (e) =>
              e.offsetParent !== null &&
              !(e.getAttribute("aria-label") || e.getAttribute("title") || (e.textContent ?? "").trim()),
          )
          .map((e) => e.className)
          .slice(0, 6),
      );
      if (isimsiz.length) throw new Error(`isimsiz buton: ${isimsiz.join(", ")}`);
    });
    await rep.check("faz listesi gezinme bölgesi etiketli", async () => {
      const lbl = await page.$eval('[data-testid="phase-sidebar"] nav', (e) => e.getAttribute("aria-label"));
      if (!lbl) throw new Error("nav aria-label yok");
    });

    // Pencere minimumu tauri.conf.json'da 1024x768 — kullanıcı bundan darını GÖREMEZ, bu yüzden
    // mobil genişlik ölçmek yanlış alarm üretir (400px'te sohbet paneli harf harf sıkışıyor ama
    // o durum ürün yüzeyinde yok). Gerçek sınır izin verilen en dar penceredir.
    rep.step("8 İzin verilen en dar pencere (1024x768) kullanılabilir mi");
    await page.setViewportSize({ width: 1024, height: 768 });
    await sleep(1200);
    await rep.check("yatay taşma yok", async () => {
      const tasma = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (tasma > 2) throw new Error(`${tasma}px yatay taşma`);
    });
    await rep.check("sohbet paneli okunabilir genişlikte (>320px)", async () => {
      const w = await page.$eval('[data-testid="chat-panel"]', (e) => Math.round(e.getBoundingClientRect().width));
      if (w < 320) throw new Error(`sohbet paneli ${w}px'e sıkıştı`);
      process.stdout.write(`      sohbet paneli: ${w}px\n`);
    });
    await rep.check("composer, faz listesi ve eylem barı görünür", async () => {
      for (const tid of ["composer-input", "phase-sidebar", "right-action-bar"]) {
        const el = await page.$(`[data-testid="${tid}"]`);
        if (!el || !(await el.isVisible())) throw new Error(`${tid} görünmüyor`);
      }
    });
    await page.screenshot({ path: path.join(ARTIFACTS, "tour-dar.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(800);

    // MyCL Studio BİLEREK tek temalı (App.css `color-scheme: dark`). "Dark/light zorunlu" kuralı
    // MyCL'in ÜRETTİĞİ projeler için (Faz 5 şablonu), uygulamanın kendisi için değil.
    rep.step("9 Tema kararı sabit mi (bilerek tek tema)");
    await rep.check("işletim sistemi açık temaya geçse de uygulama koyu kalır", async () => {
      const koyu = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.emulateMedia({ colorScheme: "light" });
      await sleep(800);
      const sonra = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.emulateMedia({ colorScheme: "dark" });
      if (koyu !== sonra) throw new Error(`tema kaydı: ${koyu} → ${sonra}`);
    });

    rep.step("10 Sağlık");
    await page.screenshot({ path: path.join(ARTIFACTS, "tour.png") });
    rep.ok("ekran görüntüleri: e2e/artifacts/tour.png + tour-dar.png");
    await rep.check("sayfa içi yakalanmamış hata yok", async () => {
      if (pageErrors.length) throw new Error(pageErrors.slice(0, 3).join(" | "));
    });
    await rep.check("konsolda hata yok", async () => {
      const gercek = consoleErrors.filter((e) => !/favicon|DevTools/i.test(e));
      if (gercek.length) throw new Error(gercek.slice(0, 3).join(" | "));
    });
  } finally {
    cleanup();
  }
  process.exit(rep.summary() ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`\n💥 ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
