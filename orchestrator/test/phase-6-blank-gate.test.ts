// Faz 6 boş ekran kapısı — "gördüm ve beğendim" yalnız görülebilir bir şey varken geçerlidir.
//
// CANLI KANIT (cüzdan koşusu, 2026-09-16): uygulamanın giriş dosyası (main.jsx) hiç yazılmamıştı,
// bu yüzden React hiç mount olmuyordu ve ekran bomboştu. Görsel tarama bunu TESPİT ETTİ ve Faz 6
// raporuna "Boş görünen sayfa: / — neredeyse tek renk" diye yazdı. Ama hiçbir karar bu bayrağı
// okumuyordu: inceleme onaylandı, akış Faz 7'ye geçti ve iş "onaylanmış" sayıldı — sahte yeşil.
import { describe, expect, it } from "vitest";
import { blankScreenGate } from "../src/phase-6.js";

describe("blankScreenGate", () => {
  it("ekran boşken çıplak onay DOĞRUDAN kabul edilmez — bir kez teyit istenir", () => {
    expect(blankScreenGate({ ui_review_blank: true })).toEqual({ kind: "confirm-needed" });
  });

  it("ısrar edilebilir: bayrak temizlendikten sonra onay GEÇER (irade ezilmez)", () => {
    // Çağıran bayrağı teyit isterken temizler; ikinci onayda durum şudur:
    expect(blankScreenGate({ ui_review_blank: undefined })).toEqual({ kind: "accept" });
  });

  it("REGRESYON KİLİDİ: ekran doluyken onay eskisi gibi doğrudan geçer", () => {
    expect(blankScreenGate({ ui_review_blank: false })).toEqual({ kind: "accept" });
    expect(blankScreenGate({})).toEqual({ kind: "accept" });
  });

  it("ölçüm yapılamadıysa (bayrak yok) 'boş' İDDİA EDİLMEZ — yanlış alarm yasağı", () => {
    expect(blankScreenGate({}).kind).toBe("accept");
  });
});
