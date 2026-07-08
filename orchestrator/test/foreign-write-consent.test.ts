// foreign-write-consent — yabancı-yazma onay kapısının SAF fonksiyonları + gate dalları. Anti-false-safe kritik:
// "EDD kaydı yok" asla "güvenli" sayılmamalı. Gate dalları (APPLY_ALL/NONE/SELECTED + onaylı alt-küme) mock'lu askq ile test edilir.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// emitAskq'i mock'la: her çağrıda sıradaki cevabı (answerQueue) mikrotaskta gate'in çözücüsüne yolla → await settle.
let gateResolve: ((id: string, sel: string) => boolean) | undefined;
let answerQueue: string[] = [];
const emittedQuestions: string[] = [];
vi.mock("../src/ipc.js", () => ({
  emitAskq: (a: { id: string; question: string }) => {
    emittedQuestions.push(a.question);
    const ans = answerQueue.shift();
    if (ans !== undefined) Promise.resolve().then(() => gateResolve?.(a.id, ans));
  },
  emitChatMessage: () => {},
}));
vi.mock("../src/translator.js", () => ({
  translate: async (_c: unknown, text: string) => ({ text }), // çeviri no-op (offline test)
}));

import {
  buildTouchedBehaviorSummary,
  formatTouchedForConsent,
  runForeignWriteConsentGate,
  confirmForeignWriteFiles,
  resolveForeignWriteConsent,
  isForeignWriteConsentAskqId,
  type TouchedBehavior,
  type ForeignWriteItem,
} from "../src/foreign-write-consent.js";
import type { EddUnitRecord } from "../src/edd/progress.js";
import type { AffectedModule } from "../src/fix/dep-graph/index.js";
import type { State } from "../src/types.js";
import type { MyclConfig } from "../src/config.js";
gateResolve = resolveForeignWriteConsent;

function rec(unit: string, r: Partial<EddUnitRecord>): [string, EddUnitRecord] {
  return [unit, { unit, status: "pending", ts: 1, ...r } as EddUnitRecord];
}
function aff(module: string): AffectedModule {
  return { module, why: "doğrudan import eder", risk: "medium" };
}

describe("foreign-write-consent · buildTouchedBehaviorSummary (anti-false-safe)", () => {
  it("done+behavior → documented (what_it_does + invariants MAX_INVARIANTS'a kırpılı)", () => {
    const byUnit = new Map([
      rec("src/auth.ts", {
        status: "done",
        behavior: { what_it_does: "guards /api", invariants: ["i1", "i2", "i3", "i4", "i5", "i6"], side_effects: [] },
      }),
    ]);
    const t = buildTouchedBehaviorSummary(byUnit, ["src/auth.ts"], []);
    expect(t).toHaveLength(1);
    expect(t[0].coverage).toBe("documented");
    expect(t[0].what_it_does).toBe("guards /api");
    expect(t[0].invariants).toEqual(["i1", "i2", "i3", "i4"]);
  });

  it("KAYIT YOK → 'unknown' (KAPSAM BELİRSİZ — asla düşürülmez/güvenli sayılmaz)", () => {
    const t = buildTouchedBehaviorSummary(new Map(), ["src/new.ts"], []);
    expect(t).toHaveLength(1);
    expect(t[0].coverage).toBe("unknown");
  });

  it("pending → pending; unanalyzable → +reason", () => {
    const byUnit = new Map([
      rec("src/p.ts", { status: "pending" }),
      rec("logo.png", { status: "unanalyzable", reason: "binary" }),
    ]);
    const t = buildTouchedBehaviorSummary(byUnit, ["src/p.ts", "logo.png"], []);
    expect(t.find((x) => x.unit === "src/p.ts")?.coverage).toBe("pending");
    const u = t.find((x) => x.unit === "logo.png");
    expect(u?.coverage).toBe("unanalyzable");
    expect(u?.reason).toBe("binary");
  });

  it("affected (bağımlılar) da dahil; seed+affected AYNI birim tekilleşir", () => {
    const byUnit = new Map([
      rec("src/a.ts", { status: "done", behavior: { what_it_does: "a", invariants: [], side_effects: [] } }),
      rec("src/dep.ts", { status: "done", behavior: { what_it_does: "dep", invariants: [], side_effects: [] } }),
    ]);
    const t = buildTouchedBehaviorSummary(byUnit, ["src/a.ts"], [aff("src/a.ts"), aff("src/dep.ts")]);
    expect(t).toHaveLength(2);
    expect(t.map((x) => x.unit).sort()).toEqual(["src/a.ts", "src/dep.ts"]);
  });

  it("sıra: documented ÖNCE, sonra pending/unanalyzable/unknown", () => {
    const byUnit = new Map([
      rec("z-doc.ts", { status: "done", behavior: { what_it_does: "d", invariants: [], side_effects: [] } }),
      rec("a-pending.ts", { status: "pending" }),
    ]);
    const t = buildTouchedBehaviorSummary(byUnit, ["a-pending.ts", "z-doc.ts", "x-unknown.ts"], []);
    expect(t[0].coverage).toBe("documented");
    expect(t.map((x) => x.coverage)).toEqual(["documented", "pending", "unknown"]);
  });
});

describe("foreign-write-consent · formatTouchedForConsent", () => {
  it("boş → 'kapsam belirsiz' uyarısı", () => {
    expect(formatTouchedForConsent([], new Map())).toContain("kapsam belirsiz");
  });
  it("documented → birim + çevrilmiş what_it_does + invariant satırları", () => {
    const touched: TouchedBehavior[] = [
      { unit: "src/auth.ts", coverage: "documented", what_it_does: "guards /api", invariants: ["401 on no token"] },
    ];
    const s = formatTouchedForConsent(touched, new Map([["src/auth.ts", "api'yi korur"]]));
    expect(s).toContain("src/auth.ts");
    expect(s).toContain("api'yi korur");
    expect(s).toContain("401 on no token");
  });
  it("belirsiz birimler SAYIYLA + uyarıyla görünür (anti-false-safe)", () => {
    const touched: TouchedBehavior[] = [
      { unit: "src/a.ts", coverage: "unknown" },
      { unit: "src/b.ts", coverage: "pending" },
    ];
    const s = formatTouchedForConsent(touched, new Map());
    expect(s).toContain("2 birim");
    expect(s).toContain("kapsam belirsiz");
  });
});

describe("foreign-write-consent · runForeignWriteConsentGate (gate dalları)", () => {
  let root: string;
  const cfg = {} as MyclConfig;
  const items = (n: number): ForeignWriteItem[] =>
    Array.from({ length: n }, (_, i) => ({ key: String(i), label: `fix ${i}`, seedFiles: [] }));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fwc-gate-"));
    answerQueue = [];
    emittedQuestions.length = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("origin!=='foreign' → items DEĞİŞMEDEN döner (non-foreign parite, askq YOK)", async () => {
    const st = { origin: "mycl", project_root: root } as unknown as State;
    const out = await runForeignWriteConsentGate(st, cfg, items(2), { source: "risk-fix" });
    expect(out).toHaveLength(2);
    expect(emittedQuestions).toHaveLength(0); // hiç sorulmadı
  });

  it("boş items → askq yok, boş döner", async () => {
    const st = { origin: "foreign", project_root: root } as unknown as State;
    expect(await runForeignWriteConsentGate(st, cfg, [], { source: "risk-fix" })).toHaveLength(0);
    expect(emittedQuestions).toHaveLength(0);
  });

  it("'Hepsini uygula' → TÜM items onaylı", async () => {
    const st = { origin: "foreign", project_root: root } as unknown as State;
    answerQueue = ["Hepsini uygula"];
    const out = await runForeignWriteConsentGate(st, cfg, items(3), { source: "risk-fix" });
    expect(out.map((o) => o.key)).toEqual(["0", "1", "2"]);
  });

  it("'Hiçbirini' → BOŞ (yabancı kod yazılmaz)", async () => {
    const st = { origin: "foreign", project_root: root } as unknown as State;
    answerQueue = ["Hiçbirini (bu tur atla)"];
    const out = await runForeignWriteConsentGate(st, cfg, items(3), { source: "risk-fix" });
    expect(out).toHaveLength(0);
  });

  it("'Yalnız seçtiklerim' → item-item; doğru alt-küme (key korunur)", async () => {
    const st = { origin: "foreign", project_root: root } as unknown as State;
    // batch → SELECTED; sonra 3 item: Uygula/Atla/Uygula → 0 ve 2 onaylı
    answerQueue = ["Yalnız seçtiklerim", "Uygula", "Atla", "Uygula"];
    const out = await runForeignWriteConsentGate(st, cfg, items(3), { source: "risk-fix" });
    expect(out.map((o) => o.key)).toEqual(["0", "2"]);
  });
});

describe("foreign-write-consent · confirmForeignWriteFiles (B1.1 hassas onay)", () => {
  let root: string;
  const cfg = {} as MyclConfig;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fwc-b11-"));
    answerQueue = [];
    emittedQuestions.length = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("origin!=='foreign' → true (askq YOK)", async () => {
    const st = { origin: "mycl", project_root: root } as unknown as State;
    expect(await confirmForeignWriteFiles(st, cfg, ["src/a.ts"])).toBe(true);
    expect(emittedQuestions).toHaveLength(0);
  });

  it("boş dosya listesi → true (askq YOK)", async () => {
    const st = { origin: "foreign", project_root: root } as unknown as State;
    expect(await confirmForeignWriteFiles(st, cfg, [])).toBe(true);
    expect(emittedQuestions).toHaveLength(0);
  });

  it("foreign 'Uygula' → true; 'İptal' → false", async () => {
    const st = { origin: "foreign", project_root: root } as unknown as State;
    answerQueue = ["Uygula"];
    expect(await confirmForeignWriteFiles(st, cfg, ["src/a.ts", "src/b.ts"])).toBe(true);
    answerQueue = ["İptal (uygulama)"];
    expect(await confirmForeignWriteFiles(st, cfg, ["src/a.ts"])).toBe(false);
  });
});

describe("foreign-write-consent · id predicate", () => {
  it("isForeignWriteConsentAskqId yalnız kendi önekini tanır", () => {
    expect(isForeignWriteConsentAskqId("foreign_write_consent_abc")).toBe(true);
    expect(isForeignWriteConsentAskqId("behavior_consent_abc")).toBe(false);
    expect(isForeignWriteConsentAskqId("error_analysis_x")).toBe(false);
  });
  it("resolveForeignWriteConsent bilinmeyen id'de false", () => {
    expect(resolveForeignWriteConsent("foreign_write_consent_yok", "x")).toBe(false);
  });
});
