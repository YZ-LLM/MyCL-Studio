// Model yükseltme sorusu — otomatik cevaplayan bir araç kullanıcının KALICI model ayarını değiştirmesin.
//
// Olay: ekransız koşu betiği (harness.mjs) soruları `suggested_option ?? opts[0] ?? "Onayla"` ile cevaplıyordu.
// Model yükseltme sorusu öneri taşımıyordu ve ilk seçeneği "Evet, geç" idi → betik ana modeli ve strong katmanı
// kalıcı olarak değiştirdi. Düzeltme: soru güvenli varsayılanı kendisi taşır ve yalnız kullanıcı cevaplar; betik
// de önerisi olmayan ya da yalnız kullanıcıya ait soruyu cevaplamaz.

import { describe, expect, it } from "vitest";
import {
  buildModelUpgradeAskq,
  isModelUpgradeAccepted,
  MODEL_UPGRADE_NO,
  MODEL_UPGRADE_YES,
} from "../src/model-discovery.js";
// @ts-expect-error — düz .mjs betik yardımcıları için tip bildirimi yok
import { pickHarnessAnswer } from "../harness-answer.mjs";

describe("model yükseltme sorusu güvenli varsayılanı kendisi taşır", () => {
  const q = buildModelUpgradeAskq("id-1", "claude-fable-5-2");

  it("önerilen seçenek 'Hayır, kalsın'", () => {
    expect(q.suggested_option).toBe("Hayır, kalsın");
    expect(q.suggested_option).toBe(MODEL_UPGRADE_NO);
  });

  it("yalnız kullanıcı cevaplar (protected) işaretli", () => {
    expect(q.protected).toBe(true);
  });

  it("insan için seçenekler ve sıra AYNI: ['Evet, geç', 'Hayır, kalsın'], başka cevap yazılamaz", () => {
    expect(q.options).toEqual(["Evet, geç", "Hayır, kalsın"]);
    expect(q.allow_other).toBe(false);
    expect(q.question).toContain("claude-fable-5-2");
  });
});

describe("cevabın yorumu — insan akışı değişmedi", () => {
  it("'Evet, geç' → kabul (eskisi gibi geçilir)", () => {
    expect(isModelUpgradeAccepted(MODEL_UPGRADE_YES)).toBe(true);
  });
  it("'Hayır, kalsın' → ret", () => {
    expect(isModelUpgradeAccepted(MODEL_UPGRADE_NO)).toBe(false);
  });
  it("betiklerin uydurduğu cevaplar ('Onayla', boş) kabul SAYILMAZ", () => {
    expect(isModelUpgradeAccepted("Onayla")).toBe(false);
    expect(isModelUpgradeAccepted("")).toBe(false);
  });
});

describe("ekransız betiğin cevap mantığı", () => {
  it("model yükseltme sorusunu CEVAPLAMAZ → ne ana model ne ret listesi değişir", () => {
    const pick = pickHarnessAnswer(buildModelUpgradeAskq("id-1", "claude-fable-5-2"));
    expect(pick.answer).toBeNull();
    expect(pick.why).toContain("yalnız kullanıcı");
  });

  it("işaret olmasaydı bile betik önerilen seçeneği seçerdi; o da kabul değildir → ana model değişmez", () => {
    const { protected: _p, ...unprotected } = buildModelUpgradeAskq("id-1", "claude-fable-5-2");
    const pick = pickHarnessAnswer(unprotected);
    expect(pick.answer).toBe("Hayır, kalsın");
    expect(isModelUpgradeAccepted(pick.answer)).toBe(false);
  });

  it("ESKİ HATA: önerisi olmayan soruda ilk seçenek körlemesine SEÇİLMEZ", () => {
    const pick = pickHarnessAnswer({ options: ["Evet, geç", "Hayır, kalsın"] });
    expect(pick.answer).toBeNull();
    expect(pickHarnessAnswer({ options: [] }).answer).toBeNull();
    expect(pickHarnessAnswer({ options: ["A"], suggested_option: "   " }).answer).toBeNull();
  });

  it("öneri taşıyan sıradan soru önerilen seçenekle cevaplanır", () => {
    expect(pickHarnessAnswer({ options: ["Onayla", "Revize", "İptal"], suggested_option: "Onayla" }).answer).toBe("Onayla");
  });
});
