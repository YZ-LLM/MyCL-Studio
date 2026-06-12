// dast-runner — GÜVENLİK-KRİTİK saf fonksiyonlar. isLocalhostTarget localhost-kaçağı
// saldırı vektörlerine karşı kilitlenir (adversaryal inceleme exploit'leri); parseNucleiJsonl
// bozuk satır/severity sayımı + injection-sanitize doğrular.

import { describe, expect, it } from "vitest";
import {
  coverageLine,
  isLocalhostTarget,
  parseKatanaUrls,
  parseNucleiJsonl,
} from "../src/dast-runner.js";

describe("dast-runner · isLocalhostTarget (localhost-kaçağı savunması)", () => {
  it("geçerli loopback hedefleri → true", () => {
    expect(isLocalhostTarget("http://localhost:5173")).toBe(true);
    expect(isLocalhostTarget("http://127.0.0.1:3000/path")).toBe(true);
    expect(isLocalhostTarget("http://[::1]:8080")).toBe(true);
    expect(isLocalhostTarget("https://localhost:443")).toBe(true);
    expect(isLocalhostTarget("http://127.0.0.1")).toBe(true);
    expect(isLocalhostTarget("http://127.1.2.3:9000")).toBe(true); // 127.0.0.0/8
  });

  it("DNS-rebinding / suffix host → false", () => {
    expect(isLocalhostTarget("http://localhost.attacker.com")).toBe(false);
    expect(isLocalhostTarget("http://127.0.0.1.evil.com")).toBe(false);
    expect(isLocalhostTarget("http://evil.com/?x=localhost")).toBe(false);
    expect(isLocalhostTarget("http://notlocalhost")).toBe(false);
  });

  it("userinfo injection → false", () => {
    expect(isLocalhostTarget("http://localhost@evil.com")).toBe(false);
    expect(isLocalhostTarget("http://user:pw@localhost")).toBe(false);
    expect(isLocalhostTarget("http://evil.com#@localhost")).toBe(false);
  });

  it("octal/hex/decimal IP → WHATWG 127.0.0.1'e normalize (gerçekten loopback → true)", () => {
    // KRİTİK: bunlar uzak host'a kaçış DEĞİL — WHATWG URL http(s)'de hepsini
    // dotted-decimal 127.0.0.1'e çevirir, yani gerçekten loopback. Kabul güvenli.
    expect(isLocalhostTarget("http://0x7f000001")).toBe(true); // hex → 127.0.0.1
    expect(isLocalhostTarget("http://2130706433")).toBe(true); // decimal → 127.0.0.1
    expect(isLocalhostTarget("http://0177.0.0.1")).toBe(true); // octal → 127.0.0.1
    // 0.0.0.0 bind-all adresi, loopback DEĞİL → RED.
    expect(isLocalhostTarget("http://0.0.0.0")).toBe(false);
  });

  it("http(s) olmayan protokol → false", () => {
    expect(isLocalhostTarget("ftp://localhost")).toBe(false);
    expect(isLocalhostTarget("file:///etc/passwd")).toBe(false);
    expect(isLocalhostTarget("javascript:alert(1)")).toBe(false);
    expect(isLocalhostTarget("data:text/html,x")).toBe(false);
  });

  it("parse edilemeyen / boş → false", () => {
    expect(isLocalhostTarget("")).toBe(false);
    expect(isLocalhostTarget("not a url")).toBe(false);
    expect(isLocalhostTarget("localhost:5173")).toBe(false); // şema yok → URL parse fail
  });

  it("IPv4-mapped IPv6 → false (fail-closed güvenli taraf)", () => {
    expect(isLocalhostTarget("http://[::ffff:127.0.0.1]")).toBe(false);
  });
});

describe("dast-runner · parseNucleiJsonl", () => {
  it("boş çıktı → 0 bulgu", () => {
    const s = parseNucleiJsonl("");
    expect(s.total).toBe(0);
    expect(s.findings).toEqual([]);
  });

  it("severity sayımı + total tüm satırları kapsar (slice değil)", () => {
    const lines = [
      JSON.stringify({ "template-id": "a", info: { severity: "high", name: "XSS" }, "matched-at": "http://localhost:3000/x" }),
      JSON.stringify({ "template-id": "b", info: { severity: "low", name: "Info leak" }, "matched-at": "http://localhost:3000/y" }),
      JSON.stringify({ "template-id": "c", info: { severity: "high", name: "SQLi" }, "matched-at": "http://localhost:3000/z" }),
    ].join("\n");
    const s = parseNucleiJsonl(lines);
    expect(s.total).toBe(3);
    expect(s.bySeverity.high).toBe(2);
    expect(s.bySeverity.low).toBe(1);
    expect(s.findings).toHaveLength(3);
    expect(s.findings[0]?.name).toBe("XSS");
  });

  it("bozuk satır + boş satır atlanır (sağlam parse)", () => {
    const lines = [
      "not json",
      "",
      JSON.stringify({ "template-id": "a", info: { severity: "medium", name: "x" } }),
      "{ kırık",
    ].join("\n");
    const s = parseNucleiJsonl(lines);
    expect(s.total).toBe(1);
    expect(s.bySeverity.medium).toBe(1);
  });

  it("20'den fazla bulgu: total tümünü sayar, findings ilk 20 detay", () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({ "template-id": `t${i}`, info: { severity: "info", name: `n${i}` } }),
    ).join("\n");
    const s = parseNucleiJsonl(lines);
    expect(s.total).toBe(25);
    expect(s.findings).toHaveLength(20);
    expect(s.bySeverity.info).toBe(25);
  });

  it("markdown/kontrol-char injection sanitize edilir (chat log-injection)", () => {
    const evil = JSON.stringify({
      "template-id": "evil`code`",
      info: { severity: "high", name: "**bold** <script>\n\ninjection" },
      "matched-at": "http://localhost/`x`",
    });
    const s = parseNucleiJsonl(evil);
    const f = s.findings[0]!;
    expect(f.name).not.toContain("`");
    expect(f.name).not.toContain("*");
    expect(f.name).not.toContain("<");
    expect(f.name).not.toContain("\n");
    expect(f.templateId).not.toContain("`");
  });
});

// GÜVENLİK-KRİTİK: katana keşfettiği URL'leri nuclei'ye besler — off-host kaçağı
// imkânsız olmalı (her URL isLocalhostTarget'tan geçer); kök hep dahil; dedupe; cap.
describe("dast-runner · parseKatanaUrls (tüm-proje crawl → nuclei besleme)", () => {
  const base = "http://localhost:3000";
  const baseCanon = "http://localhost:3000/"; // new URL().href trailing-slash ekler (kanonik)

  it("localhost route'ları toplanır + kök hep dahil + dedupe (kanonik biçim)", () => {
    const stdout = [
      "http://localhost:3000/login",
      "http://localhost:3000/admin",
      "http://localhost:3000/login", // tekrar → dedupe
      "  http://localhost:3000/api/users  ", // boşluk → trim
      "",
    ].join("\n");
    const { urls, capped } = parseKatanaUrls(stdout, base);
    expect(capped).toBe(false);
    expect(urls[0]).toBe(baseCanon); // kök ilk + her zaman dahil (kanonik)
    expect(urls).toContain("http://localhost:3000/login");
    expect(urls).toContain("http://localhost:3000/admin");
    expect(urls).toContain("http://localhost:3000/api/users");
    expect(new Set(urls).size).toBe(urls.length); // tekrarsız
  });

  it("off-host / loopback-dışı URL'ler ATILIR (katana scope kaçsa bile defense-in-depth)", () => {
    const stdout = [
      "http://localhost:3000/ok",
      "http://evil.com/pwn", // dış host → at
      "https://cdn.example.com/app.js", // dış CDN → at
      "http://169.254.169.254/latest/meta-data/", // cloud metadata SSRF → at
      "http://localhost.attacker.com/x", // suffix host → at
      "ftp://localhost:3000/x", // http(s) değil → at
    ].join("\n");
    const { urls } = parseKatanaUrls(stdout, base);
    expect(urls).toContain("http://localhost:3000/ok");
    expect(urls).not.toContain("http://evil.com/pwn");
    expect(urls.some((u) => u.includes("example.com"))).toBe(false);
    expect(urls.some((u) => u.includes("169.254"))).toBe(false);
    expect(urls.some((u) => u.includes("attacker"))).toBe(false);
    expect(urls.some((u) => u.startsWith("ftp:"))).toBe(false);
  });

  // I1 düşman-gözü: satır-içi \r/\t/kontrol-char taşıyan satır REDDEDİLİR. new URL() bu
  // char'ları sessizce siler → gate "localhost" görür ama ham string dosyaya \r ile yazılır →
  // nuclei -l satır-böler → off-host kaçağı. Hem evrensel split hem kontrol-char red.
  it("I1: satır-içi \\r ile gizlenmiş off-host URL kaçırılamaz (CRLF-smuggling)", () => {
    // Tek 'satır' gibi görünen ama içinde \r olan girdi (\n'de bölünmez).
    const smuggle = "http://localhost:3000/a\rhttp://evil.com/x";
    const { urls } = parseKatanaUrls(smuggle, base);
    // Hiçbir çıktı evil.com içermemeli + ham \r taşıyan string yazılmamalı.
    expect(urls.some((u) => u.includes("evil.com"))).toBe(false);
    expect(urls.some((u) => u.includes("\r"))).toBe(false);
  });

  it("I1: evrensel satır-sonu (\\r\\n ve tek \\r) doğru bölünür", () => {
    const stdout = "http://localhost:3000/a\r\nhttp://localhost:3000/b\rhttp://localhost:3000/c";
    const { urls } = parseKatanaUrls(stdout, base);
    expect(urls).toContain("http://localhost:3000/a");
    expect(urls).toContain("http://localhost:3000/b");
    expect(urls).toContain("http://localhost:3000/c");
  });

  // I2 düşman-gözü: yıkıcı (state-değiştiren) GET-yolları nuclei listesine GİRMEZ
  // (katana -crawl-out-scope ile aynı kaynak; defense-in-depth: katana kaçırsa bile).
  it("I2: yıkıcı GET-yolları (logout/delete/purge...) nuclei listesinden elenir", () => {
    const stdout = [
      "http://localhost:3000/safe-page",
      "http://localhost:3000/logout",
      "http://localhost:3000/users/42/delete",
      "http://localhost:3000/admin/purge",
      "http://localhost:3000/account?action=delete", // delete= → yıkıcı
      "http://localhost:3000/api/cache/clear",
    ].join("\n");
    const { urls } = parseKatanaUrls(stdout, base);
    expect(urls).toContain("http://localhost:3000/safe-page");
    expect(urls.some((u) => /logout|delete|purge|clear/i.test(u))).toBe(false);
  });

  it("MAX_SCAN_URLS tavanı aşılırsa capped=true + kök yine dahil (sessiz kırpma yok)", () => {
    // 300 benzersiz localhost route → 250 tavanını aşar.
    const lines = Array.from({ length: 300 }, (_, i) => `http://localhost:3000/p${i}`);
    const { urls, capped } = parseKatanaUrls(lines.join("\n"), base);
    expect(capped).toBe(true);
    expect(urls.length).toBe(250); // MAX_SCAN_URLS
    expect(urls[0]).toBe(baseCanon); // kök tavan içinde garanti
  });

  it("boş crawl çıktısı → yalnız kök (en az kök taranır)", () => {
    const { urls, capped } = parseKatanaUrls("", base);
    expect(urls).toEqual([baseCanon]);
    expect(capped).toBe(false);
  });
});

// I4 düşman-gözü: rapor gerçek kapsamı yansıtır — crawl çalışsa bile yalnız kök
// bulunduysa "tüm proje" DEME (SPA/auth-wall sahte-yeşili).
describe("dast-runner · coverageLine (dürüst kapsam — sahte 'tüm proje' yok)", () => {
  it("crawl + çok route → 'tüm proje tarandı'", () => {
    const line = coverageLine({ crawled: true, urlCount: 12, capped: false, katanaMissing: false });
    expect(line).toContain("tüm proje tarandı");
    expect(line).toContain("12");
  });

  it("I4: crawl çalıştı ama yalnız kök (urlCount=1) → 'tüm proje' DEMEZ (SPA dürüstlüğü)", () => {
    const line = coverageLine({ crawled: true, urlCount: 1, capped: false, katanaMissing: false });
    expect(line).not.toContain("tüm proje");
    expect(line).toContain("yalnız ana sayfa");
    expect(line).toContain("EDİLMEDİ");
  });

  it("capped → sınır görünür bildirilir (sessiz kırpma yok)", () => {
    const line = coverageLine({ crawled: true, urlCount: 250, capped: true, katanaMissing: false });
    expect(line).toContain("sınırland");
    expect(line).toContain("250");
  });

  it("katana yok → kurulum önerisi + 'tüm proje' demez", () => {
    const line = coverageLine({ crawled: false, urlCount: 1, capped: false, katanaMissing: true });
    expect(line).not.toContain("tüm proje");
    expect(line).toContain("katana");
  });
});
