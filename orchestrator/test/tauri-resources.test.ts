import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Ümit 2026-06-13: paketlenmiş .app, MyCL'in KENDİ .mjs tarama araçlarını (arch-check/csp-check/
// headers-check) ve semgrep kural dizinlerini (security-rules/quality-rules) bundle'a koymadığı için
// Faz 10/13 kapıları çalışma anında "Cannot find module" / exit-7 alıp ATLIYORDU (sahte-yeşil değil ama
// kontrol hiç koşmuyordu). Bu test, kodun okuduğu öz-araç/kural yollarının resources'ta kaldığını GARANTİ
// eder → aynı bug sınıfı sessizce geri gelemez.

const testDir = dirname(fileURLToPath(import.meta.url));
const orchRoot = resolve(testDir, "..");
const repoRoot = resolve(orchRoot, "..");
const conf = JSON.parse(readFileSync(resolve(repoRoot, "src-tauri", "tauri.conf.json"), "utf-8")) as {
  bundle: { resources: string[] };
};
const resources = conf.bundle.resources;

describe("tauri bundle resources — MyCL öz-araçları + kural dosyaları paketlenmeli", () => {
  it("orchestrator kökündeki .mjs öz-araçlar resources globunda", () => {
    // tsc .mjs derlemez → dist'e girmez → resources globu olmadan .app'e KOPYALANMAZ.
    const mjs = readdirSync(orchRoot).filter((f) => f.endsWith(".mjs"));
    expect(mjs).toContain("arch-check.mjs");
    expect(mjs).toContain("csp-check.mjs");
    expect(mjs).toContain("headers-check.mjs");
    expect(resources).toContain("../orchestrator/*.mjs");
  });

  it("güvenlik + kalite semgrep kural dizinleri resources'ta", () => {
    // securityRulePath/qualityRulePath bunları MUTLAK yolla semgrep --config'e verir; bundle'da yoksa exit-7.
    expect(resources).toContain("../assets/security-rules/**/*");
    expect(resources).toContain("../assets/quality-rules/**/*");
  });

  it("orchestrator dist + node_modules (öz-araç bağımlılıkları, örn. csp_evaluator) hâlâ bundle'da", () => {
    expect(resources).toContain("../orchestrator/dist/**/*");
    expect(resources).toContain("../orchestrator/node_modules/**/*");
  });
});
