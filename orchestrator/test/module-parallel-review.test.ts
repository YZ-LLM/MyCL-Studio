import { describe, expect, it } from "vitest";
import { parseReviewResponse, formatReview } from "../src/module-parallel/review.js";

describe("parseReviewResponse (saf)", () => {
  it("geçerli review → ok + issues (severity normalize)", () => {
    const text =
      'bla\n{"kind":"review","ok":false,"issues":[' +
      '{"file":"src/a.ts","severity":"high","note":"B modülünün state\'ine gizli bağımlılık"},' +
      '{"file":"src/b.ts","severity":"zzz","note":"belirsiz"}]}\nokay';
    const r = parseReviewResponse(text);
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(2);
    expect(r.issues[0].severity).toBe("high");
    expect(r.issues[1].severity).toBe("low"); // geçersiz severity → low
  });

  it("review bloğu yok → ok:true, issues:[] (bloklamaz)", () => {
    expect(parseReviewResponse("hiç json yok")).toEqual({ ok: true, issues: [] });
  });
});

describe("formatReview (saf)", () => {
  it("issue yoksa → tutarlı mesajı", () => {
    expect(formatReview({ ok: true, issues: [] })).toContain("tutarlı");
  });
  it("issue varsa → severity sıralı liste (high önce)", () => {
    const out = formatReview({
      ok: false,
      issues: [
        { file: "x", severity: "low", note: "küçük" },
        { file: "y", severity: "high", note: "kritik" },
      ],
    });
    expect(out.indexOf("kritik")).toBeLessThan(out.indexOf("küçük")); // high önce
  });
});
