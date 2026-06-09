// GERÇEK uçtan-uca: istek → proposeModules (LLM böler) → runParallelModules (gerçek worker) → entegre.
// no mock. Çalıştır: node orchestrator/scripts/e2e-parallel-full.mjs
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const { runParallelModules } = await import(join(here, "../dist/module-parallel/dispatch.js"));
const { makeScopedCodegenWorker } = await import(join(here, "../dist/module-parallel/worker.js"));
const { proposeModules } = await import(join(here, "../dist/module-parallel/decompose.js"));

const dir = mkdtempSync(join(tmpdir(), "mycl-e2e-full-"));
const git = (args) => spawnSync("git", args, { cwd: dir, stdio: "ignore" });
git(["init", "--initial-branch=main"]);
git(["config", "user.email", "e2e@test"]);
git(["config", "user.name", "E2E"]);
git(["config", "commit.gpgsign", "false"]);
git(["commit", "--allow-empty", "-m", "init"]);

const config = { selected_models: { main: "claude-sonnet-4-6" } };
const request =
  "Build two completely independent utilities: (1) a string helper module under src/strutil/ " +
  "(e.g. capitalize), and (2) a number helper module under src/numutil/ (e.g. clamp). " +
  "They share no files and do not import each other.";

console.log(`E2E FULL: istek → LLM böl → paralel codegen. repo: ${dir}`);
const t0 = Date.now();
const modules = await proposeModules(config, request, dir);
console.log(`Decomposition: ${((Date.now() - t0) / 1000).toFixed(1)} sn →`, JSON.stringify(modules, null, 2));

if (!modules) {
  console.log("LLM ≥2 ayrık modül üretmedi → SERİ yola düşülürdü (fail-closed). E2E: kapı çalıştı.");
} else {
  const res = await runParallelModules(dir, modules, { enabled: true }, makeScopedCodegenWorker(config));
  console.log(`Toplam: ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
  console.log("Sonuç:", JSON.stringify(res, null, 2));
  for (const m of modules) {
    const d = join(dir, m.scope_paths[0]);
    console.log(`✔ ${m.scope_paths[0]} →`, existsSync(d) ? readdirSync(d) : "YOK");
  }
}
console.log("TEST DİZİNİ:", dir);
