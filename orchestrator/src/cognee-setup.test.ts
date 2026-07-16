// cognee-setup — SAF LLM-env + gömülü-env + flag/fallback testleri (YZLLM 2026-07-13, Phase B).
// cognee LLM'i MyCL sağlayıcısına yönlenir (LiteLLM anthropic; ayrı OpenAI key YOK); key yoksa null (fallback).

import { describe, expect, it } from "vitest";
import {
  COGNEE_PINNED_SHA,
  cogneeEmbeddedEnv,
  cogneeLlmEnvFromTarget,
  resolveCogneeInstalled,
  resolveCogneeMcpConfig,
} from "./cognee-setup.js";
import type { MyclConfig } from "./config.js";

describe("cogneeLlmEnvFromTarget — MyCL sağlayıcısı → LiteLLM anthropic env", () => {
  it("Claude → LLM_MODEL='anthropic/<model>' + key; LLM_ENDPOINT YOK", () => {
    const env = cogneeLlmEnvFromTarget("sk-ant-xyz", "claude-opus-4-8");
    expect(env).toEqual({ LLM_API_KEY: "sk-ant-xyz", LLM_MODEL: "anthropic/claude-opus-4-8" });
    expect(env?.LLM_ENDPOINT).toBeUndefined();
  });

  it("apiKey yok (salt-abonelik/CLI) → null (cognee LLM'i besleyemez → görünür fallback)", () => {
    expect(cogneeLlmEnvFromTarget("", "claude-opus-4-8")).toBeNull();
  });
});

describe("cogneeEmbeddedEnv — Docker/Postgres/dış-key YOK + proje-bazlı izole", () => {
  it("SQLite+LanceDB+Kuzu gömülü + YEREL fastembed embedder (dış key YOK — BULGU 1)", () => {
    const env = cogneeEmbeddedEnv("/proj/a");
    expect(env.DB_PROVIDER).toBe("sqlite");
    expect(env.VECTOR_DB_PROVIDER).toBe("lancedb");
    expect(env.GRAPH_DATABASE_PROVIDER).toBe("kuzu");
    expect(env.EMBEDDING_PROVIDER).toBe("fastembed"); // yerel ONNX; Anthropic embeddings sunmaz → OpenAI-key gerekmesin
    expect(env.EMBEDDING_MODEL).toContain("bge-small");
    expect(env.EMBEDDING_DIMENSIONS).toBe("384");
  });

  it("BULGU 2: DATA_DIRECTORY PROJE-BAZLI izole (farklı proje → farklı depo; çapraz-proje sızıntı yok)", () => {
    const a = cogneeEmbeddedEnv("/proj/a").DATA_DIRECTORY;
    const b = cogneeEmbeddedEnv("/proj/b").DATA_DIRECTORY;
    expect(a).not.toBe(b); // ayrı hash → ayrı depo
    expect(cogneeEmbeddedEnv("/proj/a").DATA_DIRECTORY).toBe(a); // deterministik
  });
});

describe("resolveCogneeMcpConfig — flag gate + fallback (opt-in)", () => {
  function cfg(on: boolean): MyclConfig {
    return { features: { cognee_memory: on } } as unknown as MyclConfig;
  }
  it("flag KAPALI → null (bağlanmaz)", () => {
    expect(resolveCogneeMcpConfig(cfg(false))).toBeNull();
  });
  it("flag AÇIK ama kurulu DEĞİLSE → null (görünür fallback; ensure uyardı)", () => {
    if (!resolveCogneeInstalled()) expect(resolveCogneeMcpConfig(cfg(true))).toBeNull();
  });
  it("pinli SHA 40-hex (supply-chain: denetlenebilir/tekrarlanabilir)", () => {
    expect(COGNEE_PINNED_SHA).toMatch(/^[0-9a-f]{40}$/);
  });
});
