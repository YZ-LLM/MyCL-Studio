import { describe, expect, it } from "vitest";
import { specToMarkdown } from "../src/phase-4.js";
import { parseAcIds, countAcceptanceCriteria } from "../src/phase-8.js";
import { parseAcTexts } from "../src/spec-comprehension.js";

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

// Birim 3 (Ümit 2026-06-12): BDD-as-spec — opsiyonel given/when/then alt-bullet render +
// GERİ-UYUM: alt-bullet'lar AC sayan parser'ları (parseAcIds/countAC/parseAcTexts) BOZMAMALI.
describe("specToMarkdown — Birim 3 BDD given/when/then", () => {
  const gwtSpec = {
    ...base,
    acceptance_criteria: [
      {
        id: "AC1",
        statement: "kullanıcı giriş yapabilir",
        given: "kayıtlı kullanıcı + doğru parola",
        when: "giriş formu gönderilir",
        then: "oturum açılır ve panele yönlendirilir",
      },
      { id: "AC2", statement: "düz binary kontrol" }, // given/when/then YOK → eski biçim
    ],
  };

  it("given/when/then VARSA girintili alt-bullet olarak render edilir", () => {
    const md = specToMarkdown(gwtSpec);
    expect(md).toContain("**AC1**: kullanıcı giriş yapabilir");
    expect(md).toContain("  - _Given:_ kayıtlı kullanıcı + doğru parola");
    expect(md).toContain("  - _When:_ giriş formu gönderilir");
    expect(md).toContain("  - _Then:_ oturum açılır ve panele yönlendirilir");
  });

  it("given/when/then YOKSA düz statement (geri-uyum — gürültü yok)", () => {
    const md = specToMarkdown(gwtSpec);
    expect(md).toContain("**AC2**: düz binary kontrol");
    // AC2 satırından sonra Given/When/Then alt-bullet'ı OLMAMALI.
    const ac2line = md.split("\n").find((l) => l.includes("**AC2**"));
    expect(ac2line).toBeTruthy();
    expect(md).not.toContain("_Given:_ undefined");
  });

  it("KRİTİK geri-uyum: alt-bullet'lar AC sayımını/id'lerini BOZMAZ", () => {
    const md = specToMarkdown(gwtSpec);
    // Faz 8 + comprehension parser'ları yalnız 2 AC görmeli (Given/When/Then alt-bullet DEĞİL).
    expect(parseAcIds(md)).toEqual(["AC1", "AC2"]);
    expect(countAcceptanceCriteria(md)).toBe(2);
    const texts = parseAcTexts(md);
    expect(texts).toContain("kullanıcı giriş yapabilir");
    expect(texts).toContain("düz binary kontrol");
    // Given/When/Then metinleri AC METNİ olarak ayrıştırılMAMALI.
    expect(texts.some((t) => t.includes("oturum açılır"))).toBe(false);
    expect(texts.length).toBe(2);
  });

  it("boş-string given/when/then → alt-bullet yazılmaz (trim guard)", () => {
    const md = specToMarkdown({
      ...base,
      acceptance_criteria: [{ id: "AC1", statement: "x", given: "  ", when: "", then: undefined }],
    });
    expect(md).not.toContain("_Given:_");
    expect(md).not.toContain("_When:_");
    expect(md).not.toContain("_Then:_");
  });

  // Düşman-gözü K3-c (HIGH): GWT metninde newline → 2.+ satır sütun-0'a düşer → kozmetik
  // bozulma + metin `- **ACn**:` içerirse FANTOM AC enjeksiyonu (countAC şişer → yanlış-fail).
  it("K3-c: çok-satırlı GWT tek-satıra indirilir → fantom AC enjekte EDİLEMEZ", () => {
    const md = specToMarkdown({
      ...base,
      acceptance_criteria: [
        {
          id: "AC1",
          statement: "kullanıcı kaydolur",
          then: "201 döner\n- **AC99**: gizli sahte kriter\n- **AC98**: bir tane daha",
        },
      ],
    });
    // Fantom AC99/AC98 ENJEKTE EDİLMEMELİ — yalnız gerçek AC1.
    expect(parseAcIds(md)).toEqual(["AC1"]);
    expect(countAcceptanceCriteria(md)).toBe(1);
    expect(parseAcTexts(md)).toEqual(["kullanıcı kaydolur"]);
    // Then tek satıra indirilmiş olmalı (newline kalmamalı, içerik korunmuş).
    expect(md).toContain("_Then:_ 201 döner - **AC99**: gizli sahte kriter - **AC98**: bir tane daha");
  });

  // Düşman-gözü K1 (LOW): cli-skeleton "..." placeholder'ı zayıf CLI ajanı literal kopyalarsa
  // spec.md'ye gürültü sızmasın.
  it("K1: '...' placeholder GWT render edilmez (cli-skeleton gürültü guard)", () => {
    const md = specToMarkdown({
      ...base,
      acceptance_criteria: [{ id: "AC1", statement: "x", given: "...", when: "...", then: "..." }],
    });
    expect(md).not.toContain("_Given:_");
    expect(md).not.toContain("_Then:_");
    expect(md).not.toContain("_Given:_ ...");
  });
});
