import { describe, expect, it } from "vitest";
import { parseConflicts, parseDesignPlan } from "../src/design-fanout.js";

describe("design-fanout · parseConflicts", () => {
  it("geçerli çatışma dizisi → tüm alanlar", () => {
    const out = parseConflicts([
      { topic: "Ödeme akışı", between: "ux vs security", summary: "Tek sayfa vs onay adımı." },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("Ödeme akışı");
    expect(out[0].between).toBe("ux vs security");
    expect(out[0].summary).toContain("onay");
  });

  it("dizi değil → boş", () => {
    expect(parseConflicts(null)).toEqual([]);
    expect(parseConflicts("oops")).toEqual([]);
    expect(parseConflicts({ topic: "x" })).toEqual([]);
  });

  it("topic'siz / bozuk girdiler atlanır, eksik alanlar boş string", () => {
    const out = parseConflicts([
      null,
      "garbage",
      { between: "a vs b" }, // topic yok → atla
      { topic: "  " }, // boş topic → atla
      { topic: "Geçerli" }, // between/summary yok → boş string
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe("Geçerli");
    expect(out[0].between).toBe("");
    expect(out[0].summary).toBe("");
  });
});

describe("design-fanout · parseDesignPlan", () => {
  it("geçerli design_plan bloğu → markdown + conflicts", () => {
    const text = `İşte tasarım:\n{"kind":"design_plan","design_markdown":"# Tasarım\\nBileşenler...","conflicts":[{"topic":"State","between":"architect vs ux","summary":"global vs lokal"}]}`;
    const res = parseDesignPlan(text);
    expect(res).not.toBeNull();
    expect(res!.designMarkdown).toContain("# Tasarım");
    expect(res!.conflicts).toHaveLength(1);
    expect(res!.conflicts[0].topic).toBe("State");
  });

  it("conflicts boş → geçerli, çatışma yok", () => {
    const text = `{"kind":"design_plan","design_markdown":"# Plan","conflicts":[]}`;
    const res = parseDesignPlan(text);
    expect(res).not.toBeNull();
    expect(res!.conflicts).toEqual([]);
  });

  it("```json fence içindeki blok da yakalanır (dengeli tarayıcı)", () => {
    const text = "blah\n```json\n{\"kind\":\"design_plan\",\"design_markdown\":\"# X\",\"conflicts\":[]}\n```\ndone";
    const res = parseDesignPlan(text);
    expect(res).not.toBeNull();
    expect(res!.designMarkdown).toBe("# X");
  });

  it("design_plan bloğu YOK → null (caller tek-ajana düşer)", () => {
    expect(parseDesignPlan("no json here")).toBeNull();
    // yanlış kind → yok sayılır
    expect(parseDesignPlan(`{"kind":"other","design_markdown":"x"}`)).toBeNull();
  });

  it("design_markdown eksik/boş → null (boş tasarım kabul edilmez)", () => {
    expect(parseDesignPlan(`{"kind":"design_plan","conflicts":[]}`)).toBeNull();
    expect(parseDesignPlan(`{"kind":"design_plan","design_markdown":"   ","conflicts":[]}`)).toBeNull();
  });
});
