import { describe, expect, it } from "vitest";
import {
  mergeScoresWithChunks,
  parseCliScores,
} from "../../src/relevance/classifier.js";
import { RelevanceError } from "../../src/relevance/types.js";
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

  it("string skor (CLI elle-JSON) coerce edilir — '8' → 8, '7/10' → 7 (API↔CLI parite)", () => {
    const chunks = [chunk("a"), chunk("b")];
    const scores = [
      { id: "a", score: "8", reason: "string skor" },
      { id: "b", score: "7/10", reason: "kesirli" },
    ];
    const merged = mergeScoresWithChunks(chunks, scores);
    expect(merged[0].score).toBe(8); // sessizce 0'a düşmedi
    expect(merged[1].score).toBe(7); // parseFloat "7/10" → 7
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

// Abonelik (CLI) modu: text-JSON çıktısından scores parse. Bu, abonelik
// kullanıcısının da gerçek recall sıralaması almasını sağlayan yolun parse'ı.
describe("relevance/classifier · parseCliScores (abonelik text-JSON)", () => {
  it("geçerli relevance_scores bloğu → chunks ile eşleşir", () => {
    const chunks = [chunk("a"), chunk("b")];
    const text = `Here are the scores:\n{"kind":"relevance_scores","scores":[{"id":"a","score":9,"reason":"core"},{"id":"b","score":1,"reason":"off"}]}`;
    const merged = parseCliScores(text, chunks);
    expect(merged[0].score).toBe(9);
    expect(merged[1].score).toBe(1);
  });

  it("```json fence içindeki blok da yakalanır (regex'siz dengeli tarayıcı)", () => {
    const chunks = [chunk("a")];
    const text = "blah\n```json\n{\"kind\":\"relevance_scores\",\"scores\":[{\"id\":\"a\",\"score\":7,\"reason\":\"ok\"}]}\n```\ndone";
    const merged = parseCliScores(text, chunks);
    expect(merged[0].score).toBe(7);
  });

  it("eksik chunk → fail-soft score 0 (mergeScoresWithChunks)", () => {
    const chunks = [chunk("a"), chunk("b")];
    const text = `{"kind":"relevance_scores","scores":[{"id":"a","score":8,"reason":"x"}]}`;
    const merged = parseCliScores(text, chunks);
    expect(merged[0].score).toBe(8);
    expect(merged[1].score).toBe(0); // model atladı → 0
  });

  it("relevance_scores bloğu YOK → RelevanceError (caller boş-array fallback)", () => {
    const chunks = [chunk("a")];
    expect(() => parseCliScores("no json here at all", chunks)).toThrow(RelevanceError);
    // yanlış kind → yine yok sayılır
    expect(() =>
      parseCliScores(`{"kind":"project_type","project_type":"web"}`, chunks),
    ).toThrow(RelevanceError);
  });

  it("scores array değil → RelevanceError", () => {
    const chunks = [chunk("a")];
    expect(() =>
      parseCliScores(`{"kind":"relevance_scores","scores":"oops"}`, chunks),
    ).toThrow(RelevanceError);
  });
});
