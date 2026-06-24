import { describe, it, expect } from "vitest";
import { aggregateGate, classifyExit, outcomeLabel } from "./engine.js";
import type { QuestionVerdict } from "./types.js";

describe("classifyExit", () => {
  it("exit 0 → PASS", () => {
    expect(classifyExit(0)).toBe("PASS");
  });

  it("exit 1 (gerçek ihlal) → FAIL", () => {
    expect(classifyExit(1)).toBe("FAIL");
  });

  it("127 (araç yok) / 126 (not-exec) → daima INCONCLUSIVE, asla FAIL", () => {
    expect(classifyExit(127)).toBe("INCONCLUSIVE");
    expect(classifyExit(126)).toBe("INCONCLUSIVE");
  });

  it("124/137/143 (timeout/kill) → INCONCLUSIVE (değerlendirilemedi)", () => {
    expect(classifyExit(124)).toBe("INCONCLUSIVE");
    expect(classifyExit(137)).toBe("INCONCLUSIVE");
    expect(classifyExit(143)).toBe("INCONCLUSIVE");
  });

  it("spec'teki inconclusive_codes (örn. semgrep crash 2/7) → INCONCLUSIVE", () => {
    expect(classifyExit(2, [2, 7])).toBe("INCONCLUSIVE");
    expect(classifyExit(7, [2, 7])).toBe("INCONCLUSIVE");
  });

  it("inconclusive_codes verilmezse 2 → FAIL (gerçek bulgu)", () => {
    expect(classifyExit(2)).toBe("FAIL");
  });
});

describe("aggregateGate", () => {
  const v = (
    outcome: QuestionVerdict["outcome"],
    blocking_class: QuestionVerdict["blocking_class"] = "blocking",
    id: string = outcome,
  ): QuestionVerdict => ({ question_id: id, outcome, blocking_class });

  it("hepsi PASS → green", () => {
    const r = aggregateGate([v("PASS", "blocking", "a"), v("PASS", "blocking", "b")]);
    expect(r.decision).toBe("green");
    expect(r.coverage).toMatchObject({ pass: 2, total: 2, fraction: 1 });
  });

  it("blocking FAIL → halt_defect (INCONCLUSIVE'den önceliklidir)", () => {
    const r = aggregateGate([v("FAIL"), v("INCONCLUSIVE")]);
    expect(r.decision).toBe("halt_defect");
    expect(r.blocking_fail).toHaveLength(1);
    expect(r.blocking_inconclusive).toHaveLength(1);
  });

  it("FAIL yok ama blocking INCONCLUSIVE var → halt_infra (yeşile çökmez)", () => {
    const r = aggregateGate([v("PASS", "blocking", "a"), v("INCONCLUSIVE")]);
    expect(r.decision).toBe("halt_infra");
  });

  it("advisory FAIL pipeline'ı DURDURMAZ → green + rapora girer", () => {
    const r = aggregateGate([v("PASS", "blocking", "a"), v("FAIL", "advisory", "b")]);
    expect(r.decision).toBe("green");
    expect(r.advisory_findings).toHaveLength(1);
    expect(r.blocking_fail).toHaveLength(0);
  });

  it("NA cezalandırılmaz ama coverage'da görünür (uncovered şeffaflığı)", () => {
    const r = aggregateGate([v("PASS", "blocking", "a"), v("NA", "blocking", "b")]);
    expect(r.decision).toBe("green");
    expect(r.coverage).toMatchObject({ pass: 1, na: 1, total: 2 });
    expect(r.coverage.fraction).toBeCloseTo(0.5);
  });

  it("boş hüküm listesi → green ama fraction 0 (hiçbir şey kontrol edilmedi)", () => {
    const r = aggregateGate([]);
    expect(r.decision).toBe("green");
    expect(r.coverage).toMatchObject({ total: 0, fraction: 0 });
  });
});

describe("outcomeLabel", () => {
  it("ikili insan-yüzü ama INCONCLUSIVE/NA 'Hayır' DEĞİL", () => {
    expect(outcomeLabel("PASS")).toBe("Evet");
    expect(outcomeLabel("FAIL")).toBe("Hayır");
    expect(outcomeLabel("INCONCLUSIVE")).toBe("Değerlendirilemedi");
    expect(outcomeLabel("NA")).toBe("Kapsam dışı");
  });
});
