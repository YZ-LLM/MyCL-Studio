import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceQuestions, ensureBank, generateBank, type QuestionProposer } from "./generate.js";
import { bankKeyToPath } from "./key.js";
import { readBank, writeBankAtomic } from "./storage.js";
import type { CmdRunner } from "./lock.js";
import { BANK_SCHEMA_VERSION, type BankKey, type BankQuestion } from "./types.js";

const markerRunner: CmdRunner = async (_cmd, cwd) => {
  try {
    const m = (await readFile(join(cwd, "marker.txt"), "utf-8")).trim();
    return { code: m === "good" ? 0 : 1 };
  } catch {
    return { code: 127 };
  }
};

const key: BankKey = { checkpoint: "phase-10", stack: "node-npm", artifact: "*" };

const discriminating: BankQuestion = {
  id: "ok",
  text: "marker iyi mi?",
  check: { cmd: "c" },
  blocking_class: "blocking",
  real_to_proxy: "g→p",
  fixtures: [
    { name: "iyi", files: { "marker.txt": "good" }, expect: "PASS" },
    { name: "kötü", files: { "marker.txt": "bad" }, expect: "FAIL" },
  ],
};
const unprovable: BankQuestion = {
  ...discriminating,
  id: "yok",
  fixtures: [{ name: "iyi", files: { "marker.txt": "good" }, expect: "PASS" }],
};

describe("generateBank — fail-closed (yalnız kanıtlanan kilitlenir)", () => {
  it("ayırt-edici aday kilitlenir, kanıtlanamayan reddedilir", async () => {
    const propose: QuestionProposer = async () => [discriminating, unprovable];
    const r = await generateBank({ key, propose, runner: markerRunner, stabilityRuns: 1 });
    expect(r.locked.map((q) => q.id)).toEqual(["ok"]);
    expect(r.rejected.map((x) => x.id)).toEqual(["yok"]);
    expect(r.bank.questions).toHaveLength(1);
  });
});

describe("ensureBank", () => {
  it("banka yoksa üretir + atomik yazar (kilitli soru varsa)", async () => {
    const banksRoot = await mkdtemp(join(tmpdir(), "qbank-gen-"));
    const propose: QuestionProposer = async () => [discriminating];
    const out = await ensureBank({ banksRoot, key, propose, runner: markerRunner, stabilityRuns: 1 });
    expect(out.generated).toBe(true);
    expect(await readBank(bankKeyToPath(banksRoot, key))).toEqual(out.bank);
  });

  it("hiç kilitli soru yoksa banka YAZILMAZ (yanlış 'banka var' sinyali yok)", async () => {
    const banksRoot = await mkdtemp(join(tmpdir(), "qbank-gen-"));
    const propose: QuestionProposer = async () => [unprovable];
    const out = await ensureBank({ banksRoot, key, propose, runner: markerRunner, stabilityRuns: 1 });
    expect(out.generated).toBe(false);
    expect(out.bank).toBeNull();
    expect(await readBank(bankKeyToPath(banksRoot, key))).toBeNull();
  });

  it("banka VARSA üretmez (proposer çağrılmaz, mevcut döner)", async () => {
    const banksRoot = await mkdtemp(join(tmpdir(), "qbank-gen-"));
    const existing = { key, questions: [discriminating], version: BANK_SCHEMA_VERSION };
    await writeBankAtomic(bankKeyToPath(banksRoot, key), existing);
    let called = false;
    const propose: QuestionProposer = async () => {
      called = true;
      return [];
    };
    const out = await ensureBank({ banksRoot, key, propose, runner: markerRunner });
    expect(out.generated).toBe(false);
    expect(called).toBe(false);
    expect(out.bank).toEqual(existing);
  });
});

describe("coerceQuestions — güvenilmez LLM çıktısı elenir", () => {
  it("şema-dışı/eksik/fixtures'siz/check.cmd'siz adaylar düşer", () => {
    const raw = [
      discriminating,
      { id: "eksik" },
      { id: "x", text: "t", real_to_proxy: "r", check: { cmd: "c" }, blocking_class: "blocking", fixtures: [] },
      "obje değil",
      { id: "y", text: "t", real_to_proxy: "r", check: {}, blocking_class: "blocking", fixtures: [{ name: "f", files: { a: "b" }, expect: "PASS" }] },
    ];
    expect(coerceQuestions(raw).map((q) => q.id)).toEqual(["ok"]);
  });

  it("array değilse boş", () => {
    expect(coerceQuestions({})).toEqual([]);
    expect(coerceQuestions(null)).toEqual([]);
  });

  it("blocking_class: advisory korunur, geçersiz → blocking", () => {
    const base = {
      text: "t",
      real_to_proxy: "r",
      check: { cmd: "c" },
      fixtures: [{ name: "f", files: { a: "b" }, expect: "PASS" }],
    };
    const out = coerceQuestions([
      { ...base, id: "a", blocking_class: "advisory" },
      { ...base, id: "b", blocking_class: "saçma" },
    ]);
    expect(out.find((q) => q.id === "a")?.blocking_class).toBe("advisory");
    expect(out.find((q) => q.id === "b")?.blocking_class).toBe("blocking");
  });
});
