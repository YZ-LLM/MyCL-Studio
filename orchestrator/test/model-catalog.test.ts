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
  it("config'te GEÇERSİZ model → katalog varsayılanına düşer (sistem bozulmaz)", () => {
    const c = selectModelForTask("codegen", { strong: "uydurma-model-xyz" });
    expect(findModel(c.modelId)).toBeDefined(); // geçerli modele düştü
    expect(findModel(c.modelId)?.tier).toBe("strong");
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
});

// 2026-06-10 (YZLLM: "efor seçimi de otomatik; kolay işte max gereksiz düşünüyor; en küçük hata istemem").
describe("selectEffortForTask (oto-efor — kaliteli hız)", () => {
  it("KALİTE-kritik işler config eforunu AYNEN alır (tam düşünme, dokunulmaz)", () => {
    for (const k of ["codegen", "spec", "design", "review", "debug"] as const) {
      expect(selectEffortForTask(k, "max")).toBe("max");
      expect(selectEffortForTask(k, "ultracode")).toBe("ultracode");
      expect(selectEffortForTask(k, undefined)).toBe("max"); // config yok → max
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
  });
  it("geçersiz config eforu → güvenli max tabanı", () => {
    expect(selectEffortForTask("codegen", "bozuk-değer")).toBe("max");
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
  it("katalog modeli (Claude/GLM) → dokunma, note yok", () => {
    expect(resolveKnownModel("claude-opus-4-8", "claude-opus-4-8", "x")).toEqual({ model: "claude-opus-4-8" });
    expect(resolveKnownModel("glm-4.6", "claude-opus-4-8", "x").note).toBeUndefined();
  });
  it("katalog-dışı (claude-fable-5) + bilinen main → main'e düşer + note", () => {
    const r = resolveKnownModel("claude-fable-5", "claude-opus-4-8", "dökümantasyon");
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.note).toContain("claude-fable-5");
    expect(r.note).toContain("dökümantasyon");
  });
  it("katalog-dışı + main de katalog-dışı → modeli DEĞİŞTİRME (sağlayıcı-karışıklığı önle), yalnız uyar", () => {
    const r = resolveKnownModel("claude-fable-5", "claude-mythos-9", "x");
    expect(r.model).toBe("claude-fable-5"); // değişmedi
    expect(r.note).toBeTruthy();
  });
  it("GLM modeli (z.ai) tanınır → fallback YOK (guard z.ai yolunu bloklamaz)", () => {
    expect(resolveKnownModel("glm-5.2", "glm-4.6", "x")).toEqual({ model: "glm-5.2" });
  });
});
