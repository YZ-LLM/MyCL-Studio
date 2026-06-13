// browser-bridge/server.mjs — MyCL Studio'yu DÜZ TARAYICIDA çalıştırmak için
// Tauri (Rust) IPC katmanının birebir taklidi. Sıfır yeni bağımlılık: Node
// yerleşik `http` + SSE (Server-Sent Events) + HTTP POST.
//
// Mimari (Rust src-tauri/src/orchestrator.rs ile AYNI sözleşme):
//   tarayıcı (vite :1420, tauri-shim alias)
//     ↓ POST /__bridge/invoke   (invoke komutları)
//     ↑ GET  /__bridge/events   (SSE: orchestrator olayları)
//   bu köprü (:1799)
//     ↓ stdin: JSON.stringify(OrchestratorCommand) + "\n"
//     ↑ stdout: her satır = bir OrchestratorEvent (JSON)
//   Node orchestrator (orchestrator/dist/index.js) — Tauri'dekiyle AYNI süreç
//
// Rust ne yapıyorsa o: orchestrator'ı spawn eder, her stdout satırını JSON parse
// edip "orchestrator-event" olarak yayınlar, stdin'e komut yazar, EOF'ta
// "orchestrator-exit" yayınlar. Faz mantığı tamamen Node tarafında — köprü onu
// bilmez, sadece boruları bağlar.

import http from "node:http";
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ORCH_ENTRY = path.join(ROOT, "orchestrator", "dist", "index.js");
// Recent projeler — repo dışında (test izolasyonu + sızıntı yok). Rust'ın
// app-data recent.json'undan AYRI; tarayıcı modu kendi listesini tutar.
const RECENT_FILE = path.join(os.homedir(), ".mycl", "browser-recent.json");

export function startBridge(port = Number(process.env.MYCL_BRIDGE_PORT) || 1799) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  /** @type {import('node:child_process').ChildProcess | null} */
  let orch = null;
  let orchStarting = false;

  function broadcast(obj) {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) {
      try {
        res.write(line);
      } catch {
        /* istemci gitti */
      }
    }
  }

  // Rust spawn_orchestrator'ın karşılığı — idempotent. SSE bağlanınca veya
  // spawn_orchestrator invoke gelince çağrılır; tek global orchestrator.
  function ensureOrchestrator() {
    if (orch || orchStarting) return;
    if (!fs.existsSync(ORCH_ENTRY)) {
      // Görünür hata — sessiz düşme yok. Frontend lastError'a düşer.
      broadcast({
        name: "orchestrator-event",
        payload: {
          kind: "error",
          data: {
            reason: `orchestrator/dist/index.js yok — önce derleyin: npm --prefix orchestrator run build`,
          },
        },
      });
      return;
    }
    orchStarting = true;
    // Rust ile aynı env: LC_ALL=C + miras PATH (dev shell'de node/npm/git zaten yolda).
    const child = spawn("node", [ORCH_ENTRY], {
      cwd: ROOT,
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    orch = child;
    orchStarting = false;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        // Rust de bozuk-json satırını atlar (log + continue).
        process.stderr.write(`[bridge] orchestrator bad json: ${trimmed}\n`);
        return;
      }
      broadcast({ name: "orchestrator-event", payload });
    });

    child.stderr.on("data", (d) => process.stderr.write(`[orchestrator] ${d}`));

    child.on("exit", (code, sig) => {
      process.stderr.write(`[bridge] orchestrator çıktı code=${code} sig=${sig}\n`);
      if (orch === child) orch = null;
      broadcast({ name: "orchestrator-exit", payload: null });
    });
    child.on("error", (e) => {
      process.stderr.write(`[bridge] orchestrator spawn hatası: ${e}\n`);
      if (orch === child) orch = null;
      broadcast({
        name: "orchestrator-event",
        payload: { kind: "error", data: { reason: `orchestrator spawn error: ${e.message}` } },
      });
      broadcast({ name: "orchestrator-exit", payload: null });
    });
  }

  // Rust send_to_orchestrator: JSON.stringify(message) + "\n" → stdin.
  function sendToOrchestrator(message) {
    if (!orch || !orch.stdin || !orch.stdin.writable) {
      throw new Error("orchestrator not running");
    }
    orch.stdin.write(JSON.stringify(message) + "\n");
  }

  // Rust stop_session: stdin kapat → 1sn bekle → SIGKILL.
  function stopOrchestrator() {
    if (!orch) return;
    const c = orch;
    orch = null;
    try {
      c.stdin.end();
    } catch {
      /* */
    }
    const killTimer = setTimeout(() => {
      try {
        c.kill("SIGKILL");
      } catch {
        /* */
      }
    }, 1000);
    c.once("exit", () => clearTimeout(killTimer));
  }

  function readRecent() {
    try {
      const arr = JSON.parse(fs.readFileSync(RECENT_FILE, "utf8"));
      if (Array.isArray(arr)) {
        return arr.filter((p) => typeof p === "string" && fs.existsSync(p));
      }
    } catch {
      /* yok/bozuk → boş */
    }
    return [];
  }
  function addRecent(p) {
    if (!p || typeof p !== "string") return;
    let arr = readRecent().filter((x) => x !== p);
    arr.unshift(p);
    arr = arr.slice(0, 20);
    try {
      fs.mkdirSync(path.dirname(RECENT_FILE), { recursive: true });
      fs.writeFileSync(RECENT_FILE, JSON.stringify(arr, null, 2));
    } catch {
      /* recent opsiyonel */
    }
  }

  // 13 invoke komutu (Rust #[tauri::command] karşılıkları).
  async function dispatchInvoke(cmd, args) {
    switch (cmd) {
      case "spawn_orchestrator":
      case "spawn_orchestrator_for_window":
        ensureOrchestrator();
        return null;
      case "send_to_orchestrator":
      case "send_to_window":
        sendToOrchestrator(args.message);
        return null;
      case "kill_orchestrator":
      case "kill_window":
        stopOrchestrator();
        return null;
      case "get_recent_projects":
        return readRecent();
      case "add_recent_project":
        addRecent(args.path);
        return null;
      case "get_open_projects":
        return [];
      case "register_window_project":
        return null;
      case "check_update_status":
        return { mode: "none", reason: "tarayıcı köprüsü — güncelleme yok", busy: false };
      case "apply_update":
        return null;
      case "open_new_window":
        // Çoklu pencere tek orchestrator'ı paylaşırdı (cross-talk) → tarayıcı
        // modunda DESTEKLENMEZ. Görünür no-op (frontend hata yutar).
        return null;
      default:
        throw new Error(`unknown bridge command: ${cmd}`);
    }
  }

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (req.method === "GET" && url.pathname === "/__bridge/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, orchestrator: !!orch, entry: ORCH_ENTRY, root: ROOT }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/__bridge/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");
      clients.add(res);
      ensureOrchestrator();
      const ping = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          /* */
        }
      }, 25000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/__bridge/invoke") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 5_000_000) req.destroy();
      });
      req.on("end", async () => {
        let parsed;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad json body" }));
          return;
        }
        try {
          const ok = await dispatchInvoke(parsed.cmd, parsed.args ?? {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port, () => {
    process.stdout.write(
      `[bridge] dinleniyor http://localhost:${port}  (orchestrator: ${ORCH_ENTRY})\n`,
    );
  });

  function stop() {
    stopOrchestrator();
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* */
      }
    }
    clients.clear();
    server.close();
  }

  return { server, stop, port };
}

// CLI: `node browser-bridge/server.mjs`
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { stop } = startBridge();
  const bye = () => {
    stop();
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
