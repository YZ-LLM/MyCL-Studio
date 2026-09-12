// e2e/faz11-simplify.mjs — Faz 11'in stack bağımsız tabanını GERÇEK uygulamada doğrular.
//
// NEDEN AYRI BİR BETİK (smoke'a eklenmedi): smoke'un sözleşmesi "hiçbir faz/LLM tetiklenmez".
// Bu betik ise bilerek bir faz çalıştırır. Proje açılışı EDD + yaşayan doküman üretimini de
// tetiklediği için KÜÇÜK BİR LLM MALİYETİ vardır → CI'da koşmaz, elle koşulur.
//
// NE KANITLIYOR (birim testlerinin kanıtlamadığı şey): Faz 11 UI'dan tetiklenince, dilin kendi
// aracı bu projeye uygulanamasa bile stack bağımsız taban gerçekten koşuyor, ölçüyor, sonucu
// projeye yazıyor ve kullanıcıya görünüyor. Adli denetim bu boyutun cave'in 94 iterasyonunda BİR
// KEZ bile koşmadığını göstermişti; buradaki fixture tam o durumu kurar (ts-prune uygulanamaz).
//
// Çalıştır: npm run e2e:faz11
// Bağımlılık: orchestrator/node_modules'taki playwright + Chromium.

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

/**
 * Fixture: İKİ PYTHON DOSYASINDA birebir aynı 30 satırlık blok.
 * Dil bağımsızlığının kanıtı burada: ts-prune bu kopyayı göremez, taban görür.
 */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mycl-faz11-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "mycl-faz11-fixture", version: "0.0.0", private: true }, null, 2),
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const blok = Array.from({ length: 30 }, (_, i) => `    toplam_${i} = hesapla(${i}, ${i + 1})`).join("\n");
  fs.writeFileSync(path.join(dir, "src", "rapor_a.py"), `def rapor_a():\n${blok}\n`);
  fs.writeFileSync(path.join(dir, "src", "rapor_b.py"), `def rapor_b():\n${blok}\n`);
  fs.writeFileSync(path.join(dir, "src", "index.js"), "console.log('faz11 fixture');\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# MyCL Faz 11 fixture\n");
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

const auditLines = (file, filtre) => {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => filtre.test(l))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const fixture = makeFixture();
  const auditPath = path.join(fixture, ".mycl", "audit.log");

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
    rep.step("0/4 Yığını başlat (köprü + vite tarayıcı modu)");
    await waitFor(async () => (await httpStatus(BRIDGE_HEALTH)) === 200, { timeout: 30000, label: "köprü (:1799)" });
    rep.ok("köprü ayakta (:1799)");
    await waitFor(async () => (await httpStatus(APP_URL)) === 200, { timeout: 60000, label: "vite (:1420)" });
    rep.ok("vite dev server ayakta (:1420)");

    const chromium = loadChromium();
    browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await page.addInitScript((p) => {
      window.__MYCL_PICK_PATH = p;
    }, fixture);

    rep.step("1/4 Projeyi aç");
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="splash-pick-folder"]', { timeout: 20000 });
    await page.click('[data-testid="splash-pick-folder"]');
    await rep.check("proje açıldı (header render)", () =>
      page.waitForSelector('[data-testid="app-header"]', { timeout: 20000 }),
    );

    // Yabancı proje açılışı EDD koşturup Faz 1'de soru sorabilir. Soru ASILIYKEN faz çalıştırma
    // DOĞRU biçimde yok sayılır (sidebar `disabled`) — ilk yazımda tam bu yüzden hiç koşmamıştı.
    // Soru her koşuda çıkmaz (doküman damgası taze olabilir) → varlığı şart değil, temizliği şart.
    rep.step("2/4 Asılı soru varsa yanıtla (soru varken faz koşmaz)");
    await page.waitForSelector('[data-testid="askq-card"]', { timeout: 60000 }).catch(() => {});
    for (let tur = 0; tur < 3; tur++) {
      const secenekler = await page.$$('[data-testid="askq-option"]');
      if (secenekler.length === 0) break;
      const son = secenekler[secenekler.length - 1];
      const metin = ((await son.textContent()) ?? "").trim();
      await son.click();
      rep.ok(`soru yanıtlandı: "${metin.slice(0, 40)}"`);
      await sleep(6000);
    }
    await rep.check("soru kalmadı (orchestrator müsait)", () =>
      waitFor(async () => (await page.$('[data-testid="askq-card"]')) === null, {
        timeout: 90000,
        label: "askq temizlendi",
      }),
    );

    rep.step("3/4 Faz 11'i sidebar'dan çalıştır");
    await page.waitForSelector('[data-testid="phase-item-11"]', { timeout: 10000 });
    await page.dblclick('[data-testid="phase-item-11"]'); // tek tık = git, çift tık = çalıştır
    await rep.check("çalıştırma onayı soruldu", () =>
      waitFor(
        async () => /Faz 11.*çalıştırılsın mı/s.test((await page.textContent('[data-testid="chat-panel"]')) ?? ""),
        { timeout: 60000, label: "onay sorusu" },
      ),
    );
    for (const el of await page.$$('[data-testid="askq-option"]')) {
      if (/Çalıştır/.test((await el.textContent()) ?? "")) {
        await el.click();
        rep.ok("onay verildi: Çalıştır");
        break;
      }
    }
    await rep.check("Faz 11 gerçekten koştu (denetim kaydına yazdı)", () =>
      waitFor(() => auditLines(auditPath, /phase-11/).length > 0, { timeout: 120000, label: "phase-11 olayı" }),
    );

    rep.step("4/4 Stack bağımsız taban ölçtü mü");
    await rep.check("taban koştu ve GEÇTİ (ilk ölçüm → temel)", () =>
      waitFor(() => auditLines(auditPath, /simplify-agnostic-pass/).length > 0, {
        timeout: 60000,
        label: "simplify-agnostic-pass",
      }),
    );
    await rep.check("ölçüm projeye yazıldı (kopya satır > 0)", async () => {
      const b = JSON.parse(fs.readFileSync(path.join(fixture, ".mycl", "simplify-baseline.json"), "utf-8"));
      if (!(b.duplicateLines > 0)) throw new Error(`kopya satır ölçülmedi: ${JSON.stringify(b)}`);
      process.stdout.write(`      ölçüm: ${b.duplicateLines} kopya satır / ${b.totalLines} toplam satır\n`);
    });
    await rep.check("ana araç uygulanamadı ama boyut KAPSANDI sayıldı", async () => {
      const atlandi = auditLines(auditPath, /"event":"phase-11-skipped"/).length > 0;
      const kapsandi = auditLines(auditPath, /phase-11-covered-by-extras/).length > 0;
      if (atlandi && !kapsandi) throw new Error("ana tarama atlandı ama kapsama kanıtı yazılmadı");
      if (!atlandi) process.stdout.write("      not: ana araç bu ortamda koşabildi (fixture'a göre beklenmedik)\n");
    });
    await rep.check("sonuç kullanıcıya göründü (sohbette 'simplify-agnostic')", async () => {
      const t = (await page.textContent('[data-testid="chat-panel"]')) ?? "";
      if (!t.includes("simplify-agnostic")) throw new Error("sohbette taramanın sonucu yok");
    });

    const shot = path.join(ARTIFACTS, "faz11.png");
    await page.screenshot({ path: shot });
    rep.ok(`ekran görüntüsü: e2e/artifacts/faz11.png`);
    await rep.check("sayfa içi hata yok", async () => {
      if (pageErrors.length) throw new Error(pageErrors.join(" | "));
    });

    process.stdout.write("\n  Faz 11 denetim satırları:\n");
    for (const j of auditLines(auditPath, /phase-11|simplify/)) {
      process.stdout.write(`    ${j.event}  ${(j.detail ?? "").slice(0, 110)}\n`);
    }
  } finally {
    cleanup();
  }
  process.exit(rep.summary() ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`\n💥 ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
