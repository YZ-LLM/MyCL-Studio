import { describe, expect, it } from "vitest";
import {
  summarizeStrength,
  formatStrengthReportTR,
  type StrengthRecord,
} from "../src/model-strength-report.js";

const rec = (domain: string, rung: string, model: string, success: boolean): StrengthRecord => ({
  domain, rung, model, success, ts: 1,
});

describe("model-strength rapor (Ümit: hangi model hangi alanda iyi)", () => {
  it("önerilen başlangıç = en DÜŞÜK güvenilir basamak (success>0 ve success>=fail)", () => {
    // codegen: cheap·low hep fail, balanced·high çözüyor → floor = balanced·high
    const recs = [
      rec("codegen", "cheap · low", "haiku", false),
      rec("codegen", "cheap · low", "haiku", false),
      rec("codegen", "balanced · high", "sonnet", true),
      rec("codegen", "balanced · high", "sonnet", true),
    ];
    const [s] = summarizeStrength(recs);
    expect(s.domain).toBe("codegen");
    expect(s.recommendedFloor).toBe("balanced · high");
    expect(s.totalAttempts).toBe(4);
  });

  it("basamaklar merdiven sırasına göre sıralı (cheap önce, strong sonra)", () => {
    const recs = [
      rec("ui", "strong · low", "opus", true),
      rec("ui", "cheap · low", "haiku", true),
    ];
    const [s] = summarizeStrength(recs);
    expect(s.byRung[0].rung).toBe("cheap · low"); // düşük önce
    expect(s.byRung[1].rung).toBe("strong · low");
    expect(s.recommendedFloor).toBe("cheap · low"); // en düşük başarılı
  });

  it("hiç güvenilir basamak yoksa recommendedFloor undefined", () => {
    const [s] = summarizeStrength([rec("debug", "cheap · low", "haiku", false)]);
    expect(s.recommendedFloor).toBeUndefined();
  });

  it("format: veri yoksa açıklayıcı mesaj; varsa domain + önerilen başlangıç", () => {
    expect(formatStrengthReportTR([])).toMatch(/Henüz veri yok/);
    const txt = formatStrengthReportTR(summarizeStrength([rec("codegen", "cheap · low", "haiku", true)]));
    expect(txt).toMatch(/Model Güç Raporu/);
    expect(txt).toMatch(/codegen/);
    expect(txt).toMatch(/Önerilen başlangıç/);
  });
});
