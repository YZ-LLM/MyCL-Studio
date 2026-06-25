// living-docs — pure helper testleri (buildLivingDocsPrompt + parseLivingDocsBlock).
// LLM turu (updateLivingDocs) saha-doğrulamada test edilir; burada saf mantık.

import { describe, expect, it } from "vitest";
import {
  buildLivingDocsPrompt,
  parseLivingDocsBlock,
  parseHelpPages,
  assignHelpPageDates,
  extractRoutesFromFeatures,
  isNoAccessDoc,
} from "../src/living-docs.js";

const TMPL =
  "intent={{INTENT_SUMMARY}} feat={{EXISTING_FEATURES}} guide={{EXISTING_USER_GUIDE}} instr={{USER_GUIDE_INSTRUCTION}}";

describe("buildLivingDocsPrompt", () => {
  it("placeholder'ları doldurur; UI varsa user-guide üretim talimatı", () => {
    const p = buildLivingDocsPrompt({
      tmpl: TMPL,
      intentSummary: "kategori ekle",
      existingFeatures: "## CRUD",
      existingUserGuide: "## Nasıl",
      existingDecisions: "(none yet)",
      includeUserGuide: true,
    });
    expect(p).toContain("intent=kategori ekle");
    expect(p).toContain("feat=## CRUD");
    expect(p).toContain("guide=## Nasıl");
    expect(p).toContain("user_guide_en_md"); // çift-dil üretim talimatı (TR + EN)
  });

  it("UI yoksa user_guide boş bırakma talimatı", () => {
    const p = buildLivingDocsPrompt({
      tmpl: TMPL,
      intentSummary: "",
      existingFeatures: "(none yet)",
      existingUserGuide: "(none yet)",
      existingDecisions: "(none yet)",
      includeUserGuide: false,
    });
    expect(p).toContain("intent=(no intent recorded)"); // boş intent fallback
    expect(p).toContain("NO end-user UI");
  });
});

describe("parseLivingDocsBlock", () => {
  it("geçerli {kind:docs} bloğu → çift-dil kılavuz parse", () => {
    const text = `Buyrun:\n{"kind":"docs","features_md":"# Özellikler\\n## CRUD","user_guide_tr_md":"# Kılavuz","user_guide_en_md":"# Guide"}`;
    const r = parseLivingDocsBlock(text);
    expect(r).not.toBeNull();
    expect(r!.features_md).toContain("## CRUD");
    expect(r!.user_guide_tr_md).toBe("# Kılavuz");
    expect(r!.user_guide_en_md).toBe("# Guide");
  });

  it("eski tek-alan user_guide_md → TR'ye düşer (geriye uyumlu)", () => {
    const r = parseLivingDocsBlock(`{"kind":"docs","features_md":"## X","user_guide_md":"# Eski"}`);
    expect(r!.user_guide_tr_md).toBe("# Eski");
    expect(r!.user_guide_en_md).toBe("");
  });

  it("kılavuz yok → boş string'e düşer (features yeterli)", () => {
    const r = parseLivingDocsBlock(`{"kind":"docs","features_md":"## X"}`);
    expect(r).not.toBeNull();
    expect(r!.user_guide_tr_md).toBe("");
    expect(r!.user_guide_en_md).toBe("");
  });

  it("features_md boş → null (geçersiz)", () => {
    expect(parseLivingDocsBlock(`{"kind":"docs","features_md":"  "}`)).toBeNull();
  });

  it("blok yok → null", () => {
    expect(parseLivingDocsBlock("düz metin, json yok")).toBeNull();
  });

  it("tech_doc_md + çift-dil help_pages parse edilir (route features'ta varsa)", () => {
    const text = `{"kind":"docs","features_md":"## X\\nWhere: /kullanicilar","tech_doc_md":"# Teknik","help_pages":[{"route":"/kullanicilar","title_tr":"Ekle","title_en":"Add","body_tr":"adımlar","body_en":"steps"}]}`;
    const r = parseLivingDocsBlock(text);
    expect(r!.tech_doc_md).toBe("# Teknik");
    expect(r!.help_pages).toHaveLength(1);
    expect(r!.help_pages[0].route).toBe("/kullanicilar");
    expect(r!.help_pages[0].title_en).toBe("Add");
    expect(r!.help_pages[0].body_en).toBe("steps");
  });

  it("yeni alanlar yoksa boş default (geriye uyumlu)", () => {
    const r = parseLivingDocsBlock(`{"kind":"docs","features_md":"## X"}`);
    expect(r!.tech_doc_md).toBe("");
    expect(r!.help_pages).toEqual([]);
    expect(r!.adr_decisions).toEqual([]);
  });

  it("adr_decisions parse edilir (geçerli kararlar)", () => {
    const text = `{"kind":"docs","features_md":"## X","adr_decisions":[{"slug":"auth-strategy","title":"Auth","status":"accepted","context":"c","options":"o","decision":"JWT","consequences":"q"}]}`;
    const r = parseLivingDocsBlock(text);
    expect(r!.adr_decisions).toHaveLength(1);
    expect(r!.adr_decisions[0].slug).toBe("auth-strategy");
    expect(r!.adr_decisions[0].decision).toBe("JWT");
  });
});

describe("extractRoutesFromFeatures", () => {
  it("markdown'dan route yollarını çıkarır", () => {
    const routes = extractRoutesFromFeatures("Where: /kullanicilar\n- `/raporlar/aylik` sayfası\n(/ana-sayfa)");
    expect(routes).toContain("/kullanicilar");
    expect(routes).toContain("/raporlar/aylik");
    expect(routes).toContain("/ana-sayfa");
  });
});

describe("parseHelpPages", () => {
  it("features'ta OLMAYAN route'a eşleneni ELER (uydurma '?' hedefi önle)", () => {
    const raw = [
      { route: "/var", title_tr: "a", title_en: "a", body_tr: "x", body_en: "x" },
      { route: "/yok", title_tr: "b", title_en: "b", body_tr: "y", body_en: "y" },
    ];
    const r = parseHelpPages(raw, ["/var"]);
    expect(r).toHaveLength(1);
    expect(r[0].route).toBe("/var");
  });

  it("knownRoutes boşsa (greenfield) çapraz-kontrol atlanır", () => {
    const r = parseHelpPages([{ route: "/x", title_tr: "a", title_en: "A", body_tr: "b", body_en: "B" }], []);
    expect(r).toHaveLength(1);
    expect(r[0].body_en).toBe("B");
  });

  it("eski şema (task_title/body_md) → her iki dile düşer (dayanıklılık)", () => {
    const r = parseHelpPages([{ route: "/x", task_title: "Ekle", body_md: "adım" }], ["/x"]);
    expect(r).toHaveLength(1);
    expect(r[0].title_tr).toBe("Ekle");
    expect(r[0].title_en).toBe("Ekle");
    expect(r[0].body_en).toBe("adım");
  });

  it("eksik alan / dizi-değil → atlanır/boş", () => {
    expect(parseHelpPages([{ route: "/x" }], ["/x"])).toHaveLength(0); // başlık/gövde yok
    expect(parseHelpPages("not-array", [])).toEqual([]);
  });
});

describe("assignHelpPageDates", () => {
  const fresh = [{ route: "/a", title_tr: "A", title_en: "A", body_tr: "icerik", body_en: "content" }];
  it("içerik DEĞİŞMEMİŞSE eski tarihi korur", () => {
    const existing = [
      { route: "/a", title_tr: "A", title_en: "A", body_tr: "icerik", body_en: "content", updated_at: "2026-01-01" },
    ];
    const r = assignHelpPageDates(fresh, existing, "2026-06-14");
    expect(r[0].updated_at).toBe("2026-01-01");
  });
  it("EN içeriği DEĞİŞMİŞSE bugüne günceller", () => {
    const existing = [
      { route: "/a", title_tr: "A", title_en: "A", body_tr: "icerik", body_en: "OLD", updated_at: "2026-01-01" },
    ];
    const r = assignHelpPageDates(fresh, existing, "2026-06-14");
    expect(r[0].updated_at).toBe("2026-06-14");
  });
  it("yeni sayfa → bugün", () => {
    const r = assignHelpPageDates(fresh, [], "2026-06-14");
    expect(r[0].updated_at).toBe("2026-06-14");
  });
});

describe("isNoAccessDoc (ajan kodu okuyamadı tespiti — YZLLM cave5)", () => {
  it("MYCL_NO_ACCESS belirteci → true (kesin sinyal)", () => {
    expect(isNoAccessDoc({ features_md: "MYCL_NO_ACCESS", tech_doc_md: "" })).toBe(true);
    expect(isNoAccessDoc({ features_md: "  mycl_no_access: izin yok", tech_doc_md: "" })).toBe(true);
  });

  it("kısa erişim-hatası özrü (≥2 ibare) → true (heuristik fallback)", () => {
    expect(
      isNoAccessDoc({
        features_md: "Hiçbir özellik belgelenemedi: kod tabanına erişilemiyor (okuma izni reddediliyor).",
        tech_doc_md: "",
      }),
    ).toBe(true);
  });

  // Çapraz-aile mahkeme false-pozitif bulgusu: kısa GERÇEK feature-doc, TEK tesadüfi ibare → no-access SANILMASIN.
  it("kısa gerçek doc, tek tesadüfi 'erişilemedi' → false (mahkeme false-pozitif fix)", () => {
    expect(
      isNoAccessDoc({
        features_md: "Dosya erişilemedi hatalarını yönetir. Basit bir hata takip uygulamasıdır.",
        tech_doc_md: "",
      }),
    ).toBe(false);
  });

  it("olumlu erişim cümleleri ('koda erişilebilir') → false", () => {
    expect(
      isNoAccessDoc({ features_md: "API'ye koda erişilebilir; kod tabanına erişildi ve tarandı.", tech_doc_md: "" }),
    ).toBe(false);
  });

  it("gerçek + UZUN döküman, tek tesadüfi ibare → false (yanlış-pozitif değil)", () => {
    const longDoc =
      "## Kullanıcı Yönetimi\n" +
      "Roller ve izinler yönetilir; admin kullanıcı ekler/siler. ".repeat(40) +
      "Belgelenemedi diye bir not yok aslında ama uzun.";
    // 'belgelenemedi' geçse de doc UZUN (>600) + tek ibare → tetiklenmez.
    expect(isNoAccessDoc({ features_md: longDoc, tech_doc_md: "" })).toBe(false);
  });

  it("normal döküman → false", () => {
    expect(
      isNoAccessDoc({ features_md: "## Sipariş\n- Sepet, ödeme, kargo takibi.", tech_doc_md: "Vite + React." }),
    ).toBe(false);
  });
});
