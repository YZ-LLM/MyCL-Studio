#!/usr/bin/env node
// simplify-check — sadeleştirme (Faz 11) kapısı, STACK BAĞIMSIZ.
//
// NEDEN (YZLLM 2026-09-12: "aracın tek dile bağlı olma ihtimalini ortadan kaldır"): `simplify`
// komutu 19 stack profilinin yalnız 4'ünde (node ailesi) tanımlıydı ve o dördünde de araç
// `ts-prune` — TypeScript'e bağlı. Yani boyut yalnız "Node + TypeScript" kesişiminde ölçülebiliyordu;
// adli denetim cave'in 94 iterasyonunda Faz 11'in BİR KEZ bile koşmadığını gösterdi.
//
// Bu script dilin aracına hiç bakmaz: kaynak dosyaları satır düzeyinde karşılaştırır. Dilin kendi
// aracı varsa o da koşar (profil komutu korunmuştur) — bu, ONUN YERİNE değil ALTINA konan tabandır.
//
// SESSİZ GEÇME YOK: taranacak kaynak yoksa "temiz" demez, atlama bildirir (exit 3).
// Çıkış: 0 = temiz / temel kaydedildi · 1 = kopya kod belirgin şekilde arttı · 3 = ölçülemedi (atlama)

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.argv[2] ?? process.cwd();
const BASELINE_REL = join(".mycl", "simplify-baseline.json");

// Kaynak SAYILMAYAN dizinler: üretilen/dış kod kopya sayılırsa ölçü anlamını yitirir.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".mycl", "dist", "build", "out", ".next", ".nuxt", ".output",
  "vendor", "target", "coverage", ".venv", "venv", "__pycache__", ".cache", ".turbo",
  "Pods", "DerivedData", ".gradle", ".svelte-kit", "bower_components", "third_party",
]);
// Dil bağımsız kaynak uzantıları — yeni bir dil eklemek TEK satır (liste veri, mantık değil).
const SOURCE_EXT = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rb", ".php", ".go", ".rs",
  ".java", ".kt", ".kts", ".swift", ".cs", ".dart", ".ex", ".exs", ".scala", ".vue", ".svelte",
]);
const MAX_FILES = 4000;
const MAX_BYTES = 512 * 1024;

async function collect(dir, acc = []) {
  if (acc.length >= MAX_FILES) return acc;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) break;
    if (e.name.startsWith(".") && e.name !== ".") {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await collect(full, acc);
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf(".");
      if (dot < 0 || !SOURCE_EXT.has(e.name.slice(dot))) continue;
      // Küçültülmüş/üretilmiş dosyalar birebir kopya gibi görünür → ölç dışı.
      if (/\.(min|bundle|generated)\./i.test(e.name)) continue;
      try {
        const st = await fs.stat(full);
        if (st.size > MAX_BYTES) continue;
        acc.push({
          path: full.slice(projectRoot.length + 1).split("\\").join("/"),
          content: await fs.readFile(full, "utf-8"),
        });
      } catch {
        /* okunamayan dosya — atla */
      }
    }
  }
  return acc;
}

const files = await collect(projectRoot);
if (files.length === 0) {
  process.stdout.write("simplify: taranacak kaynak dosya bulunamadı — bu boyut ÖLÇÜLEMEDİ ('temiz' sayılmaz)\n");
  process.exit(3);
}

const rules = await import(
  pathToFileURL(join(import.meta.dirname, "dist", "simplify-rules.js")).href
);
const blocks = rules.findDuplicateBlocks(files);
const measurement = {
  filesScanned: files.length,
  totalLines: files.reduce((n, f) => n + f.content.split("\n").length, 0),
  duplicateLines: rules.countDuplicateLines(blocks),
  duplicates: blocks.slice(0, 10),
  orphanCandidates: rules.findOrphanCandidates(files),
};

let baseline;
try {
  baseline = JSON.parse(await fs.readFile(join(projectRoot, BASELINE_REL), "utf-8"));
} catch {
  baseline = undefined;
}

const outcome = rules.decideSimplify(measurement, baseline);

// Temeli güncelle (iyileşme kalıcı olsun). Yazılamazsa akış durmaz; ölçüm yine raporlanır.
try {
  const next = rules.nextSimplifyBaseline(measurement, baseline);
  await fs.mkdir(join(projectRoot, ".mycl"), { recursive: true });
  await fs.writeFile(join(projectRoot, BASELINE_REL), JSON.stringify(next, null, 2) + "\n", "utf-8");
} catch (e) {
  process.stderr.write(`simplify: temel yazılamadı (${String(e).slice(0, 80)})\n`);
}

const orphanNote =
  measurement.orphanCandidates.length > 0
    ? `\n  bilgi (kapıyı düşürmez) — hiçbir yerden adı geçmeyen dosyalar:\n` +
      measurement.orphanCandidates.slice(0, 10).map((f) => `    · ${f}`).join("\n")
    : "";
const dupNote =
  measurement.duplicates.length > 0
    ? `\n  en çok tekrarlanan bloklar:\n` +
      measurement.duplicates
        .slice(0, 5)
        .map((d) => `    · ${d.lines} satır × ${d.places.length} yer: ${d.places.slice(0, 3).join(", ")}`)
        .join("\n")
    : "";

if (outcome.kind === "fail") {
  process.stdout.write(`simplify: ${outcome.reasons.join("; ")}${dupNote}${orphanNote}\n`);
  process.exit(1);
}
process.stdout.write(`simplify: ${outcome.note}${dupNote}${orphanNote}\n`);
process.exit(0);
