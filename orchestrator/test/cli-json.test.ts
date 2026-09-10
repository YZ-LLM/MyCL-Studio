// cli-json — string-aware JSON çıkarımı (saf fonksiyon, mock yok).

import { describe, expect, it } from "vitest";
import {
  extractTokenUsage,
  scanBalancedObjects,
  extractLastJsonObject,
  extractKindBlock,
  schemaToSkeleton,
  coerceToSchema,
} from "../src/cli-json.js";

// Faz 2 complete_precision_audit şemasının gerçek şekli (test referansı).
const PHASE2_SCHEMA = {
  type: "object",
  required: ["enriched_summary", "dimensions"],
  properties: {
    enriched_summary: { type: "string", description: "4-6 sentence summary." },
    dimensions: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "decision"],
        properties: {
          name: { type: "string" },
          decision: { type: "string", description: "covered | defaulted | asked" },
          detail: { type: "string" },
        },
      },
    },
  },
};

describe("schemaToSkeleton (somut örnek)", () => {
  it("iç içe dizi-of-object şeklini GÖSTERİR (düzyazı değil)", () => {
    const skel = schemaToSkeleton(PHASE2_SCHEMA) as Record<string, unknown>;
    expect(typeof skel.enriched_summary).toBe("string");
    expect(Array.isArray(skel.dimensions)).toBe(true);
    const item = (skel.dimensions as unknown[])[0] as Record<string, unknown>;
    expect(item).toHaveProperty("name");
    expect(item).toHaveProperty("decision");
    // JSON.stringify edilebilir + dizi yapısını içerir
    expect(JSON.stringify(skel)).toContain(`"dimensions":[{`);
  });

  it("enum → ilk değer; integer → 0", () => {
    expect(schemaToSkeleton({ type: "string", enum: ["a", "b"] })).toBe("a");
    expect(schemaToSkeleton({ type: "integer" })).toBe(0);
  });
});

describe("coerceToSchema (eksik alanı doldur — takılma yok)", () => {
  it("eksik dizi → []; eksik string → alias'tan kurtar", () => {
    const { coerced, defaulted } = coerceToSchema(
      { kind: "approval", summary: "audit prose" },
      PHASE2_SCHEMA,
      "raw agent text",
    );
    expect(Array.isArray(coerced.dimensions)).toBe(true);
    expect((coerced.dimensions as unknown[]).length).toBe(0);
    expect(coerced.enriched_summary).toBe("audit prose"); // summary alias
    expect(defaulted.sort()).toEqual(["dimensions", "enriched_summary"]);
  });

  it("alias yoksa eksik string → ham metinden (fallbackText) kurtar", () => {
    const { coerced } = coerceToSchema({ kind: "approval" }, PHASE2_SCHEMA, "the prose audit");
    expect(coerced.enriched_summary).toBe("the prose audit");
  });

  it("dizi-yerine-string (düzyazı) → [] coerce edilir", () => {
    const { coerced, defaulted } = coerceToSchema(
      { kind: "approval", enriched_summary: "E", dimensions: "1. SCOPE covered 2. USERS..." },
      PHASE2_SCHEMA,
    );
    expect(Array.isArray(coerced.dimensions)).toBe(true);
    expect(defaulted).toContain("dimensions");
    expect(defaulted).not.toContain("enriched_summary"); // doğru olan korunur
  });

  it("var + doğru tip → DOKUNMA", () => {
    const valid = { kind: "approval", enriched_summary: "E", dimensions: [{ name: "SCOPE", decision: "covered" }] };
    const { coerced, defaulted } = coerceToSchema(valid, PHASE2_SCHEMA);
    expect(defaulted).toEqual([]);
    expect(coerced.dimensions).toEqual(valid.dimensions);
  });
});

describe("scanBalancedObjects", () => {
  it("top-level dengeli nesneleri bulur (nested + string-içi parantez)", () => {
    const t = `önce {"a":1} sonra {"b":{"c":2},"s":"şu { değil }"} son`;
    const out = scanBalancedObjects(t);
    expect(out).toEqual([`{"a":1}`, `{"b":{"c":2},"s":"şu { değil }"}`]);
  });
  it("kaçışlı tırnağı doğru yönetir", () => {
    const t = `{"s":"a \\" { b"}`;
    expect(scanBalancedObjects(t)).toEqual([`{"s":"a \\" { b"}`]);
  });
  it("nesne yoksa boş", () => {
    expect(scanBalancedObjects("hiç yok")).toEqual([]);
  });
});

describe("extractLastJsonObject", () => {
  it("predicate'i sağlayan SON nesneyi alır", () => {
    const t = `{"action":"chat","reason":"ilk"} ara {"action":"run_phase","reason":"son"}`;
    expect(extractLastJsonObject(t, (o) => "action" in o)).toEqual({
      action: "run_phase",
      reason: "son",
    });
  });
  it("```json fence içindeki nesneyi de yakalar (regex yok)", () => {
    const t = "metin\n```json\n{\"action\":\"chat\",\"reason\":\"x\"}\n```";
    expect(extractLastJsonObject(t, (o) => "action" in o)).toEqual({
      action: "chat",
      reason: "x",
    });
  });
  it("predicate sağlanmazsa null", () => {
    expect(extractLastJsonObject(`{"foo":1}`, (o) => "action" in o)).toBeNull();
  });
  it("bozuk JSON → null", () => {
    expect(extractLastJsonObject(`{"action":"chat",}`, (o) => "action" in o)).toBeNull();
  });
});

describe("extractKindBlock", () => {
  it("kind alanı eşleşen son bloğu alır", () => {
    const t = `{"kind":"askq","question_en":"a"} sonra {"kind":"complete","x":1}`;
    expect(extractKindBlock(t, ["askq", "complete"])).toEqual({ kind: "complete", x: 1 });
  });
  it("askq bloğu (terminal kind sonrasında soru) — sonuncu kazanır", () => {
    const t = `{"kind":"complete"} {"kind":"askq","question_en":"q"}`;
    expect(extractKindBlock(t, ["askq", "complete"])).toEqual({
      kind: "askq",
      question_en: "q",
    });
  });
  it("eşleşen kind yoksa null", () => {
    expect(extractKindBlock(`{"kind":"other"}`, ["askq", "complete"])).toBeNull();
  });
});

// ADLİ DENETİM BULGUSU (2026-09-10): bu fonksiyon `raw` bir nesne olduğu sürece — boş `{}` bile
// olsa — dolu bir kullanım nesnesi döndürüyordu. Böylece "kullanım hiç bildirilmedi" ile "kullanım
// gerçekten sıfırdı" ayrımı kayboluyor, tur sayacı artıyor ama jeton sıfır görünüyordu. Canlı
// kayıtta 694 maliyet kaydının 88'i bu durumdaydı (model + 394 tur + gerçek süre, jeton sıfır) —
// yani adli doğrulamanın en güçlü çapası (jetonu sağlayıcı üretir) güvenilmez hale gelmişti.
describe("extractTokenUsage — bildirilmedi ile gerçekten sıfır ayrımı", () => {
  it("BOŞ nesne → undefined (sahte sıfır üretilmez)", () => {
    expect(extractTokenUsage({})).toBeUndefined();
  });

  it("alakasız alanlar → undefined", () => {
    expect(extractTokenUsage({ foo: 1, service_tier: "standard" })).toBeUndefined();
  });

  it("GERÇEKTEN sıfır bildirildiyse sıfır döner (bildirim var, değer sıfır)", () => {
    const u = extractTokenUsage({ input_tokens: 0, output_tokens: 0 });
    expect(u).toBeDefined();
    expect(u?.input_tokens).toBe(0);
    expect(u?.output_tokens).toBe(0);
  });

  it("tek alan bile bildirildiyse blok geçerlidir, kalanı sıfırlanır", () => {
    const u = extractTokenUsage({ output_tokens: 120 });
    expect(u?.output_tokens).toBe(120);
    expect(u?.cache_read_input_tokens).toBe(0);
  });

  it("DAVRANIŞ KORUNUR: dolu blok eskisiyle birebir aynı çözülür", () => {
    expect(
      extractTokenUsage({
        input_tokens: 8,
        output_tokens: 5568,
        cache_read_input_tokens: 91422,
        cache_creation_input_tokens: 18259,
      }),
    ).toEqual({
      input_tokens: 8,
      output_tokens: 5568,
      cache_read_input_tokens: 91422,
      cache_creation_input_tokens: 18259,
    });
  });

  it("nesne olmayan girdi → undefined (eski davranış)", () => {
    expect(extractTokenUsage(null)).toBeUndefined();
    expect(extractTokenUsage("x")).toBeUndefined();
    expect(extractTokenUsage(undefined)).toBeUndefined();
  });
});
