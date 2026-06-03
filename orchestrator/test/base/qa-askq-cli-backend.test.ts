// qa-askq-cli-backend — Faz 1/2/9 CLI backend (cli-session mock'lu, interaktif).

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MyclConfig } from "../../src/config.js";
import type { State } from "../../src/types.js";
import type { QaAskqRunOpts } from "../../src/base/qa-askq-controller.js";

const sessionMock = vi.fn();
vi.mock("../../src/cli-session.js", () => ({
  runClaudeCliSession: (...a: unknown[]) => sessionMock(...a),
}));
let claudeAvail = true;
vi.mock("../../src/codegen/cli-backend.js", () => ({
  isClaudeAvailable: () => claudeAvail,
}));
let lastAskqId: string | null = null;
let lastAskqOpts: { options: string[]; allow_other: boolean } | null = null;
let onAskqEmitted: (() => void) | null = null;
vi.mock("../../src/ipc.js", () => ({
  emitAskq: vi.fn((o: { id: string; options: string[]; allow_other: boolean }) => {
    lastAskqId = o.id;
    lastAskqOpts = { options: o.options, allow_other: o.allow_other };
    onAskqEmitted?.();
  }),
  emitChatMessage: vi.fn(),
  emitClaudeStream: vi.fn(),
  emitError: vi.fn(),
}));
vi.mock("../../src/translator.js", () => ({
  translate: vi.fn(async (_c: unknown, text: string) => ({ text })),
}));
vi.mock("../../src/i18n.js", () => ({
  localizeOptionLabels: (en: string[]) => en,
  t: () => "",
}));
vi.mock("../../src/history-loader.js", () => ({ appendHistory: vi.fn(async () => {}) }));
vi.mock("../../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  CliQaAskqBackend,
  createQaAskqBackend,
} from "../../src/base/qa-askq-cli-backend.js";
import { setAutoAnswerSuggested } from "../../src/auto-answer.js";
import { QaAskqBaseController } from "../../src/base/qa-askq-controller.js";

function ok(text: string) {
  return { ok: true, text, toolUses: [], turns: 1 };
}

function makeOpts(): QaAskqRunOpts {
  const config = {
    selected_models: { translator: "m", main: "m" },
    api_keys: { translator: "k", main: "k" },
    claude_code_flags: { effort: "high", betas: [] },
    agent_backends: { orchestrator: "api", translator: "api", main: "cli" },
  } as unknown as MyclConfig;
  const state = { project_root: "/tmp/x" } as unknown as State;
  return {
    tag: "phase-2",
    state,
    config,
    systemPrompt: "SYS",
    modelId: "m",
    apiKey: "k",
    initialUserMessage: "Begin.",
    tools: [
      { name: "ask_clarifying", description: "c", input_schema: { type: "object" } },
      { name: "complete_audit", description: "a", input_schema: { type: "object" } },
      { name: "abandon_iteration", description: "ab", input_schema: { type: "object" } },
    ],
    askq: {
      approval_tool_name: "complete_audit",
      clarifying_tool_name: "ask_clarifying",
      abandon_tool_name: "abandon_iteration",
      approval_summary_field: "summary",
      max_questions: 6,
    } as unknown as QaAskqRunOpts["askq"],
  };
}

async function answerOnce(
  backend: { submitAskqAnswer: (id: string, tr: string) => void },
  answer: string,
): Promise<void> {
  const emitted = new Promise<void>((r) => (onAskqEmitted = r));
  await emitted;
  onAskqEmitted = null;
  backend.submitAskqAnswer(lastAskqId!, answer);
}

beforeEach(() => {
  sessionMock.mockReset();
  claudeAvail = true;
  lastAskqId = null;
  lastAskqOpts = null;
  onAskqEmitted = null;
  setAutoAnswerSuggested(false); // testler arası sızıntı olmasın
});

describe("CliQaAskqBackend.run", () => {
  it("clarifying → cevap → approval → Approve → approved (approvalInput)", async () => {
    sessionMock
      .mockResolvedValueOnce(ok(`{"kind":"askq","question":"hangi db?","options":["Postgres","MySQL"]}`))
      .mockResolvedValueOnce(ok(`{"kind":"approval","summary":"audit done","score":9}`));
    const backend = new CliQaAskqBackend(makeOpts());
    const p = backend.run();
    await answerOnce(backend, "Postgres"); // clarifying cevabı
    // clarifying askq allow_other=true olmalı
    expect(lastAskqOpts?.allow_other).toBe(true);
    await answerOnce(backend, "Approve"); // approval
    const out = (await p) as { kind: string; approvalInput: Record<string, unknown> };
    expect(out.kind).toBe("approved");
    expect(out.approvalInput).toEqual({ summary: "audit done", score: 9 });
    // clarifying cevabı (Postgres, EN) resume userMessage olarak gitti
    expect(sessionMock.mock.calls[1][0].resume).toBe(true);
    expect(sessionMock.mock.calls[1][0].userMessage).toBe("Postgres");
  });

  it("abandon bloğu → abandoned (askq açılmaz)", async () => {
    sessionMock.mockResolvedValueOnce(ok(`{"kind":"abandon","reason":"scope creep","concerns":["x"]}`));
    const out = (await new CliQaAskqBackend(makeOpts()).run()) as {
      kind: string;
      abandonInput: Record<string, unknown>;
    };
    expect(out.kind).toBe("abandoned");
    expect(out.abandonInput).toEqual({ reason: "scope creep", concerns: ["x"] });
  });

  it("approval → Cancel → cancelled", async () => {
    sessionMock.mockResolvedValueOnce(ok(`{"kind":"approval","summary":"s"}`));
    const backend = new CliQaAskqBackend(makeOpts());
    const p = backend.run();
    await answerOnce(backend, "Cancel");
    expect(((await p) as { kind: string }).kind).toBe("cancelled");
  });

  it("approval → Revise → resume → approval → Approve → approved", async () => {
    sessionMock
      .mockResolvedValueOnce(ok(`{"kind":"approval","summary":"v1"}`))
      .mockResolvedValueOnce(ok(`{"kind":"approval","summary":"v2"}`));
    const backend = new CliQaAskqBackend(makeOpts());
    const p = backend.run();
    await answerOnce(backend, "Revise");
    await answerOnce(backend, "Approve");
    const out = (await p) as { kind: string; approvalInput: Record<string, unknown> };
    expect(out.kind).toBe("approved");
    expect(out.approvalInput).toEqual({ summary: "v2" });
  });

  it("CLI turu ok:false → failed", async () => {
    sessionMock.mockResolvedValueOnce({ ok: false, text: "", toolUses: [], turns: 0, error: "x" });
    expect(((await new CliQaAskqBackend(makeOpts()).run()) as { kind: string }).kind).toBe("failed");
  });

  it("blok yok → nudge → sonra approval", async () => {
    sessionMock
      .mockResolvedValueOnce(ok(`düz metin, json yok`))
      .mockResolvedValueOnce(ok(`{"kind":"approval","summary":"s"}`));
    const backend = new CliQaAskqBackend(makeOpts());
    const p = backend.run();
    await answerOnce(backend, "Approve");
    expect(((await p) as { kind: string }).kind).toBe("approved");
    expect(String(sessionMock.mock.calls[1][0].userMessage)).toContain("JSON");
  });
});

describe("CliQaAskqBackend oto-cevap (saha 3/5)", () => {
  it("ON + öneri var → netleştirme otomatik yanıtlanır (sormaz); resume=öneri", async () => {
    setAutoAnswerSuggested(true);
    try {
      sessionMock
        .mockResolvedValueOnce(
          ok(`{"kind":"askq","question":"hangi db?","options":["Postgres","MySQL"],"suggested_answer":"MySQL"}`),
        )
        .mockResolvedValueOnce(ok(`{"kind":"approval","summary":"done"}`));
      const backend = new CliQaAskqBackend(makeOpts());
      const p = backend.run();
      // Netleştirme otomatik yanıtlandı → manuel cevap GEREKMEZ; yalnız approval'a cevap ver.
      await answerOnce(backend, "Approve");
      expect(((await p) as { kind: string }).kind).toBe("approved");
      // Önerilen cevap ("MySQL") resume userMessage olarak gitti (kullanıcı sorulmadan).
      expect(sessionMock.mock.calls[1][0].userMessage).toBe("MySQL");
    } finally {
      setAutoAnswerSuggested(false);
    }
  });

  it("ON ama öneri YOK → yine kullanıcıya sorulur", async () => {
    setAutoAnswerSuggested(true);
    try {
      sessionMock
        .mockResolvedValueOnce(ok(`{"kind":"askq","question":"q?","options":["A","B"]}`))
        .mockResolvedValueOnce(ok(`{"kind":"approval","summary":"s"}`));
      const backend = new CliQaAskqBackend(makeOpts());
      const p = backend.run();
      await answerOnce(backend, "A"); // öneri yok → normal sorulur (answerOnce gerekli)
      await answerOnce(backend, "Approve");
      expect(((await p) as { kind: string }).kind).toBe("approved");
    } finally {
      setAutoAnswerSuggested(false);
    }
  });
});

describe("createQaAskqBackend (factory)", () => {
  it("main=cli + claude var → CLI backend", () => {
    claudeAvail = true;
    expect(createQaAskqBackend(makeOpts())).toBeInstanceOf(CliQaAskqBackend);
  });
  it("main=cli + claude YOK → görünür fail (run→failed)", async () => {
    claudeAvail = false;
    const b = createQaAskqBackend(makeOpts());
    expect(b).not.toBeInstanceOf(CliQaAskqBackend);
    expect(b).not.toBeInstanceOf(QaAskqBaseController);
    expect(((await b.run()) as { kind: string }).kind).toBe("failed");
  });
  it("main=api → SDK QaAskqBaseController", () => {
    const opts = makeOpts();
    (opts.config as unknown as { agent_backends: Record<string, string> }).agent_backends.main = "api";
    expect(createQaAskqBackend(opts)).toBeInstanceOf(QaAskqBaseController);
  });
});

// v15.9: terminal blok zorunlu-alan doğrulaması + nudge (Faz 2 contract bug fix).
// complete_audit'in required'ı [enriched_summary, dimensions] → ajan generic
// {summary} emit ederse nudge; düzeltirse approved; düzeltmezse görünür fail.
function makeOptsRequired(): QaAskqRunOpts {
  const o = makeOpts();
  o.tools = o.tools.map((t) =>
    t.name === "complete_audit"
      ? {
          ...t,
          input_schema: {
            type: "object",
            required: ["enriched_summary", "dimensions"],
            properties: {
              enriched_summary: { type: "string" },
              dimensions: { type: "array", items: { type: "object" } },
            },
          },
        }
      : t,
  );
  return o;
}

describe("CliQaAskqBackend zorunlu-alan nudge", () => {
  it("approval eksik zorunlu alan → nudge → düzeltme → approved", async () => {
    sessionMock
      .mockResolvedValueOnce(ok(`{"kind":"approval","summary":"audit done"}`)) // eksik
      .mockResolvedValueOnce(
        ok(`{"kind":"approval","enriched_summary":"E","dimensions":[{"name":"SCOPE","decision":"covered"}]}`),
      ); // düzeltilmiş
    const backend = createQaAskqBackend(makeOptsRequired()) as CliQaAskqBackend;
    const p = backend.run();
    await answerOnce(backend, "Approve");
    const out = (await p) as { kind: string; approvalInput: Record<string, unknown> };
    expect(out.kind).toBe("approved");
    expect(out.approvalInput.enriched_summary).toBe("E");
    expect(sessionMock).toHaveBeenCalledTimes(2); // nudge resume edildi
  });

  it("v15.12: nudge'lardan sonra hâlâ eksik → coerce + DEVAM (takılma YOK)", async () => {
    // Ajan 3 turda da eksik blok yazıyor (2 nudge sonrası). Eski davranış: hard-fail.
    // Yeni davranış: coerce (summary→enriched_summary alias, dimensions→[]) + devam.
    sessionMock
      .mockResolvedValueOnce(ok(`{"kind":"approval","summary":"audit x"}`))
      .mockResolvedValueOnce(ok(`{"kind":"approval","summary":"audit x"}`))
      .mockResolvedValueOnce(ok(`{"kind":"approval","summary":"audit x"}`));
    const backend = createQaAskqBackend(makeOptsRequired()) as CliQaAskqBackend;
    const p = backend.run();
    await answerOnce(backend, "Approve");
    const out = (await p) as { kind: string; approvalInput: Record<string, unknown> };
    expect(out.kind).toBe("approved"); // ASLA takılma — coerce + devam
    expect(out.approvalInput.enriched_summary).toBe("audit x"); // alias'tan kurtarıldı
    expect(Array.isArray(out.approvalInput.dimensions)).toBe(true); // coerce → []
  });
});
