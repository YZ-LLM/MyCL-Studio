#!/usr/bin/env node
// arch-check.mjs — mimari sınır guardrail'i (Birim 2): KESİN client kodu sunucu-yalnız
// kaynak (DB sürücüsü / node fs-child_process gibi server builtin) import edemez.
//
// NEDEN minik + yüksek-güvenli (Ümit kararı "yalnız evrensel set"): klasik "UI→DB yasak"
// kuralı RSC çağında ARTIK evrensel değil — Next.js server component (.tsx, "use client" YOK)
// MEŞRU olarak DB sorgular. Yanlış-fail üretmemek için yalnız KESİN-client işaretli dosyaları
// kontrol ederiz (false-positive ~ 0):
//   • "use client" direktifi (React/Next — açık tarayıcı işareti), VEYA
//   • .vue / .svelte single-file component (client SFC), VEYA
//   • proje RSC-yetili DEĞİLse (next yok → Vite/CRA SPA → her component client) + dosya UI
//     framework (react/vue/svelte) import eden bir component.
// Bu dosyalar tarayıcıya paketlenir → DB sürücüsü/fs/child_process import etmeleri HER
// framework'te yanlıştır (paketlenmez / sunucu sızar). Belirsiz (.tsx, marker yok, RSC proje)
// → DOKUNMA (proje-özel kurallar ileride; Ümit "fragile layer-haritasını ertele").
//
// Çalışma-anı: orchestrator KÖKÜ .mjs (csp-check.mjs gibi), Faz 10 extra_scan MUTLAK yolla
// çağırır (runner cwd=hedef-proje). Argümanlar: pozisyonel dosya listesi (scoped {files}) →
// yalnız onları tara; yoksa --project <dir> (vars. cwd) → bounded recursive tüm-proje.
// Exit: 0 = geçti / uygulanamaz (atla); 1 = ihlal (bulgu); 2 = beklenmeyen hata
//       (runner tool_error_codes ile skip → yanlış-blocking yapmaz).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative, isAbsolute } from "node:path";

function argVal(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const projectDir = argVal("project") || process.cwd();
// Pozisyonel argümanlar = scoped dosya listesi ({files}). --project + değerini ve diğer
// --flag'leri atla; kalan pozisyoneller scoped dosyalardır.
const explicitFiles = [];
{
  const raw = process.argv.slice(2);
  for (let k = 0; k < raw.length; k++) {
    const a = raw[k];
    if (a === "--project") { k++; continue; } // flag + değerini atla
    if (a.startsWith("--")) continue;
    explicitFiles.push(a);
  }
}

const DENY = new Set([
  "node_modules", "dist", "build", ".git", ".mycl", "coverage", ".next", "out", "tmp",
]);
const SRC_EXT = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte",
]);

// UI framework işaretleri (component = client, RSC-olmayan projede). Yalnız tartışmasız-client
// olanlar; alpinejs/htmx (progressive-enhancement, server-rendered sayfada da olur) BİLEREK HARİÇ.
const UI_FRAMEWORKS = new Set([
  "react", "react-dom", "vue", "svelte", "solid-js", "preact", "@angular/core", "lit",
  "mithril", "inferno",
]);
// Sunucu-yalnız kaynaklar — KESİN client dosyasında ASLA olmamalı. (Hepsi tarayıcıda meşru
// çalışmaz → eklemek false-fail riski taşımaz.) Modern istemciler düşman-gözü K2'de eklendi.
const DB_DRIVERS = new Set([
  "pg", "pg-promise", "postgres", "mysql", "mysql2", "sqlite3", "better-sqlite3",
  "mongodb", "mongoose", "redis", "ioredis", "typeorm", "sequelize", "knex",
  "@prisma/client", "drizzle-orm", "mssql", "oracledb", "cassandra-driver",
  "@planetscale/database", "@neondatabase/serverless", "node-postgres",
  // K2 (düşman-gözü): mainstream 2024-2026 istemciler — pg kadar yaygın, kaçıyordu.
  "@libsql/client", "kysely", "slonik", "@vercel/postgres", "@supabase/postgres-js",
  "bun:sqlite", "sqlite", // node:sqlite (Node 22+) → "sqlite"e iner; npm sqlite de server-only
]);
// Node server-builtin (tarayıcıda yok / paketlenmez). DUAL-USE olanlar (path/url/crypto/os/
// util/stream/buffer/events/http/https) BİLEREK HARİÇ (bundler shim'ler → false-positive).
const SERVER_BUILTINS = new Set([
  "fs", "child_process", "net", "dgram", "dns", "tls", "cluster",
  "worker_threads", "vm", "v8", "readline", "repl", "inspector", "module",
  "perf_hooks", "http2",
]);

/** package.json'dan RSC-yetili framework var mı (varsa belirsiz .tsx'i flag'leme). */
function isRscCapable(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    // next (app-router/RSC), remix, qwik, solid-start, astro → server-component modeli olabilir.
    return ["next", "@remix-run/react", "@builder.io/qwik", "solid-start", "astro"].some((d) => d in deps);
  } catch {
    return false; // package.json yok → SPA varsay (daha çok yakala; yine yalnız component+DB)
  }
}

/** Specifier'ı base-pakete normalize et (@scope/name | pg/pool→pg | node:fs→fs). */
function basePackage(specRaw) {
  let spec = specRaw.trim();
  if (!spec || spec.startsWith(".") || spec.startsWith("/")) return null; // relative/absolute = internal
  spec = spec.replace(/^node:/, ""); // node:fs → fs (bun: KORUNUR → bun:sqlite ayrı paket)
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]; // @scope/name
  }
  return spec.split("/")[0]; // pg/pool → pg, fs/promises → fs
}

/**
 * Bir dosyanın DEĞER (runtime) import'larını base-pakete çıkar. TİP-yalnız import'ları
 * (`import type ...`, `export type ... from`, `import { type X } from` tümü-tip) DIŞLAR —
 * TypeScript bunları derlemede SİLER, bundle'a girmez → mimari ihlali DEĞİL (düşman-gözü K1
 * kök neden: `import type { User } from '@prisma/client'` yaygın+meşru, yanlış-bloklanıyordu).
 */
function importedPackages(content) {
  const out = new Set();
  // 1) ESM from-clause'lu import/export (çok-satır toleranslı). Tip-yalnız olanları atla.
  const esm = /\b(import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = esm.exec(content)) !== null) {
    const clause = m[2]; // import/export ile from arasındaki kısım
    const trimmed = clause.trim();
    // `import type ...` / `export type ...` → tümü tip → atla.
    if (/^type\b/.test(trimmed)) continue;
    // `{ type A, type B }` → tüm named öğeler tip → atla (karışık `{ type A, Pool }` ATLANMAZ → Pool değer).
    const named = trimmed.match(/^\{([\s\S]*)\}$/);
    if (named) {
      const items = named[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (items.length > 0 && items.every((it) => /^type\b/.test(it))) continue;
    }
    const base = basePackage(m[3]);
    if (base) out.add(base);
  }
  // 2) Yan-etki / dynamic / CJS: `import "x"` | `import("x")` | `require("x")` (backtick dahil).
  //    Bunlar her zaman DEĞER import'tur (tip-yalnız olamaz).
  const se = /\b(?:require|import)\s*\(?\s*['"`]([^'"`]+)['"`]/g;
  while ((m = se.exec(content)) !== null) {
    const base = basePackage(m[1]);
    if (base) out.add(base);
  }
  return out;
}

/**
 * Dosya sunucu-konvansiyonuyla mı işaretli? .server.* dosya adı veya `server/` yol
 * segmenti → sunucuda koşar (SvelteKit +page.server.ts, Nuxt *.server.vue) → client SAYMA
 * (düşman-gözü K1: Nuxt .server.vue yanlış-bloklanıyordu).
 */
function isServerByConvention(file) {
  const norm = file.replace(/\\/g, "/");
  if (/\.server\.[a-z]+$/i.test(norm)) return true;
  if (/(^|\/)server\//.test(norm)) return true;
  return false;
}

/**
 * `'use client'` direktifi dosyanın GERÇEK ilk ifadesi mi (yorum/string-içi değil)?
 * Next/React spec: direktif modülün EN ÜSTÜnde olmalı. Baştaki whitespace + yorumları
 * sıyır, kalan direktifle BAŞLIYOR mu bak → yorum-bloğundaki / dizi-elemanı / derinlerdeki
 * "use client" string'i yanlış-eşleşmez (düşman-gözü K1: yorum/string FP'leri).
 */
function hasUseClientDirective(content) {
  let s = content.replace(/^\uFEFF/, ""); // BOM
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "");
    s = s.replace(/^\/\/[^\n]*/, ""); // satır yorumu
    s = s.replace(/^\/\*[\s\S]*?\*\//, ""); // blok yorumu
    if (s === before) break;
  }
  return /^['"]use client['"]\s*;?/.test(s);
}

/** Dosya KESİN client mı? .vue|.svelte / "use client" / (RSC-değil + UI import). */
function isDefinitelyClient(file, content, pkgs, rscCapable) {
  if (isServerByConvention(file)) return false; // .server.* / server/ → sunucu
  const ext = extname(file);
  if (ext === ".vue" || ext === ".svelte") return true;
  if (hasUseClientDirective(content)) return true;
  if (!rscCapable) {
    for (const p of pkgs) if (UI_FRAMEWORKS.has(p)) return true; // SPA component
  }
  return false;
}

/** Tek dosyayı kontrol et → ihlal varsa {file, forbidden[]} döndür, yoksa null. */
function checkFile(absFile, rscCapable) {
  let content;
  try {
    if (statSync(absFile).size > 512 * 1024) return null; // çok büyük → atla
    content = readFileSync(absFile, "utf8");
  } catch {
    return null;
  }
  const pkgs = importedPackages(content);
  if (!isDefinitelyClient(absFile, content, pkgs, rscCapable)) return null;
  const forbidden = [...pkgs].filter((p) => DB_DRIVERS.has(p) || SERVER_BUILTINS.has(p));
  return forbidden.length > 0 ? { file: absFile, forbidden } : null;
}

/** Bounded recursive kaynak-dosya toplama (DENY atlar). */
function collectFiles(dir, depth, acc) {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (DENY.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, depth + 1, acc);
    else if (e.isFile() && SRC_EXT.has(extname(e.name))) acc.push(p);
  }
}

try {
  const rscCapable = isRscCapable(projectDir);
  let files;
  if (explicitFiles.length > 0) {
    // Scoped mod: yalnız verilen dosyalar (kaynak-uzantılı + var olanlar).
    files = explicitFiles
      .map((f) => (isAbsolute(f) ? f : join(projectDir, f)))
      .filter((f) => SRC_EXT.has(extname(f)));
  } else {
    files = [];
    collectFiles(projectDir, 0, files);
  }

  const violations = [];
  for (const f of files) {
    const v = checkFile(f, rscCapable);
    if (v) violations.push(v);
  }

  if (violations.length === 0) {
    console.log(
      `architecture: katman ihlali yok (${files.length} dosya tarandı; KESİN-client dosyaları DB-sürücüsü/server-builtin import etmiyor).`,
    );
    process.exit(0);
  }

  console.error("architecture: KATMAN İHLALİ — client (tarayıcı) kodu sunucu-yalnız kaynak import ediyor:");
  for (const v of violations) {
    const rel = isAbsolute(v.file) ? relative(projectDir, v.file) || v.file : v.file;
    console.error(`  • ${rel} → ${v.forbidden.join(", ")} (client dosyası DB-sürücüsü/server-builtin import edemez; veriyi bir API/server katmanı üzerinden çek)`);
  }
  process.exit(1);
} catch (e) {
  // Beklenmeyen → tool_error (runner tool_error_codes ile skip; yanlış-blocking yok).
  console.error("architecture: beklenmeyen hata: " + String(e?.message ?? e));
  process.exit(2);
}
