#!/usr/bin/env node
// db-schema-check — veritabanı şemasının güvenlik/performans kapısı (Faz 13 ve Faz 12 alt taraması).
//
// NEDEN (2026-08-03): kullanıcının ürün amacı "veritabanı performanslı ve güvenli tasarlanmış" diyor;
// ama üretilen şemayı doğrulayan tek bir mekanik kontrol yoktu. Bu script `.mycl/migrations/*.sql`,
// proje içi `*.sql` migration'ları ve Prisma şemasını okuyup tartışmasız kuralları uygular.
//
// Kullanım: node db-schema-check.mjs <projectRoot> <security|performance>
// Çıkış: 0 = temiz · 1 = bulgu var · 3 = şema bulunamadı (ölçüm YAPILAMADI, "temiz" sayılmaz)

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.argv[2] ?? process.cwd();
const dimension = process.argv[3] === "performance" ? "performance" : "security";

const SCHEMA_DIRS = [".mycl/migrations", "migrations", "db/migrate", "prisma", "supabase/migrations", "sql"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "vendor"]);
const MAX_FILES = 200;
const MAX_BYTES = 512 * 1024;

async function collect(dir, depth = 0, acc = []) {
  if (depth > 4 || acc.length >= MAX_FILES) return acc;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) break;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await collect(join(dir, e.name), depth + 1, acc);
    } else if (/\.(sql|prisma)$/i.test(e.name)) {
      const full = join(dir, e.name);
      try {
        const st = await fs.stat(full);
        if (st.size > MAX_BYTES) continue;
        acc.push({ path: full.slice(projectRoot.length + 1), content: await fs.readFile(full, "utf-8") });
      } catch {
        /* okunamayan dosya — atla */
      }
    }
  }
  return acc;
}

const files = [];
for (const d of SCHEMA_DIRS) {
  await collect(join(projectRoot, d), 0, files);
}
if (files.length === 0) {
  // Proje kökünde de ara (küçük projeler migration klasörü kullanmayabilir).
  await collect(projectRoot, 3, files);
}

if (files.length === 0) {
  process.stdout.write(
    "db-schema: veritabanı şeması/migration bulunamadı — bu boyut ÖLÇÜLEMEDİ ('temiz' sayılmaz)\n",
  );
  process.exit(3);
}

const { analyzeDbSchemas } = await import(
  pathToFileURL(join(import.meta.dirname, "dist", "db-schema-rules.js")).href
);
const result = analyzeDbSchemas(files);
const findings = result[dimension] ?? [];

// Görünür istisna dosyası: kullanıcı bilerek kabul ettiği bulguyu susturabilir (sessiz değil, dosyada).
let allow = [];
try {
  allow = JSON.parse(await fs.readFile(join(projectRoot, ".mycl", "db-check-allow.json"), "utf-8"));
} catch {
  allow = [];
}
const active = findings.filter((f) => !allow.some((a) => a.file === f.file && a.kind === f.kind));

if (active.length === 0) {
  process.stdout.write(
    `db-schema (${dimension}): temiz — ${files.length} şema/migration dosyası tarandı` +
      (findings.length > active.length ? ` (${findings.length - active.length} bulgu kullanıcı istisnasında)` : "") +
      "\n",
  );
  process.exit(0);
}

process.stdout.write(
  `db-schema (${dimension}): ${active.length} bulgu (${files.length} dosya tarandı)\n` +
    active.slice(0, 30).map((f) => `  - [${f.kind}] ${f.file}: ${f.detail}`).join("\n") +
    "\n",
);
process.exit(1);
