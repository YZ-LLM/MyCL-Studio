import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit } from "../../src/audit.js";
import { appendAbandonedIntent } from "../../src/abandoned-intents.js";
import { saveHistoryStep } from "../../src/history.js";
import {
  extractAbandonedChunks,
  extractAuditChunks,
  extractBriefChunks,
  extractFeatureChunks,
  extractGitChunks,
  extractHistoryChunks,
  extractPatternsChunks,
  extractSpecChunks,
  extractUserGuideChunks,
} from "../../src/relevance/chunk-store.js";

describe("relevance/chunk-store", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-chunks-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  describe("extractAuditChunks", () => {
    it("empty audit log → empty array", async () => {
      expect(await extractAuditChunks(projectRoot)).toEqual([]);
    });

    it("emits one chunk per audit event with stable id", async () => {
      await appendAudit(projectRoot, {
        ts: 1000,
        phase: 1,
        event: "phase-1-intent-approve",
        caller: "user",
        detail: "added dark mode toggle",
      });
      await appendAudit(projectRoot, {
        ts: 2000,
        phase: 8,
        event: "tdd-green",
        caller: "mycl-orchestrator",
      });
      const chunks = await extractAuditChunks(projectRoot);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].source).toBe("audit");
      expect(chunks[0].text).toContain("Phase 1");
      expect(chunks[0].text).toContain("phase-1-intent-approve");
      expect(chunks[0].text).toContain("user");
      expect(chunks[0].text).toContain("added dark mode toggle");
      expect(chunks[0].metadata.ts).toBe(1000);
      expect(chunks[0].metadata.phase).toBe(1);
      expect(chunks[1].metadata.event).toBe("tdd-green");
    });
  });

  describe("extractSpecChunks", () => {
    it("missing spec.md → empty array", async () => {
      expect(await extractSpecChunks(projectRoot)).toEqual([]);
    });

    it("splits spec.md by ## headings, one chunk per section", async () => {
      await mkdir(join(projectRoot, ".mycl"), { recursive: true });
      await writeFile(
        join(projectRoot, ".mycl", "spec.md"),
        `# My App

## Scope
A dark mode toggle for the settings page.

## Acceptance Criteria
- AC1: toggle switches theme
- AC2: preference persists

## Risks
### Theme system mismatch
Existing app has no theme provider.
`,
      );
      const chunks = await extractSpecChunks(projectRoot);
      expect(chunks).toHaveLength(3);
      const headings = chunks.map((c) => c.metadata.heading);
      expect(headings).toEqual(["Scope", "Acceptance Criteria", "Risks"]);
      expect(chunks[0].text).toContain("dark mode toggle");
      expect(chunks[0].id).toBe("spec-Scope");
    });

    it("ignores content before the first ## heading", async () => {
      await mkdir(join(projectRoot, ".mycl"), { recursive: true });
      await writeFile(
        join(projectRoot, ".mycl", "spec.md"),
        `# Title only\n\nIntro paragraph not under any section.\n\n## RealSection\nbody\n`,
      );
      const chunks = await extractSpecChunks(projectRoot);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].metadata.heading).toBe("RealSection");
    });
  });

  describe("extractAbandonedChunks", () => {
    it("missing file → empty array", async () => {
      expect(await extractAbandonedChunks(projectRoot)).toEqual([]);
    });

    it("emits one chunk per abandoned entry with intent + concerns + reason", async () => {
      await appendAbandonedIntent(projectRoot, {
        ts: 5000,
        iteration: 2,
        phase: 2,
        intent: "rewrite auth from scratch",
        concerns: ["existing sessions invalidated", "PII migration"],
        reason: "scope too large",
      });
      const chunks = await extractAbandonedChunks(projectRoot);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].source).toBe("abandoned");
      expect(chunks[0].text).toContain("rewrite auth");
      expect(chunks[0].text).toContain("existing sessions invalidated");
      expect(chunks[0].text).toContain("scope too large");
      expect(chunks[0].metadata.iteration).toBe(2);
    });
  });

  describe("extractHistoryChunks", () => {
    it("missing history → empty array", async () => {
      expect(await extractHistoryChunks(projectRoot, 9)).toEqual([]);
    });

    it("summarizes ApiMessage content: text + tool_use + tool_result", async () => {
      await saveHistoryStep(projectRoot, 9, {
        role: "user",
        content: "implement AC1",
      });
      await saveHistoryStep(projectRoot, 9, {
        role: "assistant",
        content: [
          { type: "text", text: "I will write the test first." },
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: "test/foo.test.ts" } },
        ],
      });
      await saveHistoryStep(projectRoot, 9, {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file written" },
        ],
      });
      const chunks = await extractHistoryChunks(projectRoot, 9);
      expect(chunks).toHaveLength(3);
      expect(chunks[0].text).toContain("[user]");
      expect(chunks[0].text).toContain("implement AC1");
      expect(chunks[1].text).toContain("[assistant]");
      expect(chunks[1].text).toContain("write the test first");
      expect(chunks[1].text).toContain("<tool_use:Write>");
      expect(chunks[2].text).toContain("<tool_result>");
      expect(chunks[2].text).toContain("file written");
    });
  });

  describe("extractPatternsChunks", () => {
    it("missing patterns.md → empty array", async () => {
      expect(await extractPatternsChunks(projectRoot)).toEqual([]);
    });

    it("splits patterns.md by ## headings", async () => {
      await mkdir(join(projectRoot, ".mycl"), { recursive: true });
      await writeFile(
        join(projectRoot, ".mycl", "patterns.md"),
        `# Pattern Match\n\n## Reusable Modules\n- foo.ts\n\n## Idioms\n- naming: camelCase\n`,
      );
      const chunks = await extractPatternsChunks(projectRoot);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].source).toBe("patterns");
      expect(chunks[0].metadata.heading).toBe("Reusable Modules");
      expect(chunks[1].metadata.heading).toBe("Idioms");
    });
  });

  describe("extractBriefChunks", () => {
    it("missing brief.md → empty array", async () => {
      expect(await extractBriefChunks(projectRoot)).toEqual([]);
    });

    it("splits brief.md by ## headings (Summary/Tags/Stakeholders/Constraints)", async () => {
      await mkdir(join(projectRoot, ".mycl"), { recursive: true });
      await writeFile(
        join(projectRoot, ".mycl", "brief.md"),
        `# Brief\n\n## Summary\nAdd dark mode toggle.\n\n## Tags\n- \`ui\`\n- \`theme\`\n\n## Constraints\n- No new deps\n`,
      );
      const chunks = await extractBriefChunks(projectRoot);
      expect(chunks).toHaveLength(3);
      expect(chunks[0].source).toBe("brief");
      expect(chunks[0].metadata.heading).toBe("Summary");
      expect(chunks[0].id).toBe("brief-Summary");
    });
  });

  describe("extractGitChunks", () => {
    it("non-git directory → empty array", async () => {
      expect(await extractGitChunks(projectRoot)).toEqual([]);
    });

    it("git repo with commits → chunks with short sha + subject + stats", async () => {
      spawnSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot, stdio: "ignore" });
      spawnSync("git", ["config", "user.email", "t@e.com"], { cwd: projectRoot, stdio: "ignore" });
      spawnSync("git", ["config", "user.name", "T"], { cwd: projectRoot, stdio: "ignore" });
      spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: projectRoot, stdio: "ignore" });
      await writeFile(join(projectRoot, "a.txt"), "hello\n");
      spawnSync("git", ["add", "a.txt"], { cwd: projectRoot, stdio: "ignore" });
      spawnSync("git", ["commit", "-m", "add a.txt"], { cwd: projectRoot, stdio: "ignore" });

      const chunks = await extractGitChunks(projectRoot);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].source).toBe("git");
      expect(chunks[0].text).toContain("add a.txt");
      expect(chunks[0].text).toContain("a.txt");
      expect(chunks[0].metadata.heading).toMatch(/^[0-9a-f]{7}$/);
      expect(chunks[0].metadata.ts).toBeGreaterThan(0);
    });
  });

  describe("extractFeatureChunks (v15.11 yaşayan dökümantasyon)", () => {
    it("dosya yok → boş array", async () => {
      expect(await extractFeatureChunks(projectRoot)).toEqual([]);
    });
    it("## heading başına bir chunk + stabil id", async () => {
      await mkdir(join(projectRoot, ".mycl"), { recursive: true });
      await writeFile(
        join(projectRoot, ".mycl", "features.md"),
        "# Özellikler\n## Ürün CRUD\nÜrün ekle/sil.\n## Arama\nCanlı filtre.\n",
        "utf-8",
      );
      const chunks = await extractFeatureChunks(projectRoot);
      expect(chunks).toHaveLength(2);
      expect(chunks.map((c) => c.source)).toEqual(["features", "features"]);
      expect(chunks[0].id).toBe("features-Ürün CRUD");
      expect(chunks[0].metadata.heading).toBe("Ürün CRUD");
      expect(chunks[1].metadata.heading).toBe("Arama");
    });
  });

  describe("extractUserGuideChunks (v15.11)", () => {
    it("dosya yok → boş array", async () => {
      expect(await extractUserGuideChunks(projectRoot)).toEqual([]);
    });
    it("## heading başına bir chunk", async () => {
      await mkdir(join(projectRoot, ".mycl"), { recursive: true });
      await writeFile(
        join(projectRoot, ".mycl", "user-guide.md"),
        "# Kılavuz\n## Nasıl ürün eklenir\n1. Forma gir 2. Kaydet\n",
        "utf-8",
      );
      const chunks = await extractUserGuideChunks(projectRoot);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].source).toBe("user-guide");
      expect(chunks[0].metadata.heading).toBe("Nasıl ürün eklenir");
    });
  });
});
