// Faz 6 çalışma zamanı hatası kapısı — boş ekran kapısının ikizi.
//
// NEDEN (2026-09-18): `runtime_error` sinyalinin bugüne kadar HİÇBİR tüketicisi yoktu. Veritabanına
// yazılıyor, olay yayınlanıyor, sohbete basılıyordu; ama faz/kapı/hüküm tarafında kimse okumuyordu.
// Canlı kanıt: Vite sürekli "Failed to load url /src/main.jsx" diye bağırdı, uygulama hiç açılmadı
// ve hiçbir karar bunu gördü. Artık onay kapısı okuyor.
import { describe, expect, it } from "vitest";
import { runtimeErrorGate } from "../src/phase-6.js";

describe("runtimeErrorGate", () => {
  it("hata kaydedilmişse çıplak onay DOĞRUDAN kabul edilmez — bir kez teyit istenir", () => {
    expect(runtimeErrorGate({ ui_review_runtime_errors: 3 })).toEqual({
      kind: "confirm-needed",
      count: 3,
    });
  });

  it("ısrar edilebilir: bayrak temizlendikten sonra onay GEÇER (gate değil, bilinçli onay)", () => {
    expect(runtimeErrorGate({ ui_review_runtime_errors: 0 })).toEqual({ kind: "accept" });
  });

  it("REGRESYON KİLİDİ: hata yokken onay eskisi gibi doğrudan geçer", () => {
    expect(runtimeErrorGate({})).toEqual({ kind: "accept" });
    expect(runtimeErrorGate({ ui_review_runtime_errors: undefined })).toEqual({ kind: "accept" });
  });

  it("ölçüm yapılamadıysa (alan yok) hata İDDİA EDİLMEZ — yanlış alarm yasağı", () => {
    expect(runtimeErrorGate({}).kind).toBe("accept");
  });
});
