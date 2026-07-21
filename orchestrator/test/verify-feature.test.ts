// verify-feature.test — saf yardımcı testleri. LLM + tarayıcı kısmı
// entegrasyon/manuel; burada sadece deterministik slug üretimi.

import { describe, expect, it } from "vitest";
import {
  buildBugGateSystemPrompt,
  buildFailureBugReport,
  containsMocking,
  extractTestTitles,
  hasSubstantiveTest,
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

describe("verify-feature · hasSubstantiveTest (MAHKEME BULGU 2 — vacuous-test guard)", () => {
  it("gerçek expect içeren test → true", () => {
    const real = `
      test('profil arama sonuç döner', async ({ page }) => {
        await page.goto('/profile');
        await page.locator('#search').fill('Ali');
        await page.locator('button[type=submit]').click();
        await expect(page.locator('table tbody tr')).not.toHaveCount(0);
      });`;
    expect(hasSubstantiveTest(real)).toBe(true);
  });

  it("hiç expect yok (vacuous) → false", () => {
    const noAssert = `
      test('sayfa açılıyor', async ({ page }) => {
        await page.goto('/profile');
        await page.locator('#search').fill('Ali');
      });`;
    expect(hasSubstantiveTest(noAssert)).toBe(false);
  });

  it("test.skip / test.fixme / describe.skip → false (atlanmış = doğrulama değil)", () => {
    expect(hasSubstantiveTest("test.skip('x', async () => { await expect(1).toBe(1); })")).toBe(false);
    expect(hasSubstantiveTest("test.fixme('x', async () => { await expect(1).toBe(1); })")).toBe(false);
    expect(hasSubstantiveTest("describe.skip('grp', () => { test('y', () => expect(2).toBe(2)) })")).toBe(false);
  });

  it("test.only (atlamaz, çalışır) + expect → true", () => {
    expect(hasSubstantiveTest("test.only('x', async () => { await expect(page).toHaveURL('/x'); })")).toBe(true);
  });

  it("expect.soft( / expect.poll( (Playwright) → true (gerçek assertion, MAHKEME v2)", () => {
    expect(hasSubstantiveTest("expect.soft(await page.locator('tr').count()).toBeGreaterThan(0)")).toBe(true);
    expect(hasSubstantiveTest("await expect.poll(() => page.locator('tr').count()).toBeGreaterThan(0)")).toBe(true);
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

describe("verify-feature · buildBugGateSystemPrompt (gerçek-app doğrulama)", () => {
  const prompt = buildBugGateSystemPrompt(
    "The /profile customer search returns empty for a valid same-day range + name",
    "bug-profile-search",
    "app structure snapshot here",
    false,
    { rootCause: "buildCustomerSearchQuery over-constrains the range", fixLabel: "widen date range boundary" },
  );

  it("bildirilen bug'ı İngilizce enjekte eder + kök neden + fix etiketi bağlamı", () => {
    expect(prompt).toContain("/profile customer search returns empty");
    expect(prompt).toContain("buildCustomerSearchQuery over-constrains");
    expect(prompt).toContain("widen date range boundary");
  });

  it("MOCK YASAK + hedef test yolu + '// MyCL generated E2E' ilk satır kuralı içerir", () => {
    expect(prompt).toMatch(/NO MOCKING/i);
    expect(prompt).toContain("page.route");
    expect(prompt).toContain("tests/bug-profile-search.spec.ts");
    expect(prompt).toContain("// MyCL generated E2E");
  });

  it("bug hâlâ varsa KIRMIZI bırak (sahte-yeşil yasağı) + 'empty may BE the bug' mantığı", () => {
    expect(prompt).toMatch(/leave the test RED|do NOT weaken/i);
    expect(prompt).toMatch(/Empty may BE the bug/i);
  });

  it("auth yoksa kimlik-bilgisi yok uyarısı; auth varsa .mycl/auth.json yönergesi", () => {
    expect(prompt).toMatch(/No login credentials configured/i);
    const authed = buildBugGateSystemPrompt("bug x", "slug-x", "snap", true, {});
    expect(authed).toContain(".mycl/auth.json");
  });

  it("kanıtlayamıyorsa dosya YAZMAMA yönergesi (sahte-test üretme)", () => {
    expect(prompt).toMatch(/DO NOT fabricate a test and DO NOT write the file/i);
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
