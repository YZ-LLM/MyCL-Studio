// cli-orchestrator — text-JSON karar çıkarımı + CLI backend respond (v15.8).
//
// extractDecisionJson saf fonksiyon (mock yok). CliOrchestratorBackend.respond:
// runClaudeCli + buildOrchestratorSystemPrompt mock'lu — gerçek spawn/LLM YOK.
// parseAgentDecision GERÇEK (validation paritesi).

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MyclConfig } from "../../src/config.js";
import type { State } from "../../src/types.js";

const runClaudeCliMock = vi.fn();
vi.mock("../../src/cli-run.js", () => ({
  runClaudeCli: (...a: unknown[]) => runClaudeCliMock(...a),
}));
vi.mock("../../src/orchestrator-agent/agent.js", () => ({
  buildOrchestratorSystemPrompt: vi.fn(async () => "SYS PROMPT"),
}));
vi.mock("../../src/ipc.js", () => ({ emitAgentEvent: vi.fn() }));
vi.mock("../../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  extractDecisionJson,
  CliOrchestratorBackend,
  CliOrchestratorError,
} from "../../src/orchestrator-agent/cli-orchestrator.js";

function fence(obj: unknown): string {
  return "```json\n" + JSON.stringify(obj) + "\n```";
}

describe("extractDecisionJson", () => {
  it("```json fenced bloğu çıkarır", () => {
    const out = extractDecisionJson(fence({ action: "chat", reason: "selam" }));
    expect(out).toEqual({ action: "chat", reason: "selam" });
  });

  it("etrafında metin olan fenced bloğu çıkarır", () => {
    const txt = `Araştırdım, durum şu.\n\n${fence({ action: "run_phase", reason: "x", target_phase: 5 })}`;
    expect(extractDecisionJson(txt)).toEqual({
      action: "run_phase",
      reason: "x",
      target_phase: 5,
    });
  });

  it("birden çok fenced blokta SONUNCUYU alır", () => {
    const txt = `${fence({ action: "chat", reason: "ilk" })}\nsonra fikir değişti\n${fence({ action: "cancel_pipeline", reason: "son" })}`;
    expect(extractDecisionJson(txt)).toEqual({
      action: "cancel_pipeline",
      reason: "son",
    });
  });

  it("fence olmadan çıplak { … } nesnesini çıkarır (action içermeli)", () => {
    const txt = `Kararım: {"action":"resume_pipeline","reason":"devam"}`;
    expect(extractDecisionJson(txt)).toEqual({
      action: "resume_pipeline",
      reason: "devam",
    });
  });

  it("string içinde süslü parantez olsa bile parse eder", () => {
    const out = extractDecisionJson(fence({ action: "chat", reason: "şunu {x} yap" }));
    expect(out).toEqual({ action: "chat", reason: "şunu {x} yap" });
  });

  it("JSON yoksa null döner", () => {
    expect(extractDecisionJson("burada hiç json yok, sadece düz metin")).toBeNull();
    expect(extractDecisionJson("")).toBeNull();
  });

  it("bozuk JSON (trailing comma) → null", () => {
    expect(extractDecisionJson('```json\n{"action":"chat",}\n```')).toBeNull();
  });

  it("action alanı olmayan çıplak nesneyi atlar", () => {
    // {"foo":1} action taşımaz → çıplak tarama reddeder → null.
    expect(extractDecisionJson('rastgele {"foo":1} nesne')).toBeNull();
  });
});

// --- CliOrchestratorBackend.respond ---

function makeConfig(): MyclConfig {
  return {
    selected_models: { translator: "claude-sonnet-4-6", main: "claude-opus-4-8", orchestrator: "claude-opus-4-8" },
    api_keys: { translator: "k", main: "k" },
    claude_code_flags: { effort: "max", betas: [] },
    agent_backends: { orchestrator: "cli", translator: "api", main: "api" },
    features: {},
    timeouts_ms: { translator: 30000, claude_subprocess_spawn: 10000, claude_first_event: 60000 },
  } as unknown as MyclConfig;
}

const state = { project_root: "/tmp/proj", current_phase: 1 } as unknown as State;

describe("CliOrchestratorBackend.respond", () => {
  beforeEach(() => runClaudeCliMock.mockReset());

  it("geçerli JSON kararı → AgentDecision döner, CLI bir kez çağrılır", async () => {
    runClaudeCliMock.mockResolvedValue({
      ok: true,
      text: `Düşündüm.\n${fence({ action: "chat", reason: "merhaba" })}`,
      toolUses: [],
      turns: 1,
    });
    const dec = await new CliOrchestratorBackend(makeConfig(), state).respond("selam");
    expect(dec.action).toBe("chat");
    expect(dec.reason).toBe("merhaba");
    expect(runClaudeCliMock).toHaveBeenCalledTimes(1);
    // read-only: Write/Edit disallowed, sadece okuma araçları allowed.
    const opts = runClaudeCliMock.mock.calls[0][0];
    expect(opts.allowedTools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(opts.disallowedTools).toContain("Write");
    expect(opts.disallowedTools).toContain("Edit");
  });

  it("ilk deneme bozuk, ikinci geçerli → nudge ile karar döner (2 çağrı)", async () => {
    runClaudeCliMock
      .mockResolvedValueOnce({ ok: true, text: "karar yok burada", toolUses: [], turns: 1 })
      .mockResolvedValueOnce({
        ok: true,
        text: fence({ action: "run_phase", reason: "faz 16", target_phase: 16 }),
        toolUses: [],
        turns: 1,
      });
    const dec = await new CliOrchestratorBackend(makeConfig(), state).respond("test et");
    expect(dec.action).toBe("run_phase");
    expect(dec.target_phase).toBe(16);
    expect(runClaudeCliMock).toHaveBeenCalledTimes(2);
  });

  it("iki deneme de başarısız → CliOrchestratorError fırlatır", async () => {
    runClaudeCliMock.mockResolvedValue({
      ok: false,
      text: "",
      toolUses: [],
      turns: 0,
      error: "claude exit=1",
    });
    await expect(
      new CliOrchestratorBackend(makeConfig(), state).respond("selam"),
    ).rejects.toBeInstanceOf(CliOrchestratorError);
    expect(runClaudeCliMock).toHaveBeenCalledTimes(2);
  });

  it("geçersiz action (parseAgentDecision reddi) → iki deneme sonrası hata", async () => {
    runClaudeCliMock.mockResolvedValue({
      ok: true,
      text: fence({ action: "teleport", reason: "geçersiz" }),
      toolUses: [],
      turns: 1,
    });
    await expect(
      new CliOrchestratorBackend(makeConfig(), state).respond("selam"),
    ).rejects.toBeInstanceOf(CliOrchestratorError);
    expect(runClaudeCliMock).toHaveBeenCalledTimes(2);
  });
});
