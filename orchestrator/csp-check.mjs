#!/usr/bin/env node
// csp-check.mjs — Faz 13 güvenlik gate'i için CSP değerlendirici (güvenlik-baseline Unit 1).
//
// Google'ın csp_evaluator paketi (CJS, orchestrator/node_modules) ile projenin
// Content-Security-Policy politikasını değerlendirir — Chrome "CSP Evaluator"
// extension'ının yaptığı analizin OTOMATİK/headless karşılığı. harness.mjs gibi
// orchestrator kökünde durur (tsc derlemez); phase-registry extra_scan'i MUTLAK
// yolla `node <abs>/csp-check.mjs` çağırır (runner cwd=hedef-proje).
//
// KAPSAM (Unit 1, false-positive-free): kaynak-tabanlı. Yalnız index.html meta
// CSP'sini değerlendirir; GERÇEK kötü policy bulursa fail eder. Statik bulunamayan
// CSP (helmet/runtime/custom middleware) → GÖRÜNÜR atlama, fail DEĞİL (kesin
// header-tabanlı değerlendirme sonraki turda — çalışan sunucuya bağlanır).
//
// Eşik (Ümit 2026-06-04 "MEDIUM da bloklasın"): csp_evaluator severity'de DÜŞÜK
// sayı = DAHA KÖTÜ (HIGH=10, SYNTAX=20, MEDIUM=30, HIGH_MAYBE=40, STRICT_CSP=45,
// MEDIUM_MAYBE=50, INFO=60, NONE=100). Blocking = severity <= 40 (HIGH/SYNTAX/
// MEDIUM/HIGH_MAYBE). STRICT_CSP(45 — nonce/strict-dynamic ÖNERİSİ) ve üstü uyarı,
// fail değil (yoksa güçlü policy'ler yanlış fail ederdi — inverted-threshold tuzağı).
//
// Exit: 0 = yeşil / not-applicable / statik-değerlendirilemedi (görünür not);
//       1 = blocking CSP bulgusu; 2 = fail-closed (csp_evaluator import edilemedi
//       = orchestrator bağımlılığı eksik, sessiz yeşil GEÇME).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function argVal(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const explicitPolicy = argVal("policy");
const projectDir = argVal("project") || process.cwd();

// csp_evaluator orchestrator-bundle — eksikse BUG, sessiz skip DEĞİL (fail-closed).
let CspParser, CspEvaluator;
try {
  ({ CspParser } = require("csp_evaluator/dist/parser.js"));
  ({ CspEvaluator } = require("csp_evaluator/dist/evaluator.js"));
} catch (e) {
  console.error(
    "csp-check: csp_evaluator import edilemedi (orchestrator bağımlılığı eksik — bug, sessiz geçilmez): " +
      String(e?.message ?? e),
  );
  process.exit(2);
}

const BLOCK_THRESHOLD = 40; // severity <= 40 → blocking (HIGH/SYNTAX/MEDIUM/HIGH_MAYBE)

function reportAndExit(policy, src) {
  const parsed = new CspParser(policy).csp;
  const findings = new CspEvaluator(parsed).evaluate();
  const blocking = findings.filter((f) => f.severity <= BLOCK_THRESHOLD);
  console.log(`csp-check: policy kaynağı = ${src}`);
  for (const f of findings) {
    const tag = f.severity <= BLOCK_THRESHOLD ? "BLOCK" : "uyarı";
    console.log(`  [${tag}] sev=${f.severity} ${f.directive}: ${String(f.description).slice(0, 110)}`);
  }
  if (blocking.length > 0) {
    console.error(
      `csp-check: ${blocking.length} blocking CSP bulgusu (severity<=${BLOCK_THRESHOLD}). CSP düzeltilmeli.`,
    );
    process.exit(1);
  }
  console.log("csp-check: CSP yeşil (blocking bulgu yok).");
  process.exit(0);
}

// 1) Açık policy (test + override yolu) — statik, deterministik.
if (explicitPolicy !== undefined) reportAndExit(explicitPolicy, "--policy");

// 2) Auto: web-UI tespiti (web framework / index.html). Değilse CSP uygulanamaz.
let pkg = null;
try {
  pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
} catch {
  /* package.json yok — node-dışı proje olabilir */
}
const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
const WEB_FRAMEWORKS = [
  "vite", "next", "react-scripts", "@vue/cli-service", "@angular/core",
  "nuxt", "astro", "@sveltejs/kit", "webpack",
];
const hasWebFramework = WEB_FRAMEWORKS.some((d) => d in deps);

const HTML_CANDIDATES = ["index.html", "public/index.html", "src/index.html", "app/index.html", "dist/index.html"];
const htmlPath = HTML_CANDIDATES.map((p) => join(projectDir, p)).find((p) => existsSync(p));
const isWebUi = hasWebFramework || Boolean(htmlPath);

if (!isWebUi) {
  console.log("csp-check: web-UI değil (web framework / index.html yok) — CSP uygulanamaz, atlandı.");
  process.exit(0);
}

// 3) index.html meta CSP'sini çıkar + değerlendir (kaynak-tabanlı, kesin).
function metaCspFromHtml(p) {
  try {
    const html = readFileSync(p, "utf8");
    const m = html.match(
      /<meta[^>]*http-equiv=["']content-security-policy["'][^>]*content=["']([^"']+)["']/i,
    );
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
const metaPolicy = htmlPath ? metaCspFromHtml(htmlPath) : null;
if (metaPolicy) reportAndExit(metaPolicy, `index.html meta (${htmlPath})`);

// 4) Web-UI ama statik CSP bulunamadı (helmet/runtime/custom middleware) → kesin
//    değerlendirme çalışan sunucu/header gerektirir (sonraki tur). FALSE-FAIL
//    riski almamak için fail DEĞİL, GÖRÜNÜR atlama (sessiz yeşil değil — not basılır).
const hasHelmet = ["helmet", "@fastify/helmet", "koa-helmet"].some((d) => d in deps);
console.log(
  hasHelmet
    ? "csp-check: helmet tespit edildi; CSP runtime'da kuruluyor → statik değerlendirilemedi (header-tabanlı değerlendirme sonraki turda). Görünür atlama."
    : "csp-check: web-UI ama statik CSP (index.html meta) bulunamadı → header-tabanlı değerlendirme sonraki turda. Görünür atlama.",
);
process.exit(0);
