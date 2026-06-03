// living-docs — pure helper testleri (buildLivingDocsPrompt + parseLivingDocsBlock).
// LLM turu (updateLivingDocs) saha-doğrulamada test edilir; burada saf mantık.

import { describe, expect, it } from "vitest";
import { buildLivingDocsPrompt, parseLivingDocsBlock } from "../src/living-docs.js";

const TMPL =
  "intent={{INTENT_SUMMARY}} feat={{EXISTING_FEATURES}} guide={{EXISTING_USER_GUIDE}} instr={{USER_GUIDE_INSTRUCTION}}";

describe("buildLivingDocsPrompt", () => {
  it("placeholder'ları doldurur; UI varsa user-guide üretim talimatı", () => {
    const p = buildLivingDocsPrompt({
      tmpl: TMPL,
      intentSummary: "kategori ekle",
      existingFeatures: "## CRUD",
      existingUserGuide: "## Nasıl",
      includeUserGuide: true,
    });
    expect(p).toContain("intent=kategori ekle");
    expect(p).toContain("feat=## CRUD");
    expect(p).toContain("guide=## Nasıl");
    expect(p).toContain("user-guide.md"); // üretim talimatı
  });

  it("UI yoksa user_guide boş bırakma talimatı", () => {
    const p = buildLivingDocsPrompt({
      tmpl: TMPL,
      intentSummary: "",
      existingFeatures: "(none yet)",
      existingUserGuide: "(none yet)",
      includeUserGuide: false,
    });
    expect(p).toContain("intent=(no intent recorded)"); // boş intent fallback
    expect(p).toContain("NO end-user UI");
  });
});

describe("parseLivingDocsBlock", () => {
  it("geçerli {kind:docs} bloğu → parse", () => {
    const text = `Buyrun:\n{"kind":"docs","features_md":"# Özellikler\\n## CRUD","user_guide_md":"# Kılavuz"}`;
    const r = parseLivingDocsBlock(text);
    expect(r).not.toBeNull();
    expect(r!.features_md).toContain("## CRUD");
    expect(r!.user_guide_md).toBe("# Kılavuz");
  });

  it("user_guide_md yok → boş string'e düşer (features yeterli)", () => {
    const r = parseLivingDocsBlock(`{"kind":"docs","features_md":"## X"}`);
    expect(r).not.toBeNull();
    expect(r!.user_guide_md).toBe("");
  });

  it("features_md boş → null (geçersiz)", () => {
    expect(parseLivingDocsBlock(`{"kind":"docs","features_md":"  "}`)).toBeNull();
  });

  it("blok yok → null", () => {
    expect(parseLivingDocsBlock("düz metin, json yok")).toBeNull();
  });
});
