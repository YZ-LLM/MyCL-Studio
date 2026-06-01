// translator-backend — translator rolünün backend yönlendirmesi (v15.8).
//
// agent_backends.translator = "cli" → `claude -p` (runClaudeCli); "api" → SDK.
// `claude` yoksa "cli" seçili olsa bile SDK'ya dürüst fallback. Tüm dış bağımlılık
// mock'lu (gerçek spawn / API çağrısı YOK) — saf yönlendirme + tag-strip testi.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MyclConfig, AgentBackend } from "../src/config.js";

const runClaudeCliMock = vi.fn();
vi.mock("../src/cli-run.js", () => ({
  runClaudeCli: (...a: unknown[]) => runClaudeCliMock(...a),
}));

let claudeAvailable = true;
vi.mock("../src/codegen/cli-backend.js", () => ({
  isClaudeAvailable: () => claudeAvailable,
}));

const sdkCreateMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...a: unknown[]) => sdkCreateMock(...a) };
    constructor(_opts: unknown) {}
  },
}));

vi.mock("../src/ipc.js", () => ({
  emitTranslation: vi.fn(),
  emitChatMessage: vi.fn(),
  emitError: vi.fn(),
}));
vi.mock("../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { translate } from "../src/translator.js";

function makeConfig(translatorBackend: AgentBackend): MyclConfig {
  return {
    api_keys: { translator: "sk-test", main: "sk-test" },
    selected_models: { translator: "claude-sonnet-4-6", main: "claude-opus-4-8" },
    claude_code_flags: { effort: "max", betas: [] },
    agent_backends: { orchestrator: "api", translator: translatorBackend, main: "api" },
    features: {},
    timeouts_ms: {
      translator: 30_000,
      claude_subprocess_spawn: 10_000,
      claude_first_event: 60_000,
    },
  } as unknown as MyclConfig;
}

// SDK content yardımcısı — Anthropic.messages.create dönüşü.
function sdkText(text: string) {
  return { content: [{ type: "text", text }] };
}

beforeEach(() => {
  runClaudeCliMock.mockReset();
  sdkCreateMock.mockReset();
  claudeAvailable = true;
});

describe("translate — backend yönlendirme", () => {
  it("translator='cli' + claude var → runClaudeCli kullanır, SDK'ya dokunmaz", async () => {
    runClaudeCliMock.mockResolvedValue({
      ok: true,
      // claude bazen tag'i echo eder — strip edilmeli.
      text: "<text_to_translate>\nMerhaba dünya\n</text_to_translate>",
      toolUses: [],
      turns: 1,
    });

    const res = await translate(makeConfig("cli"), "Hello world", "en-to-tr");

    expect(res.text).toBe("Merhaba dünya");
    expect(res.model).toBe("claude-sonnet-4-6");
    expect(runClaudeCliMock).toHaveBeenCalledTimes(1);
    expect(sdkCreateMock).not.toHaveBeenCalled();

    const opts = runClaudeCliMock.mock.calls[0][0];
    expect(opts.modelId).toBe("claude-sonnet-4-6");
    expect(opts.userMessage).toContain("Hello world");
    expect(opts.userMessage).toContain("<text_to_translate>");
    expect(typeof opts.systemPrompt).toBe("string");
    expect(opts.systemPrompt.length).toBeGreaterThan(0);
    // Translator read-only — tool izni VERİLMEZ.
    expect(opts.allowedTools).toBeUndefined();
  });

  it("translator='cli' ama claude YOK → görünür hata + THROW (sessiz API YOK)", async () => {
    claudeAvailable = false;
    sdkCreateMock.mockResolvedValue(sdkText("Merhaba"));

    await expect(translate(makeConfig("cli"), "Hello", "en-to-tr")).rejects.toThrow();
    // Sessizce API'ye düşmedi: SDK de CLI de çağrılmadı.
    expect(sdkCreateMock).not.toHaveBeenCalled();
    expect(runClaudeCliMock).not.toHaveBeenCalled();
  });

  it("translator='api' → SDK kullanır, CLI'a dokunmaz", async () => {
    sdkCreateMock.mockResolvedValue(sdkText("Selam"));

    const res = await translate(makeConfig("api"), "Hi", "en-to-tr");

    expect(res.text).toBe("Selam");
    expect(sdkCreateMock).toHaveBeenCalledTimes(1);
    expect(runClaudeCliMock).not.toHaveBeenCalled();
  });

  it("CLI sonucu ok=false → hata fırlatır (sessiz boş çeviri yok)", async () => {
    runClaudeCliMock.mockResolvedValue({
      ok: false,
      text: "",
      toolUses: [],
      turns: 0,
      error: "claude exit=1",
    });

    // withExpBackoff gerçek setTimeout sleep'leri (1+2+4+8s) içerir — fake timer
    // ile saniye beklemeden retry zincirini tüketip reddedişi doğrula.
    vi.useFakeTimers();
    try {
      const p = translate(makeConfig("cli"), "Hello", "en-to-tr");
      const assertion = expect(p).rejects.toThrow();
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    // Her retry CLI'ı bir kez dener → SDK'ya sessizce kaçmaz.
    expect(sdkCreateMock).not.toHaveBeenCalled();
    expect(runClaudeCliMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
