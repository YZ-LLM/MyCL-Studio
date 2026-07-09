// auto-answer — entegre-modu bastırma (YZLLM cave5): foreign-origin projede oto-cevap kullanıcıya yönlenir.

import { describe, expect, it, afterEach } from "vitest";
import {
  setAutoAnswerSuggested,
  setIntegrateModeSuppression,
  isIntegrateSuppressed,
  autoAnswerSuggested,
  autoAnswerPick,
  decideAutoAnswer,
  classifyQaAskq,
  isAutoAnswerEnabled,
} from "../src/auto-answer.js";

describe("auto-answer · entegre-modu bastırma", () => {
  afterEach(() => {
    // Modül-singleton → testler arası sıfırla.
    setAutoAnswerSuggested(false);
    setIntegrateModeSuppression(false);
  });

  it("oto-cevap AÇIK + entegre-bastırma AÇIK → suggested=false, pick=null (kullanıcı yanıtlar)", () => {
    setAutoAnswerSuggested(true);
    setIntegrateModeSuppression(true);
    expect(isIntegrateSuppressed()).toBe(true);
    expect(autoAnswerSuggested()).toBe(false);
    expect(autoAnswerPick(["a", "b"], "a")).toBeNull();
  });

  it("oto-cevap AÇIK + bastırma KAPALI → normal (suggested=true, pick=öneri)", () => {
    setAutoAnswerSuggested(true);
    setIntegrateModeSuppression(false);
    expect(autoAnswerSuggested()).toBe(true);
    expect(autoAnswerPick(["a", "b"], "b")).toBe("b");
  });

  it("oto-cevap KAPALI → bastırmadan bağımsız null (geriye-uyum, default davranış)", () => {
    setAutoAnswerSuggested(false);
    expect(autoAnswerSuggested()).toBe(false);
    expect(autoAnswerPick(["a"], undefined)).toBeNull();
  });

  it("isAutoAnswerEnabled: entegre-bastırmadan BAĞIMSIZ ham toggle (güvenlik-fix opt-in için)", () => {
    setAutoAnswerSuggested(true);
    setIntegrateModeSuppression(true); // foreign bastırma
    expect(autoAnswerSuggested()).toBe(false); // bastırmalı → false
    expect(isAutoAnswerEnabled()).toBe(true); // ama ham toggle AÇIK (foreign güvenlik-fix opt-in bunu okur)
    setAutoAnswerSuggested(false);
    expect(isAutoAnswerEnabled()).toBe(false);
  });
});

describe("auto-answer · decideAutoAnswer (kategori doğruluk tablosu)", () => {
  const F = { enabled: true, suppressed: true }; // FOREIGN
  const N = { enabled: true, suppressed: false }; // NON-FOREIGN

  it("kapalı (enabled=false) → HER kategori/durum false", () => {
    for (const cat of ["safe-flow", "dangerous-write", "user-preference"] as const) {
      expect(decideAutoAnswer(cat, { enabled: false, suppressed: false })).toBe(false);
      expect(decideAutoAnswer(cat, { enabled: false, suppressed: true })).toBe(false);
    }
  });

  it("NON-FOREIGN parite: !suppressed → category'ye BAKMADAN true (eski _enabled davranışı)", () => {
    // Kritik parite: dangerous/user-preference bile non-foreign'de true döner (category kontrolünden ÖNCE).
    expect(decideAutoAnswer("safe-flow", N)).toBe(true);
    expect(decideAutoAnswer("dangerous-write", N)).toBe(true);
    expect(decideAutoAnswer("user-preference", N)).toBe(true);
  });

  it("FOREIGN: dangerous-write + user-preference → HER ZAMAN false (kullanıcıda)", () => {
    expect(decideAutoAnswer("dangerous-write", { ...F, isApproval: true, hasSuggestion: true })).toBe(false);
    expect(decideAutoAnswer("user-preference", { ...F, isApproval: true, hasSuggestion: true })).toBe(false);
  });

  it("FOREIGN safe-flow: onay (isApproval) → true; onay değil → yalnız hasSuggestion", () => {
    expect(decideAutoAnswer("safe-flow", { ...F, isApproval: true })).toBe(true); // onay → oto
    expect(decideAutoAnswer("safe-flow", { ...F, isApproval: false, hasSuggestion: true })).toBe(true); // clarify+öneri → oto
    expect(decideAutoAnswer("safe-flow", { ...F, isApproval: false, hasSuggestion: false })).toBe(false); // clarify öneri yok → kullanıcı
    expect(decideAutoAnswer("safe-flow", F)).toBe(false); // opts yok (öneri yok) → kullanıcı
  });
});

describe("auto-answer · classifyQaAskq", () => {
  it("Faz 1/2 NETLEŞTİRME (onay değil) → user-preference", () => {
    expect(classifyQaAskq("phase-1", false)).toBe("user-preference");
    expect(classifyQaAskq("phase-2", false)).toBe("user-preference");
  });
  it("Faz 1/2 ONAY → safe-flow (kullanıcı 'güvenli onaylar' istedi)", () => {
    expect(classifyQaAskq("phase-1", true)).toBe("safe-flow");
    expect(classifyQaAskq("phase-2", true)).toBe("safe-flow");
  });
  it("Faz 9 risk → dangerous-write (dispatchRiskFixes yabancı kod)", () => {
    expect(classifyQaAskq("phase-9", false)).toBe("dangerous-write");
    expect(classifyQaAskq("phase-9", true)).toBe("dangerous-write");
  });
  it("diğer faz clarify/onay → safe-flow", () => {
    expect(classifyQaAskq("phase-4", false)).toBe("safe-flow");
  });
});

describe("auto-answer · kategori entegrasyonu (foreign'de seçmeli)", () => {
  afterEach(() => {
    setAutoAnswerSuggested(false);
    setIntegrateModeSuppression(false);
  });
  it("FOREIGN: safe-flow onay oto; dangerous kullanıcıda", () => {
    setAutoAnswerSuggested(true);
    setIntegrateModeSuppression(true);
    // safe-flow onay → pick döner
    expect(autoAnswerPick(["Onayla", "Reddet"], undefined, "safe-flow", { isApproval: true })).toBe("Onayla");
    // dangerous → null (kullanıcı)
    expect(autoAnswerPick(["Onayla"], "Onayla", "dangerous-write")).toBeNull();
    // safe-flow clarify öneriyle → suggested döner
    expect(autoAnswerPick(["a", "b"], "b", "safe-flow")).toBe("b");
    // safe-flow clarify önerisiz → null (emin değil)
    expect(autoAnswerPick(["a", "b"], undefined, "safe-flow")).toBeNull();
  });
});
