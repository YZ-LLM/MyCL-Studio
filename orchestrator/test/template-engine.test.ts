import { describe, expect, it } from "vitest";
import { substitute, TemplateError } from "../src/template-engine.js";

describe("template-engine", () => {
  it("substitutes a simple variable", () => {
    expect(substitute("Hi {{NAME}}!", { NAME: "world" })).toBe("Hi world!");
  });

  it("throws on unknown variable (fallback yasak)", () => {
    expect(() => substitute("X={{MISSING}}", {})).toThrow(TemplateError);
    expect(() => substitute("X={{MISSING}}", {})).toThrow(/MISSING/);
  });

  it("escapes markdown special chars with |raw modifier", () => {
    const out = substitute("{{X|raw}}", { X: "_*[hello]*_" });
    expect(out).toBe("\\_\\*\\[hello\\]\\*\\_");
  });

  it("JSON-encodes value with |json modifier", () => {
    expect(substitute("v={{X|json}}", { X: 'a"b' })).toBe('v="a\\"b"');
  });

  it("supports number and boolean values", () => {
    expect(substitute("{{N}}-{{B}}", { N: 42, B: true })).toBe("42-true");
  });

  it("throws on unknown modifier", () => {
    expect(() => substitute("{{X|nope}}", { X: "x" })).toThrow(TemplateError);
  });

  it("leaves text outside tokens untouched", () => {
    expect(substitute("a {{V}} c", { V: "b" })).toBe("a b c");
  });

  it("replaces multiple occurrences", () => {
    expect(substitute("{{V}} and {{V}}", { V: "x" })).toBe("x and x");
  });
});
