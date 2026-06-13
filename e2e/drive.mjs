// e2e/drive.mjs — MyCL Studio'yu GERÇEK bir proje üzerinde tarayıcıda otonom sür.
//
// Amaç: adminpanel'i (dış test hedefi) tarayıcıda aç, kaldığı yerden GERÇEK
// claude ile devam ettir; askq'leri UI'dan yanıtla (mimik kullanıcı), tüm olay
// akışını + ekran görüntülerini logla, MyCL hatalarını (uncaught / runtime_error
// / takılma) yüzeye çıkar. adminpanel SADECE iş yükü — geliştirilmez/commit'lenmez.
//
// Çalıştır: node e2e/drive.mjs [/proje/yolu]
// Loglar: e2e/artifacts/drive-events.ndjson, drive-state.json, drive-*.png

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS = path.join(__dirname, "artifacts");
const PROJECT = process.argv[2] || process.env.MYCL_TEST_PROJECT || "";
if (!PROJECT) {
  console.error("Kullanım: node e2e/drive.mjs <proje-yolu>  (veya MYCL_TEST_PROJECT env)");
  process.exit(1);
}
const BRIDGE_PORT = 1799;
const APP_URL = "http://localhost:1420";

// Sınırlar — sonsuz/saatlerce koşmasın.
const WALL_CLOCK_MS = 25 * 60 * 1000; // 25 dk toplam
const IDLE_STOP_MS = 200 * 1000; // 200s olaysız + koşmuyor → dur
const MAX_ASKQ = 40;
const NUDGE_AFTER_MS = 35 * 1000; // açılıştan sonra bu kadar sessizlikte "devam" dürt

const HIGH_FREQ = new Set(["claude_stream", "history_chunk", "agent_event", "token_totals", "cost_phase", "cost_history"]);

fs.mkdirSync(ARTIFACTS, { recursive: true });
const eventsLog = fs.createWriteStream(path.join(ARTIFACTS, "drive-events.ndjson"), { flags: "w" });

function loadChromium() {
  const req = createRequire(path.join(ROOT, "orchestrator", "package.json"));
  const pw = req("playwright");
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) throw new Error("playwright chromium export yok");
  return chromium;
}

// ── Paylaşılan durum (Node SSE tüketicisinden beslenir) ──
const state = {
  ready: false,
  phase: null,
  status: null,
  configStatus: null,
  pendingAskq: null, // {id, question}
  lastEventAt: Date.now(),
  running: false,
  pipelineEnded: null, // {verdict, gateFailures}
  counts: {},
  errors: [], // {kind, text, ts}
  startedAt: Date.now(),
};

function logLine(s) {
  const t = new Date(state.startedAt + (Date.now() - state.startedAt)).toISOString().slice(11, 19);
  process.stdout.write(`  [${t}] ${s}\n`);
}

function handleEvent(ev) {
  state.lastEventAt = Date.now();
  const k = ev.kind;
  state.counts[k] = (state.counts[k] || 0) + 1;
  eventsLog.write(JSON.stringify({ t: Date.now(), ev }) + "\n");

  switch (k) {
    case "ready":
      state.ready = true;
      logLine("⚡ orchestrator ready");
      break;
    case "config_status":
      state.configStatus = ev.data;
      logLine(`⚙ config_status: ${JSON.stringify(ev.data)}`);
      break;
    case "phase_changed":
      state.phase = ev.data?.to ?? state.phase;
      state.status = ev.data?.status ?? state.status;
      state.running = ev.data?.status === "running";
      logLine(`▷ phase_changed → Faz ${ev.data?.from}→${ev.data?.to} (${ev.data?.status})`);
      break;
    case "phase_running":
      state.running = true;
      logLine(`▶ phase_running: ${ev.data?.label ?? ""}`);
      break;
    case "phase_idle":
      state.running = false;
      break;
    case "askq":
      state.pendingAskq = { id: ev.data?.id, question: ev.data?.question };
      logLine(`❓ ASKQ: ${String(ev.data?.question ?? "").slice(0, 120)}`);
      break;
    case "askq_resolved":
      state.pendingAskq = null;
      break;
    case "pipeline_end":
      state.pipelineEnded = ev.data;
      state.running = false;
      logLine(`🏁 pipeline_end: verdict=${ev.data?.verdict} gateFailures=${JSON.stringify(ev.data?.gateFailures ?? [])}`);
      break;
    case "runtime_error":
    case "error":
      state.errors.push({ kind: k, text: JSON.stringify(ev.data), ts: Date.now() });
      logLine(`💥 ${k}: ${JSON.stringify(ev.data).slice(0, 200)}`);
      break;
    case "chat_message":
      if (ev.data?.role === "system" || ev.data?.role === "assistant") {
        logLine(`💬 ${ev.data.role}: ${String(ev.data.text ?? "").replace(/\n/g, " ").slice(0, 140)}`);
      }
      break;
    default:
      if (!HIGH_FREQ.has(k)) logLine(`· ${k}`);
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
        try {
          msg = JSON.parse(json);
        } catch {
          continue;
        }
        if (msg.name === "orchestrator-event" && msg.payload && msg.payload.kind) {
          handleEvent(msg.payload);
        } else if (msg.name === "orchestrator-exit") {
          logLine("⚠ orchestrator-exit (süreç durdu)");
        }
      }
    });
    res.on("end", () => logLine("SSE bağlantısı kapandı"));
  });
  req.on("error", (e) => logLine(`SSE hata: ${e.message}`));
}

function httpStatus(url) {
  return new Promise((resolve) => {
    const r = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    r.on("error", () => resolve(0));
    r.setTimeout(2000, () => {
      r.destroy();
      resolve(0);
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 60000, interval = 300, label = "koşul" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(interval);
  }
  throw new Error(`zaman aşımı: ${label}`);
}

// Köprü üzerinden doğrudan komut (resume nudge için — UI disabled olsa da çalışır).
function sendCommand(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ cmd: "send_to_orchestrator", args: { message } });
    const r = http.request(
      { hostname: "localhost", port: BRIDGE_PORT, path: "/__bridge/invoke", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    r.on("error", reject);
    r.write(body);
    r.end();
  });
}

function snapshotState(extra = {}) {
  fs.writeFileSync(
    path.join(ARTIFACTS, "drive-state.json"),
    JSON.stringify({ ...state, ...extra, project: PROJECT, now: Date.now() }, null, 2),
  );
}

async function main() {
  logLine(`Proje: ${PROJECT}`);
  logLine("Yığın başlatılıyor (köprü + vite tarayıcı modu)…");
  const stack = spawn("node", [path.join(ROOT, "browser-bridge", "start.mjs")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });

  let browser;
  let stopped = false;
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    snapshotState({ endReason: state.pipelineEnded ? "pipeline_end" : "stopped" });
    try {
      if (browser) browser.close();
    } catch { /* */ }
    try {
      if (stack.pid) process.kill(-stack.pid, "SIGTERM");
    } catch { /* */ }
    eventsLog.end();
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(1);
  });

  try {
    await waitFor(async () => (await httpStatus(`http://localhost:${BRIDGE_PORT}/__bridge/health`)) === 200, { timeout: 30000, label: "köprü" });
    await waitFor(async () => (await httpStatus(APP_URL)) === 200, { timeout: 60000, label: "vite" });
    logLine("Yığın hazır. Tarayıcı (Node SSE gözlemci) bağlanıyor…");
    startEventLogger();

    const chromium = loadChromium();
    browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => {
      state.errors.push({ kind: "pageerror", text: e.message, ts: Date.now() });
      logLine(`💥 PAGEERROR: ${e.message}`);
    });
    page.on("console", (m) => {
      if (m.type() === "error") logLine(`⚠ console.error: ${m.text().slice(0, 160)}`);
    });
    page.on("dialog", (d) => d.dismiss().catch(() => {}));

    await page.addInitScript((p) => {
      window.__MYCL_PICK_PATH = p;
    }, PROJECT);

    logLine("Sayfa açılıyor…");
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="splash"]', { timeout: 20000 });
    logLine("Splash geldi → proje açılıyor (fixture pick enjekte)…");
    await page.click('[data-testid="splash-pick-folder"]');
    await page.waitForSelector('[data-testid="app-header"]', { timeout: 20000 });
    logLine("✅ Ana UI render oldu — proje yüklendi. Olaylar gözleniyor…");
    await sleep(1500);
    await page.screenshot({ path: path.join(ARTIFACTS, "drive-opened.png"), fullPage: false });
    snapshotState();

    // ── Sürüş döngüsü ──
    let askqAnswered = 0;
    let nudged = false;
    let lastAnsweredQuestion = null;
    let lastShot = 0;
    const t0 = Date.now();

    while (true) {
      const now = Date.now();
      if (now - t0 > WALL_CLOCK_MS) {
        logLine("⏱ duvar-saat sınırı (25dk) — duruluyor.");
        break;
      }
      if (state.pipelineEnded) {
        logLine("🏁 pipeline_end yakalandı — bu iterasyon tamam.");
        break;
      }
      if (askqAnswered >= MAX_ASKQ) {
        logLine("askq sınırı (40) — duruluyor.");
        break;
      }

      // Periyodik ekran görüntüsü (~30s).
      if (now - lastShot > 30000) {
        lastShot = now;
        const n = String(Math.floor((now - t0) / 1000)).padStart(4, "0");
        await page.screenshot({ path: path.join(ARTIFACTS, `drive-t${n}.png`), fullPage: false }).catch(() => {});
        snapshotState();
      }

      // Askq kartı var mı → UI'dan yanıtla (önerileni, yoksa ilkini).
      const cardCount = await page.locator('[data-testid="askq-card"]').count().catch(() => 0);
      if (cardCount > 0) {
        const q = (await page.locator('[data-testid="askq-card"] .askq-question').first().textContent().catch(() => "")) || "";
        if (q !== lastAnsweredQuestion) {
          await page.screenshot({ path: path.join(ARTIFACTS, `drive-askq-${askqAnswered}.png`), fullPage: false }).catch(() => {});
          // Önerilen seçenek (askq-option-suggested) varsa onu, yoksa ilk seçeneği tıkla.
          const suggested = page.locator('[data-testid="askq-card"] .askq-option-suggested').first();
          const target = (await suggested.count().catch(() => 0)) > 0 ? suggested : page.locator('[data-testid="askq-card"] [data-testid="askq-option"]').first();
          const chosen = (await target.textContent().catch(() => "")) || "?";
          await target.click({ timeout: 5000 }).catch((e) => logLine(`askq tıklama hata: ${e.message}`));
          askqAnswered++;
          lastAnsweredQuestion = q;
          logLine(`✔ askq#${askqAnswered} yanıtlandı → "${chosen.trim().slice(0, 60)}"  (soru: ${q.slice(0, 70)})`);
          await sleep(1500);
          continue;
        }
      }

      // Açılıştan sonra uzun sessizlik + koşmuyor + askq yok → "devam" dürt (bir kez).
      if (!nudged && !state.running && !state.pendingAskq && now - state.lastEventAt > NUDGE_AFTER_MS) {
        nudged = true;
        logLine('➤ idle algılandı — "Kaldığın yerden devam et." gönderiliyor.');
        await sendCommand({ kind: "user_message", data: { text: "Kaldığın yerden devam et." } }).catch((e) => logLine(`nudge hata: ${e.message}`));
        await sleep(2000);
        continue;
      }

      // Tam idle (dürttük, hâlâ sessiz) → dur.
      if (nudged && !state.running && !state.pendingAskq && now - state.lastEventAt > IDLE_STOP_MS) {
        logLine("💤 dürtmeden sonra uzun sessizlik — duruluyor.");
        break;
      }

      await sleep(1000);
    }

    await page.screenshot({ path: path.join(ARTIFACTS, "drive-final.png"), fullPage: false }).catch(() => {});
    snapshotState({ askqAnswered, endReason: state.pipelineEnded ? "pipeline_end" : "stopped" });

    // ── Özet ──
    logLine("");
    logLine("════════ ÖZET ════════");
    logLine(`Son faz: ${state.phase} (${state.status})`);
    logLine(`pipeline_end: ${state.pipelineEnded ? JSON.stringify(state.pipelineEnded) : "yok"}`);
    logLine(`askq yanıtlandı: ${askqAnswered}`);
    logLine(`hatalar (runtime/page): ${state.errors.length}`);
    for (const e of state.errors.slice(0, 10)) logLine(`   - ${e.kind}: ${e.text.slice(0, 160)}`);
    logLine(`olay sayıları: ${JSON.stringify(state.counts)}`);
  } catch (e) {
    logLine(`💥 sürücü hatası: ${e instanceof Error ? e.stack : String(e)}`);
    state.errors.push({ kind: "driver", text: String(e), ts: Date.now() });
  } finally {
    cleanup();
  }

  process.exit(state.errors.some((e) => e.kind === "pageerror" || e.kind === "driver") ? 1 : 0);
}

main();
