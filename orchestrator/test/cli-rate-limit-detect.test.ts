import { describe, expect, it } from "vitest";
import { detectCliRateLimit } from "../src/cli-rate-limit.js";

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
