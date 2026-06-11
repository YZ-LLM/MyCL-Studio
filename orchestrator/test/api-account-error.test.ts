import { describe, expect, it } from "vitest";
import { isApiAccountError } from "../src/claude-api.js";

describe("isApiAccountError (Ümit: kredi/hesap hatası ≠ proje hatası, tırmanma/analiz YAPMA)", () => {
  it("credit balance too low → true", () => {
    expect(isApiAccountError("Anthropic API isteği geçersiz: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.")).toBe(true);
  });
  it("auth + permission + quota → true", () => {
    expect(isApiAccountError("Anthropic API anahtarı geçersiz veya yetersiz.")).toBe(true);
    expect(isApiAccountError("permission_error: no access")).toBe(true);
    expect(isApiAccountError("quota exceeded")).toBe(true);
  });
  it("normal proje/derleme hatası → false (escalation/analiz çalışmalı)", () => {
    expect(isApiAccountError("TypeError: cannot read property x of undefined")).toBe(false);
    expect(isApiAccountError("lint failed: 3 errors")).toBe(false);
    expect(isApiAccountError("Anthropic API rate limit aşıldı")).toBe(false); // transient, hesap değil
  });
});
