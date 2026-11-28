// regression-diff — fix öncesi/sonrası fail farkı. Parser TUTARLI olmalı (mükemmel değil); fark yeni kırılmayı verir.

import { describe, expect, it } from "vitest";
import { parseFailures, computeRegression, baselineFromRun, regressionVerdict, testFailureDigest, withoutTestNamesLine } from "../src/regression-diff.js";

describe("regression-diff · parseFailures", () => {
  it("vitest '×' satırlarını + 'FAIL dosya'yı yakalar, süreyi (5ms) soyar", () => {
    const out = [
      " × backend/youtube-url-admin.integration.test.js > YouTube URL Admin > AC4: invalid (400) 5ms",
      " × src/components/Navigation.test.jsx > Navigation - AC1 > renders menu 13ms",
      " ✓ backend/users-me.integration.test.js > GET /api/users/me [AC1] 9ms",
      " FAIL  tests/integration/example.test.js [ tests/integration/example.test.js ]",
    ].join("\n");
    const f = parseFailures(out);
    expect(f.has("backend/youtube-url-admin.integration.test.js > YouTube URL Admin > AC4: invalid (400)")).toBe(true);
    expect(f.has("src/components/Navigation.test.jsx > Navigation - AC1 > renders menu")).toBe(true);
    expect(f.has("tests/integration/example.test.js [ tests/integration/example.test.js ]")).toBe(true);
    // ✓ (geçen) yakalanmaz
    expect([...f].some((x) => x.includes("users-me"))).toBe(false);
  });

  it("ANSI renk kodlu çıktıdan da fail çıkarır (execAsync/npm test gerçeği — KÖK NEDEN)", () => {
    // MyCL execAsync ile koşunca vitest RENKLİ basar: ' ESC[31m×ESC[39m suite ESC[2m > ESC[22m test ESC[2m5msESC[22m'.
    // ANSI soyulmazsa '^\s*[×]' eşleşmez → 0 fail → baseline=null → regresyon-farkı çöker (YZLLM'in gördüğü hata).
    const E = String.fromCharCode(27);
    const out = [
      ` ${E}[31m×${E}[39m backend/youtube-url-admin.integration.test.js${E}[2m > ${E}[22mYouTube URL Admin > AC4 invalid${E}[2m 5ms${E}[22m`,
      ` ${E}[32m✓${E}[39m backend/users-me.integration.test.js > GET /api/users/me [AC1]`,
      `${E}[31m FAIL ${E}[39m tests/integration/example.test.js`,
    ].join("\n");
    const f = parseFailures(out);
    expect([...f].some((x) => x.includes("youtube-url-admin") && x.includes("AC4"))).toBe(true);
    expect(f.has("tests/integration/example.test.js")).toBe(true);
    expect([...f].some((x) => x.includes("users-me"))).toBe(false); // ✓ geçen yakalanmaz
    expect([...f].every((x) => !x.includes(E))).toBe(true); // hiçbir kimlikte ESC kalmamalı
  });

  it("pytest FAILED ve go --- FAIL desenleri", () => {
    const out = ["FAILED tests/test_x.py::test_y", "--- FAIL: TestFoo (0.00s)"].join("\n");
    const f = parseFailures(out);
    expect(f.has("tests/test_x.py::test_y")).toBe(true);
    expect(f.has("TestFoo")).toBe(true);
  });
});

describe("regression-diff · computeRegression", () => {
  // YZLLM'in GERÇEK adminpanel senaryosu: fix users-me ekledi (geçti); suite önceden 18+2 kırıktı (alakasız).
  // Fix YENİ kırılma yapmadı → regressed boş → gate GEÇMELİ (eski hali yanlışlıkla fail+rollback+eskalasyon yapıyordu).
  it("önceden-var kırmızılar değişmeden kalırsa regresyon YOK", () => {
    const baseline = new Set(["youtube > AC4", "navigation > AC1", "example.test.js"]);
    const after = new Set(["youtube > AC4", "navigation > AC1", "example.test.js"]);
    const r = computeRegression(baseline, after);
    expect(r.regressed).toEqual([]);
    expect(r.preExistingCount).toBe(3);
  });

  it("fix önceden-geçen bir testi kırarsa = REGRESYON", () => {
    const baseline = new Set(["youtube > AC4"]); // navigation geçiyordu
    const after = new Set(["youtube > AC4", "navigation > AC1"]); // şimdi navigation düştü
    const r = computeRegression(baseline, after);
    expect(r.regressed).toEqual(["navigation > AC1"]);
  });

  it("fix önceden-kırık bir testi DÜZELTİRSE regresyon değil (azalma)", () => {
    const baseline = new Set(["youtube > AC4", "navigation > AC1"]);
    const after = new Set(["youtube > AC4"]); // navigation artık geçiyor
    const r = computeRegression(baseline, after);
    expect(r.regressed).toEqual([]);
    expect(r.preExistingCount).toBe(1);
  });

  it("yeşil baseline (boş) → sonra herhangi bir fail = regresyon", () => {
    const r = computeRegression(new Set(), new Set(["x > y"]));
    expect(r.regressed).toEqual(["x > y"]);
  });
});

// 2026-11-28 (koşu 32): takım düzeltmeden önce de 4 kırık testle kırmızıydı; Faz 10 lint düzeltmesinden sonra regresyon
// guard "başka testleri bozdu" dedi ve akış ikinci bir Faz 9'a döndü.
describe("regressionVerdict — düzeltme öncesi temele göre hüküm", () => {
  const kirik4 = ["× a > t1", "× a > t2", "× b > t3", "× b > t4"].join("\n");
  it("temel yeşil: yeşil → green; ayrıştırılan kırık → new", () => {
    const base = baselineFromRun(0, "");
    expect(base).toEqual({ failures: new Set(), green: true });
    expect(regressionVerdict(base, 0, "")).toEqual({ kind: "green" });
    expect(regressionVerdict(base, 1, "× a > t1")).toEqual({ kind: "new", regressed: ["a > t1"], preExisting: 0 });
  });
  it("koşu 32: önceden kırık 4 test, sonra aynı 4 → no-new (düşmez)", () => {
    const base = baselineFromRun(1, kirik4);
    expect(base?.failures.size).toBe(4);
    expect(regressionVerdict(base, 1, kirik4)).toEqual({ kind: "no-new", preExisting: 4 });
  });
  it("önceden kırık 4 + yeni 1 → new, yalnız yenisinin adı", () => {
    const base = baselineFromRun(1, kirik4);
    expect(regressionVerdict(base, 1, `${kirik4}\n× c > t5`)).toEqual({ kind: "new", regressed: ["c > t5"], preExisting: 4 });
  });
  it("yeşil temeldeki tutarlı gürültü satırı sonraki koşuda yeni kırık sayılmaz (Faz 8'in eski kuralı)", () => {
    const base = baselineFromRun(0, "FAIL fixtures/ornek.txt");
    expect(base?.failures.has("fixtures/ornek.txt")).toBe(true);
    expect(regressionVerdict(base, 1, "FAIL fixtures/ornek.txt")).toEqual({ kind: "no-new", preExisting: 1 });
  });
  it("ayrıştırılamayan çıktı → mutlak (temel null ya da sonraki çıktı boş)", () => {
    expect(baselineFromRun(1, "bir şeyler patladı")).toBeNull();
    expect(regressionVerdict(null, 1, kirik4)).toEqual({ kind: "absolute" });
    expect(regressionVerdict(baselineFromRun(1, kirik4), 1, "anlaşılmaz çıktı")).toEqual({ kind: "absolute" });
  });
});

describe("regression-diff · testFailureDigest (koşu 37)", () => {
  it("kırık test adlarıyla başlar; stderr'deki günlükler kırığı örtmez", () => {
    const stderr = "stderr | tests/integration/log-error.test.ts > accepts a report\n" + "console.error noise\n".repeat(400);
    const stdout = " × items > returns 'False' string 12ms\n Test Files  1 failed | 9 passed";
    const d = testFailureDigest(stdout, stderr);
    expect(d.startsWith("Kırık testler (1): items > returns 'False' string")).toBe(true);
    expect(d).toContain("[stdout sonu]");
    expect(d).toContain("1 failed | 9 passed");
    expect(d.length).toBeLessThan(1500);
  });
  it("ad ayrışmazsa başı ve sonu verir", () => {
    const d = testFailureDigest("x".repeat(2000) + "END", "");
    expect(d.startsWith("Kırık test adı ayrıştırılamadı")).toBe(true);
    expect(d).toContain("[stdout başı]");
    expect(d).toContain("END");
  });
  it("ortam izi satırları ad satırının ardına konur; uzun çıktıda toplam 1500'ü aşmaz", () => {
    const names = Array.from({ length: 20 }, (_, i) => ` × suite${i} > a fairly long failing test name number ${i} 3ms`).join("\n");
    const d = testFailureDigest(names + "\n" + "o".repeat(3000), "e".repeat(3000) + "SUMMARY", [
      "Error: connect ECONNREFUSED 127.0.0.1:5432",
    ]);
    expect(d.startsWith("Kırık testler (20):")).toBe(true);
    expect(d).toContain("[ortam izi]\nError: connect ECONNREFUSED 127.0.0.1:5432");
    expect(d.length).toBeLessThan(1500);
    expect(d.slice(0, 1500)).toContain("SUMMARY");
  });
  it("hesap/ortam denetimi ad satırını okumaz, çıktının kendisini okur", () => {
    const d = testFailureDigest(" × billing > computes invoice total 2ms", "");
    const cleaned = withoutTestNamesLine(d);
    expect(cleaned).not.toContain("Kırık testler");
    expect(cleaned).toContain("[stdout sonu]");
  });
});

