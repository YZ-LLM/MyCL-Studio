// agent-memory/store — append/read roundtrip + isolation tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendProjectMemory,
  appendAgentDecisionLog,
  appendGeneralMemory,
  readProjectMemory,
  readAgentDecisionLog,
} from "../../src/agent-memory/store.js";
import { log } from "../../src/logger.js";
import type {
  AgentMemoryEntry,
  AgentDecisionLogEntry,
} from "../../src/agent-memory/types.js";

describe("agent-memory/store · project memory", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-mem-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("append + read roundtrip preserves entry", async () => {
    const entry: AgentMemoryEntry = {
      ts: 1779600000000,
      topic_slug: "user-auth",
      type: "project",
      summary: "JWT-based auth eklendi",
      user_text: "auth ekle",
      decision_action: "develop_new_or_iter",
      affected_files: ["src/api/auth.ts"],
      affected_db_tables: ["users", "sessions"],
      affected_algorithms: ["JWT", "bcrypt"],
      change_description: "Login + logout + refresh endpoint",
      confirmed_at: 1779600005000,
    };
    await appendProjectMemory(projectRoot, entry);
    const read = await readProjectMemory(projectRoot);
    expect(read).toHaveLength(1);
    // v15.6: enrichRecord _schema_v + _record_ts ekler — toMatchObject (subset)
    expect(read[0]).toMatchObject(entry);
  });

  it("returns empty array when file missing", async () => {
    const read = await readProjectMemory(projectRoot);
    expect(read).toEqual([]);
  });

  it("multiple appends preserve order", async () => {
    for (let i = 0; i < 5; i++) {
      await appendProjectMemory(projectRoot, {
        ts: 1779600000000 + i,
        topic_slug: `topic-${i}`,
        type: "project",
        summary: `entry ${i}`,
        user_text: `text ${i}`,
        decision_action: "chat",
        confirmed_at: 1779600000000 + i,
      });
    }
    const read = await readProjectMemory(projectRoot);
    expect(read).toHaveLength(5);
    expect(read.map((e) => e.topic_slug)).toEqual([
      "topic-0",
      "topic-1",
      "topic-2",
      "topic-3",
      "topic-4",
    ]);
  });

  it("limit returns last N entries", async () => {
    for (let i = 0; i < 10; i++) {
      await appendProjectMemory(projectRoot, {
        ts: i,
        topic_slug: `t${i}`,
        type: "project",
        summary: `${i}`,
        user_text: `${i}`,
        decision_action: "chat",
        confirmed_at: i,
      });
    }
    const last3 = await readProjectMemory(projectRoot, 3);
    expect(last3).toHaveLength(3);
    expect(last3.map((e) => e.topic_slug)).toEqual(["t7", "t8", "t9"]);
  });
});

describe("agent-memory/store · decision log", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-dec-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("append + read decision log", async () => {
    const entry: AgentDecisionLogEntry = {
      ts: 1779600000000,
      user_text: "login ekle",
      topic_slug: "user-auth",
      action: "develop_new_or_iter",
      reason: "Yeni feature isteği — auth.",
      confirmed: true,
    };
    await appendAgentDecisionLog(projectRoot, entry);
    const read = await readAgentDecisionLog(projectRoot);
    expect(read).toHaveLength(1);
    // v15.6: enrichRecord metadata — subset match
    expect(read[0]).toMatchObject(entry);
  });

  it("limit param son N entry", async () => {
    for (let i = 0; i < 25; i++) {
      await appendAgentDecisionLog(projectRoot, {
        ts: i,
        user_text: `t${i}`,
        topic_slug: `s${i}`,
        action: "chat",
        reason: `r${i}`,
        confirmed: true,
      });
    }
    const last5 = await readAgentDecisionLog(projectRoot, 5);
    expect(last5).toHaveLength(5);
    expect(last5[0].topic_slug).toBe("s20");
    expect(last5[4].topic_slug).toBe("s24");
  });
});

// v15.6 (2026-05-24): genel hafıza cross-project sızıntı koruması.
// Credential pattern yakalandığında log.warn'a düşmeli ama write block olmamalı.
describe("agent-memory/store · general memory credential warning (v15.6)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("temiz entry → warn YOK + write OK", async () => {
    const entry: AgentMemoryEntry = {
      ts: Date.now(),
      topic_slug: "form-validation",
      type: "general",
      summary: "Zod + react-hook-form pattern, prod-grade form validation.",
      user_text: "form validation pattern",
      decision_action: "save_memory_proposal",
      confirmed_at: Date.now(),
    };
    await appendGeneralMemory(entry);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("sk- key içeren entry → warn", async () => {
    const entry: AgentMemoryEntry = {
      ts: Date.now(),
      topic_slug: "leaky",
      type: "general",
      summary: "Uses sk-ant-api03-abcdefghijklmnop1234567890XYZ for auth.",
      user_text: "auth setup",
      decision_action: "save_memory_proposal",
      confirmed_at: Date.now(),
    };
    await appendGeneralMemory(entry);
    expect(warnSpy).toHaveBeenCalled();
    const call = warnSpy.mock.calls[0];
    expect(call?.[2]).toMatchObject({ matched: expect.arrayContaining(["anthropic/openai-key"]) });
  });

  it("password=xxx içeren entry → warn", async () => {
    const entry: AgentMemoryEntry = {
      ts: Date.now(),
      topic_slug: "leaky2",
      type: "general",
      summary: "Login pattern; admin password=hunter2letmein for testing.",
      user_text: "login",
      decision_action: "save_memory_proposal",
      confirmed_at: Date.now(),
    };
    await appendGeneralMemory(entry);
    expect(warnSpy).toHaveBeenCalled();
  });
});
