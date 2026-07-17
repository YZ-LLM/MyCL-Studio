// revert-decision — "geri al mı, tut mu?" saf karar matrisi (YZLLM: kararı MyCL versin).
// Güvenli varsayılan GERİ AL; TUT yalnız pozitif kanıtla (suite temiz + silinmiş test yok).
import { describe, expect, it } from "vitest";
import { decideRevertOrKeep } from "../src/revert-decision.js";

describe("decideRevertOrKeep", () => {
  it("anchor hiç koşmadı (kanıt yok) → GERİ AL (güvenli varsayılan)", () => {
    const d = decideRevertOrKeep({ anchor: null, deletedTestFiles: [] });
    expect(d.action).toBe("revert");
    expect(d.reason_tr).toContain("kanıt");
  });

  it("yeni regresyon var → GERİ AL + kırılan test adları gerekçede", () => {
    const d = decideRevertOrKeep({
      anchor: { cleanVsBaseline: false, newRegressions: ["auth.test.ts > login", "nav.test.ts > menü"] },
      deletedTestFiles: [],
    });
    expect(d.action).toBe("revert");
    expect(d.reason_tr).toContain("auth.test.ts > login");
  });

  it("3'ten çok regresyonda gerekçe kısaltılır (+N)", () => {
    const d = decideRevertOrKeep({
      anchor: { cleanVsBaseline: false, newRegressions: ["a", "b", "c", "d", "e"] },
      deletedTestFiles: [],
    });
    expect(d.action).toBe("revert");
    expect(d.reason_tr).toContain("(+2)");
  });

  it("suite temiz + silinmiş test yok → TUT", () => {
    const d = decideRevertOrKeep({
      anchor: { cleanVsBaseline: true, newRegressions: [] },
      deletedTestFiles: [],
    });
    expect(d.action).toBe("keep");
    expect(d.reason_tr).toContain("geri almak");
  });

  it("MAHKEME: suite temiz AMA test dosyası SİLİNMİŞ → GERİ AL (kapsam kaybıyla sahte temiz)", () => {
    const d = decideRevertOrKeep({
      anchor: { cleanVsBaseline: true, newRegressions: [] },
      deletedTestFiles: ["tests/auth.test.ts"],
    });
    expect(d.action).toBe("revert");
    expect(d.reason_tr).toContain("tests/auth.test.ts");
  });

  it("MAHKEME: suite temiz AMA değişen dosya listesi doğrulanamadı → GERİ AL (fail-closed)", () => {
    const d = decideRevertOrKeep({
      anchor: { cleanVsBaseline: true, newRegressions: [] },
      deletedTestFiles: null,
    });
    expect(d.action).toBe("revert");
    expect(d.reason_tr).toContain("doğrulanamadı");
  });

  it("kırmızı + regresyon hesaplanamadı (baseline yok / parser anlamadı) → GERİ AL", () => {
    const d = decideRevertOrKeep({
      anchor: { cleanVsBaseline: false, newRegressions: [] },
      deletedTestFiles: [],
    });
    expect(d.action).toBe("revert");
    expect(d.reason_tr).toContain("ilerleme");
  });
});
