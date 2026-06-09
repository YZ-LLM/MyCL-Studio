// Canlı smoke: proposeModules (runReasoning backend-aware + decompose + K1 ayrıklık kapısı) çalışıyor mu?
// Read-only (planlama; dosya yazmaz). dist'ten import.
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, backendForRole } from "../dist/config.js";
import { proposeModules } from "../dist/module-parallel/decompose.js";

const config = await loadConfig();
console.log("main backend:", backendForRole(config, "main"));
const dir = await mkdtemp(join(tmpdir(), "mycl-smoke-"));
const request =
  "Build two INDEPENDENT, non-overlapping modules: (1) a standalone date-formatting utility with its own files " +
  "under src/lib/dateutil/, and (2) a completely separate string-casing utility under src/lib/strcase/. " +
  "They share no files.";
console.log("Decompose başlıyor (runReasoning, ~30-60sn)...\n");
const t0 = Date.now();
const modules = await proposeModules(config, request, dir);
console.log(`Süre: ${Math.round((Date.now() - t0) / 1000)}sn`);
if (modules) {
  console.log(`PARALEL → ${modules.length} bağımsız modül (K1 ayrıklık kapısı geçti):`);
  for (const m of modules) console.log(`  - ${m.id}: [${m.scope_paths.join(", ")}] — ${m.brief.slice(0, 70)}`);
} else {
  console.log("SERİ → ≥2 gerçekten ayrık modül çıkmadı / bölünemedi (fail-closed)");
}
