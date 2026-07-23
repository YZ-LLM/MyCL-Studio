import { describe, expect, it } from "vitest";
import { detectCliRateLimit, isCliUsageLimitError } from "../src/cli-rate-limit.js";

describe("detectCliRateLimit (rate-limit-as-error tespiti — dar)", () => {
  it("usage limit imzası → usage-limit", () => {
    expect(detectCliRateLimit("Claude usage limit reached. Try again later.")).toBe(
      "usage-limit",
    );
    expect(detectCliRateLimit("usage_limit exceeded")).toBe("usage-limit");
  });

  it("rate limit / too many requests → rate-limit", () => {
    expect(detectCliRateLimit("rate limit exceeded")).toBe("rate-limit");
    expect(detectCliRateLimit("429 Too Many Requests")).toBe("rate-limit");
    expect(detectCliRateLimit("rate-limited, retry after 60s")).toBe("rate-limit");
  });

  it("genel hata → null (yanlış-pozitif yok)", () => {
    expect(detectCliRateLimit("Error: file not found")).toBeNull();
    expect(detectCliRateLimit("TypeError at file.ts:429")).toBeNull(); // çıplak 429 EŞLEŞMEZ
    expect(detectCliRateLimit("")).toBeNull();
  });
});

describe("detectCliRateLimit — session limit (YZLLM 2026-07-17 canlı cave donması)", () => {
  it("yeni CLI metni 'You've hit your session limit · resets 6pm' → usage-limit", () => {
    expect(detectCliRateLimit("You've hit your session limit · resets 6pm (Europe/Istanbul)")).toBe("usage-limit");
  });
  it("'session limit' geçmeyen sıradan hata → null (yanlış pozitif yok)", () => {
    expect(detectCliRateLimit("session expired, please login again")).toBeNull();
  });
});

describe("isCliUsageLimitError — CLAUDE'A ÇAPALI imza (MAHKEME 2026-07-23: failPhase proje çıktısı taşır)", () => {
  it("canlı log metni (Faz 1 çeviri hatası) → true", () => {
    expect(
      isCliUsageLimitError(
        "Faz 1: niyet çevirisi başarısız — Error: claude exit=1 :: You've hit your session limit · resets 6:20am (Europe/Istanbul)",
      ),
    ).toBe(true);
  });
  it("çıplak CLI cümlesi (sarmalayıcısız) → true; eski CLI metni → true", () => {
    expect(isCliUsageLimitError("You've hit your usage limit.")).toBe(true);
    expect(isCliUsageLimitError("Claude AI usage limit reached|1780504200")).toBe(true);
  });
  it("exit-sarmalı genel imza → true", () => {
    expect(isCliUsageLimitError("claude exit=1 :: usage_limit exceeded, try later")).toBe(true);
  });
  it("PROJENİN kendi çıktısındaki limit metni (Claude çapası yok) → false (yanlış pozitif yok)", () => {
    // Faz 5 lastFailReason'a projenin dev-server stderr'i girer — bunlar Claude limiti DEĞİL:
    expect(isCliUsageLimitError("MyApp API error: usage limit exceeded for tenant acme")).toBe(false);
    expect(isCliUsageLimitError("warning: session limit reached, oldest session evicted")).toBe(false);
    expect(isCliUsageLimitError("rate limit exceeded")).toBe(false);
    expect(isCliUsageLimitError("")).toBe(false);
  });
});
