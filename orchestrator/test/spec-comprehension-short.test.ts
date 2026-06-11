import { describe, expect, it } from "vitest";
import { shortenOption } from "../src/spec-comprehension.js";
describe("shortenOption (Ümit: kısa seçenek)", () => {
  it("uzun AC → ilk cümle + ~70 char + …", () => {
    const long = "Yöneticiye özel anket oluşturma sayfası sunucu tarafında erişim kontrollüdür çünkü yönetici olmayan kullanıcılar 403 alır.";
    const s = shortenOption(long);
    expect(s.length).toBeLessThanOrEqual(72);
    expect(s.endsWith("…")).toBe(true);
  });
  it("kısa metin değişmez", () => {
    expect(shortenOption("403 Forbidden döner.")).toBe("403 Forbidden döner.");
  });
});
