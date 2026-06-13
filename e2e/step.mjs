// e2e/step.mjs — canlı (açık) tarayıcıya bağlan, TEK aksiyon al, durumu raporla.
// live.mjs'in açtığı görünür pencereye CDP ile bağlanır; tarayıcıyı KAPATMAZ
// (sadece bağlantıyı bırakır → pencere açık kalır).
//
// Kullanım:
//   node e2e/step.mjs status                 # durum + ekran görüntüsü
//   node e2e/step.mjs open                    # Splash → adminpanel'i seç (proje aç)
//   node e2e/step.mjs send "metin..."         # composer'a yaz + gönder
//   node e2e/step.mjs answer [suggested|N]    # bekleyen askq'yi yanıtla (öneri / N. seçenek)
//   node e2e/step.mjs phase 8                  # Faz 8'i çalıştır (sidebar tık)
//   node e2e/step.mjs click <data-testid>     # genel tıklama
//   node e2e/step.mjs shot                     # sadece ekran görüntüsü

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS = path.join(__dirname, "artifacts");
const WS_FILE = path.join(ARTIFACTS, "ws.txt");

function loadChromium() {
  const req = createRequire(path.join(ROOT, "orchestrator", "package.json"));
  const pw = req("playwright");
  return pw.chromium ?? pw.default?.chromium;
}

function out(s) {
  process.stdout.write(s + "\n");
}

async function findPage(browser) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      try {
        if (p.url().includes("localhost:1420")) return p;
      } catch { /* */ }
    }
  }
  // fallback: ilk sayfa
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) return p;
  return null;
}

async function reportState(page) {
  const state = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    const header = txt(q('[data-testid="phase-indicator"]'));
    const projectPath = txt(q(".app-project-path"));
    const splash = !!q('[data-testid="splash"]');
    const askqCard = q('[data-testid="askq-card"]');
    let askq = null;
    if (askqCard) {
      const question = txt(askqCard.querySelector(".askq-question"));
      const opts = Array.from(askqCard.querySelectorAll('[data-testid="askq-option"]')).map((b) => b.textContent.replace(/\s+/g, " ").trim());
      const suggested = txt(askqCard.querySelector(".askq-option-suggested"));
      askq = { question, opts, suggested };
    }
    const banner = txt(q('[data-testid="running-banner"]'));
    const msgs = Array.from(document.querySelectorAll(".chat-messages .msg")).slice(-6).map((m) => {
      const role = (m.className.match(/\b(user|assistant|system|error)\b/) || [])[1] || "?";
      return `[${role}] ${m.textContent.replace(/\s+/g, " ").trim().slice(0, 200)}`;
    });
    return { splash, header, projectPath, askq, banner, msgs };
  });

  out("── DURUM ──");
  if (state.splash) out("  Ekran: SPLASH (proje seçilmedi)");
  else {
    out(`  Faz göstergesi: ${state.header}`);
    out(`  Proje: ${state.projectPath}`);
  }
  if (state.banner) out(`  ⏳ Çalışıyor: ${state.banner}`);
  if (state.askq) {
    out(`  ❓ BEKLEYEN ASKQ: ${state.askq.question}`);
    state.askq.opts.forEach((o, i) => out(`       [${i}] ${o}${o === state.askq.suggested ? "  ⟵ öneri" : ""}`));
  }
  if (state.msgs.length) {
    out("  Son mesajlar:");
    for (const m of state.msgs) out(`     ${m}`);
  }
  const shot = path.join(ARTIFACTS, "step.png");
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  out(`  📸 ${path.relative(ROOT, shot)}`);
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!fs.existsSync(WS_FILE)) {
    out("HATA: ws.txt yok — önce `node e2e/live.mjs` çalışıyor olmalı.");
    process.exit(2);
  }
  const ws = fs.readFileSync(WS_FILE, "utf8").trim();
  const chromium = loadChromium();
  const browser = await chromium.connectOverCDP(ws);
  const page = await findPage(browser);
  if (!page) {
    out("HATA: MyCL sayfası bulunamadı (localhost:1420).");
    process.exit(2);
  }

  try {
    switch (action) {
      case "open": {
        out("→ Splash'ta 'Yeni Klasör Seç' tıklanıyor (adminpanel enjekte)…");
        await page.click('[data-testid="splash-pick-folder"]', { timeout: 8000 });
        await page.waitForSelector('[data-testid="app-header"]', { timeout: 20000 });
        await page.waitForTimeout(1500);
        out("✅ Proje açıldı.");
        break;
      }
      case "send": {
        const text = args.join(" ");
        if (!text) { out("HATA: gönderilecek metin yok."); break; }
        out(`→ Composer'a yazılıyor + gönderiliyor: "${text}"`);
        const ta = page.locator('[data-testid="composer-input"]');
        await ta.waitFor({ timeout: 8000 });
        await ta.fill(text);
        await ta.press("Enter");
        await page.waitForTimeout(1200);
        out("✅ Gönderildi.");
        break;
      }
      case "answer": {
        const card = page.locator('[data-testid="askq-card"]').first();
        if ((await card.count()) === 0) { out("Bekleyen askq yok."); break; }
        const which = args[0] || "suggested";
        let target;
        if (which === "suggested") {
          const sug = card.locator(".askq-option-suggested").first();
          target = (await sug.count()) > 0 ? sug : card.locator('[data-testid="askq-option"]').first();
        } else {
          target = card.locator('[data-testid="askq-option"]').nth(Number(which) || 0);
        }
        const label = (await target.textContent().catch(() => "?")) || "?";
        out(`→ askq yanıtlanıyor → "${label.trim()}"`);
        await target.click({ timeout: 6000 });
        await page.waitForTimeout(1200);
        out("✅ Yanıtlandı.");
        break;
      }
      case "phase": {
        const n = args[0];
        out(`→ Faz ${n} çalıştırılıyor (sidebar tık)…`);
        await page.click(`[data-testid="phase-item-${n}"]`, { timeout: 6000 });
        await page.waitForTimeout(1200);
        out("✅ Tıklandı.");
        break;
      }
      case "click": {
        const id = args[0];
        out(`→ [data-testid="${id}"] tıklanıyor…`);
        await page.click(`[data-testid="${id}"]`, { timeout: 6000 });
        await page.waitForTimeout(800);
        out("✅ Tıklandı.");
        break;
      }
      case "autoanswer": {
        const want = (args[0] ?? "on") !== "off";
        const cb = page.locator('[data-testid="auto-answer-toggle"]');
        await cb.waitFor({ timeout: 6000 });
        const checked = await cb.isChecked();
        if (checked !== want) {
          await cb.click();
          out(`→ oto-cevap ${want ? "AÇILDI" : "KAPATILDI"}`);
        } else {
          out(`oto-cevap zaten ${want ? "açık" : "kapalı"}`);
        }
        break;
      }
      case "shot":
      case "status":
      case undefined:
        break;
      default:
        out(`Bilinmeyen aksiyon: ${action}`);
    }

    await reportState(page);
  } finally {
    // Tarayıcıyı KAPATMA — sadece bu istemci bağlantısını bırak (pencere açık kalsın).
    process.exit(0);
  }
}

main().catch((e) => {
  out(`💥 step hata: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
