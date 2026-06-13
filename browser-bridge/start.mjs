// browser-bridge/start.mjs — `npm run dev:browser` girişi.
// Köprüyü (in-process) + vite'ı (MYCL_BROWSER=1 → tauri-shim alias) birlikte
// başlatır. Tek süreç ikisini de sahiplenir; SIGINT/SIGTERM ikisini de kapatır.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "./server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const bridge = startBridge();

const viteBin = path.join(ROOT, "node_modules", ".bin", "vite");
const vite = spawn(viteBin, [], {
  cwd: ROOT,
  env: { ...process.env, MYCL_BROWSER: "1" },
  stdio: "inherit",
});

let stopped = false;
function shutdown(code = 0) {
  if (stopped) return;
  stopped = true;
  try {
    bridge.stop();
  } catch {
    /* */
  }
  try {
    vite.kill("SIGTERM");
  } catch {
    /* */
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
vite.on("exit", (code) => shutdown(code ?? 0));

process.stdout.write(
  "\n  MyCL Studio — TARAYICI MODU\n" +
    "  → http://localhost:1420   (uygulama; Playwright/tarayıcı buraya bağlanır)\n" +
    `  → http://localhost:${bridge.port}/__bridge/health   (köprü sağlık)\n\n` +
    "  Proje açmak için: ?project=/mutlak/yol  veya  Splash'ta klasör gir.\n" +
    "  Durdurmak için Ctrl-C.\n\n",
);
