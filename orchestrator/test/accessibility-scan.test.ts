// accessibility-scan — formatA11yReport saf mantık testleri (severity-tabanı, salt-rapor dili) ve
// katı CSP'li sayfada GERÇEK tarama (Playwright chromium + yerel http sunucusu). Tarayıcı kurulu
// değilse gerçek tarama testleri GÖRÜNÜR biçimde atlanır (vitest "skipped"); saf testler hep koşar.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import {
  formatA11yReport,
  runAccessibilityScan,
  type A11yResult,
  type A11yViolation,
} from "../src/accessibility-scan.js";

const V = (over: Partial<A11yViolation> = {}): A11yViolation => ({
  id: "color-contrast",
  impact: "serious",
  help: "Elements must have sufficient color contrast",
  nodes: 3,
  helpUrl: "https://dequeuniversity.com/x",
  ...over,
});

describe("formatA11yReport", () => {
  it("ran=false → görünür 'taranamadı' (sessizce temiz DEME)", () => {
    const r: A11yResult = { ran: false, url: "u", violations: [], skippedReason: "axe yok" };
    const out = formatA11yReport(r);
    expect(out).toContain("taranamadı");
    expect(out).toContain("axe yok");
    expect(out).not.toContain("✅");
  });

  it("ihlal yok → temiz", () => {
    expect(formatA11yReport({ ran: true, url: "u", violations: [] })).toContain("✅");
  });

  it("severity-tabanı: yalnız critical/serious listelenir, moderate/minor sayılır", () => {
    const out = formatA11yReport({
      ran: true,
      url: "u",
      violations: [
        V({ id: "image-alt", impact: "critical", nodes: 1 }),
        V({ id: "color-contrast", impact: "serious", nodes: 2 }),
        V({ id: "landmark", impact: "moderate" }),
        V({ id: "region", impact: "minor" }),
      ],
    });
    expect(out).toContain("2 önemli");
    expect(out).toContain("`image-alt`");
    expect(out).toContain("`color-contrast`");
    expect(out).toContain("2 düşük öncelikli"); // moderate + minor
    expect(out).not.toContain("`landmark`"); // moderate listelenmez
  });

  it("yalnız düşük öncelikli varsa 'önemli bulgu yok' + sayım", () => {
    const out = formatA11yReport({
      ran: true,
      url: "u",
      violations: [V({ id: "x", impact: "moderate" }), V({ id: "y", impact: "minor" })],
    });
    expect(out).toContain("Önemli (critical/serious) bulgu yok");
    expect(out).toContain("2 düşük öncelikli");
  });

  it("8'den fazla önemli bulgu → ilk 8 + 'daha' özeti", () => {
    const many = Array.from({ length: 10 }, (_, i) => V({ id: `rule-${i}`, impact: "critical" }));
    const out = formatA11yReport({ ran: true, url: "u", violations: many });
    expect(out).toContain("10 önemli");
    expect(out).toContain("+2 daha");
  });

  it("hiçbir çıktıda 'bloklan/durdur' dili yok (salt-rapor)", () => {
    const out = formatA11yReport({ ran: true, url: "u", violations: [V({ impact: "critical" })] });
    expect(out.toLowerCase()).not.toMatch(/blok|durdur|fail|başarısız/);
  });
});

// CANLI KANIT (ekransız deneme koşusu, 2026-11-27): MyCL'in kendi istediği katı politikayı taşıyan
// sayfada tarama `page.addScriptTag` satır içi betik eklediği için hiç koşamadı
// ("Executing inline script violates ... 'script-src 'self''") ve `a11y-scan-skipped` yazıldı.
// Politika, o koşuda üretilen `index.html` içindeki politikanın aynısıdır; 2026-11-27'den beri `STRICT_CSP` gibi
// `frame-ancestors` içermez (meta ile verilince tarayıcı zaten yok sayar).
const KATI_POLITIKA =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'self'";

/** Bilinen bir ihlal (alt metni olmayan resim) taşıyan sayfa: taramanın GERÇEKTEN koştuğunun kanıtı. */
function denemeSayfasi(metaIle: boolean): string {
  const meta = metaIle ? `<meta http-equiv="Content-Security-Policy" content="${KATI_POLITIKA}">` : "";
  return (
    `<!doctype html><html lang="tr"><head><meta charset="utf-8">${meta}<title>Deneme</title></head>` +
    `<body><main><h1>Deneme</h1><img src="/resim.png"></main></body></html>`
  );
}

describe("runAccessibilityScan — katı CSP'li sayfada da koşar (gerçek tarayıcı)", () => {
  let server: Server;
  let base = "";
  let tarayiciVar = false;

  beforeAll(async () => {
    try {
      const b = await chromium.launch({ headless: true });
      await b.close();
      tarayiciVar = true;
    } catch {
      tarayiciVar = false;
    }
    server = createServer((req, res) => {
      if (req.url === "/meta") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(denemeSayfasi(true));
        return;
      }
      if (req.url === "/baslik") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": KATI_POLITIKA,
        });
        res.end(denemeSayfasi(false));
        return;
      }
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("politika <meta> ile geldiğinde tarama sonuç üretir, atlanmaz", async (ctx) => {
    if (!tarayiciVar) return ctx.skip("Playwright chromium kurulu değil");
    const r = await runAccessibilityScan(`${base}/meta`);
    expect(r.skippedReason).toBeUndefined();
    expect(r.ran).toBe(true);
    expect(r.violations.map((v) => v.id)).toContain("image-alt");
  }, 60_000);

  it("politika yanıt başlığıyla geldiğinde tarama sonuç üretir, atlanmaz", async (ctx) => {
    if (!tarayiciVar) return ctx.skip("Playwright chromium kurulu değil");
    const r = await runAccessibilityScan(`${base}/baslik`);
    expect(r.skippedReason).toBeUndefined();
    expect(r.ran).toBe(true);
    expect(r.violations.map((v) => v.id)).toContain("image-alt");
  }, 60_000);
});
