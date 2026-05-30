// agent-quality.test — Orchestrator karar kalitesi metriği.
//
// Production readiness madde 19. Golden test: fixture decision log üzerinde
// computeAgentQuality doğru istatistik üretir mi.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAgentQuality } from "../src/agent-quality.js";

describe("agent-quality", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "mycl-quality-"));
    await mkdir(join(tmpRoot, ".mycl"), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeDecisions(entries: object[]): Promise<void> {
    const path = join(tmpRoot, ".mycl", "agent-decisions.jsonl");
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(path, lines, "utf-8");
  }

  it("boş log: hep 0 döner, NaN guard", async () => {
    const m = await computeAgentQuality(tmpRoot);
    expect(m.total).toBe(0);
    expect(m.confirmed).toBe(0);
    expect(m.confirm_rate).toBe(0);
    expect(m.recent_confirm_rate).toBe(0);
    expect(m.top_rejected_topics).toEqual([]);
  });

  it("karışık log: confirm_rate doğru", async () => {
    await writeDecisions([
      { ts: Date.now(), user_text: "x", topic_slug: "a", action: "chat", reason: "r", confirmed: true },
      { ts: Date.now(), user_text: "y", topic_slug: "a", action: "chat", reason: "r", confirmed: true },
      { ts: Date.now(), user_text: "z", topic_slug: "b", action: "run_phase", reason: "r", confirmed: false },
      { ts: Date.now(), user_text: "w", topic_slug: "b", action: "run_phase", reason: "r", confirmed: false },
    ]);
    const m = await computeAgentQuality(tmpRoot);
    expect(m.total).toBe(4);
    expect(m.confirmed).toBe(2);
    expect(m.confirm_rate).toBe(0.5);
    expect(m.action_distribution).toEqual({ chat: 2, run_phase: 2 });
  });

  it("top_rejected_topics doğru sıralanır", async () => {
    await writeDecisions([
      { ts: Date.now(), user_text: "x", topic_slug: "auth", action: "x", reason: "r", confirmed: false },
      { ts: Date.now(), user_text: "x", topic_slug: "auth", action: "x", reason: "r", confirmed: false },
      { ts: Date.now(), user_text: "x", topic_slug: "auth", action: "x", reason: "r", confirmed: false },
      { ts: Date.now(), user_text: "x", topic_slug: "db", action: "x", reason: "r", confirmed: false },
      { ts: Date.now(), user_text: "x", topic_slug: "auth", action: "x", reason: "r", confirmed: true },
    ]);
    const m = await computeAgentQuality(tmpRoot);
    expect(m.top_rejected_topics[0]).toEqual({ topic_slug: "auth", reject_count: 3 });
    expect(m.top_rejected_topics[1]).toEqual({ topic_slug: "db", reject_count: 1 });
  });

  it("recent_confirm_rate sadece son 7 günü sayar", async () => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    await writeDecisions([
      // Eski: confirmed=false (recent'e dahil değil)
      { ts: tenDaysAgo, user_text: "x", topic_slug: "old", action: "x", reason: "r", confirmed: false },
      { ts: tenDaysAgo, user_text: "x", topic_slug: "old", action: "x", reason: "r", confirmed: false },
      // Yeni: confirmed=true (recent_confirm_rate = 1.0)
      { ts: yesterday, user_text: "x", topic_slug: "new", action: "x", reason: "r", confirmed: true },
      { ts: yesterday, user_text: "x", topic_slug: "new", action: "x", reason: "r", confirmed: true },
    ]);
    const m = await computeAgentQuality(tmpRoot);
    expect(m.confirm_rate).toBe(0.5); // overall 2/4
    expect(m.recent_confirm_rate).toBe(1); // son 7 gün 2/2
  });
});
