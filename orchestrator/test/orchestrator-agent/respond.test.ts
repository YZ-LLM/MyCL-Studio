// respond — orkestratör backend seam yönlendirmesi (v15.8).
//
// CliOrchestratorBackend + OrchestratorAgent + isClaudeAvailable mock'lu; gerçek
// backendForRole kullanılır. Yönlendirme + SDK-fallback davranışı doğrulanır.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MyclConfig, AgentBackend } from "../../src/config.js";
import type { State } from "../../src/types.js";
import type { AgentDecision } from "../../src/orchestrator-agent/decision.js";

const cliRespond = vi.fn();
const sdkRespond = vi.fn();

vi.mock("../../src/orchestrator-agent/cli-orchestrator.js", () => ({
  CliOrchestratorBackend: class {
    constructor(_c: unknown, _s: unknown) {}
    respond(t: string) {
      return cliRespond(t);
    }
  },
}));
vi.mock("../../src/orchestrator-agent/agent.js", () => ({
  OrchestratorAgent: class {
    constructor(_o: unknown) {}
    respond(t: string) {
      return sdkRespond(t);
    }
  },
}));
let claudeAvail = true;
vi.mock("../../src/codegen/cli-backend.js", () => ({
  isClaudeAvailable: () => claudeAvail,
}));
vi.mock("../../src/ipc.js", () => ({
  emitChatMessage: vi.fn(),
  emitError: vi.fn(),
}));
vi.mock("../../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { respondAsOrchestrator } from "../../src/orchestrator-agent/respond.js";

function makeConfig(orchestrator: AgentBackend): MyclConfig {
  return {
    selected_models: { translator: "s", main: "o", orchestrator: "o" },
    api_keys: { translator: "k", main: "k" },
    claude_code_flags: { effort: "max", betas: [] },
    agent_backends: { orchestrator, translator: "api", main: "api" },
    features: {},
    timeouts_ms: { translator: 30000, claude_subprocess_spawn: 10000, claude_first_event: 60000 },
  } as unknown as MyclConfig;
}

const state = { project_root: "/tmp/proj", current_phase: 1 } as unknown as State;
const chatDecision: AgentDecision = { action: "chat", reason: "ok" };

beforeEach(() => {
  cliRespond.mockReset();
  sdkRespond.mockReset();
  claudeAvail = true;
});

describe("respondAsOrchestrator", () => {
  it("orchestrator='api' → SDK kullanır, CLI'a dokunmaz", async () => {
    sdkRespond.mockResolvedValue(chatDecision);
    const dec = await respondAsOrchestrator(makeConfig("api"), state, "selam");
    expect(dec).toBe(chatDecision);
    expect(sdkRespond).toHaveBeenCalledTimes(1);
    expect(cliRespond).not.toHaveBeenCalled();
  });

  it("orchestrator='cli' + claude var → CLI kullanır, SDK'a dokunmaz", async () => {
    cliRespond.mockResolvedValue(chatDecision);
    const dec = await respondAsOrchestrator(makeConfig("cli"), state, "selam");
    expect(dec).toBe(chatDecision);
    expect(cliRespond).toHaveBeenCalledTimes(1);
    expect(sdkRespond).not.toHaveBeenCalled();
  });

  it("orchestrator='cli' + CLI fırlatır → SDK fallback", async () => {
    cliRespond.mockRejectedValue(new Error("cli karar veremedi"));
    sdkRespond.mockResolvedValue(chatDecision);
    const dec = await respondAsOrchestrator(makeConfig("cli"), state, "selam");
    expect(dec).toBe(chatDecision);
    expect(cliRespond).toHaveBeenCalledTimes(1);
    expect(sdkRespond).toHaveBeenCalledTimes(1);
  });

  it("orchestrator='cli' ama claude YOK → görünür hata + THROW (sessiz SDK YOK)", async () => {
    claudeAvail = false;
    sdkRespond.mockResolvedValue(chatDecision);
    await expect(respondAsOrchestrator(makeConfig("cli"), state, "selam")).rejects.toThrow();
    // Sessizce SDK'ya düşmedi.
    expect(cliRespond).not.toHaveBeenCalled();
    expect(sdkRespond).not.toHaveBeenCalled();
  });
});
