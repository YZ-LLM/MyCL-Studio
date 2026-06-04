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

// Phase 5 dev-server zinciri (codegen-dahil test için) — gerçek server/watcher/browser yerine sahte.
vi.mock("../../src/dev-server-launcher.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  tryDevServerChain: vi.fn(async () => ({
    ok: true,
    cmd: "npm run dev",
    handle: { pid: 99999, port: 5173, stdout: null, stderr: null },
    attempts: [],
  })),
  openBrowser: vi.fn(),
}));
vi.mock("../../src/runtime-error-watcher.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  replaceActiveWatcher: vi.fn(),
}));
vi.mock("../../src/vite-runtime-injector.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureViteRuntimeInjection: vi.fn(async () => {}),
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
import { computeVerdict } from "../../src/harness-verdict.js";
import type { MyclConfig } from "../../src/config.js";
import type { AuditEvent } from "../../src/types.js";

const usage = { input_tokens: 120, output_tokens: 60 };
let turnSeq = 0;
const written = new Set<string>();
let neededForTest: number[] = []; // write_brief'in önereceği opsiyonel fazlar
let p5Step = 0; // Phase 5 codegen turn sayacı
let p8Step = 0; // Phase 8 codegen turn sayacı

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

function dispatch(turnOpts: { tools?: Array<{ name: string }>; system?: string }) {
  const names = (turnOpts.tools ?? []).map((t) => t.name);
  const sys = String(turnOpts.system ?? "");
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
      needed_optional_phases: neededForTest, // [] → 5-8 skip; [5,8] → codegen koşar
      needed_optional_phases_reason: "Test scope.",
    });
  } else if (names.includes("request_brief_approval")) {
    res = toolTurn("request_brief_approval", { pitch: "Brief ready." });
  } else if (names.includes("write_spec") && !written.has("spec")) {
    written.add("spec");
    res = toolTurn("write_spec", {
      title: "Backend utility spec", scope: "Backend logic with a small UI.",
      acceptance_criteria: [{ id: "AC1", statement: "Function returns the computed value." }],
      out_of_scope: ["analytics"], risks: [{ title: "edge cases", detail: "empty input" }],
    });
  } else if (names.includes("request_spec_approval")) {
    res = toolTurn("request_spec_approval", { pitch: "Spec ready." });
  } else if (names.includes("complete_risk_review")) {
    res = toolTurn("complete_risk_review", { summary: "No blocking risks.", decisions: [] });
  } else if (names.includes("Write")) {
    // Faz 5 (UI Build) ile Faz 8 (TDD) ayrımı: "UI Build" yalnızca phase-05'te var
    // ("TDD" her iki prompt'ta da geçiyor — güvenilmez).
    if (sys.includes("UI Build")) {
      // Phase 5 (UI codegen): bir UI dosyası yaz → bitir.
      if (p5Step < 1) { p5Step++; res = toolTurn("Write", { file_path: "src/App.tsx", content: "export default function App(){return null}" }); }
      else res = endTurn();
    } else {
      // Phase 8 (TDD codegen): test yaz → prod yaz (temiz) → 3× bash test (green) → bitir.
      if (p8Step < 1) { p8Step++; res = toolTurn("Write", { file_path: "src/foo.test.ts", content: "// test stub" }); }
      else if (p8Step < 2) { p8Step++; res = toolTurn("Write", { file_path: "src/foo.ts", content: "export const foo = () => 1;\n" }); }
      else if (p8Step < 5) { p8Step++; res = toolTurn("Bash", { command: "npm test" }); }
      else res = endTurn();
    }
  } else {
    res = endTurn();
  }
  recordTokenUsage(res.usage); // gerçek per-faz kovasını doldur (cost.jsonl)
  return res;
}

describe("pipeline e2e (Faz 2→17, mock LLM + oto-askq)", () => {
  let projectRoot: string;
  // Fire-and-forget advanceToNextPhase promise'i — teardown'dan ÖNCE settle
  // edilir ki trailing yazımlar (cost flush / pipeline-end summary) `rm` ile
  // yarışıp ENOTEMPTY vermesin.
  let advancePromise: Promise<unknown> | null = null;

  beforeEach(async () => {
    advancePromise = null;
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-e2e-"));
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "tmp", scripts: { dev: "vite", test: "exit 0", lint: "exit 0" } }),
    );
    runTurnMock.mockReset();
    runTurnMock.mockImplementation(async (_c, _k, turnOpts) => dispatch(turnOpts));
    askqQueue.length = 0;
    turnSeq = 0;
    neededForTest = [];
    p5Step = 0;
    p8Step = 0;
    written.clear();
  });

  afterEach(async () => {
    // Arka plan pipeline TAM bitsin (trailing cost/audit/decisions yazımları) →
    // `rm` ile yarışmasın. Tüm-gate yükünde (45 test paraleli, event loop doygun)
    // settle GEÇ olabilir → cömert cap (15s; pipeline phase-17'de zaten biter).
    if (advancePromise) {
      await Promise.race([advancePromise, new Promise((r) => setTimeout(r, 15_000))]);
    }
    // Fire-and-forget kalan yazımlar için AGRESİF retry: node ENOTEMPTY/EBUSY'de
    // retryDelay backoff'uyla 10 kez dener. Yine de tüm-gate yükünde nadir ENOTEMPTY
    // olabilir — teardown cleanup'ı best-effort: assertion'lar zaten geçti, /tmp
    // artığı (OS temizler) yüzünden testi KIRMA. Hatayı yut + logla (sessiz değil).
    try {
      await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    } catch (err) {
      console.warn(`[e2e teardown] rm best-effort başarısız (yok sayıldı): ${String(err)}`);
    }
  });

  // Faz 1'i (intent) tamamlanmış varsayıp Faz 2'den gerçek motoru sürer; askq'ları
  // (scope-confirm + onaylar) options[0] ile oto-cevaplar. phase-17-complete'e kadar pompala.
  async function driveFromPhase1(): Promise<AuditEvent[]> {
    const state = await loadOrInit(projectRoot);
    state.current_phase = 1;
    state.intent_summary = "Build a small backend utility function.";
    await saveState(state);
    await appendAudit(projectRoot, { ts: Date.now(), phase: 1, event: "phase-1-complete", caller: "mycl-orchestrator" });

    const config = {
      selected_models: { translator: "m", main: "m", orchestrator: "m", relevance: "m" },
      api_keys: { translator: "k", main: "k", orchestrator: "k", relevance: "k" },
      claude_code_flags: { betas: [], effort: "high" },
      agent_backends: { orchestrator: "api", translator: "api", main: "api" },
      features: { claude_code_cli_enabled: false },
    } as unknown as MyclConfig;

    __initRuntimeForTest(state, config);
    // Gerçek-zaman pump (fsync'li yazımlar setImmediate'tan yavaş; setTimeout + deadline).
    // Promise yakalanır → afterEach trailing yazımları settle eder (teardown yarışı yok).
    advancePromise = advanceToNextPhase(1).catch((e) => console.error("ADVANCE(1) REJECT:", e));
    let reached17 = false;
    // Tüm-gate yükünde (50 test paraleli, event loop doygun) fsync'li pipeline
    // 35s'i aşıp flake olabiliyordu → 50s cap (normal koşum ~2-5s; bu sadece tavan).
    const deadline = Date.now() + 50_000;
    while (!reached17 && Date.now() < deadline) {
      while (askqQueue.length) {
        const a = askqQueue.shift()!;
        handleAskqAnswer(a.id, a.options[0] ?? "Onayla").catch((e) =>
          console.error("ASKQ REJECT:", a.id, e),
        );
      }
      await new Promise((r) => setTimeout(r, 5));
      reached17 = (await readAuditLog(projectRoot)).some((e) => e.event === "phase-17-complete");
    }
    // Trailing yazımlar (cost flush / pipeline-end summary) tamamlansın ki
    // decisions/cost assertion'ları tam veri görsün (bounded — hang yok).
    await Promise.race([advancePromise, new Promise((r) => setTimeout(r, 3000))]);
    return readAuditLog(projectRoot);
  }

  const hasIn = (events: AuditEvent[], ev: string) => events.some((e) => e.event === ev);
  const hasComplete = (events: AuditEvent[], n: number) =>
    hasIn(events, `phase-${n}-complete`) || hasIn(events, `phase-0${n}-complete`);

  it("spine: 2→17 tam geçiş, 5/6/7/8 scope-skip, decisions + cost yazıldı", async () => {
    neededForTest = []; // opsiyonel fazlar atlanır
    const events = await driveFromPhase1();

    for (let n = 2; n <= 17; n++) {
      expect(hasComplete(events, n), `phase-${n}-complete bekleniyor`).toBe(true);
    }
    for (const n of [5, 6, 7, 8]) {
      expect(hasIn(events, `phase-${n}-skipped-by-scope`), `phase-${n}-skipped-by-scope`).toBe(true);
    }
    const decisions = await readDecisions(projectRoot);
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    expect(decisions.some((d) => d.phase === 4)).toBe(true);
    const costs = await readCosts(projectRoot);
    expect(costs.length).toBeGreaterThanOrEqual(1);
    expect(costs.every((c) => c.input_tokens > 0)).toBe(true);
    // Headless harness verdict'i: tüm gate'ler yeşil (mock exec code 0) → PASS.
    // Bu, harness-verdict'in GERÇEK pipeline audit'i üzerinde doğru çalıştığının kanıtı.
    const v = computeVerdict(events);
    expect(v.verdict, JSON.stringify(v.gateFailures)).toBe("PASS");
    expect(v.completed).toBe(true);
    expect(v.exitCode).toBe(0);
  }, 65_000);

  it("codegen-dahil: Faz 5 (UI) + Faz 8 (TDD) gerçekten koşar (Phase 5 fix doğrulanır)", async () => {
    neededForTest = [5, 8]; // UI build + TDD koşar; 6/7 scope-skip
    const events = await driveFromPhase1();

    for (let n = 2; n <= 17; n++) {
      expect(hasComplete(events, n), `phase-${n}-complete bekleniyor`).toBe(true);
    }
    // Phase 5 KOŞTU (skip değil) + ui-file-write doğrulaması geçti (bug fix kanıtı).
    expect(hasIn(events, "ui-file-write"), "ui-file-write (Phase 5 yazdı)").toBe(true);
    expect(hasComplete(events, 5), "phase-5-complete (fix sonrası geçer)").toBe(true);
    // Phase 8 (TDD codegen) KOŞTU: ≥3 tdd-green.
    const greens = events.filter((e) => e.event === "tdd-green").length;
    expect(greens, "≥3 tdd-green").toBeGreaterThanOrEqual(3);
    expect(hasComplete(events, 8), "phase-8-complete").toBe(true);
    // 6/7 scope ile atlandı.
    for (const n of [6, 7]) {
      expect(hasIn(events, `phase-${n}-skipped-by-scope`), `phase-${n}-skipped-by-scope`).toBe(true);
    }
  }, 65_000);
});
