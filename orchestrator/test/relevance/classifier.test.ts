import { describe, expect, it } from "vitest";
import { mergeScoresWithChunks } from "../../src/relevance/classifier.js";
import type { Chunk } from "../../src/relevance/types.js";

const chunk = (id: string, text = "x"): Chunk => ({
  id,
  source: "audit",
  text,
  metadata: {},
});

describe("relevance/classifier · mergeScoresWithChunks", () => {
  it("matches scores to chunks by id", () => {
    const chunks = [chunk("a"), chunk("b")];
    const scores = [
      { id: "a", score: 7, reason: "matches scope" },
      { id: "b", score: 2, reason: "unrelated" },
    ];
    const merged = mergeScoresWithChunks(chunks, scores);
    expect(merged).toHaveLength(2);
    expect(merged[0].score).toBe(7);
    expect(merged[0].reason).toBe("matches scope");
    expect(merged[1].score).toBe(2);
  });

  it("missing chunk in scores → score=0 sentinel reason", () => {
    const chunks = [chunk("a"), chunk("b")];
    const scores = [{ id: "a", score: 5, reason: "ok" }];
    const merged = mergeScoresWithChunks(chunks, scores);
    expect(merged[1].score).toBe(0);
    expect(merged[1].reason).toBe("(not scored by model)");
  });

  it("clamps out-of-range scores to 0-10", () => {
    const chunks = [chunk("a"), chunk("b")];
    const scores = [
      { id: "a", score: 15, reason: "too high" },
      { id: "b", score: -3, reason: "too low" },
    ];
    const merged = mergeScoresWithChunks(chunks, scores);
    expect(merged[0].score).toBe(10);
    expect(merged[1].score).toBe(0);
  });

  it("ignores malformed score entries", () => {
    const chunks = [chunk("a")];
    const scores = [
      null,
      "garbage",
      { id: "a", score: "not-a-number" },
      { id: "a", score: 4, reason: "valid" },
    ];
    const merged = mergeScoresWithChunks(chunks, scores);
    expect(merged[0].score).toBe(4);
    expect(merged[0].reason).toBe("valid");
  });

  it("missing reason → empty string (not undefined)", () => {
    const chunks = [chunk("a")];
    const scores = [{ id: "a", score: 6 }];
    const merged = mergeScoresWithChunks(chunks, scores);
    expect(merged[0].score).toBe(6);
    expect(merged[0].reason).toBe("");
  });

  it("preserves original chunk metadata", () => {
    const chunks: Chunk[] = [
      {
        id: "spec-Scope",
        source: "spec",
        text: "scope body",
        metadata: { heading: "Scope" },
      },
    ];
    const scores = [{ id: "spec-Scope", score: 8, reason: "yes" }];
    const merged = mergeScoresWithChunks(chunks, scores);
    expect(merged[0].source).toBe("spec");
    expect(merged[0].metadata.heading).toBe("Scope");
    expect(merged[0].text).toBe("scope body");
  });
});
