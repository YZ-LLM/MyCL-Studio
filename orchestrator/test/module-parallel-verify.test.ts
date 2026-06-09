import { describe, expect, it } from "vitest";
import { formatVerifyResult } from "../src/module-parallel/verify.js";

describe("formatVerifyResult (saf)", () => {
  it("hepsi ok → 'geçti' başlığı + ✅", () => {
    const out = formatVerifyResult({
      allOk: true,
      results: [
        { key: "build", ran: true, ok: true, detail: "geçti" },
        { key: "lint", ran: false, ok: true, detail: "komut yok → atlandı" },
      ],
    });
    expect(out).toContain("geçti");
    expect(out).toContain("✅");
    expect(out).toContain("⏭️"); // atlanan
  });

  it("fail varsa → uyarı başlığı + hata detayı", () => {
    const out = formatVerifyResult({
      allOk: false,
      results: [{ key: "test", ran: true, ok: false, detail: "2 test fail" }],
    });
    expect(out).toContain("sorun");
    expect(out).toContain("2 test fail");
    expect(out).toContain("❌");
  });
});
