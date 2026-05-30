import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearHistory,
  HistoryError,
  loadHistory,
  saveHistoryStep,
} from "../src/history.js";
import type { ApiMessage } from "../src/claude-api.js";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "mycl-history-"));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("history — save/load roundtrip", () => {
  it("loadHistory returns [] when file missing", async () => {
    const msgs = await loadHistory(projectRoot, 6);
    expect(msgs).toEqual([]);
  });

  it("save + load roundtrip preserves order", async () => {
    const m1: ApiMessage = { role: "user", content: "Begin Phase 5" };
    const m2: ApiMessage = { role: "assistant", content: "ok" };
    const m3: ApiMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "wrote 100 chars",
        },
      ],
    };
    await saveHistoryStep(projectRoot, 6, m1);
    await saveHistoryStep(projectRoot, 6, m2);
    await saveHistoryStep(projectRoot, 6, m3);
    const loaded = await loadHistory(projectRoot, 6);
    expect(loaded).toHaveLength(3);
    expect(loaded[0]).toEqual(m1);
    expect(loaded[1]).toEqual(m2);
    expect(loaded[2]).toEqual(m3);
  });

  it("phase-isolated: phase 5 history not visible to phase 8", async () => {
    await saveHistoryStep(projectRoot, 6, { role: "user", content: "p6" });
    await saveHistoryStep(projectRoot, 9, { role: "user", content: "p9" });
    const p6 = await loadHistory(projectRoot, 6);
    const p9 = await loadHistory(projectRoot, 9);
    expect(p6).toHaveLength(1);
    expect(p9).toHaveLength(1);
    expect(p6[0].content).toBe("p6");
    expect(p9[0].content).toBe("p9");
  });
});

describe("history — clearHistory", () => {
  it("removes file", async () => {
    await saveHistoryStep(projectRoot, 6, { role: "user", content: "x" });
    expect((await loadHistory(projectRoot, 6)).length).toBe(1);
    await clearHistory(projectRoot, 6);
    expect((await loadHistory(projectRoot, 6)).length).toBe(0);
  });

  it("no-op when file missing (no error)", async () => {
    await clearHistory(projectRoot, 6);
    expect((await loadHistory(projectRoot, 6)).length).toBe(0);
  });
});

describe("history — error paths (fallback YOK)", () => {
  it("throws HistoryError on corrupt JSON line", async () => {
    await mkdir(join(projectRoot, ".mycl"), { recursive: true });
    await writeFile(
      join(projectRoot, ".mycl/phase-history-6.jsonl"),
      `{"role":"user","content":"ok"}\n{ bad json\n`,
    );
    await expect(loadHistory(projectRoot, 6)).rejects.toThrow(HistoryError);
  });
});
