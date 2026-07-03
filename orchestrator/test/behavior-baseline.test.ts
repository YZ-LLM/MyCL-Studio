import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { State } from "../src/types.js";
import {
  verifyNoUnconsentedRegression,
  snapshotBehaviorBaseline,
  readBehaviorBaseline,
  acceptRegressionsIntoBaseline,
  type BehaviorBaseline,
} from "../src/behavior-baseline.js";

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "bbaseline-"));
}

describe("verifyNoUnconsentedRegression — SAF", () => {
  it("baseline null → reliable:false (görünür atla)", () => {
    expect(verifyNoUnconsentedRegression(null, "FAIL x")).toEqual({ reliable: false, regressed: [] });
  });

  it("testCmd null (güvenilmez baseline) → reliable:false", () => {
    const b: BehaviorBaseline = { ts: 1, testCmd: null, green: false, failures: [] };
    expect(verifyNoUnconsentedRegression(b, "FAIL x")).toEqual({ reliable: false, regressed: [] });
  });

  it("önceden yeşil, sonra bir test düştü → regressed", () => {
    const b: BehaviorBaseline = { ts: 1, testCmd: "npm test", green: true, failures: [] };
    const { reliable, regressed } = verifyNoUnconsentedRegression(b, "FAIL src/login.test.ts");
    expect(reliable).toBe(true);
    expect(regressed).toEqual(["src/login.test.ts"]);
  });

  it("önceden kırık test yine kırık → regresyon DEĞİL (fix/iterasyon suçu değil)", () => {
    const b: BehaviorBaseline = { ts: 1, testCmd: "npm test", green: false, failures: ["src/old.test.ts"] };
    const { regressed } = verifyNoUnconsentedRegression(b, "FAIL src/old.test.ts");
    expect(regressed).toEqual([]);
  });

  it("bir önceden-kırık + bir YENİ kırık → yalnız yeni regressed", () => {
    const b: BehaviorBaseline = { ts: 1, testCmd: "npm test", green: false, failures: ["src/old.test.ts"] };
    const { regressed } = verifyNoUnconsentedRegression(b, "FAIL src/old.test.ts\nFAIL src/new.test.ts");
    expect(regressed).toEqual(["src/new.test.ts"]);
  });
});

describe("snapshotBehaviorBaseline / readBehaviorBaseline — I/O", () => {
  it("stack yok → resolveMechanicalCmd null → testCmd null, diske yazılır, okunur", async () => {
    const root = await mkTmp();
    const state = { project_root: root } as unknown as State; // stack undefined
    const b = await snapshotBehaviorBaseline(state, 123);
    expect(b.testCmd).toBeNull();
    expect(b.ts).toBe(123);
    const read = await readBehaviorBaseline(root);
    expect(read?.testCmd).toBeNull();
    expect(read?.ts).toBe(123);
  });

  it("baseline dosyası yoksa readBehaviorBaseline → null", async () => {
    expect(await readBehaviorBaseline(await mkTmp())).toBeNull();
  });
});

describe("acceptRegressionsIntoBaseline (mahkeme #2 — regresyon kabulü) ", () => {
  const base: BehaviorBaseline = { ts: 1, testCmd: "npm test", green: false, failures: ["A"] };

  it("regressed'i failures'a ekler (dup elenir), diske yazar", async () => {
    const root = await mkTmp();
    await acceptRegressionsIntoBaseline(root, base, ["B", "A"]);
    const read = await readBehaviorBaseline(root);
    expect(read?.failures.slice().sort()).toEqual(["A", "B"]);
  });

  it("regressed boş → no-op (dosya yazılmaz)", async () => {
    const root = await mkTmp();
    await acceptRegressionsIntoBaseline(root, base, []);
    expect(await readBehaviorBaseline(root)).toBeNull();
  });
});
