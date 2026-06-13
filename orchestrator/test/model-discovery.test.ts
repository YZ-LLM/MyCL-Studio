import { describe, expect, it } from "vitest";
import { parseDiscoveredModels, verifyModelCallable } from "../src/model-discovery.js";
import type { MyclConfig } from "../src/config.js";

describe("parseDiscoveredModels (web keşif doğrulama — hatasız liste)", () => {
  it("geçerli claude id'leri parse; claude-olmayan/boş id REDDEDİLİR", () => {
    const text =
      "found:\n" +
      '{"kind":"models","models":[' +
      '{"id":"claude-opus-4-9","display_name":"Opus 4.9"},' +
      '{"id":"claude-sonnet-4-7","display_name":"Sonnet 4.7"},' +
      '{"id":"gpt-4","display_name":"GPT"},' + // claude değil → reddet (uydurma/yanlış)
      '{"id":"","display_name":"boş"}]}'; // boş id → reddet
    const out = parseDiscoveredModels(text);
    expect(out.map((m) => m.id)).toEqual(["claude-opus-4-9", "claude-sonnet-4-7"]);
  });

  it("display_name yoksa id'ye düşer", () => {
    const out = parseDiscoveredModels('{"kind":"models","models":[{"id":"claude-haiku-4-6"}]}');
    expect(out).toHaveLength(1);
    expect(out[0].display_name).toBe("claude-haiku-4-6");
  });

  it("models bloğu yok → []", () => {
    expect(parseDiscoveredModels("hiç JSON yok")).toEqual([]);
  });
});

// Fix 2 (Ümit 2026-06-13): kabul-öncesi model doğrulama. parseDiscoveredModels biçim-geçerli
// ama VAR-OLMAYAN id'yi (claude-mythos-5) kabul eder; verifyModelCallable bunu çağrı ile yakalar.
// Burada yalnız BİÇİM-RED dalını test ederiz (ağsız, deterministik); gerçek-çağrı dalı E2E işi.
describe("verifyModelCallable (kabul-öncesi var-olma doğrulaması — biçim guard)", () => {
  const cfg = {
    selected_models: { main: "claude-opus-4-8" },
    agent_backends: { main: "cli" },
    api_keys: {},
  } as unknown as MyclConfig;

  it("claude-olmayan / bozuk-biçim id → çağrı YAPMADAN false", async () => {
    expect(await verifyModelCallable(cfg, "gpt-4", "/tmp")).toBe(false);
    expect(await verifyModelCallable(cfg, "", "/tmp")).toBe(false);
    expect(await verifyModelCallable(cfg, "claude", "/tmp")).toBe(false); // suffix yok
    expect(await verifyModelCallable(cfg, "not a model", "/tmp")).toBe(false);
  });
});
