// cli-interactive-loop — interaktif CLI döngüsü (cli-session mock'lu, gerçek spawn yok).

import { describe, expect, it, vi, beforeEach } from "vitest";

const sessionMock = vi.fn();
vi.mock("../src/cli-session.js", () => ({
  runClaudeCliSession: (...a: unknown[]) => sessionMock(...a),
}));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  runInteractiveCliLoop,
  InteractiveCliError,
} from "../src/cli-interactive-loop.js";

const base = {
  sessionId: "sess-1",
  modelId: "claude-opus-4-8",
  cwd: "/tmp/p",
  systemPrompt: "SYS",
  initialUserMessage: "görev",
  maxTurns: 8,
  terminalKinds: ["complete", "approval", "abandon"] as const,
  askqKind: "askq",
  label: "cli-test",
};

function ok(text: string) {
  return { ok: true, text, toolUses: [], turns: 1 };
}

beforeEach(() => sessionMock.mockReset());

describe("runInteractiveCliLoop", () => {
  it("tek-atış terminal blok → döner, resume yok", async () => {
    sessionMock.mockResolvedValueOnce(ok(`{"kind":"complete","summary_en":"ok"}`));
    const onAskq = vi.fn();
    const out = await runInteractiveCliLoop({ ...base, onAskq });
    expect(out).toEqual({ kind: "complete", summary_en: "ok" });
    expect(sessionMock).toHaveBeenCalledTimes(1);
    expect(sessionMock.mock.calls[0][0].resume).toBe(false);
    expect(onAskq).not.toHaveBeenCalled();
  });

  it("askq → cevap → resume → terminal (çok turlu)", async () => {
    sessionMock
      .mockResolvedValueOnce(ok(`{"kind":"askq","question_en":"hangi db?"}`))
      .mockResolvedValueOnce(ok(`{"kind":"approval","pitch_en":"hazır"}`));
    const onAskq = vi.fn(async (_b: Record<string, unknown>) => "Postgres");
    const out = await runInteractiveCliLoop({ ...base, onAskq });
    expect(out.kind).toBe("approval");
    expect(onAskq).toHaveBeenCalledTimes(1);
    expect(onAskq.mock.calls[0][0]).toEqual({ kind: "askq", question_en: "hangi db?" });
    // 1. tur ilk (resume:false), 2. tur resume:true + cevap
    expect(sessionMock).toHaveBeenCalledTimes(2);
    expect(sessionMock.mock.calls[1][0].resume).toBe(true);
    expect(sessionMock.mock.calls[1][0].userMessage).toBe("Postgres");
    // resume turunda systemPrompt geçilmez
    expect(sessionMock.mock.calls[1][0].systemPrompt).toBeUndefined();
  });

  it("blok yok → nudge retry → sonra terminal", async () => {
    sessionMock
      .mockResolvedValueOnce(ok(`burada hiç json yok`))
      .mockResolvedValueOnce(ok(`{"kind":"complete","x":1}`));
    const out = await runInteractiveCliLoop({ ...base, onAskq: vi.fn() });
    expect(out).toEqual({ kind: "complete", x: 1 });
    expect(sessionMock).toHaveBeenCalledTimes(2);
    // nudge turu resume + STRICT_NUDGE mesajı
    expect(sessionMock.mock.calls[1][0].resume).toBe(true);
    expect(String(sessionMock.mock.calls[1][0].userMessage)).toContain("JSON");
  });

  it("nudge sonrası da blok yok → InteractiveCliError", async () => {
    sessionMock.mockResolvedValue(ok(`json yok`));
    await expect(
      runInteractiveCliLoop({ ...base, onAskq: vi.fn() }),
    ).rejects.toBeInstanceOf(InteractiveCliError);
    expect(sessionMock).toHaveBeenCalledTimes(2); // ilk + 1 nudge
  });

  it("CLI turu ok:false → InteractiveCliError (görünür fallback)", async () => {
    sessionMock.mockResolvedValueOnce({ ok: false, text: "", toolUses: [], turns: 0, error: "exit 1" });
    await expect(
      runInteractiveCliLoop({ ...base, onAskq: vi.fn() }),
    ).rejects.toBeInstanceOf(InteractiveCliError);
  });

  it("maxTurns aşılırsa hata (sürekli askq)", async () => {
    sessionMock.mockResolvedValue(ok(`{"kind":"askq","question_en":"q"}`));
    const onAskq = vi.fn(async (_b: Record<string, unknown>) => "cevap");
    await expect(
      runInteractiveCliLoop({ ...base, maxTurns: 3, onAskq }),
    ).rejects.toBeInstanceOf(InteractiveCliError);
    expect(sessionMock).toHaveBeenCalledTimes(3);
  });
});
