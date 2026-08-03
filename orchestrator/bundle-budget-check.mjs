#!/usr/bin/env node
// bundle-budget-check — paket boyutu ölçümü + bütçe kapısı (stack bağımsız).
//
// NEDEN (2026-08-03): Faz 12 gerçek ölçüm yapmıyordu; MyCL'in kendi şablonu `perf` komutunu
// `npm run build`'e eşitliyordu. Bu script build ÇIKTISINI ölçer: hangi klasöre üretildiğini bulur,
// istemciye giden varlıkların (js/css/wasm) toplam boyutunu hesaplar ve `.mycl/perf-budget.json`
// bütçesiyle kıyaslar.
//
// SESSİZ GEÇME YOK: build çıktısı bulunamazsa "temiz" demez — atlama bildirir (exit 3).
// Çıkış: 0 = bütçe içinde (ya da ilk koşu, temel kaydedildi) · 1 = bütçe aşıldı · 3 = ölçülemedi (atlama)

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.argv[2] ?? process.cwd();
const BUDGET_REL = join(".mycl", "perf-budget.json");
// Yaygın build çıktı klasörleri — VAR OLAN + en son değişen seçilir (stack tahmin edilmez).
const CANDIDATES = [
  "dist", "build", "out", ".next/static", ".output/public", "public/build", "_site", ".svelte-kit/output/client",
];
const ASSET_EXT = [".js", ".mjs", ".cjs", ".css", ".wasm"];

async function dirStat(rel) {
  try {
    const st = await fs.stat(join(projectRoot, rel));
    return st.isDirectory() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

async function walk(dir) {
  let total = 0;
  const files = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { total, files };
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await walk(full);
      total += sub.total;
      files.push(...sub.files);
    } else if (ASSET_EXT.some((x) => e.name.toLowerCase().endsWith(x))) {
      try {
        const st = await fs.stat(full);
        total += st.size;
        files.push({ path: full.slice(projectRoot.length + 1), size: st.size });
      } catch {
        /* okunamayan dosya — atla */
      }
    }
  }
  return { total, files };
}

const found = [];
for (const c of CANDIDATES) {
  const m = await dirStat(c);
  if (m !== null) found.push({ rel: c, mtime: m });
}
if (found.length === 0) {
  process.stdout.write(
    "bundle-budget: build çıktısı bulunamadı (dist/build/out/... yok) — ölçüm YAPILAMADI, 'temiz' sayılmaz\n",
  );
  process.exit(3);
}
found.sort((a, b) => b.mtime - a.mtime);
const outDir = found[0].rel;
const { total, files } = await walk(join(projectRoot, outDir));
if (total === 0) {
  process.stdout.write(`bundle-budget: ${outDir} içinde ölçülebilir varlık yok — ölçüm YAPILAMADI\n`);
  process.exit(3);
}

// Bütçe dosyası: yoksa muhafazakâr varsayılanla oluşturulur (kullanıcı elle düzenleyebilir; MyCL EZMEZ).
const budgetPath = join(projectRoot, BUDGET_REL);
const { DEFAULT_PERF_BUDGET, decidePerf, nextBaseline } = await import(
  pathToFileURL(join(import.meta.dirname, "dist", "perf-budget.js")).href
);
let budget;
try {
  budget = JSON.parse(await fs.readFile(budgetPath, "utf-8"));
} catch {
  budget = { ...DEFAULT_PERF_BUDGET };
}

const measurement = { bundleBytes: total, env: "prod" };
const outcome = decidePerf(measurement, budget);
const top = [...files].sort((a, b) => b.size - a.size).slice(0, 5);
const topLine = top.map((f) => `    ${f.path} ${Math.round(f.size / 1024)} KB`).join("\n");

if (outcome.kind === "fail") {
  process.stdout.write(
    `bundle-budget: BÜTÇE AŞILDI (${outDir})\n` +
      outcome.reasons.map((r) => `  - ${r}`).join("\n") +
      `\n  en büyük dosyalar:\n${topLine}\n`,
  );
  process.exit(1);
}

// Geçti / temel kaydedildi → temeli güncelle (ilk koşu asla düşmez sözleşmesi).
budget.baseline = nextBaseline(measurement, budget);
try {
  await fs.mkdir(join(projectRoot, ".mycl"), { recursive: true });
  await fs.writeFile(budgetPath, JSON.stringify(budget, null, 2) + "\n", "utf-8");
} catch (e) {
  process.stdout.write(`bundle-budget: uyarı — bütçe dosyası yazılamadı (${String(e).slice(0, 80)})\n`);
}
process.stdout.write(
  `bundle-budget: ${outcome.kind === "baseline_recorded" ? "temel kaydedildi" : "bütçe içinde"} — ` +
    `${outDir}, ${Math.round(total / 1024)} KB (${files.length} varlık)\n  en büyük dosyalar:\n${topLine}\n`,
);
process.exit(0);
