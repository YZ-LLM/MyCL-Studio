import { describe, expect, it } from "vitest";
import { decideDebugFixApplication } from "../src/phase-0.js";

// Çift-soru fix (YZLLM 2026-07-03 "aynı şeyi 2 kere sordu"): D2 kararı — SOR mu OTO-UYGULA mı.
// userChoiceHonored = kullanıcı error-analysis'te seçti VE D1 recommended'ı o yöne EXPLICIT kilitledi
// (user_choice_feasible === true; mahkeme EXPLICIT-TRUE dayattı). Bu + restart değil → auto (tekrar sorma).
describe("decideDebugFixApplication", () => {
  it("ASIL FİX: kullanıcı-seçimi D1'ce onaylandı (honored) + restart değil → 'auto' (çift-soru bastırılır)", () => {
    expect(
      decideDebugFixApplication({ restartsPipeline: false, otoCevap: false, userChoiceHonored: true }),
    ).toBe("auto");
  });

  it("Edge 3b: honored olsa bile pipeline-restart → 'ask' (büyük karar guardrail)", () => {
    expect(
      decideDebugFixApplication({ restartsPipeline: true, otoCevap: false, userChoiceHonored: true }),
    ).toBe("ask");
  });

  it("EXPLICIT-TRUE değil (undefined/false → honored=false) + oto kapalı → 'ask' (yanlış-yön sessiz uygulanmaz)", () => {
    // D1 feasible=true dönmediyse (unuttu VEYA yönü çürüttü) → honored=false → sor.
    expect(
      decideDebugFixApplication({ restartsPipeline: false, otoCevap: false, userChoiceHonored: false }),
    ).toBe("ask");
  });

  it("kullanıcı seçmedi (honored=false) + oto-cevap AÇIK → 'auto' (mevcut oto-cevap davranışı korunur)", () => {
    expect(
      decideDebugFixApplication({ restartsPipeline: false, otoCevap: true, userChoiceHonored: false }),
    ).toBe("auto");
  });

  it("oto-cevap AÇIK ama pipeline-restart → 'ask' (guardrail oto-cevaptan güçlü)", () => {
    expect(
      decideDebugFixApplication({ restartsPipeline: true, otoCevap: true, userChoiceHonored: false }),
    ).toBe("ask");
  });

  it("honored + oto-cevap AÇIK + restart değil → 'auto'", () => {
    expect(
      decideDebugFixApplication({ restartsPipeline: false, otoCevap: true, userChoiceHonored: true }),
    ).toBe("auto");
  });
});
