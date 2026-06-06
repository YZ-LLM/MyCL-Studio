import { beforeEach, describe, expect, it, vi } from "vitest";

// runClaudeCli'yi mock'la (gerçek claude spawn etme) — classifier testiyle aynı desen.
const cliMock = vi.fn();
vi.mock("../src/cli-run.js", () => ({ runClaudeCli: (...a: unknown[]) => cliMock(...a) }));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runHypothesisInvestigations } from "../src/hypothesis-investigation.js";
import type { MyclConfig } from "../src/config.js";

const cfg = {
  selected_models: { main: "claude-main", model_tiers: { balanced: "claude-bal" } },
  claude_code_flags: { effort: "high" },
} as unknown as MyclConfig;

describe("runHypothesisInvestigations", () => {
  beforeEach(() => cliMock.mockReset());

  it("3 mercek geçerli hypothesis bloğu → 3 etiketli sonuç", async () => {
    cliMock.mockResolvedValue({
      ok: true,
      text: `{"kind":"hypothesis","text":"stale state in store"}`,
      toolUses: [],
      turns: 3,
    });
    const out = await runHypothesisInvestigations(cfg, "/tmp/proj", "Login fails", "errors+blame");
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^\[state-data\] /);
    expect(out.join()).toContain("stale state in store");
    expect(cliMock).toHaveBeenCalledTimes(3);
  });

  it("Read/Grep/Glob/Bash izinli + Write yasak + cwd=projectRoot + balanced tier", async () => {
    cliMock.mockResolvedValue({ ok: true, text: `{"kind":"hypothesis","text":"x"}`, toolUses: [], turns: 1 });
    await runHypothesisInvestigations(cfg, "/tmp/proj", "bug", "ev");
    const opts = cliMock.mock.calls[0][0];
    expect(opts.allowedTools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(opts.disallowedTools).toEqual(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    expect(opts.cwd).toBe("/tmp/proj");
    // hypothesis rolü → balanced tier → model_tiers.balanced
    expect(opts.modelId).toBe("claude-bal");
    expect(opts.timeoutMs).toBeGreaterThan(0);
  });

  it("başarısız/bloksuz mercekler atlanır (fail-soft)", async () => {
    cliMock
      .mockResolvedValueOnce({ ok: true, text: `{"kind":"hypothesis","text":"a"}`, toolUses: [], turns: 1 })
      .mockResolvedValueOnce({ ok: false, text: "", toolUses: [], turns: 0, error: "boom" })
      .mockResolvedValueOnce({ ok: true, text: "düz metin, json yok", toolUses: [], turns: 1 });
    const out = await runHypothesisInvestigations(cfg, "/tmp/proj", "bug", "ev");
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("[state-data] a");
  });

  it("boş evidence → '(none gathered)' user message'a girer", async () => {
    cliMock.mockResolvedValue({ ok: true, text: `{"kind":"hypothesis","text":"x"}`, toolUses: [], turns: 1 });
    await runHypothesisInvestigations(cfg, "/tmp/proj", "bug", "");
    expect(cliMock.mock.calls[0][0].userMessage).toContain("(none gathered)");
  });

  it("boş text bloğu → atlanır", async () => {
    cliMock.mockResolvedValue({ ok: true, text: `{"kind":"hypothesis","text":"   "}`, toolUses: [], turns: 1 });
    const out = await runHypothesisInvestigations(cfg, "/tmp/proj", "bug", "ev");
    expect(out).toHaveLength(0);
  });
});
