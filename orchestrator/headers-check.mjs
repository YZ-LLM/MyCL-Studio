#!/usr/bin/env node
// headers-check.mjs — güvenlik HTTP başlıkları kontrolü (STATİK, deps + kaynak tarama).
//
// Canlı dev-server'a BAKMAZ (dev server'lar prod güvenlik-header'larını koymaz → yanlış-fail
// olurdu). Bunun yerine: HTTP backend var mı (express/fastify/koa/nest/next) + güvenlik-header
// middleware'i (helmet ailesi) ya da MANUEL header ayarı var mı? Statik SPA (backend yok) →
// güvenlik-header'ları host/serve katmanının işi → atlandı (uygulanamaz). csp-check.mjs gibi
// orchestrator kökü .mjs; Faz 13 extra_scan MUTLAK yolla çağırır (runner cwd=hedef-proje).
//
// Exit: 0 = geçti / uygulanamaz (atla); 1 = backend var ama güvenlik-header YOK (bulgu);
//       2 = beklenmeyen hata (tool_error_codes ile skip → yanlış-blocking yapmaz).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function argVal(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const projectDir = argVal("project") || process.cwd();

const DENY = new Set([
  "node_modules", "dist", "build", ".git", ".mycl", "coverage", ".next", "out", "tmp",
]);
const BACKEND = ["express", "fastify", "koa", "@nestjs/core", "hapi", "@hapi/hapi", "next"];
const HELMET = ["helmet", "@fastify/helmet", "koa-helmet"];
// Manuel header ayarı / helmet kullanımı işaretleri (kaynak taramada).
const HEADER_HINTS = [
  "helmet(",
  "strict-transport-security",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "contentsecuritypolicy",
];

try {
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
  } catch {
    console.log("security-headers: package.json yok — uygulanamaz, atlandı.");
    process.exit(0);
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const backend = BACKEND.filter((d) => d in deps);
  if (backend.length === 0) {
    console.log(
      "security-headers: HTTP backend yok (statik SPA → güvenlik header'ları host/serve katmanının işi) — atlandı.",
    );
    process.exit(0);
  }
  if (HELMET.some((h) => h in deps)) {
    console.log("security-headers: helmet (güvenlik-header middleware) bağımlılığı bulundu — geçti.");
    process.exit(0);
  }

  // helmet dep yok → kaynakta manuel header ayarı / next headers() var mı (FP azalt).
  const found = scanForHints(projectDir, 0);
  if (found) {
    console.log("security-headers: kaynakta manuel güvenlik-header ayarı bulundu — geçti.");
    process.exit(0);
  }

  console.error(
    `security-headers: HTTP backend (${backend.join(",")}) var ama güvenlik-header middleware (helmet) ` +
      "veya manuel header ayarı YOK — HSTS / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / " +
      "Permissions-Policy ekle (Express/Koa→helmet, Fastify→@fastify/helmet, Next→next.config headers()).",
  );
  process.exit(1);
} catch (e) {
  // Beklenmeyen → tool_error (runner tool_error_codes:[2] ile skip; yanlış-blocking yok).
  console.error("security-headers: beklenmeyen hata: " + String(e?.message ?? e));
  process.exit(2);
}

/** Kaynak dosyalarda güvenlik-header işareti var mı (bounded recursive, DENY atlar). */
function scanForHints(dir, depth) {
  if (depth > 6) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (DENY.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (scanForHints(p, depth + 1)) return true;
    } else if (e.isFile() && /\.(js|ts|mjs|cjs|jsx|tsx)$/.test(e.name)) {
      try {
        if (statSync(p).size > 512 * 1024) continue; // çok büyük dosya atla
        const lower = readFileSync(p, "utf8").toLowerCase();
        if (HEADER_HINTS.some((h) => lower.includes(h))) return true;
      } catch {
        /* okunamadı → atla */
      }
    }
  }
  return false;
}
