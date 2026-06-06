// F2 — 1 saatlik prompt cache (opt-in). API yolu: buildCacheControl (cache_control.ttl);
// CLI yolu: setCacheTtl → claudeSpawnEnv (ENABLE_PROMPT_CACHING_1H). Default 5m (geriye uyum).

import { describe, expect, it, afterEach } from "vitest";
import { buildCacheControl } from "../src/claude-api.js";
import { setCacheTtl, claudeSpawnEnv } from "../src/codegen/cli-backend.js";

describe("F2 buildCacheControl (saf, API yolu)", () => {
  it("cache_ttl='1h' → { type:'ephemeral', ttl:'1h' }", () => {
    expect(buildCacheControl({ cache_ttl: "1h" })).toEqual({ type: "ephemeral", ttl: "1h" });
  });
  it("cache_ttl='5m'/yok/undefined → ttl YOK (varsayılan 5dk)", () => {
    expect(buildCacheControl({ cache_ttl: "5m" })).toEqual({ type: "ephemeral" });
    expect(buildCacheControl({})).toEqual({ type: "ephemeral" });
    expect(buildCacheControl(undefined)).toEqual({ type: "ephemeral" });
  });
});

describe("F2 setCacheTtl → claudeSpawnEnv (CLI/abonelik yolu)", () => {
  afterEach(() => setCacheTtl("5m")); // modül-singleton state'ini sızdırma

  it("'1h' → ENABLE_PROMPT_CACHING_1H='1'", () => {
    setCacheTtl("1h");
    expect(claudeSpawnEnv().ENABLE_PROMPT_CACHING_1H).toBe("1");
  });

  it("'5m'/undefined → env'de YOK (varsayılan davranış)", () => {
    setCacheTtl("5m");
    expect(claudeSpawnEnv().ENABLE_PROMPT_CACHING_1H).toBeUndefined();
    setCacheTtl(undefined);
    expect(claudeSpawnEnv().ENABLE_PROMPT_CACHING_1H).toBeUndefined();
  });
});
