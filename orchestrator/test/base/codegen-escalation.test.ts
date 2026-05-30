// codegen-controller — doubt-driven eskalasyon (v15.8, 2026-05-31).
//
// AskUserQuestion tool_use'u executeTool'a GİTMEZ; turn-loop intercept eder,
// mevcut askq tesisatıyla (emitAskq + submitAskqAnswer) kullanıcıya sorar,
// EN cevabı tool_result olarak besler ve döngü sürer. Abort → {kind:"aborted"}.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TurnResult } from "../../src/claude-api.js";

// --- module mock'ları (vitest hoist eder) ---
const runTurnMock = vi.fn();
vi.mock("../../src/claude-api.js", () => ({ runTurn: (...a: unknown[]) => runTurnMock(...a) }));

// translate identity: EN→TR ve TR→EN aynı metni döner (option mapping deterministik).
vi.mock("../../src/translator.js", () => ({
  translate: vi.fn(async (_cfg: unknown, text: string) => ({ text })),
}));

let capturedAskqId = "";
let askqEmitted: (v: unknown) => void;
const askqGate = new Promise((res) => { askqEmitted = res; });
vi.mock("../../src/ipc.js", () => ({
  emitAskq: vi.fn((o: { id: string }) => { capturedAskqId = o.id; askqEmitted(null); }),
  emitChatMessage: vi.fn(),
  emitClaudeStream: vi.fn(),
  emitError: vi.fn(),
}));

vi.mock("../../src/history.js", () => ({
  loadHistory: vi.fn(async () => []),
  saveHistoryStep: vi.fn(async () => {}),
  clearHistory: vi.fn(async () => {}),
}));

vi.mock("../../src/tool-handlers.js", () => ({
  executeTool: vi.fn(async () => ({ content: "ok", is_error: false })),
}));

vi.mock("../../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { CodegenBaseController } from "../../src/base/codegen-controller.js";

function makeOpts() {
  return {
    tag: "phase-8",
    phaseId: 8 as const,
    state: { project_root: "/tmp/p", iteration_count: 1 } as never,
    config: { claude_code_flags: {} } as never,
    systemPrompt: "sys",
    modelId: "m",
    apiKey: "k",
    initialUserMessage: "go",
    tools: [],
    toolContext: { project_root: "/tmp/p" } as never,
  };
}

const usage = { input_tokens: 0, output_tokens: 0 };
const askTurn: TurnResult = {
  assistantContent: [{ type: "text", text: "I must escalate." }],
  stop_reason: "tool_use",
  usage,
  toolUses: [{ id: "tu1", name: "AskUserQuestion", input: { question: "X or Y?", options: ["X", "Y"] } }],
};
const endTurn: TurnResult = {
  assistantContent: [{ type: "text", text: "done" }],
  stop_reason: "end_turn",
  usage,
  toolUses: [],
};

describe("codegen escalation (AskUserQuestion)", () => {
  beforeEach(() => {
    runTurnMock.mockReset();
    capturedAskqId = "";
  });

  it("escalation round-trip: askq emitted → submit → answer fed back → done", async () => {
    let secondTurnMessages: unknown[] = [];
    runTurnMock
      .mockImplementationOnce(async () => askTurn)
      .mockImplementationOnce(async (_c, _k, turnOpts: { messages: unknown[] }) => {
        secondTurnMessages = [...turnOpts.messages]; // snapshot (array sonradan mutate olur)
        return endTurn;
      });

    const ctrl = new CodegenBaseController(makeOpts());
    const runPromise = ctrl.run();
    await askqGate; // emitAskq fired → askq pending
    ctrl.submitAskqAnswer(capturedAskqId, "X"); // user picked TR option "X" (identity)

    const outcome = await runPromise;
    expect(outcome.kind).toBe("done");

    // 2. turn'e beslenen son user mesajı, eskalasyon cevabını tool_result olarak taşımalı.
    const lastUser = secondTurnMessages.at(-1) as { role: string; content: Array<Record<string, unknown>> };
    expect(lastUser.role).toBe("user");
    const tr = lastUser.content.find((b) => b.type === "tool_result");
    expect(tr?.tool_use_id).toBe("tu1");
    expect(tr?.content).toBe("X");
  });

  it("abort during pending escalation → {kind:'aborted'}", async () => {
    runTurnMock.mockImplementation(async () => askTurn);
    const ctrl = new CodegenBaseController(makeOpts());
    const runPromise = ctrl.run();
    // emitAskq zaten round-trip testinde resolve oldu; yeni gate için kısa bekle.
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    const outcome = await runPromise;
    expect(outcome.kind).toBe("aborted");
  });
});
