// e2e/auto-answer-loop.mjs — ÇALIŞAN canlı oturuma (live.mjs) CDP ile bağlanıp parked askq'leri
// otomatik "önerilen"le tıklar + Faz 6 UI-inceleme parkını "tamam" ile onaylar. Köprü modunda
// frontend'in oto-cevap senkronu güvenilmez (_enabled backend'de false kalıyor) → bu sürücü o
// boşluğu kapatır: kullanıcı/ben hiçbir soruda beklemez. Pipeline_end'e kadar koşar.
//
// Çalıştır: node e2e/auto-answer-loop.mjs   (live.mjs zaten açık olmalı → ws.txt)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

// Server-side oto-cevap flag'ini AÇIK TUT — köprü frontend-senkronu güvenilmez (_enabled false kalıyor);
// bu olmadan mahkeme (autoResolve=true gerektirir) gate-fail'lerde tetiklenmez. Her turda tazele.
function keepAutoAnswer() {
  const body = JSON.stringify({
    cmd: "send_to_orchestrator",
    args: { message: { kind: "set_auto_answer", data: { enabled: true } } },
  });
  const req = http.request(
    "http://localhost:1799/__bridge/invoke",
    { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
    (r) => r.resume(),
  );
  req.on("error", () => {});
  req.write(body);
  req.end();
}

// Faz 6 UI-inceleme parkı composer-driven (oto-cevap GEÇMEZ → kullanıcı sürer). Header'dan yakalamak
// güvenilmez; bunun yerine bridge user_message ile "tamam" yolla (kullanıcı izni var → onayla).
function sendUserMessage(text) {
  const body = JSON.stringify({
    cmd: "send_to_orchestrator",
    args: { message: { kind: "user_message", data: { text } } },
  });
  const req = http.request(
    "http://localhost:1799/__bridge/invoke",
    { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
    (r) => r.resume(),
  );
  req.on("error", () => {});
  req.write(body);
  req.end();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WS_FILE = path.join(__dirname, "artifacts", "ws.txt");
if (!fs.existsSync(WS_FILE)) {
  console.error("ws.txt yok — önce live.mjs çalışmalı.");
  process.exit(2);
}
const ws = fs.readFileSync(WS_FILE, "utf8").trim();
const chromium = createRequire(path.join(ROOT, "orchestrator", "package.json"))("playwright").chromium;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = () => new Date().toISOString().slice(11, 19);
const log = (s) => process.stdout.write(`[${t()}] ${s}\n`);

const browser = await chromium.connectOverCDP(ws);
function findPage() {
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
    try { if (p.url().includes("localhost:1420")) return p; } catch { /* */ }
  }
  return null;
}

let answered = 0;
let lastTamamAt = 0;
let lastHeader = "";
log("auto-answer-loop bağlandı — parked soruları otomatik sürüyor (önerilen + Faz 6 onay).");

while (true) {
  try {
    keepAutoAnswer(); // server-side flag'i açık tut (mahkeme tetiklensin + sorular oto-resolve olsun)
    const page = findPage();
    if (!page) { await sleep(3000); continue; }
    const st = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
      const header = txt(q('[data-testid="phase-indicator"]'));
      const card = q('[data-testid="askq-card"]');
      let askq = null;
      if (card) {
        const sug = card.querySelector(".askq-option-suggested");
        const opts = [...card.querySelectorAll('[data-testid="askq-option"]')];
        askq = { hasSug: !!sug, label: txt(sug || opts[0]) };
      }
      const msgs = [...document.querySelectorAll(".chat-messages .msg")];
      const lastChat = msgs.length ? txt(msgs[msgs.length - 1]) : "";
      return { header, askq, lastChat };
    });
    if (st.header && st.header !== lastHeader) { log(`faz: ${st.header}`); lastHeader = st.header; }

    if (st.askq) {
      const sel = st.askq.hasSug ? ".askq-option-suggested" : '[data-testid="askq-option"]';
      await page.click(`[data-testid="askq-card"] ${sel}`, { timeout: 4000 }).catch(() => {});
      answered++;
      log(`askq #${answered} cevaplandı → "${st.askq.label}"`);
      await sleep(1500);
    } else if (/Beğendiysen|UI İncelemesi|inceledikten sonra/i.test(st.lastChat) && Date.now() - lastTamamAt > 60000) {
      // Faz 6 UI-inceleme parkı — son sohbet mesajı inceleme istemi → bridge user_message ile onayla.
      sendUserMessage("tamam");
      lastTamamAt = Date.now();
      log("Faz 6 onaylandı (bridge user_message: tamam).");
    }
  } catch (e) {
    log(`döngü hatası (yut): ${e instanceof Error ? e.message : String(e)}`);
  }
  await sleep(4000);
}
