// guide-pdf — saf kısımlar (route çıkarımı + markdown→HTML + HTML belgesi). Headless
// Chromium/PDF üretimi runtime (test edilmez); burada saf, deterministik mantık.

import { describe, expect, it } from "vitest";
import { extractRoutesFromFeatures, markdownToHtml, buildGuideHtml } from "../src/guide-pdf.js";

describe("extractRoutesFromFeatures", () => {
  it("her zaman '/' içerir + backtick rotaları çıkarır + dedup", () => {
    const md = "## Dashboard\n**Where** `/dashboard`\n## Settings\n`/settings` ve tekrar `/dashboard`";
    const routes = extractRoutesFromFeatures(md);
    expect(routes).toContain("/");
    expect(routes).toContain("/dashboard");
    expect(routes).toContain("/settings");
    expect(routes.filter((r) => r === "/dashboard")).toHaveLength(1); // dedup
  });

  it("URL'leri (://) atlar; trailing slash strip", () => {
    const md = "`https://example.com/x` ama `/page/`";
    const routes = extractRoutesFromFeatures(md);
    expect(routes).not.toContain("https://example.com/x");
    expect(routes).toContain("/page"); // trailing slash strip
  });

  it("rota yoksa → yalnız '/'", () => {
    expect(extractRoutesFromFeatures("hiç backtick yol yok")).toEqual(["/"]);
  });
});

describe("markdownToHtml", () => {
  it("başlıklar: ## → h2, ### → h3", () => {
    const h = markdownToHtml("## Nasıl: Giriş\n### Adımlar");
    expect(h).toContain("<h2>Nasıl: Giriş</h2>");
    expect(h).toContain("<h3>Adımlar</h3>");
  });

  it("numaralı liste → ol/li; madde → ul/li", () => {
    const h = markdownToHtml("1. Birinci\n2. İkinci");
    expect(h).toContain("<ol>");
    expect(h).toContain("<li>Birinci</li>");
    expect(h).toContain("</ol>");
    const h2 = markdownToHtml("- a\n- b");
    expect(h2).toContain("<ul>");
    expect(h2).toContain("<li>a</li>");
  });

  it("**kalın** → strong; düz satır → p", () => {
    const h = markdownToHtml("Bu **önemli** bir nottur.");
    expect(h).toContain("<strong>önemli</strong>");
    expect(h).toContain("<p>");
  });

  it("HTML escape (XSS koruması)", () => {
    const h = markdownToHtml("<script>alert(1)</script>");
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
  });
});

describe("buildGuideHtml", () => {
  it("başlık + gövde içerir; ss yoksa figure yok", () => {
    const doc = buildGuideHtml("Kullanım Kılavuzu", "<p>gövde</p>", []);
    expect(doc).toContain("<h1>Kullanım Kılavuzu</h1>");
    expect(doc).toContain("<p>gövde</p>");
    expect(doc).not.toContain("<figure>");
    expect(doc).toContain("<!doctype html>");
  });

  it("ss varsa figure + img + 'Ekran Görüntüleri' başlığı", () => {
    const doc = buildGuideHtml("K", "<p>x</p>", [{ route: "/dashboard", dataUri: "data:image/png;base64,AAA" }]);
    expect(doc).toContain("Ekran Görüntüleri");
    expect(doc).toContain("<figure>");
    expect(doc).toContain('src="data:image/png;base64,AAA"');
    expect(doc).toContain("<code>/dashboard</code>");
  });
});
