// code-map — kod haritası (ilk sürüm; module-stock'un yerine). Kayıt doğrulaması (bağlama ile birebir geri çıkma), değişmez
// sürümler, faz kapısı koşulu, haritadan yerleştirme (üzerine yazmaz, proje dışına yazmaz) ve isabet yokken/harita boşken
// bugünkü akış.
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
  bindingKeysForParts,
  currentRecords,
  listRecords,
  placeFileRecords,
  prepareFromCodeMap,
  readEvidence,
  recordCodeMapAfterGate,
  renderTemplate,
  type CodeMapRecord,
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

function state(root = proj): State {
  return { project_root: root, stack: "node-npm", iteration_count: 1, intent_summary: "todo list" } as unknown as State;
}

const TODO_STORE = [
  "const TODO_KEY = 'todos';",
  "export function loadTodos() {",
  "  return JSON.parse(localStorage.getItem(TODO_KEY) || '[]');",
  "}",
  "",
].join("\n");

/** Ajanın iş sonu metni: serbest metin + son code_map bloğu. */
function agentText(report: unknown): string {
  return `Done. All tests pass.\n\n${JSON.stringify({ kind: "code_map", ...(report as object) })}`;
}

const STORE_UNIT = {
  key: "u1",
  level: "file",
  name: "Local storage store",
  description: "Loads items from localStorage",
  path: "src/todoStore.js",
  bindings: [
    { name: "entity", kind: "name", description: "item noun (lowercase)", value: "todo" },
    { name: "Entity", kind: "name", description: "item noun (capitalised)", value: "Todo" },
    { name: "storageKey", kind: "key", description: "localStorage key", value: "todos" },
  ],
  uses: [],
};

async function seedProject(): Promise<void> {
  await mkdir(join(proj, "src"), { recursive: true });
  await writeFile(join(proj, "src", "todoStore.js"), TODO_STORE);
}

describe("kayıt doğrulaması — kaynak değerleriyle birebir geri çıkma", () => {
  it("kabul edilen kayıt kaynak değerleriyle yerine konunca kaynak metni ve yolu BİREBİR veriyor", async () => {
    await seedProject();
    const out = await recordCodeMapAfterGate({
      state: state(),
      phase: 5,
      gatePassed: true,
      gatesPassed: ["phase-5-complete: dev server ready"],
      agentText: agentText({ frameworks: ["react"], units: [STORE_UNIT], scenarios: [{ key: "s1", name: "Persist list", steps: ["u1"] }] }),
    });
    expect(out.rejected).toEqual([]);
    expect(out.recorded).toHaveLength(2);
    const rec = (await listRecords()).find((r) => r.level === "file")!;
    const values = Object.fromEntries(rec.bindings.map((b) => [b.name, b.source_value]));
    expect(renderTemplate(rec.template!, values)).toBe(TODO_STORE);
    expect(renderTemplate(rec.path_template!, values)).toBe("src/todoStore.js");
    // Uzun değer önce: 'todos' depolama anahtarı, 'Todo' fonksiyon adında; 'todo' yalnız yolda kalır.
    expect(rec.template).toContain("{{mycl:storageKey}}");
    expect(rec.template).toContain("load{{mycl:Entity}}s");
    expect(rec.path_template).toBe("src/{{mycl:entity}}Store.js");
    expect(rec.template).not.toContain("todo");
    expect(rec.links_declared_by_agent).toBe(true);
    const scen = (await listRecords()).find((r) => r.level === "scenario")!;
    expect(scen.steps).toEqual([rec.id]);
    expect(rec.used_by).toEqual([scen.id]);
  });

  it("birebir geri çıkmayan / tutmayan birim reddediliyor ve nedeni yazılıyor", async () => {
    await seedProject();
    await writeFile(join(proj, "src", "tricky.js"), "const t = '{{mycl:entity}}';\n");
    const out = await recordCodeMapAfterGate({
      state: state(),
      phase: 5,
      gatePassed: true,
      gatesPassed: ["phase-5-complete"],
      agentText: agentText({
        units: [
          { ...STORE_UNIT, key: "u1", bindings: [{ name: "entity", kind: "name", description: "x", value: "widget" }] },
          { key: "u2", level: "file", name: "Tricky", path: "src/tricky.js", bindings: [{ name: "entity", kind: "name", description: "x", value: "t" }] },
          { key: "u3", level: "symbol", name: "Loader", path: "src/todoStore.js", lines: [2, 4], first_line: "function wrong() {", bindings: [] },
          { key: "u4", level: "file", name: "Env", path: ".env", bindings: [] },
        ],
        scenarios: [],
      }),
    });
    expect(out.recorded).toEqual([]);
    const reasons = Object.fromEntries(out.rejected.map((r) => [r.key, r.reason]));
    expect(reasons.u1).toMatch(/değeri metinde ve yolda geçmiyor/);
    expect(reasons.u2).toMatch(/yer tutucu çakışması/);
    expect(reasons.u3).toMatch(/ilk satırla tutmuyor/);
    expect(reasons.u4).toMatch(/güvensiz ya da gizli/);
    const ileti = chatMock.mock.calls.map((c) => String(c[1])).find((t) => t.includes("Kod haritası (Faz 5)"));
    expect(ileti).toMatch(/Reddedilen 4/);
  });
});

describe("değişmez kayıt — değişen sürüm yeni kayıt", () => {
  it("aynı parçanın değişen sürümü YENİ kayıt açıyor; eski kayıt duruyor, yenisi onu gösteriyor", async () => {
    await seedProject();
    const report = agentText({ units: [STORE_UNIT], scenarios: [] });
    const first = await recordCodeMapAfterGate({ state: state(), phase: 5, gatePassed: true, gatesPassed: ["g"], agentText: report });
    const oldId = first.recorded[0]!;
    await writeFile(join(proj, "src", "todoStore.js"), TODO_STORE.replace("'[]'", "'[]' /* default */"));
    // Aynı faz (sürüm zinciri proje + faz içindedir).
    const second = await recordCodeMapAfterGate({ state: state(), phase: 5, gatePassed: true, gatesPassed: ["g2"], agentText: report });
    const newId = second.recorded[0]!;
    expect(newId).not.toBe(oldId);
    const all = await listRecords();
    expect(all.find((r) => r.id === oldId)).toBeDefined(); // eski kayıt duruyor
    const neu = all.find((r) => r.id === newId)!;
    expect(neu.supersedes?.id).toBe(oldId);
    expect(neu.supersedes?.reason).toMatch(/içerik değişti \(.*, Faz 5\)/);
    expect(currentRecords(all).map((r) => r.id)).toEqual([newId]);
  });

  it("aynı içerik ikinci kez bildirilirse yeni kayıt açılmaz, kanıt satırı eklenir", async () => {
    await seedProject();
    const report = agentText({ units: [STORE_UNIT], scenarios: [] });
    const a = await recordCodeMapAfterGate({ state: state(), phase: 5, gatePassed: true, gatesPassed: ["g"], agentText: report });
    const b = await recordCodeMapAfterGate({ state: state(), phase: 8, gatePassed: true, gatesPassed: ["g2"], agentText: report });
    expect(b.recorded).toEqual([]);
    expect(b.reused).toEqual(a.recorded);
    expect((await readEvidence()).filter((e) => e.record_id === a.recorded[0])).toHaveLength(2);
  });
});

describe("faz kapısı koşulu", () => {
  it("kapı geçmeden kayıt alınmıyor; geçince alınıyor ve kanıt satırı hangi kapının geçtiğini söylüyor", async () => {
    await seedProject();
    const report = agentText({ units: [STORE_UNIT], scenarios: [] });
    const no = await recordCodeMapAfterGate({ state: state(), phase: 8, gatePassed: false, gatesPassed: [], agentText: report });
    expect(no.recorded).toEqual([]);
    expect(await listRecords()).toEqual([]);
    const yes = await recordCodeMapAfterGate({
      state: state(),
      phase: 8,
      gatePassed: true,
      gatesPassed: ["phase-8-complete: tdd=true suite=true debt=0"],
      agentText: report,
    });
    expect(yes.recorded).toHaveLength(1);
    const ev = await readEvidence();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.kind).toBe("gates-passed");
    expect(ev[0]!.detail).toContain("phase-8-complete: tdd=true suite=true debt=0");
    const rec = (await listRecords())[0]!;
    expect(rec.provenance.gates_passed).toEqual(["phase-8-complete: tdd=true suite=true debt=0"]);
    expect(rec.provenance.phase).toBe(8);
  });

  it("ajan bildirim yapmadıysa kayıt yok ve bu görünür yazılıyor", async () => {
    const out = await recordCodeMapAfterGate({ state: state(), phase: 5, gatePassed: true, gatesPassed: ["g"], agentText: "Done." });
    expect(out.noReport).toBe(true);
    expect(chatMock.mock.calls.some((c) => String(c[1]).includes("iş sonu bildirimini (code_map) yapmadı"))).toBe(true);
  });
});

describe("kod yazmadan önce — haritadan yerleştirme", () => {
  /** Kaynak projede (A) kayıt al (varsayılan Faz 5). */
  async function seedMapFromProjectA(phase = 5): Promise<void> {
    const a = await mkdtemp(join(tmpdir(), "mycl-codemap-A-"));
    try {
      await mkdir(join(a, "src"), { recursive: true });
      await writeFile(join(a, "src", "todoStore.js"), TODO_STORE);
      await recordCodeMapAfterGate({
        state: state(a),
        phase,
        gatePassed: true,
        gatesPassed: [`phase-${phase}-complete`],
        agentText: agentText({ units: [STORE_UNIT], scenarios: [{ key: "s1", name: "Persist list in browser", steps: ["u1"] }] }),
      });
    } finally {
      await rm(a, { recursive: true, force: true });
    }
  }

  it("isabet varken dosya yerleştiriliyor (bağlama değerleriyle), ajana toplu inceleme talimatı veriliyor", async () => {
    await seedMapFromProjectA();
    scoreCliMock.mockImplementation(async (_m: string, _i: string, chunks: Array<{ id: string }>) =>
      chunks.map((c) => ({ ...c, score: 9, reason: "same use case" })),
    );
    runCliMock.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ kind: "binding_values", values: { entity: "task", Entity: "Task", storageKey: "tasks" } }),
      toolUses: [],
      turns: 1,
    });
    const res = await prepareFromCodeMap(state(), config, 5, "A task list stored in the browser");
    expect(res.placed.map((p) => p.path)).toEqual(["src/taskStore.js"]);
    const text = await readFile(join(proj, "src", "taskStore.js"), "utf8");
    expect(text).toBe(TODO_STORE.split("todo").join("task").split("Todo").join("Task"));
    expect(res.promptAddition).toMatch(/review ALL placed files together/);
    expect(chatMock.mock.calls.some((c) => String(c[1]).includes("1 dosya yerleştirildi"))).toBe(true);
  });

  it("var olan dosyanın üzerine yazmıyor", async () => {
    await seedMapFromProjectA();
    scoreCliMock.mockImplementation(async (_m: string, _i: string, chunks: Array<{ id: string }>) =>
      chunks.map((c) => ({ ...c, score: 9, reason: "x" })),
    );
    runCliMock.mockResolvedValue({
      ok: true,
      text: JSON.stringify({ kind: "binding_values", values: { entity: "task", Entity: "Task", storageKey: "tasks" } }),
      toolUses: [],
      turns: 1,
    });
    await mkdir(join(proj, "src"), { recursive: true });
    await writeFile(join(proj, "src", "taskStore.js"), "// mine\n");
    const res = await prepareFromCodeMap(state(), config, 5, "task list");
    expect(res.placed).toEqual([]);
    expect(await readFile(join(proj, "src", "taskStore.js"), "utf8")).toBe("// mine\n");
  });

  it("proje dışına ve güvensiz yola yazmıyor", async () => {
    const outside = { id: "file-x", level: "file", path_template: "../escape.js", template: "x", bindings: [] } as unknown as CodeMapRecord;
    const env = { id: "file-y", level: "file", path_template: ".env", template: "SECRET=1", bindings: [] } as unknown as CodeMapRecord;
    const res = await placeFileRecords(proj, [outside, env], {});
    expect(res.placed).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toEqual(["güvensiz ya da gizli yol", "güvensiz ya da gizli yol"]);
    expect(existsSync(join(proj, "..", "escape.js"))).toBe(false);
    expect(existsSync(join(proj, ".env"))).toBe(false);
  });

  it("başka fazın kaydı yerleştirilmez (Faz 8 arka uç kaydı Faz 5'e girmez); projenin kendi kaydı aranmaz", async () => {
    await seedMapFromProjectA(8);
    const res5 = await prepareFromCodeMap(state(), config, 5, "A task list stored in the browser");
    expect(res5).toEqual({ promptAddition: "", placed: [] });
    expect(scoreCliMock).not.toHaveBeenCalled();
    // Kendi projesi: proj'de Faz 5 kaydı al, aynı projede Faz 5 araması onu görmez.
    await seedProject();
    await recordCodeMapAfterGate({
      state: state(),
      phase: 5,
      gatePassed: true,
      gatesPassed: ["g"],
      agentText: agentText({ units: [STORE_UNIT], scenarios: [{ key: "s1", name: "Own", steps: ["u1"] }] }),
    });
    expect(await prepareFromCodeMap(state(), config, 5, "todo")).toEqual({ promptAddition: "", placed: [] });
    expect(scoreCliMock).not.toHaveBeenCalled();
  });

  it("aynı adlı bağlama parçalar arasında farklı kaynak değer taşıyorsa ayrı anahtar alır", () => {
    const a = { id: "a", bindings: [{ name: "name", kind: "name", description: "list", source_value: "TodoList" }] } as unknown as CodeMapRecord;
    const b = { id: "b", bindings: [{ name: "name", kind: "name", description: "item", source_value: "TodoItem" }] } as unknown as CodeMapRecord;
    const c = { id: "c", bindings: [{ name: "name", kind: "name", description: "list", source_value: "TodoList" }] } as unknown as CodeMapRecord;
    const { bindings, keyOf } = bindingKeysForParts([a, b, c]);
    expect(bindings.map((x) => x.name)).toEqual(["name", "name_2"]);
    expect(keyOf.get("a")!.get("name")).toBe("name");
    expect(keyOf.get("b")!.get("name")).toBe("name_2");
    expect(keyOf.get("c")!.get("name")).toBe("name");
  });

  it("harita boşken akış bugünküyle aynı: puanlama yok, dosya yok, ek talimat yok", async () => {
    const res = await prepareFromCodeMap(state(), config, 5, "task list");
    expect(res).toEqual({ promptAddition: "", placed: [] });
    expect(scoreCliMock).not.toHaveBeenCalled();
    expect(runCliMock).not.toHaveBeenCalled();
  });

  it("isabet yokken akış bugünküyle aynı: dosya yok, ek talimat yok, bağlama çağrısı yok", async () => {
    await seedMapFromProjectA();
    scoreCliMock.mockImplementation(async (_m: string, _i: string, chunks: Array<{ id: string }>) =>
      chunks.map((c) => ({ ...c, score: 2, reason: "unrelated" })),
    );
    const res = await prepareFromCodeMap(state(), config, 5, "A weather dashboard");
    expect(res).toEqual({ promptAddition: "", placed: [] });
    expect(runCliMock).not.toHaveBeenCalled();
    expect(existsSync(join(proj, "src"))).toBe(false);
  });
});
