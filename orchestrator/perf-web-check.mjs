#!/usr/bin/env node
// perf-web-check — çalışan uygulamanın SAYFA PERFORMANS SKORU (Lighthouse) + bütçe kapısı.
//
// NEDEN (2026-08-03): Faz 12 gerçek ölçüm yapmıyordu (MyCL'in kendi şablonu `perf` komutunu build'e
// eşitliyordu). Kullanıcının ürün amacı açıkça "performanslı" olduğu için kapının GERÇEKTEN ölçmesi gerek.
//
// STACK BAĞIMSIZ: hedef projeye hiçbir şey KURULMAZ. Orkestratörün kendi Chromium'u (playwright) +
// kendi lighthouse bağımlılığı kullanılır, çalışan uygulamanın adresine vurulur. Next/Vite/Go/Rails fark etmez.
//
// YANLIŞ ALARM YASAĞI: ilk koşu asla düşmez (temel kaydedilir); düşme yalnız mutlak dip ya da temele göre
// geniş gerileme; ihlalde İKİNCİ ölçüm alınıp medyan kullanılır (tek seferlik dalgalanma düşürmez).
//
// Çıkış: 0 = bütçe içinde / temel kaydedildi · 1 = bütçe aşıldı · 3 = ölçülemedi (atlama, "temiz" DEĞİL)

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.argv[2] ?? process.cwd();
const BUDGET_REL = join(".mycl", "perf-budget.json");
const CANDIDATE_PORTS = [5173, 5174, 4173, 3000, 8080, 4321];
const PROBE_TIMEOUT_MS = 2000;

async function findLiveUrl() {
  for (const port of CANDIDATE_PORTS) {
    const url = `http://localhost:${port}/`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.status < 500) return url;
    } catch {
      /* bu port kapalı — sıradaki */
    }
  }
  return null;
}

const url = await findLiveUrl();
if (!url) {
  process.stdout.write(
    "perf-web: çalışan uygulama bulunamadı (5173/3000/8080… kapalı) — performans ÖLÇÜLEMEDİ, 'temiz' sayılmaz\n",
  );
  process.exit(3);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  process.stdout.write("perf-web: playwright yok — ölçüm yapılamadı\n");
  process.exit(3);
}
let lighthouse;
try {
  ({ default: lighthouse } = await import("lighthouse"));
} catch {
  process.stdout.write("perf-web: lighthouse yok — ölçüm yapılamadı\n");
  process.exit(3);
}

/** Tek ölçüm: Chromium'u uzaktan hata ayıklama portuyla aç, lighthouse ona bağlansın. */
async function measureOnce() {
  const port = 9222 + Math.floor(process.pid % 500);
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  try {
    const runnerResult = await lighthouse(
      url,
      { port, output: "json", logLevel: "error", onlyCategories: ["performance"] },
      undefined,
    );
    const score = runnerResult?.lhr?.categories?.performance?.score;
    return typeof score === "number" ? Math.round(score * 100) : undefined;
  } finally {
    await browser.close().catch(() => {});
  }
}

let score;
try {
  score = await measureOnce();
} catch (e) {
  process.stdout.write(`perf-web: ölçüm başarısız (${String(e).slice(0, 140)}) — 'temiz' sayılmaz\n`);
  process.exit(3);
}
if (score === undefined) {
  process.stdout.write("perf-web: skor üretilemedi — ölçüm YAPILAMADI\n");
  process.exit(3);
}

const budgetPath = join(projectRoot, BUDGET_REL);
const { DEFAULT_PERF_BUDGET, decidePerf, nextBaseline, medianMeasurement } = await import(
  pathToFileURL(join(import.meta.dirname, "dist", "perf-budget.js")).href
);
let budget;
try {
  budget = JSON.parse(await fs.readFile(budgetPath, "utf-8"));
} catch {
  budget = { ...DEFAULT_PERF_BUDGET };
}

// Ölçüm ortamı: geliştirme sunucusu üretim build'inden yavaştır → temeller AYRI tutulur.
let measurement = { score, env: "dev" };
let outcome = decidePerf(measurement, budget);

// YANLIŞ ALARM SAVUNMASI: ihlal göründüyse ikinci ölçüm + medyan (tek seferlik dalgalanma düşürmesin).
if (outcome.kind === "fail") {
  try {
    const second = await measureOnce();
    if (second !== undefined) {
      measurement = medianMeasurement(measurement, { score: second, env: "dev" });
      outcome = decidePerf(measurement, budget);
      process.stdout.write(`perf-web: ikinci ölçüm alındı (${score} ve ${second}) → medyan ${measurement.score}\n`);
    }
  } catch {
    /* ikinci ölçüm alınamadı — ilk sonuç geçerli */
  }
}

if (outcome.kind === "fail") {
  process.stdout.write(
    `perf-web: PERFORMANS BÜTÇESİ AŞILDI (${url})\n` + outcome.reasons.map((r) => `  - ${r}`).join("\n") + "\n",
  );
  process.exit(1);
}

budget.baseline = nextBaseline(measurement, budget);
try {
  await fs.mkdir(join(projectRoot, ".mycl"), { recursive: true });
  await fs.writeFile(budgetPath, JSON.stringify(budget, null, 2) + "\n", "utf-8");
} catch (e) {
  process.stdout.write(`perf-web: uyarı — bütçe dosyası yazılamadı (${String(e).slice(0, 80)})\n`);
}
process.stdout.write(
  `perf-web: ${outcome.kind === "baseline_recorded" ? "temel kaydedildi" : "bütçe içinde"} — ` +
    `sayfa performans skoru ${measurement.score}/100 (${url})\n`,
);
process.exit(0);
