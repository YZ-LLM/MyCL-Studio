// auto-answer — SAF karar mantığı testleri (finding-queue.test deseni: yan etki yok, singleton'a dokunmaz).
// ODAK: decideAutoAnswer doğruluk tablosu — (1) neverAsk=false PARİTE (eski davranış birebir), (2) neverAsk=true
// HİÇBİR ŞEY SORMA (her kategori × foreign/non × onay/clarify → HEP oto, enabled/suppressed'ı AŞAR). classifyQaAskq.

import { describe, expect, it } from "vitest";
import { decideAutoAnswer, classifyQaAskq, type AutoAnswerCategory } from "./auto-answer.js";

const CATS: AutoAnswerCategory[] = ["safe-flow", "dangerous-write", "user-preference"];

describe("decideAutoAnswer — PARİTE (neverAsk=false → eski davranış BİREBİR)", () => {
  it("oto-cevap KAPALI (enabled=false) → her kategori false", () => {
    for (const c of CATS) {
      expect(decideAutoAnswer(c, { enabled: false, suppressed: false })).toBe(false);
      expect(decideAutoAnswer(c, { enabled: false, suppressed: true })).toBe(false);
    }
  });

  it("NON-FOREIGN (suppressed=false) + enabled → kategori'ye BAKMADAN true (parite değişmezi)", () => {
    for (const c of CATS) {
      expect(decideAutoAnswer(c, { enabled: true, suppressed: false })).toBe(true);
      expect(decideAutoAnswer(c, { enabled: true, suppressed: false, isApproval: false, hasSuggestion: false })).toBe(true);
    }
  });

  it("FOREIGN (suppressed=true) + enabled: yalnız safe-flow geçer, dangerous+user-preference → false", () => {
    // safe-flow onay → true; safe-flow clarify → yalnız hasSuggestion
    expect(decideAutoAnswer("safe-flow", { enabled: true, suppressed: true, isApproval: true })).toBe(true);
    expect(decideAutoAnswer("safe-flow", { enabled: true, suppressed: true, hasSuggestion: true })).toBe(true);
    expect(decideAutoAnswer("safe-flow", { enabled: true, suppressed: true, hasSuggestion: false })).toBe(false);
    // dangerous + user-preference foreign'de HER durumda kullanıcıda
    expect(decideAutoAnswer("dangerous-write", { enabled: true, suppressed: true, isApproval: true })).toBe(false);
    expect(decideAutoAnswer("user-preference", { enabled: true, suppressed: true, hasSuggestion: true })).toBe(false);
  });
});

describe("decideAutoAnswer — HİÇBİR ŞEY SORMA (neverAsk=true → her kategori oto; foreign'de GÖSTER-oto, çağıran gösterir)", () => {
  it("her kategori × foreign/non × onay/clarify → HEP true (foreign dangerous dahil — kör DEĞİL: kod-değiştiren yol GÖSTERİR)", () => {
    for (const c of CATS) {
      for (const suppressed of [false, true]) {
        for (const enabled of [false, true]) {
          for (const isApproval of [false, true]) {
            for (const hasSuggestion of [false, true]) {
              expect(decideAutoAnswer(c, { enabled, suppressed, isApproval, hasSuggestion, neverAsk: true })).toBe(true);
            }
          }
        }
      }
    }
  });

  it("neverAsk enabled=false iken bile oto (superset — kullanıcı yalnız hiçbir-şey-sorma açtı)", () => {
    expect(decideAutoAnswer("dangerous-write", { enabled: false, suppressed: true, neverAsk: true })).toBe(true);
  });

  it("neverAsk=false açıkça verilince parite bozulmaz (dangerous+foreign → false)", () => {
    expect(decideAutoAnswer("dangerous-write", { enabled: true, suppressed: true, neverAsk: false })).toBe(false);
  });
});

describe("classifyQaAskq (değişmedi — regresyon guard)", () => {
  it("Faz 1/2 netleştirme (onay değil) → user-preference", () => {
    expect(classifyQaAskq("phase-1", false)).toBe("user-preference");
    expect(classifyQaAskq("phase-2", false)).toBe("user-preference");
  });
  it("Faz 1/2 ONAY → safe-flow (netleştirme değil)", () => {
    expect(classifyQaAskq("phase-1", true)).toBe("safe-flow");
  });
  it("Faz 9 → dangerous-write (kod-değiştiren risk-fix)", () => {
    expect(classifyQaAskq("phase-9", false)).toBe("dangerous-write");
    expect(classifyQaAskq("phase-9", true)).toBe("dangerous-write");
  });
  it("diğer fazlar → safe-flow", () => {
    expect(classifyQaAskq("phase-4", false)).toBe("safe-flow");
  });
});
