// pipeline-e2e — uçtan uca orkestrasyon entegrasyon testi (v15.8, 2026-05-31).
//
// GERÇEK `advanceToNextPhase` motorunu Faz 2→17 boyunca sürer: LLM (runTurn) +
// classifyProjectType + mekanik exec MOCK'lu; kullanıcıya sorulan askq'lar
// (scope-confirm + faz onayları) test tarafından OTOMATİK cevaplanır.
//
// KAPSAM (dürüst): orkestrasyon glue'sunu kanıtlar — faz geçişleri, scope-confirm,
// scope-skip (5/6/7/8), mekanik 10-17, artefakt yazımı (spec/brief/decisions/cost).
// LLM çıktı KALİTESİNİ değil. Faz 1 (intent bootstrap) handleUserMessage yolundan
// girer (advanceToNextPhase inline işlemez) → testte intent ön-set edilir.
// Codegen 5/8 + UI-review 6 bilinçli scope-skip: Phase 5'te gerçek bir bug var
// (observer phase:5 yazıyor, kontrol phase:6 arıyor) + dev-server spawn; Phase 6
// deferred döngüyü durdurur. Bunlar ayrı ele alınır.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

// --- mock'lar (vitest hoist eder) ---
const runTurnMock = vi.fn();
vi.mock("../../src/claude-api.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runTurn: (...a: unknown[]) => runTurnMock(...a),
}));

vi.mock("../../src/translator.js", () => ({
  translate: vi.fn(async (_cfg: unknown, text: string) => ({ text })),
}));

// Phase 2 classifyProjectType ayrı SDK çağrısı yapar → sabit sonuç döndür.
vi.mock("../../src/project-type-classifier.js", () => ({
  classifyProjectType: vi.fn(async () => ({
    project_type: "web",
    confidence: "high",
    reason: "test",
  })),
  shouldSkipUiPhases: vi.fn(() => false),
}));

// Mekanik fazlar (10-17) exec ile çalışır → her zaman başarı (code 0).
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  exec: (_cmd: string, opts: unknown, cb?: unknown) => {
    const done = (typeof opts === "function" ? opts : cb) as (
      e: null,
      r: { stdout: string; stderr: string },
    ) => void;
    done(null, { stdout: "", stderr: "" });
  },
}));

// ipc: emitAskq dışında GERÇEK (beginPhaseCost/takePhaseCost/recordTokenUsage gerçek kalmalı).
const askqQueue: Array<{ id: string; options: string[] }> = [];
vi.mock("../../src/ipc.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    emitAskq: vi.fn((o: { id: string; options: string[] }) => {
      askqQueue.push({ id: o.id, options: o.options.map(String) });
    }),
  };
});

import {
  advanceToNextPhase,
  handleAskqAnswer,
  __initRuntimeForTest,
} from "../../src/index.js";
import { loadOrInit, save as saveState } from "../../src/state.js";
import { appendAudit, readAuditLog, readDecisions, readCosts } from "../../src/audit.js";
import { recordTokenUsage } from "../../src/ipc.js";
import type { MyclConfig } from "../../src/config.js";

const usage = { input_tokens: 120, output_tokens: 60 };
let turnSeq = 0;
const written = new Set<string>();

function toolTurn(name: string, input: Record<string, unknown>) {
  const id = `tu_${name}_${turnSeq++}`;
  return {
    assistantContent: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    usage,
    toolUses: [{ id, name, input }],
  };
}
function endTurn() {
  return {
    assistantContent: [{ type: "text", text: "done" }],
    stop_reason: "end_turn",
    usage,
    toolUses: [],
  };
}

function dispatch(turnOpts: { tools?: Array<{ name: string }> }) {
  const names = (turnOpts.tools ?? []).map((t) => t.name);
  let res: ReturnType<typeof toolTurn> | ReturnType<typeof endTurn>;
  if (names.includes("request_intent_approval")) {
    res = toolTurn("request_intent_approval", { summary: "Build a small backend utility." });
  } else if (names.includes("complete_precision_audit")) {
    res = toolTurn("complete_precision_audit", { enriched_summary: "Refined intent.", dimensions: [] });
  } else if (names.includes("write_brief") && !written.has("brief")) {
    written.add("brief");
    res = toolTurn("write_brief", {
      title: "Backend utility", summary: "A small backend logic change.",
      tags: [], stakeholders: [], constraints: [],
      needed_optional_phases: [], // 5/6/7/8 scope-skip
      needed_optional_phases_reason: "Backend-only logic; no UI/DB this iteration.",
    });
  } else if (names.includes("request_brief_approval")) {
    res = toolTurn("request_brief_approval", { pitch: "Brief ready." });
  } else if (names.includes("write_spec") && !written.has("spec")) {
    written.add("spec");
    res = toolTurn("write_spec", {
      title: "Backend utility spec", scope: "Backend logic only; no UI.",
      acceptance_criteria: [{ id: "AC1", statement: "Function returns the computed value." }],
      out_of_scope: ["UI"], risks: [{ title: "edge cases", detail: "empty input" }],
    });
  } else if (names.includes("request_spec_approval")) {
    res = toolTurn("request_spec_approval", { pitch: "Spec ready." });
  } else if (names.includes("complete_risk_review")) {
    res = toolTurn("complete_risk_review", { summary: "No blocking risks.", decisions: [] });
  } else {
    res = endTurn();
  }
  recordTokenUsage(res.usage); // gerçek per-faz kovasını doldur (cost.jsonl)
  return res;
}

describe("pipeline e2e (Faz 2→17, mock LLM + oto-askq)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-e2e-"));
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "tmp", scripts: { test: "exit 0", lint: "exit 0" } }),
    );
    runTurnMock.mockReset();
    runTurnMock.mockImplementation(async (_c, _k, turnOpts) => dispatch(turnOpts));
    askqQueue.length = 0;
    turnSeq = 0;
    written.clear();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("drives the real advanceToNextPhase engine through 2→17 with auto-answered askq", async () => {
    const state = await loadOrInit(projectRoot);
    // Faz 1 (intent) ayrı yoldan girer; testte tamamlanmış varsay.
    state.current_phase = 1;
    state.intent_summary = "Build a small backend utility function.";
    await saveState(state);
    await appendAudit(projectRoot, { ts: Date.now(), phase: 1, event: "phase-1-complete", caller: "mycl-orchestrator" });

    const config = {
      selected_models: { translator: "m", main: "m", orchestrator: "m", relevance: "m" },
      api_keys: { translator: "k", main: "k", orchestrator: "k", relevance: "k" },
      claude_code_flags: { betas: [], effort: "high" },
      features: { claude_code_cli_enabled: false },
    } as unknown as MyclConfig;

    __initRuntimeForTest(state, config);

    // Faz 2'den sür; askq'ları (scope-confirm + onaylar) options[0] ile oto-cevapla.
    // Gerçek-zaman pump: pipeline fsync'li yazımlar yapar, setImmediate'tan hızlı
    // tüketip yarıda kesmemek için setTimeout + wall-clock deadline kullan.
    advanceToNextPhase(1).catch((e) => console.error("ADVANCE(1) REJECT:", e));

    let reached17 = false;
    const deadline = Date.now() + 25_000;
    while (!reached17 && Date.now() < deadline) {
      while (askqQueue.length) {
        const a = askqQueue.shift()!;
        handleAskqAnswer(a.id, a.options[0] ?? "Onayla").catch((e) =>
          console.error("ASKQ REJECT:", a.id, e),
        );
      }
      await new Promise((r) => setTimeout(r, 5));
      const events = await readAuditLog(projectRoot);
      reached17 = events.some((e) => e.event === "phase-17-complete");
    }

    const events = await readAuditLog(projectRoot);
    const has = (ev: string) => events.some((e) => e.event === ev);
    // Bazı fazlar sıfır-padded yazar (örn. "phase-09-complete"); ikisini de kabul et.
    const hasComplete = (n: number) =>
      has(`phase-${n}-complete`) || has(`phase-0${n}-complete`);

    // Tam geçiş zinciri 2→17 (her faz phase-N-complete yazar).
    for (let n = 2; n <= 17; n++) {
      expect(hasComplete(n), `phase-${n}-complete bekleniyor`).toBe(true);
    }
    // Opsiyonel fazlar (5/6/7/8) scope ile atlandı.
    for (const n of [5, 6, 7, 8]) {
      expect(has(`phase-${n}-skipped-by-scope`), `phase-${n}-skipped-by-scope bekleniyor`).toBe(true);
    }
    // Part B: kararlar yazıldı (Faz 3 brief + Faz 4 spec).
    const decisions = await readDecisions(projectRoot);
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    expect(decisions.some((d) => d.phase === 4)).toBe(true);
    // Part A: per-faz token kayıtları yazıldı (LLM fazları 2/3/4/9).
    const costs = await readCosts(projectRoot);
    expect(costs.length).toBeGreaterThanOrEqual(1);
    expect(costs.every((c) => c.input_tokens > 0)).toBe(true);
  }, 30_000);
});
