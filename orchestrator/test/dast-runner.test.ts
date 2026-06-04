// dast-runner — GÜVENLİK-KRİTİK saf fonksiyonlar. isLocalhostTarget localhost-kaçağı
// saldırı vektörlerine karşı kilitlenir (adversaryal inceleme exploit'leri); parseNucleiJsonl
// bozuk satır/severity sayımı + injection-sanitize doğrular.

import { describe, expect, it } from "vitest";
import { isLocalhostTarget, parseNucleiJsonl } from "../src/dast-runner.js";

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
