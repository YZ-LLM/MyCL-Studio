// user-directives — SAF seam testleri: verdict parse (adopt/object/null) + satır ayrıştırma.
// IMPURE yollar (appendUserDirective/readUserDirectives fs + handleOrchestratorDirective LLM) burada test EDİLMEZ.

import { describe, expect, it } from "vitest";
import {
  buildDirectiveEvalPrompt,
  normalizeForDedup,
  parseDirectiveLines,
  parseDirectiveVerdict,
} from "../src/user-directives.js";

describe("parseDirectiveVerdict — karar çıkarımı", () => {
  it("KARAR: BENİMSE → adopt + işaretçi satırı mesajdan çıkar", () => {
    const r = parseDirectiveVerdict("Bu makul bir tercih, uygularım.\nKARAR: BENİMSE");
    expect(r.verdict).toBe("adopt");
    expect(r.message).toBe("Bu makul bir tercih, uygularım.");
    expect(r.message).not.toContain("KARAR");
  });

  it("KARAR: İTİRAZ → object", () => {
    const r = parseDirectiveVerdict("Bu mevcut güvenlik ilkesiyle çelişir.\nKARAR: İTİRAZ");
    expect(r.verdict).toBe("object");
    expect(r.message).toBe("Bu mevcut güvenlik ilkesiyle çelişir.");
  });

  it("Türkçe-İ'siz varyant (BENIMSE/ITIRAZ) da tanınır", () => {
    expect(parseDirectiveVerdict("ok\nKARAR: BENIMSE").verdict).toBe("adopt");
    expect(parseDirectiveVerdict("hayır\nKARAR: ITIRAZ").verdict).toBe("object");
  });

  it("İngilizce ADOPT/OBJECT/KABUL fallback'i", () => {
    expect(parseDirectiveVerdict("x\nKARAR: ADOPT").verdict).toBe("adopt");
    expect(parseDirectiveVerdict("x\nKARAR: KABUL").verdict).toBe("adopt");
    expect(parseDirectiveVerdict("x\nKARAR: OBJECT").verdict).toBe("object");
  });

  it("prose'da 'itiraz' geçse bile yalnız KARAR: işaretçisi belirler (yanlış-eşleşme yok)", () => {
    // "itirazım yok" = itiraz YOK = benimse; bare 'itiraz' kelimesi kararı YANILTMAMALI.
    const r = parseDirectiveVerdict("Bu yönergeye itirazım yok, uygularım.\nKARAR: BENİMSE");
    expect(r.verdict).toBe("adopt");
  });

  it("işaretçi yoksa verdict=null (fail-closed: çağıran kaydetmez) + mesaj tüm metin", () => {
    const r = parseDirectiveVerdict("Belirsiz bir cevap, net karar yok.");
    expect(r.verdict).toBeNull();
    expect(r.message).toBe("Belirsiz bir cevap, net karar yok.");
  });

  it("boş/whitespace → verdict null", () => {
    expect(parseDirectiveVerdict("").verdict).toBeNull();
    expect(parseDirectiveVerdict("   \n  ").verdict).toBeNull();
  });

  it("birden fazla KARAR: satırı varsa hepsi mesajdan çıkar", () => {
    const r = parseDirectiveVerdict("Gerekçe.\nKARAR: BENİMSE\nnot: KARAR: ikinci");
    expect(r.message).toBe("Gerekçe.");
  });
});

describe("parseDirectiveLines — bullet ayrıştırma", () => {
  it("'- ' bullet'ları soyar, boşları eler", () => {
    expect(parseDirectiveLines("- a\n- b\n\n-   c  ")).toEqual(["a", "b", "c"]);
  });
  it("bullet'sız satırlar da yönerge sayılır (trim'li)", () => {
    expect(parseDirectiveLines("  düz yönerge \n")).toEqual(["düz yönerge"]);
  });
  it("boş içerik → []", () => {
    expect(parseDirectiveLines("")).toEqual([]);
    expect(parseDirectiveLines("\n  \n")).toEqual([]);
  });
});

describe("normalizeForDedup — yakın-kopya eleme (mahkeme #6)", () => {
  it("büyük-küçük + sondaki noktalama varyantı aynı sayılır", () => {
    expect(normalizeForDedup("Her zaman versiyonlama yap.")).toBe(
      normalizeForDedup("her zaman versiyonlama yap"),
    );
    expect(normalizeForDedup("Test Yap!  ")).toBe(normalizeForDedup("test yap"));
  });
  it("içerik farkı korunur (yanlış-dedup yok)", () => {
    expect(normalizeForDedup("a yap")).not.toBe(normalizeForDedup("b yap"));
  });
});

describe("buildDirectiveEvalPrompt — prompt kurulumu", () => {
  it("yönergeyi içerir + KARAR işaretçi formatını ister + 'görev değil' çerçevesi", () => {
    const p = buildDirectiveEvalPrompt("her zaman versiyonlama yap");
    expect(p).toContain("her zaman versiyonlama yap");
    expect(p).toContain("KARAR: BENİMSE");
    expect(p).toContain("KARAR: İTİRAZ");
    expect(p).toContain("GÖREV değil");
  });
});
