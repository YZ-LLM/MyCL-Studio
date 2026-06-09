// GERÇEK E2E: runMultiAgentSelection (flag AÇIK) → decompose + paralel + worker agent_event görünürlüğü.
// Çalıştır: node orchestrator/scripts/e2e-multi-agent-select.mjs
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const { runMultiAgentSelection } = await import(join(here, "../dist/module-parallel/select.js"));
const { setAgentTraceRoot, readAgentTrace } = await import(join(here, "../dist/agent-trace.js"));

const dir = mkdtempSync(join(tmpdir(), "mycl-e2e-sel-"));
const git = (a) => spawnSync("git", a, { cwd: dir, stdio: "ignore" });
git(["init", "--initial-branch=main"]);
git(["config", "user.email", "e2e@test"]);
git(["config", "user.name", "E2E"]);
git(["config", "commit.gpgsign", "false"]);
git(["commit", "--allow-empty", "-m", "init"]);

const config = {
  selected_models: { main: "claude-sonnet-4-6" },
  claude_code_flags: { multi_agent_selection: true },
};
const request =
  "Build two completely independent utilities: (1) a date helper under src/datefmt/, " +
  "(2) an array helper under src/arrutil/. No shared files, no cross-imports.";

setAgentTraceRoot(dir); // standalone'da iz kökünü set et (normalde open_project yapar)
console.log(`E2E ÇOKLU AJAN SEÇİMİ (flag açık). repo: ${dir}`);
const t0 = Date.now();
const sel = await runMultiAgentSelection(config, request, dir);
console.log(`Süre: ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
console.log("Sonuç:", JSON.stringify(sel, null, 2));
if (sel.used) {
  for (const f of sel.files ?? []) console.log("  dosya:", f, existsSync(join(dir, f)) ? "✔" : "YOK");
}
// Tam iz doğrulama: worker tool_use'ları + çıktıları yakalandı mı (kör nokta kalmadı mı)?
const trace = await readAgentTrace(dir);
const byAgent = {};
for (const r of trace) byAgent[r.agent_label ?? "?"] = (byAgent[r.agent_label ?? "?"] ?? 0) + 1;
console.log(`İZ: ${trace.length} kayıt, ajan başına:`, JSON.stringify(byAgent));
console.log("  örnek tool_use:", JSON.stringify(trace.find((r) => r.sub === "tool_use") ?? "yok"));
console.log("TEST DİZİNİ:", dir);
