import { describe, expect, it } from "vitest";
import { runMultiAgentSelection } from "../src/module-parallel/select.js";
import type { MyclConfig } from "../src/config.js";

describe("runMultiAgentSelection — fail-closed", () => {
  it("flag KAPALI → used:false, LLM/codegen çağrılmaz (normal akış)", async () => {
    const config = {
      claude_code_flags: { multi_agent_selection: false },
    } as unknown as MyclConfig;
    const r = await runMultiAgentSelection(config, "iki bağımsız modül yap", "/tmp/yok");
    expect(r.used).toBe(false);
    expect(r.reason).toContain("kapalı");
  });
});
