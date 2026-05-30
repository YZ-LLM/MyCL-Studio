import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit } from "../../src/audit.js";
import {
  extractKeywords,
  getRelevantChunks,
  jaccardOverlap,
  keywordPreFilter,
} from "../../src/relevance/relevance-engine.js";
import type { Chunk } from "../../src/relevance/types.js";
import * as classifier from "../../src/relevance/classifier.js";
import type { State } from "../../src/types.js";
import type { MyclConfig } from "../../src/config.js";

const chunk = (id: string, text: string): Chunk => ({
  id,
  source: "audit",
  text,
  metadata: {},
});

describe("relevance/engine · extractKeywords", () => {
  it("lowercases + splits on non-alphanumeric + drops stopwords + min 3 char", () => {
    const k = extractKeywords("Add a Dark Mode toggle to the Settings page");
    expect(k.has("dark")).toBe(true);
    expect(k.has("mode")).toBe(true);
    expect(k.has("toggle")).toBe(true);
    expect(k.has("settings")).toBe(true);
    expect(k.has("page")).toBe(true);
    // Stopwords + short
    expect(k.has("add")).toBe(true); // "add" is 3 chars, not stopword
    expect(k.has("a")).toBe(false);
    expect(k.has("the")).toBe(false);
    expect(k.has("to")).toBe(false);
  });

  it("empty string → empty set", () => {
    expect(extractKeywords("").size).toBe(0);
  });

  it("only stopwords → empty set", () => {
    expect(extractKeywords("a the and or but if of").size).toBe(0);
  });
});

describe("relevance/engine · jaccardOverlap", () => {
  it("disjoint sets → 0", () => {
    expect(jaccardOverlap(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("identical sets → 1", () => {
    expect(jaccardOverlap(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });

  it("half overlap", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["a", "c"]);
    // intersection = {a} = 1; union = {a,b,c} = 3 → 1/3
    expect(jaccardOverlap(a, b)).toBeCloseTo(1 / 3, 4);
  });

  it("empty set → 0 (no division by zero)", () => {
    expect(jaccardOverlap(new Set(), new Set(["a"]))).toBe(0);
    expect(jaccardOverlap(new Set(["a"]), new Set())).toBe(0);
  });
});

describe("relevance/engine · keywordPreFilter", () => {
  it("returns top-K chunks ranked by Jaccard overlap with intent", () => {
    const chunks = [
      chunk("c1", "dark mode toggle button"),
      chunk("c2", "user authentication flow"),
      chunk("c3", "dark theme persistence storage"),
      chunk("c4", "database migration scripts"),
    ];
    const filtered = keywordPreFilter("dark mode persistence", chunks, 2);
    expect(filtered).toHaveLength(2);
    // c1 ("dark mode") and c3 ("dark persistence") should outrank c2/c4
    const ids = filtered.map((c) => c.id);
    expect(ids).toContain("c1");
    expect(ids).toContain("c3");
    expect(ids).not.toContain("c4");
  });

  it("empty intent keywords (only stopwords) → first K passes through", () => {
    const chunks = [chunk("a", "x"), chunk("b", "y"), chunk("c", "z")];
    const filtered = keywordPreFilter("a the and", chunks, 2);
    expect(filtered).toHaveLength(2);
    expect(filtered[0].id).toBe("a");
    expect(filtered[1].id).toBe("b");
  });

  it("topK larger than chunk count → returns all chunks", () => {
    const chunks = [chunk("a", "dark mode"), chunk("b", "light theme")];
    const filtered = keywordPreFilter("dark theme", chunks, 10);
    expect(filtered).toHaveLength(2);
  });

  it("empty chunks → empty result", () => {
    expect(keywordPreFilter("anything", [], 5)).toEqual([]);
  });
});

describe("relevance/engine · audit_phase post-filter", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-engine-"));
    // 3 farklı fazdan audit event yaz
    await appendAudit(projectRoot, { ts: 1, phase: 5, event: "ui-file-write", caller: "mycl-orchestrator", detail: "wrote App.tsx" });
    await appendAudit(projectRoot, { ts: 2, phase: 8, event: "tdd-green", caller: "mycl-orchestrator" });
    await appendAudit(projectRoot, { ts: 3, phase: 8, event: "tdd-red", caller: "mycl-orchestrator" });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("audit_phase=5 keeps only Phase 5 audit chunks (classifier stubbed)", async () => {
    // Classifier'ı stub'la: gelen tüm chunks'a max score (10) ver → threshold/sort'a etki yok
    const spy = vi.spyOn(classifier, "scoreChunks").mockImplementation(
      async (_cfg, _key, _model, _intent, chunks) =>
        chunks.map((c) => ({ ...c, score: 10, reason: "stub" })),
    );

    const fakeConfig = {
      api_keys: { translator: "t", main: "m" },
      selected_models: { translator: "tm", main: "mm" },
    } as MyclConfig;
    const fakeState: State = {
      current_phase: 7,
      session_id: "s",
      spec_approved: false,
      ui_flow_active: false,
      regression_block_active: false,
      project_root: projectRoot,
      created_at: 0,
      updated_at: 0,
    };

    const result = await getRelevantChunks(fakeConfig, fakeState, {
      sources: ["audit"],
      intent: "ui-related work",
      max_chunks: 10,
      min_score: 1,
      audit_phase: 5,
    });

    // Sadece Phase 5 event'i geçmeli
    expect(result).toHaveLength(1);
    expect(result[0].metadata.phase).toBe(5);
    expect(result[0].metadata.event).toBe("ui-file-write");

    spy.mockRestore();
  });
});
