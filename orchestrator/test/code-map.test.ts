// code-map — kod haritası (ilk sürüm, sade: yalnız DOSYA ve SENARYO kaydı). Kayıt doğrulaması (bağlamalar kaynak
// değerleriyle birebir geri çıkıyor), faz kapısı koşulu, başka boş projede arama + yerleştirme (üzerine yazmaz, proje
// dışına ve gizli yola yazmaz), harita boşken / isabet yokken bugünkü akış, stack süzgeci.
//
// Gerçek `claude` çağrılmaz: ilgililik puanlaması ve bağlama değeri çağrısı taklit edilir. `MYCL_HOME` geçici klasöre
// yönlendirilir (gerçek ~/.mycl'e dokunulmaz).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { scoreCliMock, runCliMock, chatMock } = vi.hoisted(() => ({
  scoreCliMock: vi.fn(),
  runCliMock: vi.fn(),
  chatMock: vi.fn(),
}));
vi.mock("../src/relevance/classifier.js", async (orig) => ({
  ...(await orig<typeof import("../src/relevance/classifier.js")>()),
  scoreChunksViaCli: scoreCliMock,
}));
vi.mock("../src/subscription-mode.js", () => ({ isSubscriptionMode: () => true, noteSubscriptionSkipOnce: vi.fn() }));
vi.mock("../src/cli-run.js", () => ({ runClaudeCli: runCliMock }));
vi.mock("../src/ipc.js", async (orig) => ({
  ...(await orig<typeof import("../src/ipc.js")>()),
  emitChatMessage: chatMock,
}));
vi.mock("../src/logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  countCodeMapUse,
  latestScenarios,
  listRecords,
  needsRefresh,
  rankHits,
  usageCount,
  placeScenarioFiles,
  prepareFromCodeMap,
  recordCodeMapAfterGate,
  renderTemplate,
  type FileRecord,
  type ScenarioRecord,
} from "../src/code-map.js";
import type { MyclConfig } from "../src/config.js";
import type { State } from "../src/types.js";

const config = {
  selected_models: { translator: "claude-haiku-4-5", main: "m", model_tiers: undefined },
  api_keys: { translator: "", main: "" },
  agent_backends: { orchestrator: "cli", translator: "cli", main: "cli" },
} as unknown as MyclConfig;

let home: string;
let proj: string;
const origHome = process.env.MYCL_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mycl-codemap-home-"));
  proj = await mkdtemp(join(tmpdir(), "mycl-codemap-proj-"));
  process.env.MYCL_HOME = home;
  scoreCliMock.mockReset();
  runCliMock.mockReset();
  chatMock.mockClear();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(proj, { recursive: true, force: true }).catch(() => {});
  if (origHome === undefined) delete process.env.MYCL_HOME;
  else process.env.MYCL_HOME = origHome;
});

function state(root = proj, stack = "node-npm"): State {
  return { project_root: root, stack, iteration_count: 1, intent_summary: "todo list" } as unknown as State;
}

const TODO_STORE = [
  "const TODO_KEY = 'todos';",
  "export function loadTodos() {",
  "  return JSON.parse(localStorage.getItem(TODO_KEY) || '[]');",
  "}",
  "",
].join("\n");
const TODO_VIEW = "import { loadTodos } from './todoStore.js';\nexport const title = 'My Todos';\n";

/** Ajanın iş sonu metni: serbest metin + son code_map bloğu. */
function agentText(report: unknown): string {
  return `Done. All tests pass.\n\n${JSON.stringify({ kind: "code_map", ...(report as object) })}`;
}

const BINDINGS = [
  { name: "entity", description: "item noun (lowercase)", value: "todo" },
  { name: "Entity", description: "item noun (capitalised)", value: "Todo" },
  { name: "storageKey", description: "localStorage key", value: "todos" },
];
const SCENARIO = {
  name: "Persist list in browser",
  description: "Loads and shows items stored in localStorage",
  acceptance_criteria: ["AC1"],
  files: ["src/todoStore.js", "src/todoView.js"],
  bindings: BINDINGS,
};

async function seedFiles(root: string): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "todoStore.js"), TODO_STORE);
  await writeFile(join(root, "src", "todoView.js"), TODO_VIEW);
}

/** Kaynak projede (A) kayıt al. */
async function seedMapFromProjectA(phase = 5, stack = "node-npm", name = SCENARIO.name): Promise<void> {
  const a = await mkdtemp(join(tmpdir(), "mycl-codemap-A-"));
  try {
    await seedFiles(a);
    await recordCodeMapAfterGate({
      state: state(a, stack),
      phase,
      gatePassed: true,
      gatesPassed: [`phase-${phase}-complete`],
      agentText: agentText({ frameworks: ["react"], scenarios: [{ ...SCENARIO, name }] }),
    });
  } finally {
    await rm(a, { recursive: true, force: true });
  }
}

const hit = async (_m: string, _i: string, chunks: Array<{ id: string }>) => chunks.map((c) => ({ ...c, score: 9, reason: "x" }));
const miss = async (_m: string, _i: string, chunks: Array<{ id: string }>) => chunks.map((c) => ({ ...c, score: 2, reason: "x" }));
const bindingReply = {
  ok: true,
  text: JSON.stringify({ kind: "binding_values", values: { entity: "task", Entity: "Task", storageKey: "tasks" } }),
  toolUses: [],
  turns: 1,
};

describe("kayıt — senaryo, dosyaları ve bağlamalarıyla", () => {
  it("bildirimdeki senaryo dosyaları + tek bağlama listesiyle kayda dönüşüyor; dosyalar kaynak değerleriyle BİREBİR geri çıkıyor", async () => {
    await seedFiles(proj);
    const out = await recordCodeMapAfterGate({
      state: state(),
      phase: 5,
      gatePassed: true,
      gatesPassed: ["phase-5-complete: dev server ready"],
      agentText: agentText({ frameworks: ["react"], scenarios: [SCENARIO] }),
    });
    expect(out.rejected).toEqual([]);
    expect(out.recorded).toHaveLength(3); // 2 dosya + 1 senaryo
    const all = await listRecords();
    const scen = all.find((r) => r.level === "scenario") as ScenarioRecord;
    expect(scen.files).toHaveLength(2);
    expect(scen.bindings.map((b) => b.name)).toEqual(["entity", "Entity", "storageKey"]);
    expect(scen.acceptance_criteria).toEqual(["AC1"]);
    expect(scen.provenance.gates_passed).toEqual(["phase-5-complete: dev server ready"]);
    const values = Object.fromEntries(scen.bindings.map((b) => [b.name, b.source_value]));
    // Sıra korunur: senaryodaki ilk dosya store.
    const store = all.find((r) => r.id === scen.files[0]) as FileRecord;
    expect(renderTemplate(store.template, values)).toBe(TODO_STORE);
    expect(renderTemplate(store.path_template, values)).toBe("src/todoStore.js");
    expect(store.path_template).toBe("src/{{mycl:entity}}Store.js");
  });

  it("doğal dille yazılan bağlama adı düzeltilir ('tasks endpoint' → tasks_endpoint); senaryo kaydedilir", async () => {
    await seedFiles(proj);
    const out = await recordCodeMapAfterGate({
      state: state(),
      phase: 5,
      gatePassed: true,
      gatesPassed: ["g"],
      agentText: agentText({
        scenarios: [{ ...SCENARIO, bindings: [{ name: "tasks endpoint", description: "list key", value: "todos" }, { name: "entity", description: "noun", value: "todo" }] }],
      }),
    });
    expect(out.rejected).toEqual([]);
    const scen = (await listRecords()).find((r) => r.level === "scenario") as ScenarioRecord;
    expect(scen.bindings.map((b) => b.name)).toEqual(["tasks_endpoint", "entity"]);
  });

  it("değeri dosyada geçmeyen bağlama atılır, senaryo kalan bağlamalarla kaydedilir, atılan ad iletide (koşu 31)", async () => {
    await seedFiles(proj);
    const out = await recordCodeMapAfterGate({
      state: state(),
      phase: 5,
      gatePassed: true,
      gatesPassed: ["g"],
      agentText: agentText({
        scenarios: [{ ...SCENARIO, bindings: [...SCENARIO.bindings, { name: "route", description: "endpoint", value: "PATCH /api/tasks/:id" }] }],
      }),
    });
    expect(out.rejected).toEqual([]);
    expect(out.dropped_bindings).toEqual([{ key: SCENARIO.name, names: ["route"] }]);
    const scen = (await listRecords()).find((r) => r.level === "scenario") as ScenarioRecord;
    expect(scen.bindings.map((b) => b.name)).toEqual(["entity", "Entity", "storageKey"]);
  });

  it("kapı geçmeden de kayıt alınıyor ve kayıt kapının geçmediğini söylüyor", async () => {
    await seedFiles(proj);
    const out = await recordCodeMapAfterGate({ state: state(), phase: 8, gatePassed: false, gatesPassed: [], agentText: agentText({ scenarios: [SCENARIO] }) });
    expect(out.recorded).toHaveLength(3);
    const scen = (await listRecords()).find((r) => r.level === "scenario") as ScenarioRecord;
    expect(scen.provenance.gate_passed).toBe(false);
  });

  it("güvensiz yol ve gizli dosya reddediliyor, nedeni yazılıyor; geçerli dosya yine kaydediliyor", async () => {
    await seedFiles(proj);
    await writeFile(join(proj, ".env"), "SECRET=1\n");
    await writeFile(join(proj, "src", "key.js"), "export const k = 'sk-ant-abcdefghijklmnop';\n");
    const out = await recordCodeMapAfterGate({
      state: state(),
      phase: 5,
      gatePassed: true,
      gatesPassed: ["g"],
      agentText: agentText({ scenarios: [{ ...SCENARIO, files: ["src/todoStore.js", ".env", "../outside.js", "CLAUDE.md", "src/key.js"] }] }),
    });
    const reasons = out.rejected.map((r) => `${r.key} → ${r.reason}`).join("\n");
    expect(reasons).toMatch(/\.env → güvensiz ya da gizli/);
    expect(reasons).toMatch(/\.\.\/outside\.js → güvensiz ya da gizli/);
    expect(reasons).toMatch(/CLAUDE\.md → güvensiz ya da gizli/);
    expect(reasons).toMatch(/key\.js → .*gizli bilgi kayda girmez/);
    expect(out.recorded).toHaveLength(2); // store + senaryo
  });

  it("ajan bildirim yapmadıysa kayıt yok ve bu görünür yazılıyor", async () => {
    const out = await recordCodeMapAfterGate({ state: state(), phase: 5, gatePassed: true, gatesPassed: ["g"], agentText: "Done." });
    expect(out.noReport).toBe(true);
    expect(chatMock.mock.calls.some((c) => String(c[1]).includes("iş sonu bildirimini (code_map) yapmadı"))).toBe(true);
  });

  it("açılışta stack 'unknown', kayıt anında bildirim dosyası var → kayıt gerçek stack ile yazılır", async () => {
    await seedFiles(proj);
    await writeFile(join(proj, "package.json"), JSON.stringify({ name: "x" }));
    const out = await recordCodeMapAfterGate({ state: state(proj, "unknown"), phase: 5, gatePassed: true, gatesPassed: ["g"], agentText: agentText({ scenarios: [SCENARIO] }) });
    expect(out.recorded.length).toBeGreaterThan(0);
    expect((await listRecords()).every((r) => r.stack === "node-npm")).toBe(true);
  });
});

describe("kullanım sayısı ve seçim sırası", () => {
  it("yerleştirilen senaryonun sayısı kapı geçince 1 artıyor (aynı projede ikinci kez değil), geçmezse artmıyor", async () => {
    await seedMapFromProjectA();
    scoreCliMock.mockImplementation(hit);
    runCliMock.mockResolvedValue(bindingReply);
    const res = await prepareFromCodeMap(state(), config, 5, "A task list stored in the browser");
    expect(res.scenarioId).toBeDefined();
    expect(await countCodeMapUse(state(), 5, res.scenarioId, false)).toBe(false);
    expect(await usageCount(res.scenarioId!)).toBe(0);
    expect(await countCodeMapUse(state(), 5, res.scenarioId, true)).toBe(true);
    expect(await usageCount(res.scenarioId!)).toBe(1);
    expect(await countCodeMapUse(state(), 5, res.scenarioId, true)).toBe(false); // aynı proje + faz: bir kez
    expect(await usageCount(res.scenarioId!)).toBe(1);
    // Kayıt dosyası değişmedi (sayı ayrı dosyada).
    const rec = (await listRecords()).find((r) => r.id === res.scenarioId) as ScenarioRecord;
    expect(rec).not.toHaveProperty("uses");
  });

  it("eşit puanda: önce kapısı geçmiş, sonra kullanımı çok olan, sonra tarihi yeni olan", () => {
    const mk = (id: string, gate: boolean | undefined, created: number) =>
      ({ id, level: "scenario", provenance: { gate_passed: gate, created_at: created } }) as unknown as ScenarioRecord;
    const ranked = rankHits([
      { record: mk("fail-new", false, 300), score: 9, uses: 9 },
      { record: mk("pass-old-few", true, 100), score: 9, uses: 1 },
      { record: mk("pass-new-few", true, 200), score: 9, uses: 1 },
      { record: mk("pass-many", true, 50), score: 9, uses: 5 },
      { record: mk("legacy", undefined, 10), score: 9, uses: 0 }, // eski kayıt: kapı geçti sayılır
      { record: mk("higher-score", false, 1), score: 10, uses: 0 },
    ]);
    expect(ranked.map((h) => h.record.id)).toEqual(["higher-score", "pass-many", "pass-new-few", "pass-old-few", "legacy", "fail-new"]);
  });

  it("aynı projenin aynı senaryosunda kapısı geçmemiş yeni kayıt, kapısı geçmiş eskisini gizlemez", () => {
    const mk = (id: string, gate: boolean, created: number) =>
      ({ id, level: "scenario", name: "X", stack: "node-npm", provenance: { project_root_sha: "p", phase: 5, gate_passed: gate, created_at: created } }) as unknown as ScenarioRecord;
    expect(latestScenarios([mk("pass-old", true, 1), mk("fail-new", false, 2)]).map((r) => r.id)).toEqual(["pass-old"]);
    expect(latestScenarios([mk("pass-old", true, 1), mk("pass-new", true, 3), mk("fail-new", false, 4)]).map((r) => r.id)).toEqual(["pass-new"]);
    expect(latestScenarios([mk("fail-old", false, 1), mk("fail-new", false, 2)]).map((r) => r.id)).toEqual(["fail-new"]);
  });

  it("aynı senaryo ikinci kez kaydedilince iki kayıt da duruyor, yenisi seçiliyor", async () => {
    const a = await mkdtemp(join(tmpdir(), "mycl-codemap-A-"));
    try {
      await seedFiles(a);
      const rec = () => recordCodeMapAfterGate({ state: state(a), phase: 5, gatePassed: true, gatesPassed: ["g"], agentText: agentText({ scenarios: [SCENARIO] }) });
      const first = (await rec()).recorded.find((id) => id.startsWith("scenario-"))!;
      await new Promise((r) => setTimeout(r, 5));
      const second = (await rec()).recorded.find((id) => id.startsWith("scenario-"))!;
      expect(second).not.toBe(first);
      const ids = (await listRecords()).map((r) => r.id);
      expect(ids).toContain(first);
      expect(ids).toContain(second);
      scoreCliMock.mockImplementation(hit);
      runCliMock.mockResolvedValue(bindingReply);
      const res = await prepareFromCodeMap(state(), config, 5, "A task list stored in the browser");
      expect(res.scenarioId).toBe(second);
    } finally {
      await rm(a, { recursive: true, force: true });
    }
  });
});

describe("kod yazmadan önce — başka projede arama ve yerleştirme", () => {
  it("başka bir boş projede aranıp yerleştiriliyor; ajana toplu inceleme talimatı veriliyor", async () => {
    await seedMapFromProjectA();
    scoreCliMock.mockImplementation(hit);
    runCliMock.mockResolvedValue(bindingReply);
    const res = await prepareFromCodeMap(state(), config, 5, "A task list stored in the browser");
    expect(res.placed.map((p) => p.path)).toEqual(["src/taskStore.js", "src/taskView.js"]);
    const store = await readFile(join(proj, "src", "taskStore.js"), "utf8");
    expect(store).toBe(TODO_STORE.split("todo").join("task").split("Todo").join("Task"));
    expect(await readFile(join(proj, "src", "taskView.js"), "utf8")).toBe(
      "import { loadTasks } from './taskStore.js';\nexport const title = 'My Tasks';\n",
    );
    expect(res.promptAddition).toMatch(/review ALL of them together/);
    expect(chatMock.mock.calls.some((c) => String(c[1]).includes("2 dosya yerleştirildi"))).toBe(true);
  });

  it("var olan dosyanın üzerine yazmıyor", async () => {
    await seedMapFromProjectA();
    scoreCliMock.mockImplementation(hit);
    runCliMock.mockResolvedValue(bindingReply);
    await mkdir(join(proj, "src"), { recursive: true });
    await writeFile(join(proj, "src", "taskStore.js"), "// mine\n");
    const res = await prepareFromCodeMap(state(), config, 5, "task list");
    expect(res.placed.map((p) => p.path)).toEqual(["src/taskView.js"]);
    expect(await readFile(join(proj, "src", "taskStore.js"), "utf8")).toBe("// mine\n");
  });

  it("proje dışına ve gizli/talimat yoluna yazmıyor", async () => {
    const mk = (path_template: string): FileRecord =>
      ({ id: `file-${path_template}`, level: "file", path_template, template: "x" }) as unknown as FileRecord;
    const res = await placeScenarioFiles(proj, [mk("../escape.js"), mk(".env"), mk("CLAUDE.md")], {});
    expect(res.placed).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toEqual(["güvensiz ya da gizli yol", "güvensiz ya da gizli yol", "güvensiz ya da gizli yol"]);
    expect(existsSync(join(proj, "..", "escape.js"))).toBe(false);
    expect(existsSync(join(proj, ".env"))).toBe(false);
  });

  it("harita boşken akış bugünküyle aynı: puanlama yok, dosya yok, ek talimat yok", async () => {
    const res = await prepareFromCodeMap(state(), config, 5, "task list");
    expect(res).toEqual({ promptAddition: "", placed: [] });
    expect(scoreCliMock).not.toHaveBeenCalled();
    expect(runCliMock).not.toHaveBeenCalled();
  });

  it("isabet yokken akış bugünküyle aynı: dosya yok, ek talimat yok, bağlama çağrısı yok", async () => {
    await seedMapFromProjectA();
    scoreCliMock.mockImplementation(miss);
    const res = await prepareFromCodeMap(state(), config, 5, "A weather dashboard");
    expect(res).toEqual({ promptAddition: "", placed: [] });
    expect(runCliMock).not.toHaveBeenCalled();
    expect(existsSync(join(proj, "src"))).toBe(false);
  });

  it("başka fazın kaydı yerleştirilmez; projenin kendi kaydı aranmaz", async () => {
    await seedMapFromProjectA(8);
    expect(await prepareFromCodeMap(state(), config, 5, "task list")).toEqual({ promptAddition: "", placed: [] });
    await seedFiles(proj);
    await recordCodeMapAfterGate({ state: state(), phase: 5, gatePassed: true, gatesPassed: ["g"], agentText: agentText({ scenarios: [{ ...SCENARIO, name: "Own" }] }) });
    expect(await prepareFromCodeMap(state(), config, 5, "todo")).toEqual({ promptAddition: "", placed: [] });
    expect(scoreCliMock).not.toHaveBeenCalled();
  });

  it("boş proje, stack 'unknown' → bütün stack'lerde aranır, puanlayıcı adayın stack'ini görür", async () => {
    await seedMapFromProjectA(5, "node-npm");
    scoreCliMock.mockImplementation(hit);
    runCliMock.mockResolvedValue(bindingReply);
    const res = await prepareFromCodeMap(state(proj, "unknown"), config, 5, "A task list stored in the browser");
    expect(res.placed).toHaveLength(2);
    const chunks = scoreCliMock.mock.calls[0]![2] as Array<{ text: string }>;
    expect(chunks[0]!.text).toContain("Stack: node-npm");
  });

  it("stack 'unknown' ama projede kod var → aranmaz, görünür ileti", async () => {
    await seedMapFromProjectA(5, "node-npm");
    await seedFiles(proj);
    expect(await prepareFromCodeMap(state(proj, "unknown"), config, 5, "task list")).toEqual({ promptAddition: "", placed: [] });
    expect(scoreCliMock).not.toHaveBeenCalled();
    expect(chatMock.mock.calls.some((c) => String(c[1]).includes("stack'i bilinmiyor ve projede kod var — aranmadı"))).toBe(true);
  });

  it("stack bilinen projede yalnız aynı stack'in kayıtları aranır", async () => {
    await seedMapFromProjectA(5, "python-pip", "Python store");
    await seedMapFromProjectA(5, "node-npm", "Node store");
    scoreCliMock.mockImplementation(miss);
    await prepareFromCodeMap(state(proj, "node-npm"), config, 5, "store");
    const chunks = scoreCliMock.mock.calls[0]![2] as Array<{ text: string }>;
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("Node store");
    expect(chunks[0]!.text).not.toContain("Stack:");
  });

  it("aynı proje aynı adlı senaryoyu yeniden kaydederse en yenisi aranır; başka projenin aynı adlısı ayrı kalır", async () => {
    const a = await mkdtemp(join(tmpdir(), "mycl-codemap-A-"));
    try {
      await seedFiles(a);
      const rec = () =>
        recordCodeMapAfterGate({ state: state(a), phase: 5, gatePassed: true, gatesPassed: ["g"], agentText: agentText({ scenarios: [SCENARIO] }) });
      const first = await rec();
      await new Promise((r) => setTimeout(r, 5)); // created_at farklı olsun
      await writeFile(join(a, "src", "todoView.js"), TODO_VIEW.replace("My Todos", "All Todos")); // içerik değişti
      const second = await rec();
      const ids = (o: { recorded: string[] }) => o.recorded.filter((id) => id.startsWith("scenario-"));
      expect(ids(second)[0]).not.toBe(ids(first)[0]);
      // Başka proje, aynı ad, farklı içerik (aynı içerik aynı kimliği alır, ayrı kayıt olmaz).
      const b = await mkdtemp(join(tmpdir(), "mycl-codemap-B-"));
      try {
        await seedFiles(b);
        await writeFile(join(b, "src", "todoView.js"), TODO_VIEW.replace("My Todos", "Other Todos"));
        await recordCodeMapAfterGate({ state: state(b), phase: 5, gatePassed: true, gatesPassed: ["g"], agentText: agentText({ scenarios: [SCENARIO] }) });
      } finally {
        await rm(b, { recursive: true, force: true });
      }
      scoreCliMock.mockImplementation(miss);
      await prepareFromCodeMap(state(), config, 5, "store");
      const chunkIds = (scoreCliMock.mock.calls[0]![2] as Array<{ id: string }>).map((c) => c.id);
      expect(chunkIds).toContain(ids(second)[0]); // A'nın en yenisi
      expect(chunkIds).not.toContain(ids(first)[0]); // A'nın eskisi değil
      expect(chunkIds).toHaveLength(2); // + öteki projenin aynı adlısı
    } finally {
      await rm(a, { recursive: true, force: true });
    }
  });
});

describe("prompt 31 (2026-11-28): boş proje ölçütü ve önceki senaryoların tazelenmesi", () => {
  it("stack 'unknown', projede yalnız .mycl/spec.md var → proje boş sayılır, aranır (koşu 40)", async () => {
    await seedMapFromProjectA(5, "node-npm");
    await mkdir(join(proj, ".mycl"), { recursive: true });
    await writeFile(join(proj, ".mycl", "spec.md"), "# spec\n");
    scoreCliMock.mockImplementation(miss);
    await prepareFromCodeMap(state(proj, "unknown"), config, 5, "task list");
    expect(scoreCliMock).toHaveBeenCalled();
    expect(chatMock.mock.calls.some((c) => String(c[1]).includes("projede kod var — aranmadı"))).toBe(false);
  });

  const pass = (name: string, files: string[]) =>
    recordCodeMapAfterGate({
      state: state(),
      phase: 8,
      gatePassed: true,
      gatesPassed: ["g"],
      agentText: agentText({ frameworks: ["react"], scenarios: [{ ...SCENARIO, name, files }] }),
    });
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("düzeltme geçişi başka adla kayıt açınca, dosyası değişen önceki senaryo AYNI adla güncel sürümle yeniden kaydedilir", async () => {
    await seedFiles(proj);
    await pass(SCENARIO.name, SCENARIO.files);
    await tick();
    const fixed = TODO_STORE + "export function clearTodos() { localStorage.removeItem(TODO_KEY); }\n";
    await writeFile(join(proj, "src", "todoStore.js"), fixed);
    const out = await pass("Fix: clear list", ["src/todoView.js"]);
    expect(out.refreshed).toEqual([SCENARIO.name]);
    expect(chatMock.mock.calls.some((c) => String(c[1]).includes("1 senaryo güncel sürümle yeniden kaydedildi"))).toBe(true);
    const all = await listRecords();
    const named = all.filter((r): r is ScenarioRecord => r.level === "scenario" && r.name === SCENARIO.name);
    expect(named).toHaveLength(2); // eski kayıt silinmedi
    const latest = latestScenarios(all).find((r) => r.name === SCENARIO.name)!;
    const files = latest.files.map((id) => all.find((r) => r.id === id) as FileRecord);
    const values = Object.fromEntries(latest.bindings.map((b) => [b.name, b.source_value]));
    const store = files.find((f) => renderTemplate(f.path_template, values) === "src/todoStore.js")!;
    expect(renderTemplate(store.template, values)).toBe(fixed);
    expect(latest.bindings.map((b) => b.name).sort()).toEqual(["Entity", "entity", "storageKey"].sort());
  });

  it("dosyaları değişmeyen önceki senaryo yeniden kaydedilmez", async () => {
    await seedFiles(proj);
    await pass(SCENARIO.name, SCENARIO.files);
    await tick();
    const out = await pass("Other", ["src/todoView.js"]);
    expect(out.refreshed).toEqual([]);
  });

  it("silinmiş dosya yeni kayda girmez; hiç dosyası kalmayan senaryo yeniden kaydedilmez", async () => {
    await seedFiles(proj);
    await pass(SCENARIO.name, SCENARIO.files);
    await tick();
    await rm(join(proj, "src", "todoStore.js"));
    const out = await pass("Other", ["src/todoView.js"]);
    expect(out.refreshed).toEqual([SCENARIO.name]);
    const all = await listRecords();
    const latest = latestScenarios(all).find((r) => r.name === SCENARIO.name)!;
    expect(latest.files).toHaveLength(1);

    await tick();
    await rm(join(proj, "src", "todoView.js"));
    const out2 = await recordCodeMapAfterGate({ state: state(), phase: 8, gatePassed: true, gatesPassed: ["g"], agentText: "no report" });
    expect(out2.refreshed).not.toContain(SCENARIO.name);
  });
  it("kapısı geçmeyen geçişin tazelediği sürüm, sonraki kapısı geçen geçişte 'geçti' olarak yeniden kaydedilir; sonra durur", async () => {
    await seedFiles(proj);
    await pass(SCENARIO.name, SCENARIO.files); // geçti, v1
    await tick();
    await writeFile(join(proj, "src", "todoStore.js"), TODO_STORE + "// v2\n");
    const failed = await recordCodeMapAfterGate({
      state: state(),
      phase: 8,
      gatePassed: false,
      gatesPassed: [],
      agentText: agentText({ scenarios: [{ ...SCENARIO, name: "Fix A", files: ["src/todoView.js"] }] }),
    });
    expect(failed.refreshed).toEqual([SCENARIO.name]);
    await tick();
    const passed = await pass("Fix B", ["src/todoView.js"]); // dosya değişmedi ama sunulan sürüm hâlâ v1
    expect(passed.refreshed).toEqual([SCENARIO.name]);
    const latest = latestScenarios(await listRecords()).find((r) => r.name === SCENARIO.name)!;
    expect(latest.provenance.gate_passed).toBe(true);
    await tick();
    const again = await pass("Fix C", ["src/todoView.js"]);
    expect(again.refreshed).toEqual([]);
  });

  it("needsRefresh: sunulan sürüm güncelse ya da en yeni kayıt aynı kapı durumuyla günceldeyse yazılmaz", () => {
    expect(needsRefresh(true, false, false, true)).toBe(false);
    expect(needsRefresh(false, true, true, true)).toBe(false);
    expect(needsRefresh(false, true, false, false)).toBe(false);
    expect(needsRefresh(false, true, false, true)).toBe(true);
    expect(needsRefresh(false, false, true, true)).toBe(true);
  });
});

