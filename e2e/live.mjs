// e2e/live.mjs — GÖRÜNÜR canlı oturum barındırıcısı.
//
// Köprü + vite (tarayıcı modu) + EKRANDA AÇILAN (headed) Chromium'u barındırır,
// MyCL'i localhost:1420'de açar, orchestrator olay akışını loglar. Süreç ayakta
// kaldıkça tarayıcı penceresi AÇIK kalır → kullanıcı izler. Ben ayrı `step.mjs`
// ile bu açık pencereye CDP (connectOverCDP :9222) ile bağlanıp adım adım
// aksiyon alırım (aç/askq/mesaj/faz).
//
// Çalıştır: node e2e/live.mjs [/proje/yolu]   (varsayılan: /Users/umitduman/adminpanel)
// CDP: http://localhost:9222   (step.mjs buradan bağlanır; e2e/artifacts/ws.txt)

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startBridge } from "../browser-bridge/server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS = path.join(__dirname, "artifacts");
const PROJECT = process.argv[2] || "/Users/umitduman/adminpanel";
const APP_URL = "http://localhost:1420";
const BRIDGE_PORT = 1799;
const CDP_PORT = 9222;
const HIGH_FREQ = new Set(["claude_stream", "history_chunk", "token_totals", "cost_phase", "cost_history"]);

fs.mkdirSync(ARTIFACTS, { recursive: true });
const eventsLog = fs.createWriteStream(path.join(ARTIFACTS, "live-events.ndjson"), { flags: "w" });

function loadChromium() {
  const req = createRequire(path.join(ROOT, "orchestrator", "package.json"));
  const pw = req("playwright");
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) throw new Error("playwright chromium export yok");
  return chromium;
}

function t() {
  return new Date().toISOString().slice(11, 19);
}
function log(s) {
  process.stdout.write(`  [${t()}] ${s}\n`);
}

function handleEvent(ev) {
  eventsLog.write(JSON.stringify({ at: Date.now(), ev }) + "\n");
  const k = ev.kind;
  switch (k) {
    case "ready": log("⚡ orchestrator ready"); break;
    case "config_status": log(`⚙ config_status: ${JSON.stringify(ev.data)}`); break;
    case "phase_changed": log(`▷ phase_changed → Faz ${ev.data?.from}→${ev.data?.to} (${ev.data?.status})`); break;
    case "phase_running": log(`▶ phase_running: ${ev.data?.label ?? ""}`); break;
    case "askq": log(`❓ ASKQ: ${String(ev.data?.question ?? "").slice(0, 140)}`); break;
    case "askq_resolved": log("✔ askq_resolved"); break;
    case "pipeline_end": log(`🏁 pipeline_end: verdict=${ev.data?.verdict} gateFailures=${JSON.stringify(ev.data?.gateFailures ?? [])}`); break;
    case "runtime_error":
    case "error": log(`💥 ${k}: ${JSON.stringify(ev.data).slice(0, 220)}`); break;
    case "chat_message":
      if (ev.data?.role !== "user") log(`💬 ${ev.data?.role}: ${String(ev.data?.text ?? "").replace(/\n/g, " ").slice(0, 150)}`);
      break;
    default: if (!HIGH_FREQ.has(k)) log(`· ${k}`);
  }
}

function startEventLogger() {
  const req = http.get(`http://localhost:${BRIDGE_PORT}/__bridge/events`, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        let msg;
        try { msg = JSON.parse(json); } catch { continue; }
        if (msg.name === "orchestrator-event" && msg.payload?.kind) handleEvent(msg.payload);
        else if (msg.name === "orchestrator-exit") log("⚠ orchestrator-exit");
      }
    });
  });
  req.on("error", (e) => log(`SSE hata: ${e.message}`));
}

function httpStatus(url) {
  return new Promise((resolve) => {
    const r = http.get(url, (res) => { res.resume(); resolve(res.statusCode || 0); });
    r.on("error", () => resolve(0));
    r.setTimeout(2000, () => { r.destroy(); resolve(0); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log(`Proje: ${PROJECT}`);
  log("Köprü başlatılıyor…");
  const bridge = startBridge();

  const viteBin = path.join(ROOT, "node_modules", ".bin", "vite");
  const vite = spawn(viteBin, [], { cwd: ROOT, env: { ...process.env, MYCL_BROWSER: "1" }, stdio: "inherit" });

  let context;
  let stopped = false;
  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    try { if (context) await context.close(); } catch { /* */ }
    try { bridge.stop(); } catch { /* */ }
    try { vite.kill("SIGTERM"); } catch { /* */ }
    try { fs.rmSync(path.join(ARTIFACTS, "ws.txt"), { force: true }); } catch { /* */ }
    eventsLog.end();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  vite.on("exit", () => cleanup());

  for (let i = 0; i < 200 && (await httpStatus(APP_URL)) !== 200; i++) await sleep(150);
  if ((await httpStatus(APP_URL)) !== 200) { log("vite ayağa kalkmadı"); await cleanup(); return; }
  log("vite hazır (:1420). Olay akışı bağlanıyor…");
  startEventLogger();

  const chromium = loadChromium();
  log("GÖRÜNÜR Chromium açılıyor (ekranda pencere)…");
  // launchPersistentContext + --remote-debugging-port → step.mjs connectOverCDP
  // ile AYNI açık sekmeyi görür (launchServer/connect context paylaşmıyordu).
  const profileDir = path.join(ARTIFACTS, "chrome-profile");
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* */ }
  context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    args: [`--remote-debugging-port=${CDP_PORT}`, "--window-size=1600,1000", "--window-position=40,40"],
  });
  fs.writeFileSync(path.join(ARTIFACTS, "ws.txt"), `http://localhost:${CDP_PORT}`);
  const page = context.pages()[0] || (await context.newPage());
  page.on("pageerror", (e) => log(`💥 PAGEERROR: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") log(`⚠ console.error: ${m.text().slice(0, 160)}`); });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.addInitScript((p) => { window.__MYCL_PICK_PATH = p; }, PROJECT);
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });

  log("");
  log("════════════════════════════════════════════════");
  log("  CANLI OTURUM HAZIR — ekranda Chromium penceresi açık.");
  log(`  MyCL: ${APP_URL}   (Splash görünüyor; proje seçimi step.mjs ile)`);
  log(`  CDP: http://localhost:${CDP_PORT}   Aksiyon: node e2e/step.mjs <komut>`);
  log("════════════════════════════════════════════════");

  await new Promise(() => {});
}

main().catch(async (e) => {
  log(`💥 live hata: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
