// verify-feature.test — saf yardımcı testleri. LLM + tarayıcı kısmı
// entegrasyon/manuel; burada sadece deterministik slug üretimi.

import { describe, expect, it } from "vitest";
import {
  buildFailureBugReport,
  containsMocking,
  extractTestTitles,
  slugifyFeature,
} from "../src/verify-feature.js";

describe("verify-feature · slugifyFeature", () => {
  it("Türkçe karakterleri ASCII'ye çevirir + kebab-case", () => {
    expect(slugifyFeature("Anket Oluşturma Sayfası")).toBe(
      "anket-olusturma-sayfasi",
    );
  });

  it("özel karakter + fazla boşluk temizlenir", () => {
    expect(slugifyFeature("Kullanıcı  Girişi!!! (login)")).toBe(
      "kullanici-girisi-login",
    );
  });

  it("İngilizce ifade dokunulmadan kebab", () => {
    expect(slugifyFeature("survey creation")).toBe("survey-creation");
  });

  it("baş/son tire kırpılır", () => {
    expect(slugifyFeature("  -- test --  ")).toBe("test");
  });

  it("tamamen geçersiz girdi → 'ozellik' fallback", () => {
    expect(slugifyFeature("!!!")).toBe("ozellik");
    expect(slugifyFeature("")).toBe("ozellik");
  });

  it("50 karakterle sınırlı", () => {
    const long = "a".repeat(100);
    expect(slugifyFeature(long).length).toBeLessThanOrEqual(50);
  });
});

describe("verify-feature · containsMocking (yanlış-yeşil guard)", () => {
  it("page.route + route.fulfill → true (sahte cevap)", () => {
    const mocked = `
      await page.route('**/api/surveys', route => route.fulfill({ status: 201, body: '{}' }));
      await page.goto('/surveys/create');
    `;
    expect(containsMocking(mocked)).toBe(true);
  });

  it("route.abort / routeFromHAR / mockResponse / vi.mock → true", () => {
    expect(containsMocking("await route.abort()")).toBe(true);
    expect(containsMocking("page.routeFromHAR('x.har')")).toBe(true);
    expect(containsMocking("mockResponse(200)")).toBe(true);
    expect(containsMocking("vi.mock('./api')")).toBe(true);
    expect(containsMocking("jest.mock('./api')")).toBe(true);
  });

  it("temiz E2E (goto/fill/click/expect, mock yok) → false", () => {
    const clean = `
      await page.goto('/surveys/create');
      await page.locator('#question').fill('Soru ' + Date.now());
      await page.locator('button[type=submit]').click();
      await page.goto('/surveys');
      await expect(page.locator('h3', { hasText: 'Soru' })).toBeVisible();
    `;
    expect(containsMocking(clean)).toBe(false);
  });
});

describe("verify-feature · extractTestTitles", () => {
  it("tek + çift tırnak test başlıklarını çıkarır", () => {
    const src = `
      test('sayfa render olur', async ({ page }) => {});
      test("anket oluşturma + listede görünme", async ({ page }) => {});
    `;
    expect(extractTestTitles(src)).toEqual([
      "sayfa render olur",
      "anket oluşturma + listede görünme",
    ]);
  });

  it("test.skip/test.only başlıklarını da çıkarır; test yoksa boş", () => {
    expect(extractTestTitles("test.skip('x', () => {})")).toEqual(["x"]);
    expect(extractTestTitles("// hiç test yok")).toEqual([]);
  });
});

describe("verify-feature · buildFailureBugReport", () => {
  it("özellik + spec yolu + hata + kök-neden yönergesi içerir", () => {
    const r = buildFailureBugReport(
      "anket oluşturma sayfası",
      "tests/anket.spec.ts",
      "Expected: 201 Received: 500",
    );
    expect(r).toContain("anket oluşturma sayfası");
    expect(r).toContain("tests/anket.spec.ts");
    expect(r).toContain("500");
    expect(r).toContain("MOCK KULLANMIYOR");
    expect(r).toMatch(/özellik gerçekten bozuk mu|kök neden/i);
  });

  it("hata özeti boşsa placeholder kullanır", () => {
    const r = buildFailureBugReport("x", "tests/x.spec.ts", "");
    expect(r).toContain("(çıktı yok)");
  });
});
