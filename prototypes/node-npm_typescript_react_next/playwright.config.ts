// MyCL scaffold v15.9 — bu dosya MyCL Studio tarafından oluşturuldu.
// Düzenlemek için bu satırı silin; MyCL bir daha üzerine yazmaz.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Only collect Playwright E2E specs (*.spec.ts). The default testMatch also
  // grabs *.test.ts, but those are Vitest unit/integration tests that import
  // `vitest` at top level; loading them under Playwright throws "Vitest failed
  // to access its internal state". Mirrors the inverse exclusion in
  // vitest.config.ts so each runner owns its own files.
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  // Önden-doğru: E2E öncesi dev server'ı otomatik ayağa kaldır (ayaktaysa reuse).
  webServer: {
    command: "npm run dev",
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
    env: { PORT: '5173' },
  },
  // v15.7 (2026-05-27): Kullanıcı kuralı — MyCL desktop ortamında çalışıyor,
  // browser görünür olsun ("uygulamayı çalıştırıp playwright ile test
  // yapmıyor" şikâyeti). Headless'i kapat — kullanıcı testi gözleyebilsin.
  use: {
    baseURL: 'http://localhost:5173',
    headless: false,
    trace: 'off',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
