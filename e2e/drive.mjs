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

// Sınırlar — sonsuz/saatlerce koşmasın. Sıfırdan proje kurmak 25 dakikadan uzun sürer;
// süre env ile uzatılabilir (varsayılan değişmedi).
const WALL_CLOCK_MS = (Number(process.env.MYCL_WALL_CLOCK_MIN) || 25) * 60 * 1000;
const IDLE_STOP_MS = 200 * 1000; // 200s olaysız + koşmuyor → dur
const MAX_ASKQ = Number(process.env.MYCL_MAX_ASKQ) || 40;
const NUDGE_AFTER_MS = 35 * 1000; // açılıştan sonra bu kadar sessizlikte "devam" dürt

/**
 * Proje açıldıktan sonra gönderilecek İLK mesaj (sıfırdan proje kurarken hedefi verir).
 * Verilmezse eski davranış: sessizlikte "Kaldığın yerden devam et." dürtüsü.
 */
const FIRST_MESSAGE = process.env.MYCL_FIRST_MESSAGE || "";

/**
 * Faz 6 (UI İnceleme) KULLANICININ fazıdır — uygulamayı insan inceler ve karar verir.
 * Otomatik sürücü oraya karışırsa kullanıcı adına onay vermiş olur; bu yüzden Faz 6'da
 * askq yanıtlanmaz, sürücü durur ve durumu bildirir.
 */
const STOP_PHASE = 6;

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
  /**
   * ⏸️ İki Claude kanalı da kapalıyken (abonelik limiti) MyCL BİLEREK bekler ve reset saatinde
   * kaldığı yerden otomatik devam eder (llm-outage.ts). Bu bir asılma DEĞİLDİR.
   * CANLI KANIT (2026-09-13, cüzdan koşusu): sürücü bunu bilmediği için 200 sn sessizlikten sonra
   * yığını kapattı → orchestrator öldü → 14:00'teki otomatik devam da öldü. Yani sürücünün
   * "asıldı" teşhisi, MyCL'in doğru davranışını iptal etti.
   */
  outageWait: null, // {active, resetMs}
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
    case "outage_wait": {
      const active = Boolean(ev.data?.active);
      state.outageWait = active ? { active, resetMs: ev.data?.reset_ms } : null;
      const saat = ev.data?.reset_ms ? new Date(ev.data.reset_ms).toISOString().slice(11, 16) : "bilinmiyor";
      logLine(active ? `⏸️ LLM erişimi kapalı — MyCL bekliyor (reset ~${saat} UTC). Sürücü BEKLER, kapatmaz.` : "▶ LLM erişimi geri geldi — bekleme bitti.");
      break;
    }
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

    // Sıfırdan proje: hedefi ilk mesajla ver. Boşsa eski davranış (idle dürtüsü) geçerli.
    if (FIRST_MESSAGE) {
      logLine(`➤ ilk mesaj gönderiliyor: "${FIRST_MESSAGE.replace(/\n/g, " ").slice(0, 90)}…"`);
      await sendCommand({ kind: "user_message", data: { text: FIRST_MESSAGE } }).catch((e) =>
        logLine(`ilk mesaj hata: ${e.message}`),
      );
      await sleep(2000);
    }

    // ── Sürüş döngüsü ──
    let askqAnswered = 0;
    let nudged = Boolean(FIRST_MESSAGE); // hedef verildiyse ayrıca "devam" dürtmeye gerek yok
    let lastAnsweredQuestion = null;
    let lastShot = 0;
    let lastOutageNote = 0;
    // YIĞIN GERÇEKTEN AYAKTA MI? CANLI KANIT (2026-09-17): önceki koşudan kalan bir vite süreci
    // portu tuttuğu için yeni vite "Port 1420 is already in use" ile hiç başlamadı; köprü ayaktaydı,
    // sağlık kontrolü geçti, sürücü sorunsuz sandı ve ÜÇ DAKİKA boşa bekledi (olay sayısı: sıfır).
    // Sağlık kontrolü "port cevap veriyor" der, "benim başlattığım süreç çalışıyor" DEMEZ. Bu yüzden
    // gerçek sinyal olay akışıdır: hiç olay gelmiyorsa erkenden görünür hata ver, sessizce bekleme.
    const BOS_AKIS_MS = 60_000;
    let bosAkisBildirildi = false;
    let outageMs = 0; // LLM erişimi kapalıyken geçen toplam süre — çalışma bütçesinden düşülmez
    const t0 = Date.now();

    while (true) {
      const now = Date.now();
      // Duvar saati ÇALIŞMA bütçesidir; LLM erişimi kapalıyken geçen süre iş değildir ve bütçeyi
      // yememeli. CANLI KANIT (cüzdan koşusu, 2026-09-13): beklemeyi öğrendikten sonra sürücü 128
      // dakika doğru şekilde bekledi, ama o süre bütçeden düşüldüğü için reset saatinden ÖNCE
      // kapandı — MyCL'in otomatik devamı yine ölmüş oldu. Bekleme süresi artık hariç tutuluyor.
      // (Metin de sabit "25dk" diyordu; gerçek sınır env ile değişiyor — yanlış bilgi kalktı.)
      if (now - t0 - outageMs > WALL_CLOCK_MS) {
        logLine(`⏱ çalışma süresi sınırı (${Math.round(WALL_CLOCK_MS / 60000)} dk; ${Math.round(outageMs / 60000)} dk bekleme hariç) — duruluyor.`);
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

      // Hiç olay gelmediyse yığın aslında ayağa kalkmamıştır — sessiz beklemek yerine söyle ve dur.
      if (!bosAkisBildirildi && Object.keys(state.counts).length === 0 && now - t0 > BOS_AKIS_MS) {
        bosAkisBildirildi = true;
        logLine("💥 Orkestratörden HİÇ olay gelmedi — yığın ayağa kalkmamış olabilir (port çakışması?).");
        await page.screenshot({ path: path.join(ARTIFACTS, "drive-no-events.png") }).catch(() => {});
        snapshotState({ endReason: "no_events" });
        break;
      }

      // Periyodik ekran görüntüsü (~30s).
      if (now - lastShot > 30000) {
        lastShot = now;
        const n = String(Math.floor((now - t0) / 1000)).padStart(4, "0");
        await page.screenshot({ path: path.join(ARTIFACTS, `drive-t${n}.png`), fullPage: false }).catch(() => {});
        snapshotState();
      }

      // SAYFA SPLASH'A DÜŞTÜ MÜ? CANLI KANIT (cüzdan koşusu, 2026-09-14): tarayıcı bir noktada proje
      // ekranını bırakıp Splash'a döndü. Olay akışı (SSE) tarayıcıdan BAĞIMSIZ olduğu için sürücü
      // hiçbir şeyin ters gittiğini görmedi: fazlar ilerliyor görünüyordu, ama DOM'da askq kartı YOKTU.
      // MyCL soru sorup yanıt bekledi, sürücü soruyu göremediği için yanıtlamadı, MyCL'in devam denemesi
      // "askq asılı" diye skipped döndü → üç saatten uzun karşılıklı kilitlenme. Açık DOM kanıtı olmadan
      // "soru yok" sonucuna varmak bu yüzden güvenli değil; önce projenin açık olduğunu doğrula.
      const projeAcik = (await page.locator('[data-testid="app-header"]').count().catch(() => 0)) > 0;
      if (!projeAcik) {
        const splashVar = (await page.locator('[data-testid="splash-pick-folder"]').count().catch(() => 0)) > 0;
        logLine(`⚠ proje ekranı kayboldu (splash=${splashVar}) — yeniden açılıyor.`);
        await page.screenshot({ path: path.join(ARTIFACTS, "drive-lost-project.png") }).catch(() => {});
        if (splashVar) {
          await page.click('[data-testid="splash-pick-folder"]').catch((e) => logLine(`yeniden açma hata: ${e.message}`));
        } else {
          await page.goto(APP_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
          await page.waitForSelector('[data-testid="splash-pick-folder"]', { timeout: 20000 }).catch(() => {});
          await page.click('[data-testid="splash-pick-folder"]').catch(() => {});
        }
        await page.waitForSelector('[data-testid="app-header"]', { timeout: 30000 }).catch(() => {});
        logLine((await page.locator('[data-testid="app-header"]').count().catch(() => 0)) > 0 ? "✅ proje yeniden açıldı." : "💥 proje yeniden AÇILAMADI.");
        await sleep(2000);
        continue;
      }

      // Askq kartı var mı → UI'dan yanıtla (önerileni, yoksa ilkini).
      const cardCount = await page.locator('[data-testid="askq-card"]').count().catch(() => 0);
      // Faz 6 KULLANICININ fazı: uygulamayı insan inceler. Sürücü burada karar veremez.
      if (cardCount > 0 && state.phase === STOP_PHASE) {
        logLine(`🛑 Faz ${STOP_PHASE} (UI İnceleme) sorusu — bu KULLANICININ kararı, sürücü yanıtlamaz.`);
        await page.screenshot({ path: path.join(ARTIFACTS, "drive-phase6-stop.png") }).catch(() => {});
        snapshotState({ askqAnswered, endReason: "phase6_user_review" });
        break;
      }
      if (cardCount > 0) {
        const q = (await page.locator('[data-testid="askq-card"] .askq-question').first().textContent().catch(() => "")) || "";
        if (q !== lastAnsweredQuestion) {
          await page.screenshot({ path: path.join(ARTIFACTS, `drive-askq-${askqAnswered}.png`), fullPage: false }).catch(() => {});
          // Önerilen seçenek (askq-option-suggested) varsa onu, yoksa ilk seçeneği tıkla.
          const suggested = page.locator('[data-testid="askq-card"] .askq-option-suggested').first();
          const target = (await suggested.count().catch(() => 0)) > 0 ? suggested : page.locator('[data-testid="askq-card"] [data-testid="askq-option"]').first();
          // TUM secenekleri logla: surucu "onerilen, yoksa ilk" diye koru korune seciyor ve bu
          // baglam gerektiren sorularda yanlis yone sokabiliyor (canli kanit, 2026-09-15: "hata
          // hizmet kesintisiydi, ne kontrol edeyim?" sorusunda olmayan bir uygulama hatasi
          // kovalatti). Secilmeyen secenekleri de gormek, yanlis yonu ERKEN fark ettirir.
          const tumSecenekler = await page
            .locator('[data-testid="askq-card"] [data-testid="askq-option"]')
            .allTextContents()
            .catch(() => []);
          if (tumSecenekler.length > 1) {
            logLine(`   seçenekler: ${tumSecenekler.map((s) => `"${s.trim().slice(0, 45)}"`).join(" | ")}`);
          }
          const chosen = (await target.textContent().catch(() => "")) || "?";
          await target.click({ timeout: 5000 }).catch((e) => logLine(`askq tıklama hata: ${e.message}`));
          askqAnswered++;
          lastAnsweredQuestion = q;
          logLine(`✔ askq#${askqAnswered} yanıtlandı → "${chosen.trim().slice(0, 60)}"  (soru: ${q.slice(0, 70)})`);
          await sleep(1500);
          continue;
        }
      }

      // Bekleme bayrağı TAKILI KALABİLİR: canlı kanıt (cüzdan koşusu, 2026-09-14) — outage_wait dört
      // kez active:true geldi, active:false HİÇ gelmedi; abonelik 11:17'de geri gelip işler koştuğu
      // hâlde bayrak açık kaldı. Reset saati geçtiyse bayrağı kendimiz düşürürüz, yoksa sonsuz bekleriz.
      if (state.outageWait?.active && state.outageWait.resetMs && now > state.outageWait.resetMs + 60_000) {
        logLine("▶ reset saati geçti — bekleme bayrağı düşürüldü (MyCL 'bekleme bitti' yayınlamadı).");
        state.outageWait = null;
      }

      // ⏸️ MyCL LLM erişimi için BEKLİYORSA sessizlik asılma değildir: dürtme de, kapatma da yapma.
      // Reset saatinde MyCL kendi devam eder; sürücünün tek işi hayatta kalmak. (Sınırı duvar saati koyar.)
      // AMA askq bunun ÜSTÜNDEDİR (aşağıda önce ele alınır): MyCL'in devam denemesi askq asılıyken
      // "skipped" döner ve bekleme SONA ERMEZ; sürücü de beklediği için soruyu yanıtlamazsa iki taraf
      // birbirini bekler — canlı kanıtta tam 3 saat süren karşılıklı kilitlenme. Soruyu yanıtlamak
      // LLM harcamaz, sadece tıklamadır; kesinti sırasında da yapılmalıdır.
      if (state.outageWait?.active && cardCount === 0) {
        if (now - lastOutageNote > 5 * 60 * 1000) {
          lastOutageNote = now;
          const kalan = state.outageWait.resetMs ? Math.max(0, Math.round((state.outageWait.resetMs - now) / 60000)) : null;
          logLine(`⏸️ bekleniyor${kalan !== null ? ` — resete ~${kalan} dk` : ""}`);
        }
        await sleep(5000);
        outageMs += 5000;
        continue;
      }

      // FAZ 6'DA DÜRTME YOK. CANLI KANIT (cüzdan koşusu, 2026-09-16): Faz 6 kullanıcı incelemesini
      // beklerken sürücü "Kaldığın yerden devam et." dürtüsünü gönderdi; Faz 6 sözleşmesi bu ifadeyi
      // ONAY jetonu sayıyor ("Beğendiysen → tamam / devam et / onayla"). Sonuç: uygulama BOZUKKEN
      // (main.jsx hiç yazılmamış, ekran bomboş) inceleme otomatik onaylandı ve akış Faz 7'ye geçti.
      // Faz 6 KULLANICININ fazıdır; sürücü orada sessiz kalır — dürtmek onay vermektir.
      if (state.phase === STOP_PHASE && !nudged && !state.running) {
        if (now - lastOutageNote > 5 * 60 * 1000) {
          lastOutageNote = now;
          logLine(`🛑 Faz ${STOP_PHASE} (UI İnceleme) kullanıcıyı bekliyor — sürücü dürtmez (dürtmek onay sayılır).`);
        }
        await sleep(5000);
        continue;
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
