// log-retention — saf budama fonksiyonları (ts-çıkarma + eski-satır filtresi). Deterministik.

import { describe, expect, it } from "vitest";
import { lineTimestamp, filterRecentLines } from "../src/log-retention.js";

describe("log-retention · lineTimestamp", () => {
  it("JSON ts (number ms) + (ISO string) + pipe-ISO prefix", () => {
    expect(lineTimestamp('{"ts":1781212964287,"x":1}')).toBe(1781212964287);
    expect(lineTimestamp('{"ts":"2026-05-12T07:20:47Z","msg":"x"}')).toBe(Date.parse("2026-05-12T07:20:47Z"));
    expect(lineTimestamp("2026-05-12T07:20:47Z | session_start | 1.0.4")).toBe(
      Date.parse("2026-05-12T07:20:47Z"),
    );
  });
  it("tarihlenemeyen → null (korunur)", () => {
    expect(lineTimestamp("düz metin, ts yok")).toBeNull();
    expect(lineTimestamp('{"msg":"ts alanı yok"}')).toBeNull();
    expect(lineTimestamp("")).toBeNull();
  });
});

describe("log-retention · filterRecentLines", () => {
  const cutoff = Date.parse("2026-01-01T00:00:00Z");
  it("eski datable satır atılır; yeni + tarihlenemeyen KORUNUR", () => {
    const content =
      [
        '{"ts":' + Date.parse("2025-06-01T00:00:00Z") + ',"m":"eski"}', // < cutoff → at
        '{"ts":' + Date.parse("2026-06-01T00:00:00Z") + ',"m":"yeni"}', // >= cutoff → tut
        "tarihsiz satır — korunur",
      ].join("\n");
    const out = filterRecentLines(content, cutoff);
    expect(out).not.toContain("eski");
    expect(out).toContain("yeni");
    expect(out).toContain("tarihsiz");
  });
  it("son maxLines güvenlik tavanı", () => {
    const many = Array.from({ length: 50 }, (_, i) => `tarihsiz ${i}`).join("\n");
    const out = filterRecentLines(many, cutoff, 10);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[9]).toBe("tarihsiz 49"); // son 10 korunur
  });
  it("hepsi eski → boş string", () => {
    const old = '{"ts":' + Date.parse("2020-01-01T00:00:00Z") + ',"m":"x"}';
    expect(filterRecentLines(old, cutoff)).toBe("");
  });
});

describe("bayt bütçesi (2026-07-18 hızlı oturumlar — 2.1.208 esinli)", () => {
  it("uzun satırlarda satır tavanı yetmez: bütçe aşılınca EN YENİ satırlar korunur", () => {
    const now = Date.now();
    const line = (i: number) => JSON.stringify({ ts: now, msg: `satır-${i}-${"x".repeat(100)}` });
    const content = Array.from({ length: 50 }, (_, i) => line(i)).join("\n") + "\n";
    const out = filterRecentLines(content, 0, 100_000, 1000); // ~1KB bütçe → yalnız son birkaç satır
    expect(out.length).toBeLessThanOrEqual(1000 + 1);
    expect(out).toContain("satır-49"); // en yeni korunur
    expect(out).not.toContain("satır-0"); // en eski atılır
  });

  it("bütçe içindeyse hiçbir satır atılmaz", () => {
    const now = Date.now();
    const content = `${JSON.stringify({ ts: now, a: 1 })}\n${JSON.stringify({ ts: now, a: 2 })}\n`;
    expect(filterRecentLines(content, 0)).toBe(content);
  });
});

describe("MAHKEME düzeltmeleri (2026-07-18)", () => {
  it("CRITICAL: bütçeyi tek başına aşan EN YENİ satır dosyayı SİLDİRMEZ — en az 1 satır korunur", () => {
    const now = Date.now();
    const huge = JSON.stringify({ ts: now, blob: "y".repeat(5000) });
    const out = filterRecentLines(huge + "\n", 0, 100_000, 1000);
    expect(out).not.toBe(""); // tüm dosya silinmiyor
    expect(out).toContain("y".repeat(100)); // en yeni satır duruyor
  });

  it("bayt ölçümü UTF-8: Türkçe karakterler gerçek bayt sayısıyla bütçelenir", () => {
    const now = Date.now();
    const line = (i: number) => JSON.stringify({ ts: now, m: `ç${i}${"ş".repeat(50)}` }); // ~2× UTF-8
    const content = Array.from({ length: 20 }, (_, i) => line(i)).join("\n") + "\n";
    const out = filterRecentLines(content, 0, 100_000, 500);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(500 + line(19).length + 2); // gerçek bayt sınırında
    expect(out).toContain('"m":"ç19'); // en yeni korunur
  });
});
