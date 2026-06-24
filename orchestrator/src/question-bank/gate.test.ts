import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBankGate } from "./gate.js";
import { bankKeyToPath } from "./key.js";
import { writeBankAtomic } from "./storage.js";
import type { CmdRunner } from "./lock.js";
import { BANK_SCHEMA_VERSION, type BankKey, type BankQuestion, type QuestionBank } from "./types.js";

// marker.txt: good→0, bad→1, yok→127. Hem fixture-cwd (meta-test) hem proje-cwd.
const markerRunner: CmdRunner = async (_cmd, cwd) => {
  try {
    const m = (await readFile(join(cwd, "marker.txt"), "utf-8")).trim();
    return { code: m === "good" ? 0 : 1 };
  } catch {
    return { code: 127 };
  }
};

const discriminating: BankQuestion = {
  id: "q1",
  text: "marker iyi mi?",
  check: { cmd: "check" },
  blocking_class: "blocking",
  real_to_proxy: "gerçek → proxy",
  fixtures: [
    { name: "iyi", files: { "marker.txt": "good" }, expect: "PASS" },
    { name: "kötü", files: { "marker.txt": "bad" }, expect: "FAIL" },
  ],
};

const key: BankKey = { checkpoint: "phase-10", stack: "node-npm", artifact: "*" };

async function setup(questions: BankQuestion[], projectMarker?: string) {
  const banksRoot = await mkdtemp(join(tmpdir(), "qbank-gate-banks-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "qbank-gate-proj-"));
  if (projectMarker !== undefined) {
    await writeFile(join(projectRoot, "marker.txt"), projectMarker, "utf-8");
  }
  const bank: QuestionBank = { key, questions, version: BANK_SCHEMA_VERSION };
  await writeBankAtomic(bankKeyToPath(banksRoot, key), bank);
  return { banksRoot, projectRoot };
}

const base = { checkpoint: "phase-10", stack: "node-npm" as const, changedFiles: ["x.ts"], profile: null, runner: markerRunner };

describe("runBankGate — uçtan uca", () => {
  it("banka yoksa → skip_no_bank (görünür, sahte-yeşil değil)", async () => {
    const banksRoot = await mkdtemp(join(tmpdir(), "qbank-gate-empty-"));
    const out = await runBankGate({ ...base, banksRoot, projectRoot: banksRoot });
    expect(out.decision).toBe("skip_no_bank");
    expect(out.result).toBeNull();
  });

  it("trusted check + proje marker=good → green", async () => {
    const { banksRoot, projectRoot } = await setup([discriminating], "good");
    const out = await runBankGate({ ...base, banksRoot, projectRoot, stabilityRuns: 2 });
    expect(out.decision).toBe("green");
    expect(out.result?.coverage.pass).toBe(1);
  });

  it("trusted check + proje marker=bad → halt_defect (insana)", async () => {
    const { banksRoot, projectRoot } = await setup([discriminating], "bad");
    const out = await runBankGate({ ...base, banksRoot, projectRoot, stabilityRuns: 2 });
    expect(out.decision).toBe("halt_defect");
    expect(out.result?.blocking_fail).toHaveLength(1);
  });

  it("kanıtlanamayan blocking check (kötü fixture yok) → stale → halt_infra (sahte-yeşil DEĞİL)", async () => {
    const unproven: BankQuestion = {
      ...discriminating,
      id: "u1",
      fixtures: [{ name: "iyi", files: { "marker.txt": "good" }, expect: "PASS" }],
    };
    const { banksRoot, projectRoot } = await setup([unproven], "good");
    const out = await runBankGate({ ...base, banksRoot, projectRoot });
    expect(out.stale).toHaveLength(1);
    expect(out.result?.coverage.total).toBe(0); // hiçbir trusted check koşmadı
    expect(out.decision).toBe("halt_infra"); // blocking stale → insana, yeşil verme
  });
});
