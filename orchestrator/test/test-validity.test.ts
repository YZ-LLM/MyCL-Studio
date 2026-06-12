import { describe, expect, it } from "vitest";
import { parseMutation, pickCandidate } from "../src/test-validity.js";
describe("test-validity (mutasyon prob saf yardımcıları)", () => {
  it("pickCandidate: test/spec/d.ts DIŞLA, gerçek kaynak seç", () => {
    expect(pickCandidate(["src/foo.test.ts", "src/bar.ts"])).toBe("src/bar.ts");
    expect(pickCandidate(["src/x.spec.js", "tests/y.js", "src/z.d.ts"])).toBeUndefined();
    expect(pickCandidate(["backend/auth.py"])).toBe("backend/auth.py");
  });
  it("parseMutation: geçerli JSON → {old,new}; aynıysa/bozuksa null", () => {
    expect(parseMutation('{"old_line":"return true","new_line":"return false"}')).toEqual({ old_line: "return true", new_line: "return false" });
    expect(parseMutation('{"old_line":"x","new_line":"x"}')).toBeNull();
    expect(parseMutation("no json")).toBeNull();
  });
});
