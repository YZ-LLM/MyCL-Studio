#!/usr/bin/env node
// osv-scan — bağımlılık zafiyeti taraması, STACK BAĞIMSIZ (osv-scanner sarmalayıcısı).
//
// NEDEN (2026-08-03): Faz 13'ün ana komutu stack profilinden geliyor (npm audit / pip-audit / cargo audit …)
// ve dört stack'te (dart/deno/flutter/swift) TANIMLI DEĞİL → o projelerde bağımlılık zafiyeti hiç
// taranmıyordu. osv-scanner tek araçla pubspec.lock, Package.resolved, composer.lock, go.mod, Cargo.lock,
// package-lock.json, requirements.txt, mix.lock, pom.xml … okur → boşluğu gerçekten kapatır.
//
// SAHTE TEMİZ KORUMASI (nuclei dersi): "0 bulgu" iki farklı şey olabilir — (a) gerçekten temiz,
// (b) hiçbir kilit dosyası tanınmadı. İkisini karıştırmak sessiz sahte yeşildir. Bu yüzden ham komut
// yerine bu sarmalayıcı: hiçbir kaynak taranmadıysa exit 3 (kapı bunu ATLAMA sayar, "geçti" DEĞİL).
//
// Çıkış kodları: 0 = tarandı ve temiz · 1 = zafiyet bulundu · 3 = taranacak kilit dosyası yok (atlama)
//                127 = araç kurulu değil (mekanik runner bunu "aracı kur" işine çevirir)
import { spawnSync } from "node:child_process";

const projectRoot = process.argv[2] ?? process.cwd();

const probe = spawnSync("osv-scanner", ["--version"], { encoding: "utf-8" });
if (probe.error) {
  process.stderr.write("osv-scanner: command not found\n");
  process.exit(127);
}

// stderr KRİTİK: osv-scanner "0 bulgu" ile "0 kaynak tarandı"yı JSON'da AYIRT ETMİYOR — ikisinde de
// `results: []` döner (ampirik olarak doğrulandı: temiz npm projesi de boş results verir). Gerçek sinyal
// stderr'deki "Scanned <dosya> file and found N packages" satırlarıdır. Bu ayrım olmadan TEMİZ bir proje
// kalıcı olarak "ölçülemedi" (sarı) görünürdü — kapatmaya çalıştığımız boşluğun aynısı.
const res = spawnSync(
  "osv-scanner",
  ["scan", "source", "--recursive", "--format", "json", projectRoot],
  { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
);
if (res.error) {
  process.stderr.write(`osv-scanner çalıştırılamadı: ${res.error.message}\n`);
  process.exit(127);
}

let parsed;
try {
  parsed = JSON.parse(res.stdout || "{}");
} catch {
  // Çıktı ayrıştırılamadı → "temiz" DEME (fail-closed): araç sorunu olarak atlama bildir.
  process.stderr.write(`osv-scanner çıktısı ayrıştırılamadı (ilk 300): ${(res.stdout || "").slice(0, 300)}\n`);
  process.exit(3);
}

const results = Array.isArray(parsed.results) ? parsed.results : [];
// Gerçekten kaç kaynak tarandı? (stderr'den — JSON bunu söylemiyor)
const scannedLines = (res.stderr || "").split("\n").filter((l) => /Scanned .* found \d+ package/i.test(l));
const scannedSources = scannedLines.map((l) => {
  const m = /Scanned (.+?) file and found/i.exec(l);
  return m?.[1]?.split("/").slice(-1)[0] ?? "?";
});
const findings = results.flatMap((r) =>
  (Array.isArray(r.packages) ? r.packages : []).flatMap((p) =>
    (Array.isArray(p.vulnerabilities) ? p.vulnerabilities : []).map((v) => ({
      pkg: p.package?.name ?? "?",
      version: p.package?.version ?? "?",
      id: v.id ?? "?",
      summary: (v.summary ?? "").slice(0, 120),
    })),
  ),
);

if (scannedSources.length === 0) {
  // SAHTE TEMİZ KORUMASI: hiçbir kaynak/kilit dosyası tanınmadı → tarama YAPILMADI say ("temiz" DEĞİL).
  process.stdout.write("osv-scanner: taranacak bağımlılık kilidi bulunamadı (bu proje için kaynak tanınmadı)\n");
  process.exit(3);
}

if (findings.length === 0) {
  process.stdout.write(
    `osv-scanner: temiz — ${scannedSources.length} bağımlılık kaynağı tarandı (${scannedSources.join(", ")})\n`,
  );
  process.exit(0);
}

const bySeverity = new Map();
for (const f of findings) bySeverity.set(f.id, f);
process.stdout.write(
  `osv-scanner: ${findings.length} zafiyet bulundu (${scannedSources.length} kaynak)\n` +
    [...bySeverity.values()]
      .slice(0, 40)
      .map((f) => `  - ${f.pkg}@${f.version}: ${f.id} ${f.summary}`)
      .join("\n") +
    "\n",
);
process.exit(1);
