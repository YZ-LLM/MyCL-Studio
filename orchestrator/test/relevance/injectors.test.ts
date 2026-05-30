import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MyclConfig } from "../../src/config.js";
import {
  buildRelevantProjectContext,
  formatAbandonedChunk,
  formatAuditChunk,
  formatBriefChunk,
  formatProjectContextGroups,
  formatSpecChunk,
  getSpecSectionMarkdown,
} from "../../src/relevance/injectors.js";
import type { ScoredChunk } from "../../src/relevance/types.js";
import type { State } from "../../src/types.js";

describe("relevance/injectors · formatSpecChunk", () => {
  it("uses heading + score + reason + body", () => {
    const c: ScoredChunk = {
      id: "spec-Scope",
      source: "spec",
      text: "## Scope\nThe app supports dark mode.",
      metadata: { heading: "Scope" },
      score: 8,
      reason: "matches dark mode intent",
    };
    const out = formatSpecChunk(c);
    expect(out).toContain("### Scope");
    expect(out).toContain("8/10");
    expect(out).toContain("matches dark mode intent");
    expect(out).toContain("dark mode");
  });

  it("missing heading → (unnamed) sentinel", () => {
    const c: ScoredChunk = {
      id: "spec-x",
      source: "spec",
      text: "body",
      metadata: {},
      score: 5,
      reason: "ok",
    };
    expect(formatSpecChunk(c)).toContain("### (unnamed)");
  });
});

describe("relevance/injectors · formatAbandonedChunk", () => {
  it("uses iteration + date + score + reason + body", () => {
    const c: ScoredChunk = {
      id: "abandoned-iter2",
      source: "abandoned",
      text: "Intent: rewrite auth\nConcerns: PII\nReason: scope too large",
      metadata: { iteration: 2, ts: Date.UTC(2026, 4, 15) },
      score: 7,
      reason: "similar abandonment",
    };
    const out = formatAbandonedChunk(c);
    expect(out).toContain("Iteration 2");
    expect(out).toContain("2026-05-15");
    expect(out).toContain("7/10");
    expect(out).toContain("similar abandonment");
    expect(out).toContain("rewrite auth");
  });

  it("missing iteration/ts → '?' sentinel for both", () => {
    const c: ScoredChunk = {
      id: "abandoned-x",
      source: "abandoned",
      text: "x",
      metadata: {},
      score: 5,
      reason: "ok",
    };
    const out = formatAbandonedChunk(c);
    expect(out).toContain("Iteration ?");
    expect(out).toContain("(?, relevance");
  });
});

describe("relevance/injectors · formatBriefChunk", () => {
  it("uses heading + score + reason + body", () => {
    const c: ScoredChunk = {
      id: "brief-Summary",
      source: "brief",
      text: "## Summary\nAdd dark mode toggle",
      metadata: { heading: "Summary" },
      score: 9,
      reason: "directly aligned",
    };
    const out = formatBriefChunk(c);
    expect(out).toContain("### Summary");
    expect(out).toContain("9/10");
    expect(out).toContain("directly aligned");
  });
});

describe("relevance/injectors · formatAuditChunk", () => {
  it("compact one-liner format", () => {
    const c: ScoredChunk = {
      id: "audit-1",
      source: "audit",
      text: "Phase 5: ui-file-write (mycl-orchestrator) wrote App.tsx",
      metadata: { phase: 5 },
      score: 8,
      reason: "ui-related",
    };
    const out = formatAuditChunk(c);
    expect(out).toMatch(/^- \[8\/10\]/);
    expect(out).toContain("ui-file-write");
    expect(out).toContain("— ui-related");
  });
});

describe("relevance/injectors · getSpecSectionMarkdown (deterministic, no LLM)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-inj-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("returns matching section text", async () => {
    await mkdir(join(projectRoot, ".mycl"), { recursive: true });
    await writeFile(
      join(projectRoot, ".mycl", "spec.md"),
      `# Spec\n\n## Scope\nAdd dark mode.\n\n## Risks\nTheme system absent.\n`,
    );
    const out = await getSpecSectionMarkdown(projectRoot, "Scope");
    expect(out).toContain("Add dark mode");
  });

  it("case-insensitive heading match", async () => {
    await mkdir(join(projectRoot, ".mycl"), { recursive: true });
    await writeFile(
      join(projectRoot, ".mycl", "spec.md"),
      `## Acceptance Criteria\n- AC1\n`,
    );
    const out = await getSpecSectionMarkdown(projectRoot, "acceptance criteria");
    expect(out).toContain("AC1");
  });

  it("missing section → sentinel", async () => {
    await mkdir(join(projectRoot, ".mycl"), { recursive: true });
    await writeFile(join(projectRoot, ".mycl", "spec.md"), `## Scope\nbody\n`);
    const out = await getSpecSectionMarkdown(projectRoot, "Nonexistent");
    expect(out).toBe("(no 'Nonexistent' section in spec)");
  });

  it("missing spec.md → sentinel", async () => {
    const out = await getSpecSectionMarkdown(projectRoot, "Scope");
    expect(out).toBe("(no 'Scope' section in spec)");
  });
});

describe("relevance/injectors · formatProjectContextGroups (Phase 1)", () => {
  it("empty chunks → empty string (caller handles sentinel separately)", () => {
    expect(formatProjectContextGroups([])).toBe("");
  });

  it("groups chunks by source with custom render order", () => {
    const chunks: ScoredChunk[] = [
      {
        id: "audit-1",
        source: "audit",
        text: "Phase 8: tdd-green",
        metadata: { phase: 8, event: "tdd-green" },
        score: 7,
        reason: "tdd-related",
      },
      {
        id: "spec-Scope",
        source: "spec",
        text: "## Scope\nTodo CRUD",
        metadata: { heading: "Scope" },
        score: 9,
        reason: "directly relevant",
      },
      {
        id: "git-abc1234",
        source: "git",
        text: "abc1234 add auth\nFiles: src/auth.ts",
        metadata: { heading: "abc1234" },
        score: 6,
        reason: "auth context",
      },
    ];
    const out = formatProjectContextGroups(chunks);
    // spec görünmeli (render order: spec, brief, abandoned, audit, git, patterns)
    expect(out).toContain("### spec");
    expect(out).toContain("### audit");
    expect(out).toContain("### git");
    // Render order: spec audit'ten ÖNCE gelmeli
    const specIdx = out.indexOf("### spec");
    const auditIdx = out.indexOf("### audit");
    const gitIdx = out.indexOf("### git");
    expect(specIdx).toBeLessThan(auditIdx);
    expect(auditIdx).toBeLessThan(gitIdx);
  });

  it("spec/brief chunks render with **heading** bold + relevance score", () => {
    const c: ScoredChunk = {
      id: "spec-AC",
      source: "spec",
      text: "## Acceptance Criteria\n- AC1",
      metadata: { heading: "Acceptance Criteria" },
      score: 8,
      reason: "AC match",
    };
    const out = formatProjectContextGroups([c]);
    expect(out).toContain("**Acceptance Criteria**");
    expect(out).toContain("relevance 8/10");
    expect(out).toContain("AC match");
  });

  it("audit/git chunks render with [score/10] compact format", () => {
    const c: ScoredChunk = {
      id: "audit-x",
      source: "audit",
      text: "Phase 5: ui-file-write",
      metadata: { phase: 5 },
      score: 7,
      reason: "ui",
    };
    const out = formatProjectContextGroups([c]);
    expect(out).toContain("[7/10]");
    expect(out).toContain("ui-file-write");
  });

  it("within a group: chunks sorted by score desc", () => {
    const chunks: ScoredChunk[] = [
      {
        id: "spec-a", source: "spec", text: "lo", metadata: { heading: "a" },
        score: 5, reason: "x",
      },
      {
        id: "spec-b", source: "spec", text: "hi", metadata: { heading: "b" },
        score: 9, reason: "y",
      },
    ];
    const out = formatProjectContextGroups(chunks);
    // 9/10 olan (b) önce gelmeli
    const bIdx = out.indexOf("**b**");
    const aIdx = out.indexOf("**a**");
    expect(bIdx).toBeLessThan(aIdx);
  });
});

describe("relevance/injectors · buildRelevantProjectContext (Phase 1, integration)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-pctx-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("empty project (no .mycl/ files) → sentinel string, no API call", async () => {
    // Yeni proje: hiçbir .mycl/ dosyası yok. Tüm extractor'lar boş döner;
    // engine empty chunks gather → classifier scoreChunks early-return (no SDK
    // call); injector sentinel döner. Template substitute bu sentinel'i strict
    // mode'da kabul eder (PROJECT_CONTEXT_DIGEST string).
    const fakeConfig = {
      api_keys: { translator: "t", main: "m" },
      selected_models: { translator: "tm", main: "mm" },
    } as MyclConfig;
    const fakeState: State = {
      current_phase: 1,
      session_id: "s",
      spec_approved: false,
      ui_flow_active: false,
      regression_block_active: false,
      project_root: projectRoot,
      created_at: 0,
      updated_at: 0,
    };
    const out = await buildRelevantProjectContext(
      fakeConfig,
      fakeState,
      "I want to add a reminder feature",
    );
    expect(out).toBe("(no prior project context — fresh project)");
    // Sentinel **DAIMA string** — substitute() TemplateError throw etmesin
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});
