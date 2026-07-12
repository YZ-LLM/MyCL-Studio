// edd/engine — isEddRateLimited SAF testi (YZLLM 2026-07-12 canlı-bug: EDD rate-limit'te fail-fast yapmıyordu →
// 3 saat 65 batch + 408 sahte "analysis-failed"). Bu helper rate-limit/kota'yı GERÇEK-analiz-hatasından ayırır.

import { describe, expect, it } from "vitest";
import { isEddRateLimited } from "./engine.js";

describe("isEddRateLimited — sağlayıcı-sınırı (dur+resume) vs gerçek analiz-hatası (unanalyzable)", () => {
  it("rate-limit / kota / kredi hataları → true (EDD DURUR, birim pending kalır)", () => {
    // Canlı trace'teki tam mesaj:
    expect(isEddRateLimited(new Error("ClaudeApiError: Anthropic API rate limit aşıldı. Bir süre bekleyip tekrar deneyin."))).toBe(true);
    expect(isEddRateLimited('429 {"type":"error","error":{"type":"rate_limit_error","code":"1113"}}')).toBe(true);
    expect(isEddRateLimited(new Error("rate_limit_error"))).toBe(true);
    expect(isEddRateLimited("credit balance too low")).toBe(true);
    expect(isEddRateLimited("kota doldu")).toBe(true);
  });

  it("gerçek analiz hataları (parse/timeout/poison) → false (birim 'analysis-failed' işaretlenir)", () => {
    expect(isEddRateLimited(new Error("parse failed: unexpected token"))).toBe(false);
    expect(isEddRateLimited("model returned no tool_use")).toBe(false);
    expect(isEddRateLimited(new Error("ENOENT: file not found"))).toBe(false);
    expect(isEddRateLimited(undefined)).toBe(false);
    expect(isEddRateLimited(null)).toBe(false);
  });

  it("ÇIPLAK 429 satır-no/pozisyon yanlış-pozitifi KAPALI (mahkeme 2026-07-12; kardeş detectCliRateLimit ile tutarlı)", () => {
    // Stack-trace satır no / JSON pozisyonu "429" içerse bile → rate-limit DEĞİL → birim 'analysis-failed' işaretlenmeli.
    expect(isEddRateLimited(new Error("at Object.<anonymous> (/repo/src/thing.ts:429:12)"))).toBe(false);
    expect(isEddRateLimited("Unexpected token u in JSON at position 429")).toBe(false);
  });

  it("Error olmayan girdiyi de string'e çevirip değerlendirir; '429 too many requests' → true (standart mesaj)", () => {
    expect(isEddRateLimited("Anthropic rate-limit")).toBe(true);
    expect(isEddRateLimited({ toString: () => "429 too many requests" })).toBe(true);
  });
});
