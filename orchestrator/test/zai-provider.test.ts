// zai-provider — resolveProvider + zaiKeyForRole merkezi çözücü (z.ai Aşama 2, ① temel).
// Provider rol-başına combobox'tan (agent_backends): api|cli|zai. z.ai key yoksa savunmacı claude.

import { describe, expect, it } from "vitest";
import {
  resolveProvider,
  zaiKeyForRole,
  ZAI_BASE_URL,
  type MyclConfig,
  type ApiKeys,
} from "../src/config.js";
import {
  findModel,
  glmModelForTier,
  catalogForProvider,
  GLM_CATALOG,
  MODEL_CATALOG,
} from "../src/model-catalog.js";

function cfg(backend: string, keys: Partial<ApiKeys>): MyclConfig {
  return {
    selected_models: { translator: "x", main: "x" },
    api_keys: { translator: "ckt", main: "ckm", ...keys },
    agent_backends: { orchestrator: backend, translator: backend, main: backend },
  } as unknown as MyclConfig;
}

describe("resolveProvider (merkezi provider çözücü)", () => {
  it("provider api → claude key + baseURL undefined; zai default varsa zaiFallbackKey dolar", () => {
    const t = resolveProvider(cfg("api", { zai: "zdef" }), "main");
    expect(t.backend).toBe("api");
    expect(t.isZai).toBe(false);
    expect(t.apiKey).toBe("ckm");
    expect(t.baseURL).toBeUndefined();
    expect(t.zaiFallbackKey).toBe("zdef");
  });

  it("provider cli → backend cli, claude key, z.ai değil", () => {
    const t = resolveProvider(cfg("cli", {}), "main");
    expect(t.backend).toBe("cli");
    expect(t.isZai).toBe(false);
  });

  it("provider zai + per-rol zai_main → zai key + ZAI_BASE_URL (per-rol önceliklidir)", () => {
    const t = resolveProvider(cfg("zai", { zai_main: "zmain", zai: "zdef" }), "main");
    expect(t.backend).toBe("zai");
    expect(t.isZai).toBe(true);
    expect(t.apiKey).toBe("zmain");
    expect(t.baseURL).toBe(ZAI_BASE_URL);
  });

  it("provider zai + sadece default zai → default zai key", () => {
    const t = resolveProvider(cfg("zai", { zai: "zdef" }), "main");
    expect(t.isZai).toBe(true);
    expect(t.apiKey).toBe("zdef");
    expect(t.baseURL).toBe(ZAI_BASE_URL);
  });

  it("provider zai ama HİÇ z.ai key yok → savunmacı claude-api (sessiz-yanlış-model yerine çalışan)", () => {
    const t = resolveProvider(cfg("zai", {}), "main");
    expect(t.backend).toBe("api");
    expect(t.isZai).toBe(false);
    expect(t.apiKey).toBe("ckm");
  });

  it("translator rolü zai + zai_translator → o key kullanılır", () => {
    const t = resolveProvider(cfg("zai", { zai_translator: "ztr" }), "translator");
    expect(t.isZai).toBe(true);
    expect(t.apiKey).toBe("ztr");
  });
});

describe("zaiKeyForRole (per-rol > default)", () => {
  it("per-rol set → onu; değilse default zai; ikisi de yoksa undefined", () => {
    const keys = { zai: "def", zai_translator: "ztr" } as ApiKeys;
    expect(zaiKeyForRole(keys, "translator")).toBe("ztr");
    expect(zaiKeyForRole(keys, "main")).toBe("def");
    expect(zaiKeyForRole(keys, "orchestrator")).toBe("def");
    expect(zaiKeyForRole({} as ApiKeys, "main")).toBeUndefined();
  });
});

describe("GLM katalog (provider-aware model — ②)", () => {
  it("findModel GLM id'lerini tanır (sessiz claude-default landmine yok); claude'u da bulur", () => {
    expect(findModel("glm-5.2")?.tier).toBe("strong");
    expect(findModel("glm-4.5-air")?.tier).toBe("cheap");
    expect(findModel("claude-opus-4-8")?.tier).toBe("strong");
    expect(findModel("yok-böyle-model")).toBeUndefined();
  });

  it("glmModelForTier her tier'dan GLM döner (glm- prefix + doğru tier)", () => {
    for (const tier of ["cheap", "balanced", "strong"] as const) {
      const id = glmModelForTier(tier);
      expect(id.startsWith("glm-")).toBe(true);
      expect(findModel(id)?.tier).toBe(tier);
    }
  });

  it("catalogForProvider: isZai → GLM, değilse Claude; GLM her tier'ı kapsar (fallback'e düşmez)", () => {
    expect(catalogForProvider(true)).toBe(GLM_CATALOG);
    expect(catalogForProvider(false)).toBe(MODEL_CATALOG);
    for (const tier of ["cheap", "balanced", "strong"] as const) {
      expect(GLM_CATALOG.some((m) => m.tier === tier)).toBe(true);
    }
  });
});
