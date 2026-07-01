import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import {
  appendAudit,
  appendCost,
  appendDecision,
  appendHandoff,
  readHandoffs,
  type HandoffRecord,
  appendWtf,
  readWtf,
  type WtfRecord,
  appendAcceptedFinding,
  readAcceptedFindings,
  type AcceptedFinding,
  AuditError,
  formatDecisions,
  extractSpecSection,
  readAuditLog,
  readAuditLogTail,
  readCosts,
  readDecisions,
  SpecMissingError,
  SpecSectionMissingError,
  summarizeAuditForPhase,
  wasPipelineCompleted,
} from "../src/audit.js";
import type { CostRecord, DecisionRecord } from "../src/types.js";

describe("audit", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-audit-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("appendAudit + readAuditLog roundtrip", async () => {
    await appendAudit(projectRoot, {
      ts: 1000,
      phase: 1,
      event: "phase-1-intent-approve",
      caller: "user",
    });
    await appendAudit(projectRoot, {
      ts: 1001,
      phase: 1,
      event: "phase-1-complete",
      caller: "mycl-orchestrator",
    });
    const events = await readAuditLog(projectRoot);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("phase-1-intent-approve");
    expect(events[1].event).toBe("phase-1-complete");
  });

  it("readAuditLog returns [] when file missing", async () => {
    const events = await readAuditLog(projectRoot);
    expect(events).toEqual([]);
  });

  it("rejects non-ASCII event names", async () => {
    await expect(
      appendAudit(projectRoot, {
        ts: 1,
        phase: 1,
        event: "aşama-1-onay",
        caller: "user",
      }),
    ).rejects.toThrow(AuditError);
  });

  it("skips malformed lines in log", async () => {
    const auditPath = join(projectRoot, ".mycl/audit.log");
    await mkdir(join(projectRoot, ".mycl"), { recursive: true });
    await writeFile(
      auditPath,
      `{"ts":1,"phase":1,"event":"ok","caller":"user"}\n` +
        `{ bad json\n` +
        `{"ts":2,"phase":1,"event":"ok2","caller":"user"}\n`,
    );
    const events = await readAuditLog(projectRoot);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.event)).toEqual(["ok", "ok2"]);
  });

  describe("summarizeAuditForPhase", () => {
    it("returns '(no events)' for missing log", async () => {
      const s = await summarizeAuditForPhase(projectRoot, 9);
      expect(s).toMatch(/no events/);
    });

    it("returns '(no events)' for phase with no entries", async () => {
      await appendAudit(projectRoot, {
        ts: 1, phase: 1, event: "phase-1-complete", caller: "user",
      });
      const s = await summarizeAuditForPhase(projectRoot, 9);
      expect(s).toMatch(/no events/);
    });

    it("lists events for the requested phase only", async () => {
      await appendAudit(projectRoot, {
        ts: 1, phase: 8, event: "tdd-test-write", caller: "mycl-orchestrator",
        detail: "src/foo.test.ts",
      });
      await appendAudit(projectRoot, {
        ts: 2, phase: 8, event: "tdd-green", caller: "mycl-orchestrator",
      });
      await appendAudit(projectRoot, {
        ts: 3, phase: 10, event: "lint-pass", caller: "mycl-orchestrator",
      });
      const s = await summarizeAuditForPhase(projectRoot, 8);
      expect(s).toContain("tdd-test-write");
      expect(s).toContain("tdd-green");
      expect(s).not.toContain("lint-pass");
    });

    it("includes green/red aggregate for phase 8", async () => {
      await appendAudit(projectRoot, {
        ts: 1, phase: 8, event: "tdd-green", caller: "mycl-orchestrator",
      });
      await appendAudit(projectRoot, {
        ts: 2, phase: 8, event: "tdd-red", caller: "mycl-orchestrator",
      });
      await appendAudit(projectRoot, {
        ts: 3, phase: 8, event: "tdd-green", caller: "mycl-orchestrator",
      });
      const s = await summarizeAuditForPhase(projectRoot, 8);
      expect(s).toMatch(/green=2 red=1/);
    });

    it("caps to last maxEvents", async () => {
      for (let i = 0; i < 50; i++) {
        await appendAudit(projectRoot, {
          ts: i, phase: 8, event: "tdd-green", caller: "mycl-orchestrator",
          detail: `event-${i}`,
        });
      }
      const s = await summarizeAuditForPhase(projectRoot, 8, 5);
      // 50 events total, last 5 shown — event-45 to event-49.
      expect(s).toContain("event-49");
      expect(s).toContain("event-45");
      expect(s).not.toContain("event-10");
    });
  });

  describe("wasPipelineCompleted", () => {
    it("returns false when audit empty", async () => {
      expect(await wasPipelineCompleted(projectRoot)).toBe(false);
    });

    it("returns false when phase-17-complete missing", async () => {
      await appendAudit(projectRoot, {
        ts: 1,
        phase: 16,
        event: "phase-16-complete",
        caller: "user",
      });
      expect(await wasPipelineCompleted(projectRoot)).toBe(false);
    });

    it("returns true when phase-17-complete present", async () => {
      await appendAudit(projectRoot, {
        ts: 1,
        phase: 17,
        event: "phase-17-complete",
        caller: "mycl-orchestrator",
      });
      expect(await wasPipelineCompleted(projectRoot)).toBe(true);
    });

    it("backward compat: returns true when legacy phase-20-complete present", async () => {
      await appendAudit(projectRoot, {
        ts: 1,
        phase: 20 as unknown as 17,
        event: "phase-20-complete",
        caller: "mycl-orchestrator",
      });
      expect(await wasPipelineCompleted(projectRoot)).toBe(true);
    });

    it("returns true even after iteration-2-start (history continues)", async () => {
      await appendAudit(projectRoot, {
        ts: 1,
        phase: 17,
        event: "phase-17-complete",
        caller: "user",
      });
      await appendAudit(projectRoot, {
        ts: 2,
        phase: 1,
        event: "iteration-2-start",
        caller: "user",
      });
      expect(await wasPipelineCompleted(projectRoot)).toBe(true);
    });
  });

  describe("extractSpecSection", () => {
    it("throws SpecMissingError when spec.md missing (fallback yasak)", async () => {
      await expect(
        extractSpecSection(projectRoot, "Risks"),
      ).rejects.toThrow(SpecMissingError);
    });

    it("throws SpecSectionMissingError when heading not found", async () => {
      await mkdir(join(projectRoot, ".mycl"), { recursive: true });
      await writeFile(
        join(projectRoot, ".mycl/spec.md"),
        "# Title\n\n## Scope\n\nA scope\n",
      );
      await expect(
        extractSpecSection(projectRoot, "Risks"),
      ).rejects.toThrow(SpecSectionMissingError);
    });

    it("extracts body until next `## ` heading", async () => {
      await mkdir(join(projectRoot, ".mycl"), { recursive: true });
      await writeFile(
        join(projectRoot, ".mycl/spec.md"),
        `# Title\n\n## Scope\n\nMy scope.\n\n## Acceptance Criteria\n\n- AC1\n- AC2\n\n## Risks\n\nrisk body\n`,
      );
      const ac = await extractSpecSection(projectRoot, "Acceptance Criteria");
      expect(ac).toBe("- AC1\n- AC2");
      const risks = await extractSpecSection(projectRoot, "Risks");
      expect(risks).toBe("risk body");
    });

    it("case-insensitive heading match", async () => {
      await mkdir(join(projectRoot, ".mycl"), { recursive: true });
      await writeFile(
        join(projectRoot, ".mycl/spec.md"),
        "# Title\n\n## Acceptance Criteria\n\n- AC1\n",
      );
      const s = await extractSpecSection(projectRoot, "acceptance criteria");
      expect(s).toBe("- AC1");
    });
  });

  // v15.7 (2026-05-25): tail-read helper for large audit logs
  describe("readAuditLogTail", () => {
    it("ENOENT (dosya yok) → boş array", async () => {
      const events = await readAuditLogTail(projectRoot, 100);
      expect(events).toEqual([]);
    });

    it("küçük dosya (<100 KB) → full read fallback + tail slice", async () => {
      // 5 event yaz, tail(3) son 3'ü dönsün
      for (let i = 0; i < 5; i++) {
        await appendAudit(projectRoot, {
          ts: 1000 + i,
          phase: 1,
          event: `event-${i}`,
          caller: "user",
        });
      }
      const events = await readAuditLogTail(projectRoot, 3);
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.event)).toEqual(["event-2", "event-3", "event-4"]);
    });

    it("büyük dosya (>100 KB) → tail offset read; partial line drop", async () => {
      // 1000 fsync'li appendAudit timeout yapar — direkt writeFile ile simule
      await mkdir(join(projectRoot, ".mycl"), { recursive: true });
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++) {
        lines.push(
          JSON.stringify({
            ts: 1000 + i,
            phase: 1,
            event: `event-${i.toString().padStart(4, "0")}`,
            caller: "user",
            detail: "x".repeat(80), // satır boyutunu büyüt → toplam ~150 KB
          }),
        );
      }
      await writeFile(
        join(projectRoot, ".mycl/audit.log"),
        lines.join("\n") + "\n",
      );
      const events = await readAuditLogTail(projectRoot, 50);
      // Son 50 event dönmeli (tail logic biraz fazla okuyabilir, slice(-50) keser)
      expect(events.length).toBe(50);
      // Son event mutlaka dahil
      expect(events[events.length - 1]?.event).toBe("event-0999");
      // Hiçbir event partial / bozuk parse değil
      for (const e of events) {
        expect(e.ts).toBeTypeOf("number");
        expect(e.event).toMatch(/^event-\d{4}$/);
      }
    });

    it("maxLines parametresi sınırlamayı uygular", async () => {
      for (let i = 0; i < 10; i++) {
        await appendAudit(projectRoot, {
          ts: 1000 + i,
          phase: 1,
          event: `event-${i}`,
          caller: "user",
        });
      }
      const tail3 = await readAuditLogTail(projectRoot, 3);
      const tail7 = await readAuditLogTail(projectRoot, 7);
      expect(tail3).toHaveLength(3);
      expect(tail7).toHaveLength(7);
    });
  });

  describe("decisions (ADR)", () => {
    it("appendDecision + readDecisions roundtrip preserves all fields", async () => {
      const rec: DecisionRecord = {
        ts: 1717000000000,
        phase: 4,
        iteration: 2,
        title: "Survey CRUD spec",
        context: "In: create/list/respond. Out: analytics dashboard.",
        alternatives_considered: ["full analytics", "realtime sync"],
        chosen: "Survey CRUD spec",
        reason: "Analytics deferred to a later iteration per brief.",
      };
      await appendDecision(projectRoot, rec);
      const back = await readDecisions(projectRoot);
      expect(back).toHaveLength(1);
      expect(back[0]).toEqual(rec);
    });

    it("appendDecision is append-only across multiple records", async () => {
      await appendDecision(projectRoot, {
        ts: 1, phase: 3, iteration: 1, title: "Brief",
        context: "scope", alternatives_considered: [], chosen: "phases [4,8,9]",
        reason: "no UI implied",
      });
      await appendDecision(projectRoot, {
        ts: 2, phase: 7, iteration: 1, title: "DB schema",
        context: "3 tables", alternatives_considered: [], chosen: "DB schema", reason: "",
      });
      const back = await readDecisions(projectRoot);
      expect(back.map((d) => d.phase)).toEqual([3, 7]);
    });

    it("readDecisions returns [] when no file exists", async () => {
      expect(await readDecisions(projectRoot)).toEqual([]);
    });

    it("formatDecisions: empty → explicit sentinel; populated → compact lines", () => {
      expect(formatDecisions([])).toMatch(/no prior decisions/i);
      const out = formatDecisions([
        { ts: 1, phase: 3, iteration: 2, title: "Brief", context: "c",
          alternatives_considered: [], chosen: "phases [4,8]", reason: "no UI implied" },
      ]);
      expect(out).toContain("Phase 3 (iter 2)");
      expect(out).toContain("phases [4,8]");
      expect(out).toContain("no UI implied");
    });
  });

  describe("handoffs (Missions yapılandırılmış devir)", () => {
    it("appendHandoff kaydı .mycl/handoffs.jsonl'a yazar (tüm alanlar)", async () => {
      const rec: HandoffRecord = {
        ts: 1717000000000,
        phase: 8,
        iteration: 2,
        status: "fail",
        summary: "AC coverage yetersiz: 2/3 green",
        discovered: ["testsiz kabul kriterleri: AC3"],
      };
      await appendHandoff(projectRoot, rec);
      const raw = await readFile(
        join(projectRoot, ".mycl", "handoffs.jsonl"),
        "utf-8",
      );
      expect(JSON.parse(raw.trim())).toEqual(rec);
    });

    it("append-only (çok kayıt, sıra korunur)", async () => {
      await appendHandoff(projectRoot, {
        ts: 1, phase: 8, iteration: 1, status: "complete", summary: "green=3",
      });
      await appendHandoff(projectRoot, {
        ts: 2, phase: 8, iteration: 2, status: "fail", summary: "x",
      });
      const lines = await readHandoffs(projectRoot);
      expect(lines.map((d) => d.status)).toEqual(["complete", "fail"]);
    });

    it("readHandoffs roundtrip + dosya yoksa []", async () => {
      expect(await readHandoffs(projectRoot)).toEqual([]); // henüz yok
      const rec: HandoffRecord = {
        ts: 5, phase: 8, iteration: 1, status: "complete", summary: "ok",
      };
      await appendHandoff(projectRoot, rec);
      expect(await readHandoffs(projectRoot)).toEqual([rec]);
    });
  });

  describe("wtf / gotcha (Cichra karar-yakalama)", () => {
    it("appendWtf + readWtf roundtrip; dosya yoksa []", async () => {
      expect(await readWtf(projectRoot)).toEqual([]);
      const rec: WtfRecord = {
        ts: 9,
        location: "src/api/orders.ts",
        note: "Bu sıralama LSH bucket mantığına dayanıyor — bitmask'leri bozma.",
      };
      await appendWtf(projectRoot, rec);
      expect(await readWtf(projectRoot)).toEqual([rec]);
    });

    it("location opsiyonel + append-only sıra", async () => {
      await appendWtf(projectRoot, { ts: 1, note: "tuzak 1" });
      await appendWtf(projectRoot, { ts: 2, note: "tuzak 2" });
      const all = await readWtf(projectRoot);
      expect(all.map((w) => w.note)).toEqual(["tuzak 1", "tuzak 2"]);
      expect(all[0].location).toBeUndefined();
    });
  });

  // FIX D (YZLLM 2026-07-01: "kabul edilen bulgu bir daha sorulmasın"): kalıcı kabul deposu roundtrip.
  describe("accepted-findings (KALICI kabul deposu)", () => {
    it("appendAcceptedFinding + readAcceptedFindings roundtrip; dosya yoksa []", async () => {
      expect(await readAcceptedFindings(projectRoot)).toEqual([]);
      const rec: AcceptedFinding = {
        ts: 42,
        scope: "tech-debt",
        file: "routes/ui.js",
        category: "hardcoded_credential",
        snippet: 'password: "devseed12345"',
        reason: "kasıtlı dev-login seed",
      };
      await appendAcceptedFinding(projectRoot, rec);
      expect(await readAcceptedFindings(projectRoot)).toEqual([rec]);
    });

    it("append-only sıra + reason opsiyonel", async () => {
      await appendAcceptedFinding(projectRoot, {
        ts: 1, scope: "tech-debt", file: "a.js", category: "empty_catch", snippet: "catch {}",
      });
      await appendAcceptedFinding(projectRoot, {
        ts: 2, scope: "tech-debt", file: "b.js", category: "todo_comment", snippet: "// TODO",
      });
      const all = await readAcceptedFindings(projectRoot);
      expect(all.map((a) => a.file)).toEqual(["a.js", "b.js"]);
      expect(all[0].reason).toBeUndefined();
    });
  });

  describe("costs (per-phase tokens)", () => {
    it("appendCost + readCosts roundtrip preserves fields", async () => {
      const rec: CostRecord = {
        ts: 1717000000000,
        phase: 8,
        iteration: 1,
        turns: 12,
        input_tokens: 90000,
        output_tokens: 4000,
        cache_read_input_tokens: 60000,
        cache_creation_input_tokens: 8000,
      };
      await appendCost(projectRoot, rec);
      const back = await readCosts(projectRoot);
      expect(back).toEqual([rec]);
    });

    it("appendCost is append-only; readCosts returns [] when absent", async () => {
      expect(await readCosts(projectRoot)).toEqual([]);
      await appendCost(projectRoot, {
        ts: 1, phase: 1, iteration: 1, turns: 2,
        input_tokens: 100, output_tokens: 50,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      });
      await appendCost(projectRoot, {
        ts: 2, phase: 4, iteration: 1, turns: 3,
        input_tokens: 200, output_tokens: 80,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      });
      const back = await readCosts(projectRoot);
      expect(back.map((c) => c.phase)).toEqual([1, 4]);
    });
  });
});
