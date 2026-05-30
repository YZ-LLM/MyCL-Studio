import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbandonedIntentError,
  appendAbandonedIntent,
  digestAbandonedIntents,
  readAbandonedIntents,
  type AbandonedIntent,
} from "../src/abandoned-intents.js";

describe("abandoned-intents", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-abandoned-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("append → read roundtrip preserves entry", async () => {
    const entry: AbandonedIntent = {
      ts: 1778878979000,
      iteration: 2,
      phase: 2,
      intent: "add dark mode toggle",
      concerns: ["theme system absent", "perf cost"],
      reason: "user not ready for design system rewrite",
    };
    await appendAbandonedIntent(projectRoot, entry);
    const back = await readAbandonedIntents(projectRoot);
    expect(back).toHaveLength(1);
    // v15.6: enrichRecord _schema_v + _record_ts ekler — toMatchObject (subset)
    expect(back[0]).toMatchObject(entry);
  });

  it("two appends produce two entries in order", async () => {
    const a: AbandonedIntent = {
      ts: 1,
      iteration: 1,
      phase: 2,
      intent: "a",
      concerns: [],
      reason: "ra",
    };
    const b: AbandonedIntent = {
      ts: 2,
      iteration: 2,
      phase: 2,
      intent: "b",
      concerns: ["c1"],
      reason: "rb",
    };
    await appendAbandonedIntent(projectRoot, a);
    await appendAbandonedIntent(projectRoot, b);
    const back = await readAbandonedIntents(projectRoot);
    expect(back).toHaveLength(2);
    // v15.6: enrichRecord metadata — subset match her element için
    expect(back[0]).toMatchObject(a);
    expect(back[1]).toMatchObject(b);
  });

  it("missing file returns empty array (not an error)", async () => {
    expect(await readAbandonedIntents(projectRoot)).toEqual([]);
  });

  it("corrupt JSON line throws AbandonedIntentError (no silent fallback)", async () => {
    await mkdir(join(projectRoot, ".mycl"), { recursive: true });
    await writeFile(
      join(projectRoot, ".mycl", "abandoned-intents.jsonl"),
      '{"ts":1,"iteration":1,"phase":2,"intent":"good","concerns":[],"reason":"r"}\nnot-json{{{\n',
    );
    await expect(readAbandonedIntents(projectRoot)).rejects.toThrow(
      AbandonedIntentError,
    );
  });

  it("digest for empty project returns '(none)'", async () => {
    expect(await digestAbandonedIntents(projectRoot)).toBe("(none)");
  });

  it("digest with entries contains intent + concerns + reason", async () => {
    await appendAbandonedIntent(projectRoot, {
      ts: Date.UTC(2026, 4, 15),
      iteration: 2,
      phase: 2,
      intent: "feature x with many concerns and detail",
      concerns: ["data mismatch", "perf"],
      reason: "user rejected after seeing concerns",
    });
    const d = await digestAbandonedIntents(projectRoot);
    expect(d).toContain("Iter 2");
    expect(d).toContain("feature x");
    expect(d).toContain("data mismatch");
    expect(d).toContain("user rejected");
  });

  it("digest with max=2 trims to most recent two entries", async () => {
    for (let i = 1; i <= 4; i++) {
      await appendAbandonedIntent(projectRoot, {
        ts: i * 1000,
        iteration: i,
        phase: 2,
        intent: `intent-${i}`,
        concerns: [],
        reason: `reason-${i}`,
      });
    }
    const d = await digestAbandonedIntents(projectRoot, 2);
    expect(d).toContain("intent-3");
    expect(d).toContain("intent-4");
    expect(d).not.toContain("intent-1");
    expect(d).not.toContain("intent-2");
  });
});
