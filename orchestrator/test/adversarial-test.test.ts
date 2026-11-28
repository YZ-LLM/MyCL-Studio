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
  // 2026-11-28 (koşu 37): metindeki süslü ayraç ve kod bloğu hükmü düşürmesin.
  it("bulgu metninde süslü ayraç olsa da ayrışır", () => {
    const t = 'done\n{"broke":true,"failures":["AC2: returns { error: \\"x\\" } instead of 400"]}';
    expect(parseAdversarialVerdict(t)).toEqual({ broke: true, failures: ['AC2: returns { error: "x" } instead of 400'] });
  });
  it("kod bloğu içindeki hüküm ayrışır", () => {
    const t = 'Result:\n```json\n{\n  "broke": false,\n  "failures": []\n}\n```\n';
    expect(parseAdversarialVerdict(t)).toEqual({ broke: false, failures: [] });
  });
  it("ayraçsız düz hüküm ayrışmaya devam eder; sonrasındaki kapanmamış ayraç bozmaz", () => {
    const t = 'const f = () => { return 1; }\n{"broke":false,"failures":[]}\ntrailing {';
    expect(parseAdversarialVerdict(t)).toEqual({ broke: false, failures: [] });
  });
});
