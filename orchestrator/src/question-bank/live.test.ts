import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBankGate } from "./gate.js";
import { runBankGateLive } from "./live.js";
import { createCmdRunner } from "./runner.js";
import { questionBanksRoot } from "../phase-registry.js";
import type { State } from "../types.js";

const liveBase = {
  banksRoot: questionBanksRoot(),
  checkpoint: "phase-10",
  stack: "node-npm" as const,
  changedFiles: [] as string[],
  profile: null,
  runner: createCmdRunner(),
  stabilityRuns: 1,
};

async function projWithPkg(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qbank-live-proj-"));
  await writeFile(join(dir, "package.json"), content, "utf-8");
  return dir;
}

describe("demo banka — gerçek node check uçtan uca", () => {
  it("geçerli package.json → green (demo soru PASS)", async () => {
    const projectRoot = await projWithPkg('{ "name": "x", "version": "1.0.0" }');
    const out = await runBankGate({ ...liveBase, projectRoot });
    expect(out.decision).toBe("green");
    expect(out.result?.coverage.pass).toBe(1);
  });

  it("bozuk package.json → halt_defect (blocking demo soru FAIL)", async () => {
    const projectRoot = await projWithPkg("{ bozuk json");
    const out = await runBankGate({ ...liveBase, projectRoot });
    expect(out.decision).toBe("halt_defect");
  });
});

describe("runBankGateLive — adaptör", () => {
  it("stack unknown → null (atla)", async () => {
    const s = { stack: "unknown", project_root: tmpdir() } as unknown as State;
    expect(await runBankGateLive(s, 10)).toBeNull();
  });

  it("node-npm + geçerli pkg → outcome döner (green)", async () => {
    const projectRoot = await projWithPkg('{ "name": "x" }');
    const s = {
      stack: "node-npm",
      project_root: projectRoot,
      changed_scope: undefined,
    } as unknown as State;
    const out = await runBankGateLive(s, 10);
    expect(out?.decision).toBe("green");
  });
});
