// risk-fix-parallel — parseMergedContent birim testi (mahkeme birleşim çıktısı ayrıştırması).
//
// Mahkeme (Sonnet) birleşilmiş dosyayı ===MERGED_START=== / ===MERGED_END=== markerları arasında döndürür.
// JSON DEĞİL (büyük dosya + özel karakter kaçışı kırılgan) → marker tabanlı. Ayrıştırma bug'ı → bozuk merge.

import { describe, expect, it } from "vitest";
import { parseMergedContent } from "./risk-fix-parallel.js";

describe("parseMergedContent", () => {
  it("marker arasındaki içeriği çıkarır (çevre newline'ları kırpılır)", () => {
    const text = "prose before\n===MERGED_START===\nline1\nline2\n===MERGED_END===\nprose after";
    expect(parseMergedContent(text)).toBe("line1\nline2");
  });

  it("içerikteki özel karakterleri/newline'ları korur (JSON kaçışı yok)", () => {
    const content = 'const x = "a\\nb";\nif (a && b) {\n  return `${x}`;\n}';
    const text = `===MERGED_START===\n${content}\n===MERGED_END===`;
    expect(parseMergedContent(text)).toBe(content);
  });

  it("marker yoksa null (fail-closed → seri fallback)", () => {
    expect(parseMergedContent("just some text, no markers")).toBeNull();
    expect(parseMergedContent("===MERGED_START=== ama bitiş yok")).toBeNull();
  });

  it("bitiş başlangıçtan önceyse null (bozuk)", () => {
    expect(parseMergedContent("===MERGED_END===\nx\n===MERGED_START===")).toBeNull();
  });

  it("içerik markerların KENDİSİNİ metin olarak içerse bile son END'e kadar alır", () => {
    // lastIndexOf(END) kullanıldığı için içerikte 'MERGED_END' geçen edge — gerçekçi değil ama guard.
    const text = "===MERGED_START===\nreal content\n===MERGED_END===";
    expect(parseMergedContent(text)).toBe("real content");
  });
});
