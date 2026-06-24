import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { createCmdRunner, normalizeExecError } from "./runner.js";

const cwd = tmpdir();

describe("createCmdRunner — gerçek exec", () => {
  it("exit 0 → code 0", async () => {
    const run = createCmdRunner();
    expect((await run("exit 0", cwd)).code).toBe(0);
  });

  it("nonzero exit → gerçek kod (3)", async () => {
    const run = createCmdRunner();
    expect((await run("exit 3", cwd)).code).toBe(3);
  });

  it("komut yok → 127 (shell not-found → INCONCLUSIVE'e gider)", async () => {
    const run = createCmdRunner();
    expect((await run("this_cmd_does_not_exist_zzz", cwd)).code).toBe(127);
  });

  it("timeout → 124 (değerlendirilemedi)", async () => {
    const run = createCmdRunner({ timeoutMs: 50 });
    expect((await run("sleep 2", cwd)).code).toBe(124);
  });
});

describe("normalizeExecError", () => {
  it("killed/SIGTERM → 124", () => {
    expect(normalizeExecError({ killed: true }).code).toBe(124);
    expect(normalizeExecError({ signal: "SIGKILL" }).code).toBe(124);
  });

  it("errno string (ENOENT/E2BIG) → 127", () => {
    expect(normalizeExecError({ code: "ENOENT" }).code).toBe(127);
    expect(normalizeExecError({ code: "E2BIG" }).code).toBe(127);
  });

  it("sayısal exit kodu korunur", () => {
    expect(normalizeExecError({ code: 2 }).code).toBe(2);
  });

  it("bilinmeyen → 127 (fail-closed)", () => {
    expect(normalizeExecError({}).code).toBe(127);
  });
});
