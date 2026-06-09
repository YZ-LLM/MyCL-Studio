import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setAgentTraceRoot,
  traceAgentEvent,
  readAgentTrace,
} from "../src/agent-trace.js";

describe("agent-trace (ajan-içi tam iz)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mycl-trace-"));
  });
  afterEach(async () => {
    setAgentTraceRoot(null);
    await rm(dir, { recursive: true, force: true });
  });

  it("kök set DEĞİLken no-op (iz yazmaz)", async () => {
    setAgentTraceRoot(null);
    await traceAgentEvent({ ts: 1, sub: "started", agent_label: "x" });
    expect(await readAgentTrace(dir)).toEqual([]);
  });

  it("setRoot + trace + read roundtrip (tool_use + output)", async () => {
    setAgentTraceRoot(dir);
    await traceAgentEvent({
      ts: 1,
      agent_label: "auth",
      sub: "tool_use",
      tool_name: "Write",
      tool_input: { path: "src/auth/x.ts" },
    });
    await traceAgentEvent({ ts: 2, agent_label: "auth", sub: "output", text: "bitti" });
    const all = await readAgentTrace(dir);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ agent_label: "auth", sub: "tool_use", tool_name: "Write" });
    expect(all[1].text).toBe("bitti");
  });
});
