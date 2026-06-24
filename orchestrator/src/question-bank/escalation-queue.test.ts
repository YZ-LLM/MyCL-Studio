import { describe, it, expect } from "vitest";
import { EscalationQueue, type EscalationEntry } from "./escalation-queue.js";

const e = (key: string, over: Partial<EscalationEntry> = {}): EscalationEntry => ({
  key,
  checkpoint: "phase-10",
  question_id: "q",
  text: "X doğru mu?",
  lane: "defect",
  ...over,
});

describe("EscalationQueue — dedup + budget", () => {
  it("aynı KEY tekrarı yeni item açmaz, count artar", () => {
    const q = new EscalationQueue(10);
    q.add(e("k1"), 1);
    q.add(e("k1"), 2);
    expect(q.size).toBe(1);
    expect(q.list()[0]).toMatchObject({ count: 2, first_seen: 1, last_seen: 2 });
  });

  it("farklı KEY'ler ayrı item", () => {
    const q = new EscalationQueue(10);
    q.add(e("k1"), 1);
    q.add(e("k2"), 1);
    expect(q.size).toBe(2);
  });

  it("budget aşılınca overBudget (LOUD degrade sinyali)", () => {
    const q = new EscalationQueue(2);
    q.add(e("k1"), 1);
    q.add(e("k2"), 1);
    expect(q.overBudget).toBe(false);
    q.add(e("k3"), 1);
    expect(q.overBudget).toBe(true);
  });

  it("resolve item'ı düşürür (insan çözünce)", () => {
    const q = new EscalationQueue(10);
    q.add(e("k1"), 1);
    expect(q.resolve("k1")).toBe(true);
    expect(q.size).toBe(0);
    expect(q.resolve("yok")).toBe(false);
  });

  it("byCheckpoint gruplar", () => {
    const q = new EscalationQueue(10);
    q.add(e("k1", { checkpoint: "phase-10" }), 1);
    q.add(e("k2", { checkpoint: "phase-13" }), 1);
    q.add(e("k3", { checkpoint: "phase-10" }), 1);
    const g = q.byCheckpoint();
    expect(g.get("phase-10")).toHaveLength(2);
    expect(g.get("phase-13")).toHaveLength(1);
  });
});
