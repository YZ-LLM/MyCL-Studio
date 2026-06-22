// discoverZaiModels — fallback (key-yok → statik GLM). Canlı /v4/models yolu key+ağ ister (ayrıca probe'la doğrulandı).
import { describe, expect, it } from "vitest";
import { discoverZaiModels } from "../src/models.js";
import { GLM_CATALOG } from "../src/model-catalog.js";

describe("discoverZaiModels (②b canlı keşif + fallback)", () => {
  it("key yoksa → statik GLM_CATALOG fallback (8 model, hepsi glm-)", async () => {
    const r = await discoverZaiModels("");
    expect(r.length).toBe(GLM_CATALOG.length);
    expect(r.every((m) => m.id.startsWith("glm-"))).toBe(true);
    expect(r.map((m) => m.id).sort()).toEqual(GLM_CATALOG.map((m) => m.id).sort());
  });

  it("boşluk-key → fallback (ağ çağrısı yapmaz)", async () => {
    const r = await discoverZaiModels("   ");
    expect(r.length).toBe(GLM_CATALOG.length);
  });
});
