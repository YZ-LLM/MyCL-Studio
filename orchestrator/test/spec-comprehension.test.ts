import { describe, expect, it } from "vitest";
import { parseAcTexts } from "../src/spec-comprehension.js";

describe("parseAcTexts (spec AC metin ayrıştırma — comprehension kapısı için)", () => {
  it("`- **ACn**: metin` satırlarından AC metinlerini çıkarır", () => {
    const spec = [
      "# Spec",
      "## Acceptance Criteria",
      "- **AC1**: User can log in with email and password",
      "- **AC2**: Invalid password shows an error message",
      "- **AC3**: Session persists for 24 hours",
    ].join("\n");
    const acs = parseAcTexts(spec);
    expect(acs).toHaveLength(3);
    expect(acs[0]).toBe("User can log in with email and password");
    expect(acs[2]).toBe("Session persists for 24 hours");
  });

  it("AC yoksa boş (kapı kurulamaz → atlanır, sayı sorusu YOK)", () => {
    expect(parseAcTexts("# Spec\nNo criteria here.")).toEqual([]);
  });

  it("çok kısa/boş AC metnini eler", () => {
    const acs = parseAcTexts("- **AC1**: ok\n- **AC2**: Valid acceptance criterion text");
    // "ok" (<4 char) elendi, geçerli olan kaldı
    expect(acs).toEqual(["Valid acceptance criterion text"]);
  });
});
