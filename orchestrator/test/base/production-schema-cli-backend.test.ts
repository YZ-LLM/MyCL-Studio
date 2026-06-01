// production-schema-cli-backend — Faz 3/4/7 CLI backend (cli-session mock'lu).
// Gerçek spawn yok; write→approval→onay akışı + factory yönlendirmesi test edilir.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { MyclConfig } from "../../src/config.js";
import type { State } from "../../src/types.js";
import type { ProductionRunOpts } from "../../src/base/production-schema-controller.js";

const sessionMock = vi.fn();
vi.mock("../../src/cli-session.js", () => ({
  runClaudeCliSession: (...a: unknown[]) => sessionMock(...a),
}));
let claudeAvail = true;
vi.mock("../../src/codegen/cli-backend.js", () => ({
  isClaudeAvailable: () => claudeAvail,
}));
let lastAskqId: string | null = null;
let onAskqEmitted: (() => void) | null = null;
vi.mock("../../src/ipc.js", () => ({
  emitAskq: vi.fn((o: { id: string }) => {
    lastAskqId = o.id;
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
  localizeOptionLabels: (en: string[]) => en, // passthrough → tr==en
  t: () => "",
}));
vi.mock("../../src/audit.js", () => ({ appendAudit: vi.fn() }));
vi.mock("../../src/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ProductionSchemaCliBackend,
  createProductionSchemaBackend,
} from "../../src/base/production-schema-cli-backend.js";
import { ProductionSchemaBaseController } from "../../src/base/production-schema-controller.js";

function ok(text: string) {
  return { ok: true, text, toolUses: [], turns: 1 };
}

async function makeOpts(): Promise<ProductionRunOpts> {
  const root = await mkdtemp(join(tmpdir(), "prod-cli-"));
  const config = {
    selected_models: { translator: "m", main: "m" },
    api_keys: { translator: "k", main: "k" },
    claude_code_flags: { effort: "high", betas: [] },
    agent_backends: { orchestrator: "api", translator: "api", main: "cli" },
  } as unknown as MyclConfig;
  const state = { project_root: root } as unknown as State;
  return {
    tag: "phase-3",
    phaseId: 3,
    state,
    config,
    systemPrompt: "SYS",
    modelId: "m",
    apiKey: "k",
    initialUserMessage: "Begin.",
    tools: [
      {
        name: "write_brief",
        description: "write",
        input_schema: { type: "object", required: ["title", "summary"], properties: {} },
      },
      { name: "request_brief_approval", description: "ap", input_schema: { type: "object" } },
    ],
    production: {
      write_tool_name: "write_brief",
      approval_tool_name: "request_brief_approval",
      output_artifact_path: "brief.md",
    } as unknown as ProductionRunOpts["production"],
    artifactRenderer: (input) => `MD:${JSON.stringify(input)}`,
  };
}

/** run() başlat; askq emit edilince cevapla; outcome'u döndür. */
async function runAndAnswer(
  backend: { run: () => Promise<unknown>; submitAskqAnswer: (id: string, tr: string) => void },
  answer: string,
): Promise<unknown> {
  const emitted = new Promise<void>((r) => (onAskqEmitted = r));
  const p = backend.run();
  await emitted;
  onAskqEmitted = null;
  backend.submitAskqAnswer(lastAskqId!, answer);
  return p;
}

beforeEach(() => {
  sessionMock.mockReset();
  claudeAvail = true;
  lastAskqId = null;
  onAskqEmitted = null;
});

describe("ProductionSchemaCliBackend.run", () => {
  it("write → approval → Approve → approved (writeInput + dosya yazıldı)", async () => {
    sessionMock
      .mockResolvedValueOnce(ok(`{"kind":"write","title":"T","summary":"S","tags":["x"]}`))
      .mockResolvedValueOnce(ok(`{"kind":"approval","pitch_en":"hazır"}`));
    const opts = await makeOpts();
    const backend = new ProductionSchemaCliBackend(opts);
    const out = (await runAndAnswer(backend, "Approve")) as {
      kind: string;
      writeInput: Record<string, unknown>;
      artifact_path: string;
    };
    expect(out.kind).toBe("approved");
    expect(out.writeInput).toEqual({ title: "T", summary: "S", tags: ["x"] });
    // Dosya gerçekten yazıldı (renderer çıktısı).
    const md = await readFile(join(opts.state.project_root, "brief.md"), "utf-8");
    expect(md).toContain("MD:");
    expect(md).toContain('"title":"T"');
    // 1. tur ilk (resume false), 2. tur resume (approval iste)
    expect(sessionMock.mock.calls[0][0].resume).toBe(false);
    expect(sessionMock.mock.calls[1][0].resume).toBe(true);
    // Write izni VERİLMEZ (dosyayı MyCL yazar)
    expect(sessionMock.mock.calls[0][0].disallowedTools).toContain("Write");
  });

  it("Cancel → cancelled", async () => {
    sessionMock
      .mockResolvedValueOnce(ok(`{"kind":"write","title":"T","summary":"S"}`))
      .mockResolvedValueOnce(ok(`{"kind":"approval","pitch_en":"p"}`));
    const backend = new ProductionSchemaCliBackend(await makeOpts());
    const out = (await runAndAnswer(backend, "Cancel")) as { kind: string };
    expect(out.kind).toBe("cancelled");
  });

  it("Revise → yeni write → Approve → approved (güncel writeInput)", async () => {
    sessionMock
      .mockResolvedValueOnce(ok(`{"kind":"write","title":"v1","summary":"S"}`))
      .mockResolvedValueOnce(ok(`{"kind":"approval","pitch_en":"p1"}`))
      .mockResolvedValueOnce(ok(`{"kind":"write","title":"v2","summary":"S2"}`))
      .mockResolvedValueOnce(ok(`{"kind":"approval","pitch_en":"p2"}`));
    const backend = new ProductionSchemaCliBackend(await makeOpts());
    // 1. approval'da Revise, 2. approval'da Approve
    const emitted1 = new Promise<void>((r) => (onAskqEmitted = r));
    const p = backend.run();
    await emitted1;
    const id1 = lastAskqId!;
    const emitted2 = new Promise<void>((r) => (onAskqEmitted = r));
    backend.submitAskqAnswer(id1, "Revise");
    await emitted2;
    onAskqEmitted = null;
    backend.submitAskqAnswer(lastAskqId!, "Approve");
    const out = (await p) as { kind: string; writeInput: Record<string, unknown> };
    expect(out.kind).toBe("approved");
    expect(out.writeInput).toEqual({ title: "v2", summary: "S2" });
  });

  it("eksik zorunlu alan → nudge (askq açılmaz), sonra tam write → approval", async () => {
    sessionMock
      .mockResolvedValueOnce(ok(`{"kind":"write","title":"T"}`)) // summary eksik
      .mockResolvedValueOnce(ok(`{"kind":"write","title":"T","summary":"S"}`))
      .mockResolvedValueOnce(ok(`{"kind":"approval","pitch_en":"p"}`));
    const backend = new ProductionSchemaCliBackend(await makeOpts());
    const out = (await runAndAnswer(backend, "Approve")) as { kind: string };
    expect(out.kind).toBe("approved");
    // 3 oturum turu: eksik-write, tam-write, approval
    expect(sessionMock).toHaveBeenCalledTimes(3);
    expect(String(sessionMock.mock.calls[1][0].userMessage)).toContain("summary");
  });

  it("CLI turu ok:false → failed", async () => {
    sessionMock.mockResolvedValueOnce({ ok: false, text: "", toolUses: [], turns: 0, error: "exit 1" });
    const backend = new ProductionSchemaCliBackend(await makeOpts());
    const out = (await backend.run()) as { kind: string };
    expect(out.kind).toBe("failed");
  });
});

describe("createProductionSchemaBackend (factory)", () => {
  it("main=cli + claude var → CLI backend", async () => {
    claudeAvail = true;
    const b = createProductionSchemaBackend(await makeOpts());
    expect(b).toBeInstanceOf(ProductionSchemaCliBackend);
  });

  it("main=cli + claude YOK → görünür fail backend (run→failed, SDK değil)", async () => {
    claudeAvail = false;
    const b = createProductionSchemaBackend(await makeOpts());
    expect(b).not.toBeInstanceOf(ProductionSchemaCliBackend);
    expect(b).not.toBeInstanceOf(ProductionSchemaBaseController);
    const out = (await b.run()) as { kind: string };
    expect(out.kind).toBe("failed");
  });

  it("main=api → SDK ProductionSchemaBaseController", async () => {
    const opts = await makeOpts();
    (opts.config as unknown as { agent_backends: Record<string, string> }).agent_backends.main = "api";
    const b = createProductionSchemaBackend(opts);
    expect(b).toBeInstanceOf(ProductionSchemaBaseController);
  });
});
