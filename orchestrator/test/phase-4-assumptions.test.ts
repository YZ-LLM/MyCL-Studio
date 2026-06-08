import { describe, expect, it } from "vitest";
import { specToMarkdown } from "../src/phase-4.js";

const base = {
  title: "Test spec başlığı",
  scope: "Bu spec'in kapsamı yeterince uzun bir metin olmalı ki gerçekçi olsun.",
  acceptance_criteria: [{ id: "AC1", statement: "kullanıcı giriş yapabilir" }],
  out_of_scope: ["analytics"],
  risks: [{ title: "risk", detail: "bir detay metni" }],
};

describe("specToMarkdown — #1 varsayım görünürlüğü", () => {
  it("AC1: varsayım varsa 'Assumptions' bölümü + içerik yazılır", () => {
    const md = specToMarkdown({
      ...base,
      assumptions: [
        { assumption: "kimlik doğrulama gerekli", why: "collaborative dendi" },
      ],
    });
    expect(md).toContain("## Assumptions");
    expect(md).toContain("kimlik doğrulama gerekli");
    expect(md).toContain("collaborative dendi");
  });

  it("AC3: varsayım yoksa (alan tanımsız) bölüm HİÇ yazılmaz — gürültü yok", () => {
    expect(specToMarkdown(base)).not.toContain("Assumptions");
  });

  it("AC3: varsayım boş dizi → bölüm yazılmaz", () => {
    expect(specToMarkdown({ ...base, assumptions: [] })).not.toContain("Assumptions");
  });

  it("AC4: eski spec (assumptions yok) sorunsuz render olur (geriye uyumlu)", () => {
    const md = specToMarkdown(base);
    expect(md).toContain("# Test spec başlığı");
    expect(md).toContain("## Acceptance Criteria");
    expect(md).toContain("**AC1**: kullanıcı giriş yapabilir");
  });
});
