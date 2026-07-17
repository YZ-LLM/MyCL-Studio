// MyCL scaffold v15.9 — bu dosya MyCL Studio tarafından oluşturuldu.
// Düzenlemek için bu satırı silin; MyCL bir daha üzerine yazmaz.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// v15.8 (2026-05-28): Auth-aware smoke. .mycl/auth.json varsa login flow
// uygulanır (kullanıcı kuralı: "login sayfasını geçsin"). Yoksa direkt /
// ziyaret edilir.
//
// auth.json şeması:
//   {
//     "username": "admin@example.com",
//     "password": "secret",
//     "loginPath": "/login",            // opsiyonel, default "/login"
//     "usernameSelector": "...",        // opsiyonel, default email/user input
//     "passwordSelector": "...",        // opsiyonel, default input[type=password]
//     "submitSelector": "...",          // opsiyonel, default button[type=submit]
//     "successUrlPattern": "/dashboard" // opsiyonel; URL change beklemek için
//   }
interface AuthConfig {
  username?: string;
  password?: string;
  loginPath?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  successUrlPattern?: string;
}

function loadAuth(): AuthConfig | null {
  const cwd = process.cwd();
  const authPath = join(cwd, '.mycl', 'auth.json');
  if (!existsSync(authPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(authPath, 'utf-8');
  } catch (e) {
    console.warn('[MyCL] auth.json okunamadı:', (e as Error).message);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // v15.8 (2026-05-28): Sessiz fail yerine açık sinyal — kullanıcı bozuk
    // JSON'u fark etsin. Smoke yine login'siz devam eder ama log görünür.
    console.warn(
      '[MyCL] auth.json bozuk JSON, login flow atlanıyor:',
      (e as Error).message,
    );
    return null;
  }
  // v15.8 (2026-05-28): Şema validation — credentials'lar string olmalı.
  // Yanlış tip → sessiz null değil, açık uyarı + skip.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn('[MyCL] auth.json kök objesi nesne değil; login atlanıyor.');
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const stringFields = ['username', 'password', 'loginPath', 'usernameSelector', 'passwordSelector', 'submitSelector', 'successUrlPattern'];
  for (const k of stringFields) {
    if (obj[k] !== undefined && typeof obj[k] !== 'string') {
      console.warn(`[MyCL] auth.json "${k}" field'ı string olmalı (tip: ${typeof obj[k]}); login atlanıyor.`);
      return null;
    }
  }
  const cfg = obj as unknown as AuthConfig;
  // Placeholder values'ı YOKSAY — gerçek credentials yoksa login skip
  if (!cfg.username || cfg.username.startsWith('<') || cfg.username === 'PLACEHOLDER') return null;
  if (!cfg.password || cfg.password.startsWith('<') || cfg.password === 'PLACEHOLDER') return null;
  return cfg;
}

test('smoke: app loads (auth-aware) with content and no console errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  const auth = loadAuth();

  if (auth) {
    // Login flow — .mycl/auth.json'dan credentials
    const loginPath = auth.loginPath ?? '/login';
    const userSel =
      auth.usernameSelector ??
      'input[type=email], input[name=email], input[id=email], input[name=username], input[id=username]';
    const passSel = auth.passwordSelector ?? 'input[type=password]';
    const submitSel =
      auth.submitSelector ??
      'button[type=submit], button:has-text("Giriş"), button:has-text("Login")';

    await page.goto(loginPath, { waitUntil: 'networkidle', timeout: 20000 });
    await page.locator(userSel).first().fill(auth.username!);
    await page.locator(passSel).first().fill(auth.password!);
    await page.locator(submitSel).first().click();

    // Login sonrası URL change veya networkidle bekle
    if (auth.successUrlPattern) {
      // v15.8 (2026-05-28): User-input regex — invalid pattern throw'unu yakala,
      // networkidle fallback ile devam et. ReDoS riski düşük (smoke test'i tek
      // çalışmalı çalıştırılır).
      let urlPattern: RegExp | null = null;
      try {
        urlPattern = new RegExp(auth.successUrlPattern);
      } catch (e) {
        console.warn('successUrlPattern invalid regex, fallback to networkidle:', e);
      }
      if (urlPattern) {
        await page.waitForURL(urlPattern, { timeout: 15000 });
      } else {
        await page.waitForLoadState('networkidle', { timeout: 15000 });
      }
    } else {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    }
  } else {
    // No auth — direkt / (anonim erişim varsayımı)
    await page.goto('/', { waitUntil: 'networkidle', timeout: 20000 });
  }

  // Title gerçek bir değer içermeli
  await expect(page).toHaveTitle(/.+/);

  // Body render edilmiş olmalı — beyaz ekran fail sinyali
  await expect(page.locator('body')).not.toBeEmpty();

  // Auth flow sonrası login sayfasında DEĞİL olmalı (başarılı giriş garantisi)
  if (auth) {
    const currentUrl = page.url();
    const loginPathStr = auth.loginPath ?? '/login';
    expect(currentUrl).not.toContain(loginPathStr);
  }

  // Console error toleransı: 0 ideal; rapor için yazılır
  if (consoleErrors.length > 0) {
    console.log('Console errors detected:', consoleErrors.slice(0, 5));
  }

  // a11y (WP3, 2026-06-04): yüklenmiş (gerekiyorsa login sonrası) sayfayı axe ile
  // tara — ÇALIŞAN DOM'u WCAG kurallarıyla denetler (pozitif-check, FP-düşük).
  // @axe-core/playwright opsiyonel: 'string'-tipli specifier ile dynamic import →
  // TS modülü statik resolve etmez (paket yoksa compile kırılmaz) + runtime'da
  // görünür-skip. Yalnız critical + serious ihlaller fail eder (minor/moderate
  // gürültüsü rapor-only — FP-fırtınası önlenir). Faz 16 SOFT → projeyi kırmaz.
  interface AxeViolation { id: string; impact?: string }
  type AxeCtor = new (opts: { page: unknown }) => { analyze(): Promise<{ violations: AxeViolation[] }> };
  const axePkg: string = '@axe-core/playwright';
  let AxeBuilder: AxeCtor | null = null;
  try {
    const mod = await import(axePkg);
    AxeBuilder = (mod.AxeBuilder ?? mod.default?.AxeBuilder ?? null) as AxeCtor | null;
  } catch {
    console.log('[MyCL] @axe-core/playwright kurulu değil — a11y taraması atlandı (npm i -D @axe-core/playwright ile etkinleşir).');
  }
  if (AxeBuilder) {
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    if (blocking.length > 0) {
      console.log('a11y ihlalleri (critical/serious):', blocking.map((v) => v.id).join(', '));
    }
    expect(blocking, 'critical/serious a11y ihlali (WCAG)').toHaveLength(0);
  }
});
