// accessibility-scan — formatA11yReport saf mantık testleri (severity-tabanı, salt-rapor dili).
// Gerçek tarama (runAccessibilityScan, Playwright+chromium) saha-doğrulamada test edilir.

import { describe, expect, it } from "vitest";
import { formatA11yReport, type A11yResult, type A11yViolation } from "../src/accessibility-scan.js";

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
