// playwright-setup.test — checkPlaywrightScaffold + ensurePlaywrightScaffold
// + isPlaywrightSpec content-check davranışı. Filesystem mock'suz; geçici
// tmpdir altında gerçek dosya yapısı kurulur.
//
// v15.7 (2026-05-27): QC Round 5 — yeni modül test coverage gap closure.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import {
  assessPhase16Verification,
  checkPlaywrightScaffold,
  ensureAuthTemplate,
  ensurePlaywrightScaffold,
} from "../src/playwright-setup.js";

describe("playwright-setup · checkPlaywrightScaffold", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-pw-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("boş proje → hasConfig=false hasTests=false", async () => {
    const r = await checkPlaywrightScaffold(projectRoot);
    expect(r.hasConfig).toBe(false);
    expect(r.hasTests).toBe(false);
    expect(r.configPath).toBeUndefined();
  });

  it("playwright.config.ts varsa → hasConfig=true + configPath", async () => {
    await writeFile(join(projectRoot, "playwright.config.ts"), "export default {};", "utf-8");
    const r = await checkPlaywrightScaffold(projectRoot);
    expect(r.hasConfig).toBe(true);
    expect(r.configPath).toBe("playwright.config.ts");
  });

  it("playwright.config.{js,mjs,cjs} varyantları → algılanır", async () => {
    await writeFile(join(projectRoot, "playwright.config.mjs"), "export default {};", "utf-8");
    const r = await checkPlaywrightScaffold(projectRoot);
    expect(r.hasConfig).toBe(true);
    expect(r.configPath).toBe("playwright.config.mjs");
  });

  it("Vitest test (@playwright/test import yok) → hasTests=false", async () => {
    // Bu, R3 bulgusu: dev-server.test.js gibi Vitest dosyaları regex match
    // ederdi; içerik kontrolü ile Playwright sanılmamalı.
    await writeFile(
      join(projectRoot, "dev-server.test.js"),
      `import { describe, it, expect } from 'vitest';\nit('boots', () => expect(true).toBe(true));\n`,
      "utf-8",
    );
    const r = await checkPlaywrightScaffold(projectRoot);
    expect(r.hasTests).toBe(false);
  });

  it("@playwright/test import içeren spec → hasTests=true", async () => {
    await mkdir(join(projectRoot, "tests"), { recursive: true });
    await writeFile(
      join(projectRoot, "tests", "smoke.spec.ts"),
      `import { test, expect } from '@playwright/test';\ntest('ok', async ({ page }) => { await page.goto('/'); });\n`,
      "utf-8",
    );
    const r = await checkPlaywrightScaffold(projectRoot);
    expect(r.hasTests).toBe(true);
  });

  it("tests/integration alt-dizininde Playwright test → bulunur (depth ≤ 2)", async () => {
    await mkdir(join(projectRoot, "tests", "integration"), { recursive: true });
    await writeFile(
      join(projectRoot, "tests", "integration", "checkout.spec.ts"),
      `import { test } from '@playwright/test';\ntest('checkout', () => {});\n`,
      "utf-8",
    );
    const r = await checkPlaywrightScaffold(projectRoot);
    expect(r.hasTests).toBe(true);
  });

  it("Sadece .gitkeep olan tests/ dir → hasTests=false (regex match etmez)", async () => {
    await mkdir(join(projectRoot, "tests"), { recursive: true });
    await writeFile(join(projectRoot, "tests", ".gitkeep"), "", "utf-8");
    const r = await checkPlaywrightScaffold(projectRoot);
    expect(r.hasTests).toBe(false);
  });
});

describe("playwright-setup · ensurePlaywrightScaffold", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-pw-scaffold-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("scaffold yoksa config + smoke yazar (action=scaffolded)", async () => {
    const r = await ensurePlaywrightScaffold(projectRoot, 5173);
    expect(r.ok).toBe(true);
    expect(r.action).toBe("scaffolded");

    // Diskte gerçekten var mı kontrol
    const reCheck = await checkPlaywrightScaffold(projectRoot);
    expect(reCheck.hasConfig).toBe(true);
    expect(reCheck.hasTests).toBe(true);
  });

  it("scaffold zaten varsa + MyCL imzasız → already (dokunma)", async () => {
    // Kullanıcı kendi config + test yazmış. MyCL imzası yok.
    await writeFile(
      join(projectRoot, "playwright.config.ts"),
      "// user-written config\nexport default { testDir: './e2e' };\n",
      "utf-8",
    );
    // v15.10: user testi config'in testDir'inde (./e2e) — tutarlı çalışan kurulum.
    await mkdir(join(projectRoot, "e2e"), { recursive: true });
    await writeFile(
      join(projectRoot, "e2e", "user.spec.ts"),
      `import { test } from '@playwright/test';\ntest('user', () => {});\n`,
      "utf-8",
    );

    const before = await import("node:fs/promises").then((m) =>
      m.readFile(join(projectRoot, "playwright.config.ts"), "utf-8"),
    );
    const r = await ensurePlaywrightScaffold(projectRoot, 5173);
    expect(r.ok).toBe(true);
    expect(r.action).toBe("already");

    const after = await import("node:fs/promises").then((m) =>
      m.readFile(join(projectRoot, "playwright.config.ts"), "utf-8"),
    );
    expect(after).toBe(before); // dokunulmamış
  });

  it("v15.10: ajan config testDir='tests/e2e' + boş e2e → smoke ORAYA yazılır (Faz 16 'No tests found' fix)", async () => {
    // Ajan-üretimi (MyCL imzasız) config testDir 'tests/e2e'; e2e dizini boş ama
    // tests/integration'da Vitest testleri var. Eski davranış: genel hasTests
    // (entegrasyon) → 'already' veya smoke yanlış dizine → `playwright test`
    // testDir'de bulamaz. Fix: smoke EFEKTİF testDir'e (tests/e2e) yazılır, config korunur.
    await writeFile(
      join(projectRoot, "playwright.config.ts"),
      `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: 'tests/e2e' });\n`,
      "utf-8",
    );
    await mkdir(join(projectRoot, "tests", "integration"), { recursive: true });
    await writeFile(
      join(projectRoot, "tests", "integration", "x.test.ts"),
      `import { it, expect } from 'vitest';\nit('x', () => expect(1).toBe(1));\n`,
      "utf-8",
    );
    const r = await ensurePlaywrightScaffold(projectRoot, 5173);
    expect(r.action).toBe("scaffolded");
    const fs = await import("node:fs/promises");
    // smoke testDir'e (tests/e2e) yazıldı mı
    const wrote = await fs
      .readFile(join(projectRoot, "tests", "e2e", "smoke.spec.ts"), "utf-8")
      .then(() => true)
      .catch(() => false);
    expect(wrote).toBe(true);
    // ajan config'i korundu mu (üzerine yazılmadı)
    const cfg = await fs.readFile(join(projectRoot, "playwright.config.ts"), "utf-8");
    expect(cfg).toContain("tests/e2e");
  });

  it("MyCL imzalı eski scaffold + yeni şablon farklı → refresh (üzerine yazar)", async () => {
    // Önce ensure çağır → MyCL imzalı dosyalar oluşturulsun.
    await ensurePlaywrightScaffold(projectRoot, 5173);

    // Config içeriğini bir bayrak ile değiştir (mock "eski şablon")
    const fs = await import("node:fs/promises");
    const configPath = join(projectRoot, "playwright.config.ts");
    const original = await fs.readFile(configPath, "utf-8");
    // Mock "eski" şablon: marker var ama içerik farklı.
    await fs.writeFile(configPath, original.replace(/5173/, "9999"), "utf-8");

    const r2 = await ensurePlaywrightScaffold(projectRoot, 5173);
    expect(r2.action).toBe("scaffolded"); // refresh
    const refreshed = await fs.readFile(configPath, "utf-8");
    expect(refreshed).toContain("5173");
    expect(refreshed).not.toContain("9999");
  });

  it("eski sürüm imzalı (v15.7) smoke → sürüm-agnostik tespit + refresh (adminpanel bug'ı)", async () => {
    // adminpanel'deki gerçek bug: smoke.spec.ts "// MyCL scaffold v15.7" marker'lı;
    // exact-v15.8 araması onu user-written sanıp refresh ATLIYORDU. Sürüm-agnostik
    // isMyclScaffolded ile eski imzalı dosya da güncel (auth-aware) şablona yenilenmeli.
    await ensurePlaywrightScaffold(projectRoot, 5173);
    const fs = await import("node:fs/promises");
    const specPath = join(projectRoot, "tests", "smoke.spec.ts");
    const cur = await fs.readFile(specPath, "utf-8");
    expect(cur).toContain("// MyCL scaffold v15.8"); // önkoşul: güncel imza yazıldı
    // Marker'ı eski sürüme düşür → güncel şablondan farklı, imza hâlâ MyCL.
    await fs.writeFile(specPath, cur.replace("v15.8", "v15.7"), "utf-8");

    const r2 = await ensurePlaywrightScaffold(projectRoot, 5173);
    // Fix öncesi: isMyclScaffolded false → "already" (refresh atlanırdı). Fix sonrası: refresh.
    expect(r2.action).toBe("scaffolded");
    const refreshed = await fs.readFile(specPath, "utf-8");
    expect(refreshed).toContain("// MyCL scaffold v15.8");
    expect(refreshed).not.toContain("v15.7");
  });

  it("Line ending farkı (CRLF↔LF) refresh tetiklemez (normalize)", async () => {
    await ensurePlaywrightScaffold(projectRoot, 5173);
    const fs = await import("node:fs/promises");
    const configPath = join(projectRoot, "playwright.config.ts");
    const original = await fs.readFile(configPath, "utf-8");
    // CRLF çevir
    await fs.writeFile(configPath, original.replace(/\n/g, "\r\n"), "utf-8");

    const r2 = await ensurePlaywrightScaffold(projectRoot, 5173);
    // CRLF/LF normalize edildiği için içerik "stale değil" → already
    expect(r2.action).toBe("already");
  });

  it("legacy MyCL scaffold (imzasız ama default şablon eşit) → refresh tetiklenir", async () => {
    // adminpanel gibi v15.7 imza markeri ÖNCESİ yazılmış MyCL scaffold simüle.
    // 5 invariant + size cap → isLegacyMyclConfig true.
    const legacyConfig = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
`;
    const legacySmoke = `import { test, expect } from '@playwright/test';

test('smoke: app loads and has a non-empty title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/.+/);
});
`;
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(projectRoot, "playwright.config.ts"), legacyConfig, "utf-8");
    await fs.mkdir(join(projectRoot, "tests"), { recursive: true });
    await fs.writeFile(join(projectRoot, "tests", "smoke.spec.ts"), legacySmoke, "utf-8");

    const r = await ensurePlaywrightScaffold(projectRoot, 5173);
    expect(r.action).toBe("scaffolded");
    expect(r.message).toMatch(/güncellendi|imzalı/i);

    // Yeni içerik MyCL marker + headless:false içermeli
    const refreshedConfig = await fs.readFile(join(projectRoot, "playwright.config.ts"), "utf-8");
    expect(refreshedConfig).toContain("MyCL scaffold v15.8");
    expect(refreshedConfig).toContain("headless: false");

    const refreshedSmoke = await fs.readFile(join(projectRoot, "tests", "smoke.spec.ts"), "utf-8");
    expect(refreshedSmoke).toContain("MyCL scaffold v15.8");
    expect(refreshedSmoke).toContain("consoleErrors");
  });

  it("user-written config (legacy şablonla farklı) → already (dokunulmaz)", async () => {
    // User'ın elle yazdığı config: testDir farklı + firefox project + retries: 2
    // → 3 invariant fail → isLegacyMyclConfig false → MyCL-managed sayılmaz
    const userConfig = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 2,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
  },
  projects: [
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
`;
    const userSmoke = `import { test, expect } from '@playwright/test';
test('user own test', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page.locator('h1')).toBeVisible();
});
`;
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(projectRoot, "playwright.config.ts"), userConfig, "utf-8");
    // v15.10: user testi config'in testDir'inde (./e2e) — tutarlı kurulum.
    await fs.mkdir(join(projectRoot, "e2e"), { recursive: true });
    await fs.writeFile(join(projectRoot, "e2e", "smoke.spec.ts"), userSmoke, "utf-8");

    const r = await ensurePlaywrightScaffold(projectRoot, 5173);
    expect(r.action).toBe("already");

    // Dosyalar dokunulmamış olmalı
    const checkConfig = await fs.readFile(join(projectRoot, "playwright.config.ts"), "utf-8");
    expect(checkConfig).toBe(userConfig);
    const checkSmoke = await fs.readFile(join(projectRoot, "e2e", "smoke.spec.ts"), "utf-8");
    expect(checkSmoke).toBe(userSmoke);
  });
});

describe("playwright-setup · ensureAuthTemplate", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-auth-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("auth.json yoksa template yazar (action=written) + .gitignore koruması", async () => {
    const r = await ensureAuthTemplate(projectRoot);
    expect(r.ok).toBe(true);
    expect(r.action).toBe("written");

    const fs = await import("node:fs/promises");
    const content = await fs.readFile(join(projectRoot, ".mycl", "auth.json"), "utf-8");
    expect(content).toContain("MyCL auth template");
    expect(content).toContain("PASSWORD");
    expect(content).toContain("loginPath");

    // .gitignore auth.json korumalı olmalı
    const gitignore = await fs.readFile(join(projectRoot, ".mycl", ".gitignore"), "utf-8");
    expect(gitignore).toContain("auth.json");
  });

  it("auth.json varsa dokunmaz (action=exists)", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(projectRoot, ".mycl"), { recursive: true });
    const userAuth = `{
  "username": "myuser@example.com",
  "password": "mysecret",
  "loginPath": "/login"
}
`;
    await fs.writeFile(join(projectRoot, ".mycl", "auth.json"), userAuth, "utf-8");

    const r = await ensureAuthTemplate(projectRoot);
    expect(r.action).toBe("exists");

    const check = await fs.readFile(join(projectRoot, ".mycl", "auth.json"), "utf-8");
    expect(check).toBe(userAuth);
  });

  it.skipIf(process.platform === "win32")(
    "auth.json chmod 0600 (Unix permission, Windows'ta skip)",
    async () => {
      await ensureAuthTemplate(projectRoot);
      const fs = await import("node:fs/promises");
      const stat = await fs.stat(join(projectRoot, ".mycl", "auth.json"));
      // mode'un en düşük 9 biti permission. 0o600 = owner rw, group/other yok.
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );
});

describe("playwright-setup · assessPhase16Verification (dürüst rapor sinyalleri)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-verify-"));
    await mkdir(join(projectRoot, "tests"), { recursive: true });
    await mkdir(join(projectRoot, ".mycl"), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("MyCL imzalı tek smoke → placeholder", async () => {
    await writeFile(
      join(projectRoot, "tests", "smoke.spec.ts"),
      `// MyCL scaffold v15.8\nimport { test, expect } from '@playwright/test';\ntest('smoke', async ({ page }) => { await page.goto('/'); });\n`,
    );
    const v = await assessPhase16Verification(projectRoot);
    expect(v.smokeKind).toBe("placeholder");
  });

  it("kullanıcının gerçek Playwright testi → real", async () => {
    await writeFile(
      join(projectRoot, "tests", "smoke.spec.ts"),
      `// MyCL scaffold v15.8\nimport { test } from '@playwright/test';\ntest('smoke', async ({ page }) => { await page.goto('/'); });\n`,
    );
    await writeFile(
      join(projectRoot, "tests", "survey.spec.ts"),
      `import { test, expect } from '@playwright/test';\ntest('anket oluştur', async ({ page }) => { await page.goto('/surveys/new'); });\n`,
    );
    const v = await assessPhase16Verification(projectRoot);
    expect(v.smokeKind).toBe("real");
  });

  it("Vitest .test.js dosyası Playwright sayılmaz (imza içerikten) → none", async () => {
    // İçerikte @playwright/test yok → Playwright testi değil; Vitest karışmaz.
    await writeFile(
      join(projectRoot, "tests", "dev-server.test.js"),
      `import { describe, it } from 'vitest';\ndescribe('x', () => { it('y', () => {}); });\n`,
    );
    const v = await assessPhase16Verification(projectRoot);
    expect(v.smokeKind).toBe("none");
  });

  it("auth.json yer tutucu → placeholder; gerçek → configured; yok → none", async () => {
    // none
    let v = await assessPhase16Verification(projectRoot);
    expect(v.authStatus).toBe("none");

    // placeholder
    await writeFile(
      join(projectRoot, ".mycl", "auth.json"),
      JSON.stringify({ username: "<EMAIL_OR_USERNAME>", password: "<PASSWORD>" }),
    );
    v = await assessPhase16Verification(projectRoot);
    expect(v.authStatus).toBe("placeholder");

    // configured
    await writeFile(
      join(projectRoot, ".mycl", "auth.json"),
      JSON.stringify({ username: "admin@example.com", password: "admin123" }),
    );
    v = await assessPhase16Verification(projectRoot);
    expect(v.authStatus).toBe("configured");
  });
});
