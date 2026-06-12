import { describe, expect, it } from "vitest";
import { parseAdversarialVerdict } from "../src/adversarial-test.js";
describe("adversarial-test verdict (SON JSON bloğu)", () => {
  it("broke=true + failures", () => {
    const t = 'I wrote tests...\n{"broke":true,"failures":["AC5: 403 beklenirken 200 döndü"]}';
    expect(parseAdversarialVerdict(t)).toEqual({ broke: true, failures: ["AC5: 403 beklenirken 200 döndü"] });
  });
  it("birden çok JSON → SONUNCU verdict alınır", () => {
    const t = '{"x":1} ara metin {"broke":false,"failures":[]}';
    expect(parseAdversarialVerdict(t)).toEqual({ broke: false, failures: [] });
  });
  it("verdict yoksa null", () => { expect(parseAdversarialVerdict("no verdict")).toBeNull(); });
});
