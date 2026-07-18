// error-analysis — ANA KURAL dil sınırı testleri (YZLLM 2026-07-18: "main ajan ile iletişim
// tamamen İngilizce kurulmalı"). _en = doğruluk kaynağı (main'e gider), _tr = yalnız gösterim.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/translator.js", () => ({
  translate: vi.fn(async (_cfg: unknown, text: string, dir: string) => {
    if (dir === "en-to-tr") return { text: `TR(${text})`, model: "m", attempts: 1, elapsed_ms: 1 };
    return { text: `EN(${text})`, model: "m", attempts: 1, elapsed_ms: 1 };
  }),
}));

import {
  buildErrorAnalysisPrompt,
  localizeFinding,
  parseErrorAnalysisBlock,
} from "../src/error-analysis.js";
import { translate } from "../src/translator.js";
import type { MyclConfig } from "../src/config.js";

const CFG = {} as MyclConfig;

describe("buildErrorAnalysisPrompt — çıktı İngilizce istenir", () => {
  const prompt = buildErrorAnalysisPrompt(
    { phase: 8, message: "gate failed", detail: "stderr...", allowAcceptContinue: false } as never,
    true,
  );
  it("şema alanları _en; Türkçe çıktı talimatı YOK", () => {
    expect(prompt).toContain("summary_en");
    expect(prompt).toContain("solutions_en");
    expect(prompt).not.toContain("MUST be in Turkish");
    expect(prompt).toContain("MUST be in English");
  });
});

describe("parseErrorAnalysisBlock — çift şema kabulü", () => {
  it("yeni _en şeması → _en dolu, _tr geçici EN kopya (çeviri öncesi)", () => {
    const a = parseErrorAnalysisBlock(
      '{"kind":"error_analysis","blocking":true,"findings":[{"summary_en":"DB connection refused","solutions_en":["Fix the connection string","Start the database"],"best_index":1}]}',
    );
    expect(a).not.toBeNull();
    expect(a!.findings[0]!.summary_en).toBe("DB connection refused");
    expect(a!.findings[0]!.summary_tr).toBe("DB connection refused"); // çeviri localizeFinding'te
    expect(a!.findings[0]!.solutions_en).toEqual(["Fix the connection string", "Start the database"]);
    expect(a!.findings[0]!.best_index).toBe(1);
  });

  it("eski _tr şeması (model itaat etmedi) → geriye uyum: _tr dolu, _en yok", () => {
    const a = parseErrorAnalysisBlock(
      '{"kind":"error_analysis","blocking":false,"summary_tr":"Bağlantı hatası","solutions_tr":["Bağlantıyı düzelt"],"best_index":0}',
    );
    expect(a).not.toBeNull();
    expect(a!.findings[0]!.summary_tr).toBe("Bağlantı hatası");
    expect(a!.findings[0]!.summary_en).toBeUndefined();
    expect(a!.findings[0]!.solutions_en).toBeUndefined();
  });
});

describe("localizeFinding — gösterim çevirisi (_tr'yi translator doldurur)", () => {
  it("çeviri OK → _tr çevrilir, _en korunur, indeks hizası bozulmaz", async () => {
    const f = {
      summary_tr: "Broken build",
      summary_en: "Broken build",
      solutions_tr: ["Fix A", "Fix B"],
      solutions_en: ["Fix A", "Fix B"],
      best_index: 0,
    };
    const ok = await localizeFinding(CFG, f, new Map());
    expect(ok).toBe(true);
    expect(f.summary_tr).toBe("TR(Broken build)");
    expect(f.solutions_tr).toEqual(["TR(Fix A)", "TR(Fix B)"]);
    expect(f.solutions_en).toEqual(["Fix A", "Fix B"]); // EN kaynak DEĞİŞMEZ (main'e bu gider)
  });

  it("cache: aynı string ikinci kez ÇEVRİLMEZ", async () => {
    vi.mocked(translate).mockClear();
    const cache = new Map<string, string>();
    const f1 = { summary_tr: "Same", summary_en: "Same", solutions_tr: [], best_index: 0 };
    const f2 = { summary_tr: "Same", summary_en: "Same", solutions_tr: [], best_index: 0 };
    await localizeFinding(CFG, f1, cache);
    await localizeFinding(CFG, f2, cache);
    expect(vi.mocked(translate)).toHaveBeenCalledTimes(1);
  });

  it("çeviri PATLARSA → false döner (caller görünür not basar), _tr EN orijinalinde kalır", async () => {
    vi.mocked(translate).mockRejectedValueOnce(new Error("translator down"));
    const f = { summary_tr: "Left as English", summary_en: "Left as English", solutions_tr: [], best_index: 0 };
    const ok = await localizeFinding(CFG, f, new Map());
    expect(ok).toBe(false);
    expect(f.summary_tr).toBe("Left as English"); // içerik kaybolmaz
  });

  it("yalnız _tr'li eski finding → dokunulmaz (çeviri çağrısı yok)", async () => {
    vi.mocked(translate).mockClear();
    const f = { summary_tr: "Türkçe özet", solutions_tr: ["Türkçe çözüm"], best_index: 0 };
    const ok = await localizeFinding(CFG, f, new Map());
    expect(ok).toBe(true);
    expect(vi.mocked(translate)).not.toHaveBeenCalled();
    expect(f.summary_tr).toBe("Türkçe özet");
  });
});
