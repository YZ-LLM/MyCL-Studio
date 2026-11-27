// protected-askq-composer — korumalı soru, kullanıcının composer'dan yazdığı serbest metinle cevaplanmaz.
//
// CANLI KANIT (ekransız deneme koşusu 29, 2026-11-27): "Yeni güçlü model … buna geçeyim mi?" korumalı sorusu açıkken
// Faz 6 incelemesinde kullanıcı "tamam" yazdı; orkestratör `answer_askq` ile "Evet, geç" dedi ve ~/.mycl/config.json'da
// ana model değişti, arayüz onaylanmadı. `index.ts` içe aktarılınca uygulamayı başlattığı için tam akış burada koşturulamaz;
// karar saf işlevde (routeComposerAskqAnswer, index.ts answer_askq dalı bunu kullanır) ve istem bölümü sınanır.

import { describe, expect, it } from "vitest";
import { routeComposerAskqAnswer } from "../src/auto-answer.js";
import { renderActiveAskqSection } from "../src/orchestrator-agent/context-builder.js";
import type { ActiveAskqSnapshot } from "../src/ipc.js";

const MODEL_ASKQ = {
  id: "model_upgrade_offer_1",
  question: "Yeni güçlü model claude-fable-5-2 çıkmış … buna geçeyim mi?",
  options: ["Evet, geç", "Hayır, kalsın"],
  suggested_option: "Hayır, kalsın",
  protected: true,
} as unknown as ActiveAskqSnapshot;

const NORMAL_ASKQ = {
  id: "phase_scope_1",
  question: "Hangi kapsam?",
  options: ["Tam", "Kısa"],
} as unknown as ActiveAskqSnapshot;

describe("korumalı soru — composer metni", () => {
  it("korumalı soru açıkken 'tamam' → soru cevaplanmaz, mesaj yeniden değerlendirilir (ayar değişmez)", () => {
    expect(routeComposerAskqAnswer(MODEL_ASKQ, "tamam", "Evet, geç")).toEqual({ kind: "reevaluate" });
  });

  it("korumalı soru açıkken seçenek metni aynen yazılırsa (boşluk ve büyük küçük harf hariç) o seçenekle cevaplanır", () => {
    expect(routeComposerAskqAnswer(MODEL_ASKQ, "Evet, geç", "Evet, geç")).toEqual({ kind: "forward", answer: "Evet, geç" });
    expect(routeComposerAskqAnswer(MODEL_ASKQ, "  evet, GEÇ ", "Hayır, kalsın")).toEqual({ kind: "forward", answer: "Evet, geç" });
  });

  it("REGRESYON: korumasız soruda orkestratörün cevabı aynen iletilir", () => {
    expect(routeComposerAskqAnswer(NORMAL_ASKQ, "kısa olsun", "Kısa")).toEqual({ kind: "forward", answer: "Kısa" });
  });

  it("istem: korumalı soruda answer_askq kullanılmaması ve mesajın faz bağlamında değerlendirilmesi söyleniyor", () => {
    const text = renderActiveAskqSection(MODEL_ASKQ);
    expect(text).toContain("**KORUMALI SORU**");
    expect(text).toContain("`answer_askq` KULLANMA");
    expect(text).toMatch(/Faz 6 incelemesi beklerken "tamam" arayüz onayıdır/);
  });

  it("REGRESYON: korumasız soruda istem bölümü eskisi gibi", () => {
    const text = renderActiveAskqSection(NORMAL_ASKQ);
    expect(text).toContain("**ÖNEMLİ**: Kullanıcı askq UI yerine composer'dan yazdı");
    expect(text).not.toContain("KORUMALI SORU");
  });
});
