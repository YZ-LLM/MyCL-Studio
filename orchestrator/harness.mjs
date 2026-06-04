#!/usr/bin/env node
// harness.mjs — headless e2e harness (saha kanıtı, BLOK 1).
//
// Orchestrator'ı (dist/index.js) ALT-PROCESS olarak başlatır, stdin/stdout NDJSON ile
// sürer (Tauri ile AYNI kanal = gerçek black-box), audit.log'dan DÜRÜST verdict üretir
// (PASS/PARTIAL/FAIL) + exit code (0/2/1). GUI gerekmez.
//
// GERÇEK claude kullanır (config + abonelik/API gerekir) → maliyetli/yavaş; periyodik
// KANIT koşusu için. `npm run check`'e KOYULMAZ (orada mock e2e + verdict birim testi var).
//
// Kullanım:
//   npm run build && node harness.mjs --project-dir /tmp/mycl-proof --intent "Basit bir TODO API'si"
//   (veya: npm run e2e -- --project-dir <dir> --intent "<metin>" [--timeout-ms N])

import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { computeVerdict } from "./dist/harness-verdict.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const projectDir = resolve(arg("project-dir", ""));
const intent = arg("intent", "");
const timeoutMs = Number(arg("timeout-ms", "1800000")); // 30 dk varsayılan
if (!arg("project-dir", "") || !intent) {
  console.error('Kullanım: node harness.mjs --project-dir <dir> --intent "<metin>" [--timeout-ms N]');
  process.exit(3);
}

const entry = join(HERE, "dist", "index.js");
if (!existsSync(entry)) {
  console.error(`dist/index.js yok — önce 'npm run build'. Aranan: ${entry}`);
  process.exit(3);
}

await mkdir(projectDir, { recursive: true });
const auditPath = join(projectDir, ".mycl", "audit.log");

async function readAudit() {
  try {
    const raw = await readFile(auditPath, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const child = spawn("node", [entry], { cwd: HERE, stdio: ["pipe", "pipe", "inherit"] });
const send = (kind, data) => child.stdin.write(`${JSON.stringify({ kind, data })}\n`);

const answered = new Set();
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let ev;
  try {
    ev = JSON.parse(t);
  } catch {
    return;
  }
  if (ev.kind === "askq" && ev.data?.id && !answered.has(ev.data.id)) {
    answered.add(ev.data.id);
    const opts = ev.data.options ?? [];
    const sel = ev.data.suggested_option ?? opts[0] ?? "Onayla";
    console.error(`[harness] askq → "${String(ev.data.question ?? "").slice(0, 70)}" → "${sel}"`);
    send("askq_answer", { id: ev.data.id, selected: sel });
  } else if (ev.kind === "chat_message" && ev.data?.role === "error") {
    console.error(`[harness] ERROR: ${String(ev.data.text ?? "").slice(0, 200)}`);
  }
});

// Boot bekle → oto-cevap aç → projeyi aç → intent gönder.
await new Promise((r) => setTimeout(r, 1000));
send("set_auto_answer", { enabled: true });
send("open_project", { path: projectDir });
await new Promise((r) => setTimeout(r, 600));
send("user_message", { text: intent });

// phase-17-complete'e (veya deadline'a) kadar audit'i poll et.
const deadline = Date.now() + timeoutMs;
let completed = false;
while (Date.now() < deadline && !completed) {
  await new Promise((r) => setTimeout(r, 2000));
  completed = (await readAudit()).some(
    (e) => e.event === "phase-17-complete" || e.event === "phase-20-complete",
  );
}

const events = await readAudit();
const verdict = computeVerdict(events);
try {
  send("shutdown");
} catch {
  /* zaten kapandı */
}
try {
  child.kill("SIGTERM");
} catch {
  /* zaten bitti */
}

console.log(
  JSON.stringify(
    { ...verdict, timedOut: !completed, auditEvents: events.length },
    null,
    2,
  ),
);
process.exit(verdict.exitCode);
