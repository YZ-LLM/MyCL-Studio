// GERÇEK 2-modül paralel codegen E2E (no mock). dist'ten import eder, geçici git repo kurar,
// runParallelModules'ü GERÇEK scoped codegen worker'ıyla koşturur → iki bağımsız modül paralel
// yazılır + ayrık entegre edilir. Çalıştır: node orchestrator/scripts/e2e-parallel-codegen.mjs
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const { runParallelModules } = await import(join(here, "../dist/module-parallel/dispatch.js"));
const { makeScopedCodegenWorker } = await import(join(here, "../dist/module-parallel/worker.js"));

const dir = mkdtempSync(join(tmpdir(), "mycl-e2e-par-"));
const git = (args) => spawnSync("git", args, { cwd: dir, stdio: "ignore" });
git(["init", "--initial-branch=main"]);
git(["config", "user.email", "e2e@test"]);
git(["config", "user.name", "E2E"]);
git(["config", "commit.gpgsign", "false"]);
git(["commit", "--allow-empty", "-m", "init"]);

const config = { selected_models: { main: "claude-sonnet-4-6" } };
const modules = [
  {
    id: "greet",
    scope_paths: ["src/greet/"],
    brief:
      "Create exactly one file: src/greet/greet.ts exporting `export function greet(name: string): string` that returns `Hello, ${name}!`. Create only that file. Do not run any build or tests.",
  },
  {
    id: "calc",
    scope_paths: ["src/calc/"],
    brief:
      "Create exactly one file: src/calc/add.ts exporting `export function add(a: number, b: number): number` that returns a + b. Create only that file. Do not run any build or tests.",
  },
];

console.log(`E2E: 2 ayrık modül, GERÇEK paralel codegen (no mock). repo: ${dir}`);
const t0 = Date.now();
const res = await runParallelModules(dir, modules, { enabled: true }, makeScopedCodegenWorker(config));
console.log(`Süre: ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
console.log("Sonuç:", JSON.stringify(res, null, 2));

const g = join(dir, "src/greet/greet.ts");
const c = join(dir, "src/calc/add.ts");
console.log("✔ src/greet/greet.ts var:", existsSync(g));
console.log("✔ src/calc/add.ts var:", existsSync(c));
if (existsSync(g)) console.log("--- greet.ts ---\n" + readFileSync(g, "utf-8"));
if (existsSync(c)) console.log("--- add.ts ---\n" + readFileSync(c, "utf-8"));
console.log("TEST DİZİNİ (incele/sil):", dir);
