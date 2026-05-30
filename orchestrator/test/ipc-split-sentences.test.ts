import { describe, expect, it } from "vitest";
import { splitSentences } from "../src/ipc.js";

describe("splitSentences (v15.2.5 — assistant cümleleri tek satıra)", () => {
  it("returns empty/null input unchanged", () => {
    expect(splitSentences("")).toBe("");
  });

  it("single sentence — unchanged", () => {
    expect(splitSentences("Bu tek bir cümle.")).toBe("Bu tek bir cümle.");
  });

  it("two sentences separated by '. ' → newline", () => {
    expect(splitSentences("İlk cümle. İkinci cümle.")).toBe(
      "İlk cümle.\nİkinci cümle.",
    );
  });

  it("question + statement", () => {
    expect(splitSentences("Bu ne demek? Anlamadım.")).toBe(
      "Bu ne demek?\nAnlamadım.",
    );
  });

  it("exclamation + statement", () => {
    expect(splitSentences("Harika! Devam edelim.")).toBe(
      "Harika!\nDevam edelim.",
    );
  });

  it("Turkish capital letters (Ç, Ğ, İ, Ö, Ş, Ü)", () => {
    expect(splitSentences("Birinci cümle. Çağrı yapıldı.")).toBe(
      "Birinci cümle.\nÇağrı yapıldı.",
    );
    expect(splitSentences("Cümle bir. İkincisi gelir.")).toBe(
      "Cümle bir.\nİkincisi gelir.",
    );
    expect(splitSentences("Test. Üçüncü cümle.")).toBe(
      "Test.\nÜçüncü cümle.",
    );
  });

  it("lowercase next char — no split (continuation)", () => {
    // "i.e." gibi kısaltmalar veya cümle ortası nokta — büyük harf gelmediği
    // için split olmaz.
    expect(splitSentences("foo. bar")).toBe("foo. bar");
  });

  it("multiple sentences in chain", () => {
    const input = "Bir cümle. İki cümle. Üç cümle.";
    expect(splitSentences(input)).toBe("Bir cümle.\nİki cümle.\nÜç cümle.");
  });

  it("preserves code block — sentences inside ``` are NOT split", () => {
    const input =
      "Açıklama. Şu kod bloğunu çalıştır.\n```js\nlet a = 1. const b = 2.\n```\nSonra bitir.";
    const out = splitSentences(input);
    // Code block içeriği değişmedi
    expect(out).toContain("let a = 1. const b = 2.");
    // Block dışı cümleler split olmuş
    expect(out).toContain("Açıklama.\nŞu kod bloğunu çalıştır.");
    expect(out).toContain("\nSonra bitir.");
  });

  it("preserves inline code — `foo.bar` not split", () => {
    const input = "Şu çağrıyı yap: `process.exit(0)`. Sonra dur.";
    const out = splitSentences(input);
    expect(out).toContain("`process.exit(0)`");
    expect(out).toContain(".\nSonra dur.");
  });

  it("does not split mid-line on lowercase abbreviation continuation", () => {
    // "vb. ifade" gibi durumlar — büyük harf yok, split yok.
    expect(splitSentences("Test vb. ifade var.")).toBe("Test vb. ifade var.");
  });

  it("preserves existing newlines in text", () => {
    const input = "Birinci satır.\nİkinci satır zaten yeni.";
    // Mevcut newline'a dokunma; aynı satırda cümle yoksa değişiklik yok.
    expect(splitSentences(input)).toBe(input);
  });
});
