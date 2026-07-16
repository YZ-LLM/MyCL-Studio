// auto-answer — SAF karar mantığı testleri (finding-queue.test deseni: yan etki yok, singleton'a dokunmaz).
// ODAK: decideAutoAnswer doğruluk tablosu — (1) neverAsk=false PARİTE (eski davranış birebir), (2) neverAsk=true
// HİÇBİR ŞEY SORMA (her kategori × foreign/non × onay/clarify → HEP oto, enabled/suppressed'ı AŞAR). classifyQaAskq.

import { describe, expect, it } from "vitest";
import {
  decideAutoAnswer,
  classifyQaAskq,
  isProtectedAskqId,
  isCourtFirstAskqId,
  isAutonomouslyAnswerableAskq,
  matchAnswerToOption,
  stripDestructiveOptions,
  pickConservativeDefault,
  shouldStopAutoAnswer,
  type AutoAnswerCategory,
} from "./auto-answer.js";

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

describe("otonom-cevap SAF helper'lar (never-ask kapsanmamış askq → orkestra ajanı/mahkeme; YZLLM 2026-07-10)", () => {
  it("isProtectedAskqId: yıkıcı iş-iptali + kullanıcı-tetikli butonlar + plan onayı korunur; diğerleri otonom-cevaplanabilir", () => {
    expect(isProtectedAskqId("agent_decision_abc")).toBe(true); // cancel_pipeline — yıkıcı
    expect(isProtectedAskqId("dast_confirm_x")).toBe(true); // 🛡️ buton
    expect(isProtectedAskqId("full_test_confirm_x")).toBe(true); // 🧪 buton (2026-07-16)
    expect(isProtectedAskqId("maintenance_confirm_x")).toBe(true); // 🔧 buton (2026-07-16)
    expect(isProtectedAskqId("plan_approve_x")).toBe(true); // 🗺️ plan onayı — never-ask'ta bile açık onay
    expect(isProtectedAskqId("phase-run-5")).toBe(false);
    expect(isProtectedAskqId("error_analysis_fallback_1")).toBe(false);
  });

  it("stripDestructiveOptions: vazgeç/iptal/sil/hayır ele; constructive kalır", () => {
    expect(stripDestructiveOptions(["✅ Çalıştır", "Vazgeç"])).toEqual(["✅ Çalıştır"]);
    expect(stripDestructiveOptions(["Uygula", "İptal (uygulama)"])).toEqual(["Uygula"]);
    expect(stripDestructiveOptions(["❌ Hayır", "Evet, değiştir"])).toEqual(["Evet, değiştir"]);
    expect(stripDestructiveOptions(["Kaydet", "Sil"])).toEqual(["Kaydet"]);
    expect(stripDestructiveOptions(["Vazgeç"])).toEqual([]); // yalnız-yıkıcı → boş
  });

  it("pickConservativeDefault: ilk constructive seçenek; yalnız-yıkıcı → null", () => {
    expect(pickConservativeDefault(["Devam et", "Yeni iş", "Vazgeç"])).toBe("Devam et");
    expect(pickConservativeDefault(["İptal"])).toBeNull();
    expect(pickConservativeDefault([])).toBeNull();
  });

  it("shouldStopAutoAnswer: MAX'ta döngü emniyeti tetiklenir", () => {
    expect(shouldStopAutoAnswer(0, 3)).toBe(false);
    expect(shouldStopAutoAnswer(2, 3)).toBe(false);
    expect(shouldStopAutoAnswer(3, 3)).toBe(true);
    expect(shouldStopAutoAnswer(5, 3)).toBe(true);
  });

  it("isCourtFirstAskqId: restart_consent_ (tüm pipeline'ı yeniden başlatan büyük karar) → yalnız mahkeme; diğerleri değil", () => {
    expect(isCourtFirstAskqId("restart_consent_abc")).toBe(true); // phase-0 GUARDRAIL 1 (full-stack/new-iteration)
    expect(isCourtFirstAskqId("phase-run-5")).toBe(false);
    expect(isCourtFirstAskqId("agent_decision_x")).toBe(false); // korunan ≠ court-first (o hiç cevaplanmaz)
    expect(isCourtFirstAskqId("error_analysis_fallback_1")).toBe(false);
  });

  it("isAutonomouslyAnswerableAskq: korunan (id-öneki VEYA protected bayrağı) → false; kapsanmamış normal → true (TEK KAYNAK)", () => {
    // KULLANICI-ONLY: id-öneki korumalı
    expect(isAutonomouslyAnswerableAskq({ id: "agent_decision_x" })).toBe(false); // cancel_pipeline
    expect(isAutonomouslyAnswerableAskq({ id: "dast_confirm_y" })).toBe(false); // DAST butonu
    // KULLANICI-ONLY: protected bayrağı (forceUserPrompt — düz-uuid id ama korumalı)
    expect(isAutonomouslyAnswerableAskq({ id: "550e8400-uuid", protected: true })).toBe(false);
    // Otonom cevaplanabilir: kapsanmamış, önek yok, protected yok
    expect(isAutonomouslyAnswerableAskq({ id: "phase-run-5" })).toBe(true);
    expect(isAutonomouslyAnswerableAskq({ id: "error_analysis_fallback_1", protected: false })).toBe(true);
    // restart_consent (court-first) OTONOM cevaplanabilir (mahkeme karar verir) — korunan değil
    expect(isAutonomouslyAnswerableAskq({ id: "restart_consent_z" })).toBe(true);
  });

  it("matchAnswerToOption: exact > çift-yön includes; uymazsa null (uydurma-yasak)", () => {
    expect(matchAnswerToOption("Devam et", ["Devam et", "Vazgeç"])).toBe("Devam et"); // exact
    expect(matchAnswerToOption("Devam", ["✅ Devam et", "Vazgeç"])).toBe("✅ Devam et"); // option, cevabı kapsar
    expect(matchAnswerToOption("Evet, Devam et diyorum", ["Devam et"])).toBe("Devam et"); // cevap option'ı kapsar (harf-duyarlı)
    expect(matchAnswerToOption("Bambaşka bir şey", ["Devam et", "Yeni iş"])).toBeNull(); // uydurma → null
    expect(matchAnswerToOption("  Devam et  ", ["Devam et"])).toBe("Devam et"); // trim
  });
});
