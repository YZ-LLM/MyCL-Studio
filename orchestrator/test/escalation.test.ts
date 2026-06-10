import { describe, expect, it } from "vitest";
import { buildLadder, firstRung, nextRung, rungLabel, isRung, type Rung } from "../src/escalation.js";

describe("escalation merdiveni (Ümit: ucuzdan başla, sorun çıktıkça tırman)", () => {
  it("ilk basamak = cheap · low (en düşük model+efor)", () => {
    expect(firstRung()).toEqual({ tier: "cheap", effort: "low" });
  });

  it("merdiven en alttan en üste sıralı: cheap[low,med,high] → balanced[...] → strong[...,xhigh,max]", () => {
    const l = buildLadder();
    expect(l[0]).toEqual({ tier: "cheap", effort: "low" });
    expect(l[l.length - 1]).toEqual({ tier: "strong", effort: "max" });
    // cheap/balanced 3 efor, strong 5 efor → 11 basamak
    expect(l.length).toBe(11);
    // xhigh/max yalnız strong'da
    expect(l.filter((r) => r.effort === "max").every((r) => r.tier === "strong")).toBe(true);
    expect(l.filter((r) => r.effort === "xhigh").every((r) => r.tier === "strong")).toBe(true);
  });

  it("önce AYNI tier'da efor yükselir (cheap low→medium→high)", () => {
    expect(nextRung({ tier: "cheap", effort: "low" })).toEqual({ tier: "cheap", effort: "medium" });
    expect(nextRung({ tier: "cheap", effort: "medium" })).toEqual({ tier: "cheap", effort: "high" });
  });

  it("efor bitince SONRAKİ tier'ın low'una atlar (cheap high → balanced low)", () => {
    expect(nextRung({ tier: "cheap", effort: "high" })).toEqual({ tier: "balanced", effort: "low" });
    expect(nextRung({ tier: "balanced", effort: "high" })).toEqual({ tier: "strong", effort: "low" });
  });

  it("strong'da xhigh→max sonrası yükseltilemez (en üst → null)", () => {
    expect(nextRung({ tier: "strong", effort: "high" })).toEqual({ tier: "strong", effort: "xhigh" });
    expect(nextRung({ tier: "strong", effort: "xhigh" })).toEqual({ tier: "strong", effort: "max" });
    expect(nextRung({ tier: "strong", effort: "max" })).toBeNull();
  });

  it("tüm merdiven baştan sona nextRung ile gezilir (11 basamak, sonda null)", () => {
    let cur: Rung | null = firstRung();
    const visited: Rung[] = [];
    while (cur) {
      visited.push(cur);
      cur = nextRung(cur);
    }
    expect(visited).toEqual(buildLadder());
  });

  it("rungLabel + isRung", () => {
    expect(rungLabel({ tier: "cheap", effort: "low" })).toBe("cheap · low");
    expect(isRung({ tier: "strong", effort: "max" })).toBe(true);
    expect(isRung({ tier: "cheap", effort: "max" })).toBe(false); // cheap'te max yok
    expect(isRung({ tier: "x", effort: "low" })).toBe(false);
    expect(isRung(null)).toBe(false);
  });
});
