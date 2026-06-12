// regression-diff — fix öncesi/sonrası fail farkı. Parser TUTARLI olmalı (mükemmel değil); fark yeni kırılmayı verir.

import { describe, expect, it } from "vitest";
import { parseFailures, computeRegression } from "../src/regression-diff.js";

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
    // ANSI soyulmazsa '^\s*[×]' eşleşmez → 0 fail → baseline=null → regresyon-farkı çöker (Ümit'in gördüğü hata).
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
  // Ümit'in GERÇEK adminpanel senaryosu: fix users-me ekledi (geçti); suite önceden 18+2 kırıktı (alakasız).
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
