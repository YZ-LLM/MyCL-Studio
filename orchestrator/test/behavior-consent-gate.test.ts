import { beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { State } from "../src/types.js";
import type { MyclConfig } from "../src/config.js";
import { specToMarkdown } from "../src/phase-4.js";
import { formatIterationTs } from "../src/devs-paths.js";
import { readBehaviorConsent, type AcRecord } from "../src/behavior-consent.js";

// translate mock (vi.hoisted — factory'den önce). Kapı yalnız İngilizce davranış metnini çevirir;
// mock kimliği aynen döndürür → test hızlı + deterministik (gerçek LLM çağrısı yok).
const { translateMock } = vi.hoisted(() => ({ translateMock: vi.fn() }));
vi.mock("../src/translator.js", () => ({ translate: translateMock }));
// saveState no-op: kapı best-effort persist eder; testte diske state yazmaya gerek yok.
vi.mock("../src/state.js", () => ({ save: vi.fn().mockResolvedValue(undefined), loadOrInit: vi.fn() }));

import { runBehaviorConsentGate, resolveConsentAnswer } from "../src/behavior-consent-gate.js";

const ITER_TS = new Date("2026-07-03T10:00:00").getTime();

function specMd(acs: AcRecord[]): string {
  return specToMarkdown({
    title: "T",
    scope: "s",
    acceptance_criteria: acs.map((a) => ({ id: a.id, statement: a.statement, given: a.given, when: a.when, then: a.then })),
    out_of_scope: ["x"],
    risks: [{ title: "r", detail: "d" }],
  });
}

async function setupProject(current: AcRecord[], prior: AcRecord[] | null): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "bcg-"));
  const curLabel = formatIterationTs(ITER_TS);
  await fs.mkdir(join(root, "devs", "_pending", curLabel), { recursive: true });
  await fs.writeFile(join(root, "devs", "_pending", curLabel, "iter-spec.md"), specMd(current), "utf-8");
  if (prior) {
    const priorLabel = "2026-01-01-00-00-00"; // her zaman curLabel'dan eski (sözlüksel)
    await fs.mkdir(join(root, "devs", "_pending", priorLabel), { recursive: true });
    await fs.writeFile(join(root, "devs", "_pending", priorLabel, "iter-spec.md"), specMd(prior), "utf-8");
  }
  return root;
}

function makeState(root: string, iterationCount = 2): State {
  return {
    project_root: root,
    iteration_started_at: ITER_TS,
    iteration_count: iterationCount,
    origin: "mycl",
  } as unknown as State;
}

const CONFIG = {} as unknown as MyclConfig;

/**
 * Kapıyı sürer: emitAskq stdout'a JSON yazar → yakala; her açık askq'yi decide(options) ile cevapla.
 * Kapı promise'ı çözülene dek sıralı ilerle. Dönüş: {proceed, askCount}.
 */
async function driveGate(
  state: State,
  decide: (options: string[]) => string,
): Promise<{ proceed: boolean; askCount: number }> {
  const seen: Array<{ id: string; options: string[] }> = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown): boolean => {
    const s = typeof chunk === "string" ? chunk : String(chunk);
    for (const l of s.split("\n")) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l) as { kind?: string; data?: { id?: string; options?: string[] } };
        if (o.kind === "askq" && o.data?.id) seen.push({ id: o.data.id, options: (o.data.options ?? []) as string[] });
      } catch {
        /* json olmayan stdout satırı */
      }
    }
    return true;
  }) as typeof process.stdout.write);
  try {
    let settled = false;
    let proceed = true;
    const gate = runBehaviorConsentGate(state, CONFIG).then((r) => {
      settled = true;
      proceed = r;
      return r;
    });
    let answered = 0;
    for (let i = 0; i < 500 && !settled; i++) {
      while (seen.length > answered) {
        const a = seen[answered++];
        resolveConsentAnswer(a.id, decide(a.options));
      }
      await new Promise((r) => setTimeout(r, 3));
    }
    await gate;
    return { proceed, askCount: seen.length };
  } finally {
    spy.mockRestore();
  }
}

const YES = (o: string[]): string => o[0]; // ilk seçenek = "Evet, değiştir/kaldır"
const NO = (o: string[]): string => o[1]; // ikinci = "Hayır, dokunma"

beforeEach(() => {
  translateMock.mockImplementation((_c: unknown, text: string) =>
    Promise.resolve({ text, model: "m", attempts: 1, elapsed_ms: 0 }),
  );
});

describe("runBehaviorConsentGate — sıfır-soru yolları (aşırı-soru koruması)", () => {
  it("iterasyon 1 → hiç sormaz, devam eder, not yok", async () => {
    const root = await setupProject([{ id: "AC1", statement: "x", then: "y" }], null);
    const state = makeState(root, 1);
    const { proceed, askCount } = await driveGate(state, YES);
    expect(proceed).toBe(true);
    expect(askCount).toBe(0);
    expect(state.pending_behavior_consent_note).toBeUndefined();
  });

  it("aynı spec (değişiklik yok) → hiç sormaz", async () => {
    const acs: AcRecord[] = [{ id: "AC1", statement: "User can log in", then: "cookie set" }];
    const root = await setupProject(acs, acs);
    const { askCount } = await driveGate(makeState(root), YES);
    expect(askCount).toBe(0);
  });

  it("saf ekleme (yeni AC) → hiç sormaz", async () => {
    const prior: AcRecord[] = [{ id: "AC1", statement: "User can log in", then: "cookie set" }];
    const current: AcRecord[] = [
      { id: "AC1", statement: "User can log in", then: "cookie set" },
      { id: "AC2", statement: "User can log out", then: "cookie cleared" },
    ];
    const { askCount } = await driveGate(makeState(await setupProject(current, prior)), YES);
    expect(askCount).toBe(0);
  });
});

describe("runBehaviorConsentGate — değişen davranış onayı", () => {
  const prior: AcRecord[] = [{ id: "AC1", statement: "User can log in", then: "session cookie set" }];
  const current: AcRecord[] = [{ id: "AC1", statement: "User can log in", then: "JWT token returned" }];

  it("EVET → 1 soru, ONAYLANAN notu enjekte, consent.jsonl 'yes'", async () => {
    const root = await setupProject(current, prior);
    const state = makeState(root);
    const { proceed, askCount } = await driveGate(state, YES);
    expect(proceed).toBe(true);
    expect(askCount).toBe(1);
    expect(state.pending_behavior_consent_note).toContain("APPROVED");
    const recs = await readBehaviorConsent(root);
    expect(recs.at(-1)?.decision).toBe("yes");
  });

  it("HAYIR → REDDEDİLEN notu (dokunma), consent.jsonl 'no'", async () => {
    const root = await setupProject(current, prior);
    const state = makeState(root);
    const { askCount } = await driveGate(state, NO);
    expect(askCount).toBe(1);
    expect(state.pending_behavior_consent_note).toContain("REFUSED");
    expect((await readBehaviorConsent(root)).at(-1)?.decision).toBe("no");
  });

  it("aynı iterasyonda yeniden koş → recall sessiz yeniden-kullan (0 yeni soru)", async () => {
    const root = await setupProject(current, prior);
    const state = makeState(root);
    await driveGate(state, YES); // ilk koş: 1 soru + kayıt
    const second = await driveGate(state, YES); // aynı iterasyon → recall
    expect(second.askCount).toBe(0);
    expect(state.pending_behavior_consent_note).toContain("APPROVED"); // not yine üretildi
  });
});
