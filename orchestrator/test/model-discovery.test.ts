import { describe, expect, it } from "vitest";
import { parseDiscoveredModels } from "../src/model-discovery.js";

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
