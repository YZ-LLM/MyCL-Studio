import { describe, expect, it } from "vitest";
import { formatBlastRadius } from "../src/fix/dep-graph/index.js";

describe("formatBlastRadius (#3 — fix codegen'e bağımlılık etki-alanı)", () => {
  it("affected varsa etki-alanı metni üretir (modül + risk + neden)", () => {
    const out = formatBlastRadius([
      { module: "src/api/orders.ts", why: "doğrudan import eder", risk: "high" as const },
      { module: "src/ui/list.tsx", why: "2. derece bağımlı", risk: "medium" as const },
    ]);
    expect(out).toContain("Bağımlılık etki alanı");
    expect(out).toContain("src/api/orders.ts (high:");
    expect(out).toContain("src/ui/list.tsx (medium:");
  });

  it("boş → '' (gürültü yok)", () => {
    expect(formatBlastRadius([])).toBe("");
  });

  it("max ile sınırlanır", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      module: `m${i}.ts`,
      why: "x",
      risk: "low" as const,
    }));
    const out = formatBlastRadius(many, 3);
    expect(out.match(/^- /gm)?.length).toBe(3);
  });
});
