// revert-decision — "geri al mı, tut mu?" saf karar matrisi (YZLLM: kararı MyCL versin).
// Güvenli varsayılan GERİ AL; TUT yalnız pozitif kanıtla.
import { describe, expect, it } from "vitest";
import { decideRevertOrKeep } from "../src/revert-decision.js";

describe("decideRevertOrKeep", () => {
  it("anchor hiç koşmadı (kanıt yok) → GERİ AL (güvenli varsayılan)", () => {
    const d = decideRevertOrKeep({ baselineGreen: null, anchor: null });
    expect(d.action).toBe("revert");
    expect(d.reason_tr).toContain("kanıt");
  });

  it("yeni regresyon var → GERİ AL + kırılan test adları gerekçede", () => {
    const d = decideRevertOrKeep({
      baselineGreen: true,
      anchor: { cleanVsBaseline: false, newRegressions: ["auth.test.ts > login", "nav.test.ts > menü"] },
    });
    expect(d.action).toBe("revert");
    expect(d.reason_tr).toContain("auth.test.ts > login");
  });

  it("3'ten çok regresyonda gerekçe kısaltılır (+N)", () => {
    const d = decideRevertOrKeep({
      baselineGreen: true,
      anchor: { cleanVsBaseline: false, newRegressions: ["a", "b", "c", "d", "e"] },
    });
    expect(d.action).toBe("revert");
    expect(d.reason_tr).toContain("(+2)");
  });

  it("suite temiz (yeşil ya da regresyonsuz) ama kapı başka kontrolde düştü → TUT", () => {
    const d = decideRevertOrKeep({
      baselineGreen: false,
      anchor: { cleanVsBaseline: true, newRegressions: [] },
    });
    expect(d.action).toBe("keep");
    expect(d.reason_tr).toContain("geri almak");
  });

  it("kırmızı + regresyon hesaplanamadı (baseline yok / parser anlamadı) → GERİ AL", () => {
    const d = decideRevertOrKeep({
      baselineGreen: null,
      anchor: { cleanVsBaseline: false, newRegressions: [] },
    });
    expect(d.action).toBe("revert");
    expect(d.reason_tr).toContain("ilerleme");
  });
});
