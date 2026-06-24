import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyLedger,
  hashInput,
  ledgerPath,
  lookupVerdict,
  readLedger,
  recordVerdict,
  writeLedgerAtomic,
} from "./verdict-ledger.js";
import type { BankKey } from "./types.js";

const key: BankKey = { checkpoint: "phase-10", stack: "node-npm", artifact: "*" };

describe("hashInput", () => {
  it("deterministik + farklı input → farklı hash", () => {
    expect(hashInput("a")).toBe(hashInput("a"));
    expect(hashInput("a")).not.toBe(hashInput("b"));
  });
});

describe("lookupVerdict — exact hash, fuzzy YOK", () => {
  it("aynı input → kayıtlı karar; farklı input → null (yeniden sor)", () => {
    let l = emptyLedger(key);
    l = recordVerdict(l, { check_id: "c1", input_hash: hashInput("INPUT-A"), verdict: "accept-override", at: 1 });
    expect(lookupVerdict(l, "c1", "INPUT-A")?.verdict).toBe("accept-override");
    expect(lookupVerdict(l, "c1", "INPUT-A-değişti")).toBeNull();
    expect(lookupVerdict(l, "başka-check", "INPUT-A")).toBeNull();
    expect(lookupVerdict(null, "c1", "INPUT-A")).toBeNull();
  });
});

describe("recordVerdict — immutable, aynı anahtar değişir", () => {
  it("aynı (check × input-hash) override edilir, yeni ekle eklenir", () => {
    let l = emptyLedger(key);
    l = recordVerdict(l, { check_id: "c1", input_hash: hashInput("X"), verdict: "accept-once", at: 1 });
    l = recordVerdict(l, { check_id: "c1", input_hash: hashInput("X"), verdict: "real-defect", at: 2 });
    expect(l.entries).toHaveLength(1);
    expect(l.entries[0].verdict).toBe("real-defect");
    l = recordVerdict(l, { check_id: "c2", input_hash: hashInput("X"), verdict: "check-wrong", at: 3 });
    expect(l.entries).toHaveLength(2);
  });
});

describe("ledger depolama", () => {
  it("yaz → oku round-trip; yol deterministik", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qbank-ledger-"));
    const p = ledgerPath(dir, key);
    expect(p).toBe(join(dir, "phase-10", "node-npm", "_all.json"));
    const l = recordVerdict(emptyLedger(key), {
      check_id: "c1",
      input_hash: hashInput("X"),
      verdict: "accept-override",
      at: 1,
    });
    await writeLedgerAtomic(p, l);
    expect(await readLedger(p)).toEqual(l);
  });

  it("olmayan ledger → null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qbank-ledger-"));
    expect(await readLedger(join(dir, "yok.json"))).toBeNull();
  });
});
