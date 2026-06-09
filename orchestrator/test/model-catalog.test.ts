import { afterEach, describe, expect, it } from "vitest";
import {
  MODEL_CATALOG,
  TASK_RELEVANCE,
  selectModelForTask,
  findModel,
  setLiveTiersFromModels,
  clearLiveTiers,
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

describe("canlı keşif (auto-discovery: güncel modelleri tier'la)", () => {
  afterEach(() => clearLiveTiers());

  it("EN YENİ sürümü tier'lara atar (opus→strong, sonnet→balanced, haiku→cheap)", () => {
    const t = setLiveTiersFromModels([
      { id: "claude-opus-4-9", display_name: "Opus 4.9" }, // newest-first
      { id: "claude-opus-4-8", display_name: "Opus 4.8" },
      { id: "claude-sonnet-4-7", display_name: "Sonnet 4.7" },
      { id: "claude-haiku-4-6", display_name: "Haiku 4.6" },
    ]);
    expect(t.strong).toBe("claude-opus-4-9");
    expect(t.balanced).toBe("claude-sonnet-4-7");
    expect(t.cheap).toBe("claude-haiku-4-6");
  });

  it("canlı tier config'i GEÇER (auto-bump: yeni sürüm kazanır)", () => {
    setLiveTiersFromModels([{ id: "claude-opus-4-9", display_name: "Opus 4.9" }]);
    const c = selectModelForTask("codegen", { strong: "claude-opus-4-8" });
    expect(c.modelId).toBe("claude-opus-4-9"); // canlı (yeni) config'i geçer
    expect(c.label).toBe("Opus 4.9");
  });

  it("bilinmeyen aile (mythos) → unknownFamilies, tier'a atanmaz", () => {
    const t = setLiveTiersFromModels([{ id: "claude-mythos-1", display_name: "Mythos 1" }]);
    expect(t.unknownFamilies).toContain("claude-mythos-1");
    expect(t.strong).toBeUndefined();
  });
});
