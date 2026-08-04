import { describe, expect, it } from "vitest";
import {
  MODEL_CATALOG,
  TASK_RELEVANCE,
  selectModelForTask,
  findModel,
  computeTiersFromModels,
  TRANSLATOR_MODEL,
  selectEffortForTask,
  modelChoiceLineIfChanged,
  resetModelChoiceCache,
  resolveKnownModel,
  auditConfiguredModels,
  describeModel,
  modelForTier,
  prettyModelLabel,
  type TaskKind,
} from "../src/model-catalog.js";

describe("MODEL_CATALOG (hatasız liste)", () => {
  it("id'ler benzersiz", () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("her tier'dan en az bir model var (fallback güvenli)", () => {
    for (const tier of ["cheap", "balanced", "strong"] as const) {
      expect(MODEL_CATALOG.some((m) => m.tier === tier)).toBe(true);
    }
  });
  it("findModel id ile bulur", () => {
    expect(findModel("claude-opus-4-8")?.tier).toBe("strong");
    expect(findModel("yok")).toBeUndefined();
  });
});

describe("TASK_RELEVANCE (her iş tipi eşli + doğru)", () => {
  const kinds: TaskKind[] = [
    "classification", "translation", "orchestration", "intent", "design",
    "spec", "codegen", "review", "debug", "verification",
  ];
  it("her TaskKind'in geçerli tier+reason'ı var", () => {
    for (const k of kinds) {
      expect(TASK_RELEVANCE[k]).toBeDefined();
      expect(["cheap", "balanced", "strong"]).toContain(TASK_RELEVANCE[k].tier);
      expect(TASK_RELEVANCE[k].reason.length).toBeGreaterThan(0);
    }
  });
  it("KRİTİK: çeviri 'cheap' DEĞİL (anlam kaybı olmamalı)", () => {
    expect(TASK_RELEVANCE.translation.tier).not.toBe("cheap");
  });
  it("ağır işler (codegen/spec/review/debug) → strong", () => {
    for (const k of ["codegen", "spec", "review", "debug"] as const) {
      expect(TASK_RELEVANCE[k].tier).toBe("strong");
    }
  });
});

describe("selectModelForTask", () => {
  it("config tier modeli geçerliyse onu seçer", () => {
    const c = selectModelForTask("codegen", { strong: "claude-opus-4-7" });
    expect(c.modelId).toBe("claude-opus-4-7");
    expect(c.tier).toBe("strong");
  });
  it("config tier yoksa katalog varsayılanı (strong → opus)", () => {
    const c = selectModelForTask("codegen", undefined);
    expect(findModel(c.modelId)?.tier).toBe("strong");
  });
  // YZLLM 2026-08-04 — BİLİNÇLİ DAVRANIŞ DEĞİŞİKLİĞİ. Eski test "katalogda olmayan model katalog
  // varsayılanına DÜŞER" davranışını kilitliyordu. Canlıda bunun bedeli şuydu: kullanıcı Ayarlar'dan
  // (canlı Anthropic listesinden) claude-opus-5 seçmişti, katalog 4.x'te kalmıştı, ve MyCL bunu HABER
  // VERMEDEN Opus 4.8'e çeviriyordu — yani ayar hiç uygulanmıyordu. Artık kullanıcının modeli aynen
  // kullanılır; "katalogda yok" bilgisi fromCatalog ile taşınır ve görünür uyarıya dönüşür (KATI #4).
  it("config'te KATALOG DIŞI model → sessizce DEĞİŞTİRİLMEZ, aynen kullanılır", () => {
    const c = selectModelForTask("codegen", { strong: "claude-gelecek-9" });
    expect(c.modelId).toBe("claude-gelecek-9");
    expect(c.tier).toBe("strong");
  });

  it("YZLLM'in gerçek ayarı: strong=claude-opus-5 → kod yazan fazlar Opus 5 koşar", () => {
    // Canlı arıza buydu: bu ayar sessizce claude-opus-4-8'e çevriliyordu.
    for (const k of ["codegen", "spec", "review", "debug", "design"] as const) {
      expect(selectModelForTask(k, { strong: "claude-opus-5" }).modelId, k).toBe("claude-opus-5");
    }
  });

  it("katalog dışı model fromCatalog=false ile işaretlenir (uyarı bu bayrağa dayanır)", () => {
    expect(selectModelForTask("codegen", { strong: "uydurma-model-xyz" }).fromCatalog).toBe(false);
    expect(selectModelForTask("codegen", undefined).fromCatalog).toBe(true);
  });

  it("modelForTier de aynı kuralı uygular (iki çözücü ayrışmasın)", () => {
    expect(modelForTier("strong", { strong: "claude-gelecek-9" }).id).toBe("claude-gelecek-9");
    expect(modelForTier("strong", { strong: "claude-gelecek-9" }).fromCatalog).toBe(false);
    expect(modelForTier("strong", undefined).fromCatalog).toBe(true);
  });
  it("KRİTİK: hiçbir iş 'cheap'(haiku) değil — kaliteyi riske atma (kaliteli hız)", () => {
    for (const k of [
      "classification", "translation", "orchestration", "intent", "design",
      "spec", "codegen", "review", "debug", "verification",
    ] as const) {
      expect(selectModelForTask(k, undefined).tier).not.toBe("cheap");
    }
  });
});

describe("computeTiersFromModels (keşif ÖNERİSİ — kullanıcı ayarını EZMEZ, saf)", () => {
  it("EN YENİ sürümü tier'lara atar (opus→strong, sonnet→balanced, haiku→cheap)", () => {
    const t = computeTiersFromModels([
      { id: "claude-opus-4-9", display_name: "Opus 4.9" }, // newest-first
      { id: "claude-opus-4-8", display_name: "Opus 4.8" },
      { id: "claude-sonnet-4-7", display_name: "Sonnet 4.7" },
      { id: "claude-haiku-4-6", display_name: "Haiku 4.6" },
    ]);
    expect(t.strong).toBe("claude-opus-4-9");
    expect(t.balanced).toBe("claude-sonnet-4-7");
    expect(t.cheap).toBe("claude-haiku-4-6");
  });

  it("KRİTİK: keşif config'i EZMEZ — selectModelForTask KULLANICI config'ini kullanır (YZLLM: ayarlar dikkate alınmalı)", () => {
    // Eski bug: canlı keşif config'i geçiyordu ("ayarlar dikkate alınmıyor"). Artık saf — yalnız hesaplar; öneri için.
    computeTiersFromModels([{ id: "claude-opus-4-9", display_name: "Opus 4.9" }]);
    const c = selectModelForTask("codegen", { strong: "claude-opus-4-8" });
    expect(c.modelId).toBe("claude-opus-4-8"); // KULLANICI config'i kazanır, keşif değil
  });

  it("YENİ aile (mythos) hesaplanır + newFamilies'te (öneri) ama OTOMATİK kullanılmaz (önce SORULUR)", () => {
    const t = computeTiersFromModels([
      { id: "claude-mythos-1", display_name: "Mythos 1", tier: "strong" }, // LLM dök-tier
    ]);
    expect(t.strong).toBe("claude-mythos-1");
    expect(t.newFamilies).toContain("claude-mythos-1");
    // selectModelForTask config/katalog kullanır — mythos otomatik DEĞİL (askq ile sorulur):
    expect(selectModelForTask("codegen", undefined).modelId).not.toBe("claude-mythos-1");
  });

  it("yeni aile + tier YOK → atanmaz (körlemesine değil)", () => {
    const t = computeTiersFromModels([{ id: "claude-mythos-1", display_name: "Mythos 1" }]);
    expect(t.strong).toBeUndefined();
  });
});

describe("TRANSLATOR_MODEL (YZLLM: sabit hızlı çeviri modeli — değiştirilemez)", () => {
  it("cheap (hızlı/ucuz) tier'dan geçerli bir model", () => {
    expect(TRANSLATOR_MODEL).toBeTruthy();
    expect(findModel(TRANSLATOR_MODEL)?.tier).toBe("cheap");
  });
  // Eskiden defaultModelForTier("cheap") ile türetiliyordu → katalog sırasına kırılgan bağ.
  it("açık sabit: katalog sırası değişse bile çevirmen kendiliğinden değişmez", () => {
    expect(TRANSLATOR_MODEL).toBe("claude-haiku-4-5");
  });
});

// Katalog SIRASI = "hiç ayar yapmamış kullanıcının varsayılanı". Bilinçli değişimde tek düzeltme noktası burası.
describe("katalog sırası (ayarsız kullanıcının varsayılanı)", () => {
  const firstOf = (tier: "cheap" | "balanced" | "strong") =>
    MODEL_CATALOG.find((m) => m.tier === tier)?.id;

  it("strong → Opus 5, balanced → Sonnet 5, cheap → Haiku 4.5", () => {
    expect(firstOf("strong")).toBe("claude-opus-5");
    expect(firstOf("balanced")).toBe("claude-sonnet-5");
    expect(firstOf("cheap")).toBe("claude-haiku-4-5");
  });

  it("Fable 5 katalogda VAR ama strong varsayılanı DEĞİL (maliyet: bilinçli seçimle gelir)", () => {
    expect(findModel("claude-fable-5")?.tier).toBe("strong");
    expect(firstOf("strong")).not.toBe("claude-fable-5");
    expect(selectModelForTask("codegen", undefined).modelId).not.toBe("claude-fable-5");
  });

  it("canlı keşif Fable'ı kendiliğinden strong yapamaz — 'fable' bilinen aile değil", () => {
    // Listenin BAŞINDA (en yetenekli) olsa bile deterministik tier ataması onu atlar; strong opus'a gider.
    const t = computeTiersFromModels([
      { id: "claude-fable-5", display_name: "Fable 5" },
      { id: "claude-opus-5", display_name: "Opus 5" },
    ]);
    expect(t.strong).toBe("claude-opus-5");
  });

  it("keşif Fable'a tier ATARSA bu yalnız ÖNERİDİR — yeni aile olarak işaretlenir, otomatik uygulanmaz", () => {
    const t = computeTiersFromModels([
      { id: "claude-fable-5", display_name: "Fable 5", tier: "strong" }, // LLM'in dökümandan attığı tier
    ]);
    expect(t.strong).toBe("claude-fable-5");
    expect(t.newFamilies).toContain("claude-fable-5"); // → kullanıcıya SORULUR (askq + verifyModelCallable)
    // Kritik olan: öneri config'i EZMEZ. Ayarı olan kullanıcı etkilenmez.
    expect(selectModelForTask("codegen", { strong: "claude-opus-5" }).modelId).toBe("claude-opus-5");
  });
});

// 2026-06-10 (YZLLM: "efor seçimi de otomatik; kolay işte max gereksiz düşünüyor; en küçük hata istemem").
describe("selectEffortForTask (oto-efor — kaliteli hız)", () => {
  // 2026-07-07 (YZLLM zaman-kaybı planı, "efor ayarını yap canlıda izle"): codegen/review → xhigh tavanı; spec/design/
  // debug → max korunur; ultracode (bilinçli en-derin) her zaman korunur.
  it("codegen/review → xhigh (max→xhigh); spec/design/debug → max korunur; ultracode korunur", () => {
    for (const k of ["codegen", "review"] as const) {
      expect(selectEffortForTask(k, "max")).toBe("xhigh"); // en büyük gecikme kaynağı → xhigh (önerilen)
      expect(selectEffortForTask(k, undefined)).toBe("xhigh"); // config yok → max tabanı → xhigh
      expect(selectEffortForTask(k, "ultracode")).toBe("ultracode"); // bilinçli en-derin → EZİLMEZ
    }
    for (const k of ["spec", "design", "debug"] as const) {
      expect(selectEffortForTask(k, "max")).toBe("max"); // düşünme derinliği kritik → max korunur
      expect(selectEffortForTask(k, "ultracode")).toBe("ultracode");
      expect(selectEffortForTask(k, undefined)).toBe("max");
    }
  });
  it("hafif/sık işler high TAVANINA çekilir (max → high; gereksiz düşünme yok)", () => {
    for (const k of ["orchestration", "intent", "verification", "translation", "classification"] as const) {
      expect(selectEffortForTask(k, "max")).toBe("high");
      expect(selectEffortForTask(k, "ultracode")).toBe("high");
      expect(selectEffortForTask(k, undefined)).toBe("high");
    }
  });
  it("kullanıcının bilinçli DÜŞÜK seçimi yükseltilmez (ekonomi tercihi)", () => {
    expect(selectEffortForTask("orchestration", "medium")).toBe("medium");
    expect(selectEffortForTask("intent", "high")).toBe("high");
    expect(selectEffortForTask("codegen", "high")).toBe("high"); // high < xhigh tavanı → korunur (yükseltmez)
  });
  it("geçersiz config eforu → güvenli max tabanı, sonra per-iş tavanı", () => {
    expect(selectEffortForTask("codegen", "bozuk-değer")).toBe("xhigh"); // geçersiz → max tabanı → codegen tavanı xhigh
    expect(selectEffortForTask("spec", "bozuk-değer")).toBe("max"); // spec tavansız → max
  });
});

// FIX C (YZLLM 2026-07-01: "model seçimi zaman kaybettiriyor"): model-seçim satırı yalnız DEĞİŞİNCE yazılır
// (config deterministik → aynı satır tekrar tekrar emit edilmez; gürültü yok).
describe("modelChoiceLineIfChanged — yalnız değişince yaz (gürültü kısma)", () => {
  it("ilk çağrı satırı döner; aynı key+aynı satır → null (tekrar yazılmaz)", () => {
    resetModelChoiceCache();
    expect(modelChoiceLineIfChanged("phase-8", "🧠 Codegen: Opus")).toBe("🧠 Codegen: Opus");
    expect(modelChoiceLineIfChanged("phase-8", "🧠 Codegen: Opus")).toBeNull();
    expect(modelChoiceLineIfChanged("phase-8", "🧠 Codegen: Opus")).toBeNull();
  });
  it("aynı key farklı satır → yeni satır döner (gerçek değişiklik görünür)", () => {
    resetModelChoiceCache();
    expect(modelChoiceLineIfChanged("phase-4", "A")).toBe("A");
    expect(modelChoiceLineIfChanged("phase-4", "B")).toBe("B");
    expect(modelChoiceLineIfChanged("phase-4", "B")).toBeNull();
  });
  it("farklı key'ler bağımsız (phase-0 ≠ phase-8)", () => {
    resetModelChoiceCache();
    expect(modelChoiceLineIfChanged("phase-0", "X")).toBe("X");
    expect(modelChoiceLineIfChanged("phase-8", "X")).toBe("X"); // farklı key → yine döner
    expect(modelChoiceLineIfChanged("phase-0", "X")).toBeNull();
  });
  it("resetModelChoiceCache sonrası satır yeniden görünür (yeni proje ilk satırı)", () => {
    resetModelChoiceCache();
    expect(modelChoiceLineIfChanged("phase-8", "L")).toBe("L");
    expect(modelChoiceLineIfChanged("phase-8", "L")).toBeNull();
    resetModelChoiceCache();
    expect(modelChoiceLineIfChanged("phase-8", "L")).toBe("L");
  });
});

// Fix 3 (YZLLM 2026-07-01: canlı Faz 17 living-docs claude-fable-5 exit=1): katalog-dışı model guard.
describe("resolveKnownModel — katalog-dışı model → görünür fallback", () => {
  it("katalog modeli (Claude) → dokunma, note yok", () => {
    expect(resolveKnownModel("claude-opus-4-8", "claude-opus-4-8", "x")).toEqual({ model: "claude-opus-4-8" });
    expect(resolveKnownModel("claude-sonnet-4-6", "claude-opus-4-8", "x").note).toBeUndefined();
  });
  // NOT: bu testler eskiden katalog-dışı örnek olarak `claude-fable-5` kullanıyordu; Fable 5
  // 2026-08-04'te kataloğa girdiği için örnek gerçekten tanınmayan bir id ile değiştirildi.
  it("katalog-dışı model + bilinen main → main'e düşer + note", () => {
    const r = resolveKnownModel("claude-gelecek-9", "claude-opus-4-8", "dökümantasyon");
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.note).toContain("claude-gelecek-9");
    expect(r.note).toContain("dökümantasyon");
  });
  it("katalog-dışı + main de katalog-dışı → modeli DEĞİŞTİRME (sağlayıcı-karışıklığı önle), yalnız uyar", () => {
    const r = resolveKnownModel("claude-gelecek-9", "claude-bilinmeyen-9", "x");
    expect(r.model).toBe("claude-gelecek-9"); // değişmedi
    expect(r.note).toBeTruthy();
  });
  it("GLM modeli artık TANINMAZ (z.ai kaldırıldı 2026-07-16) → bilinen main'e görünür fallback", () => {
    const r = resolveKnownModel("glm-5.2", "claude-opus-4-8", "x");
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.note).toBeTruthy();
  });
});

// YZLLM 2026-08-04: katalog bayatladığında kullanıcı ayarının SESSİZCE yok sayılmasını bitiren katman.
describe("describeModel — katalog dışı model de tam bir kayda çözülür", () => {
  it("katalogdaki model → katalog kaydının kendisi", () => {
    expect(describeModel("claude-opus-4-8")).toEqual(findModel("claude-opus-4-8"));
  });

  it("katalog dışı model → tier kullanıcının koyduğu slottan gelir", () => {
    expect(describeModel("bilinmeyen-model-x", "cheap").tier).toBe("cheap");
    expect(describeModel("bilinmeyen-model-x", "balanced").tier).toBe("balanced");
  });

  it("tier ipucu yoksa bilinen aileden, o da yoksa strong (kaliteyi düşüren yönde varsayma)", () => {
    expect(describeModel("claude-sonnet-9").tier).toBe("balanced");
    expect(describeModel("claude-haiku-9").tier).toBe("cheap");
    expect(describeModel("tamamen-bilinmeyen").tier).toBe("strong");
  });

  it("etiket id'den türetilir", () => {
    expect(prettyModelLabel("claude-opus-5")).toBe("Opus 5");
    expect(prettyModelLabel("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(prettyModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });
});

describe("auditConfiguredModels — katalog dışı ayarları yüzeye çıkarır", () => {
  it("hepsi tanınıyorsa boş", () => {
    expect(
      auditConfiguredModels({
        main: "claude-opus-4-8",
        model_tiers: { strong: "claude-opus-4-8", balanced: "claude-sonnet-4-6" },
      }),
    ).toEqual([]);
  });

  it("katalog dışı olanları rol adıyla döner", () => {
    const out = auditConfiguredModels({
      main: "claude-opus-4-8",
      model_tiers: { strong: "sahte-model-1", cheap: "sahte-model-2" },
    });
    expect(out.map((o) => o.id).sort()).toEqual(["sahte-model-1", "sahte-model-2"]);
    expect(out.find((o) => o.id === "sahte-model-1")?.role).toBe("güçlü katman");
  });

  it("aynı model birden çok slotta → tek satır (uyarı tekrarlanmasın)", () => {
    const out = auditConfiguredModels({
      main: "sahte-model-1",
      orchestrator: "sahte-model-1",
      model_tiers: { strong: "sahte-model-1" },
    });
    expect(out).toHaveLength(1);
  });
});
