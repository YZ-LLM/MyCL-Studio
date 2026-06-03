// isMissingCommand — "komut/araç yok" (skip) vs "gerçek fail" ayrımı.
// v15.10: `npx --no-install <tool>` aracı kurulu değilse skip (örn. Faz 11 ts-prune).

import { describe, expect, it } from "vitest";
import { isMissingCommand } from "../../src/base/mechanical-runner.js";

describe("isMissingCommand", () => {
  const r = (o: Partial<{ code: number; stdout: string; stderr: string }>) => ({
    code: 0,
    stdout: "",
    stderr: "",
    ...o,
  });

  it("code 127 → true (komut yok)", () => {
    expect(isMissingCommand(r({ code: 127 }))).toBe(true);
  });
  it("Missing script → true", () => {
    expect(isMissingCommand(r({ stderr: 'npm error Missing script: "lint"' }))).toBe(true);
  });
  it("command not found → true", () => {
    expect(isMissingCommand(r({ stderr: "sh: ts-prune: command not found" }))).toBe(true);
  });
  it("could not determine executable → true", () => {
    expect(isMissingCommand(r({ stderr: "npm error could not determine executable to run" }))).toBe(true);
  });
  it("v15.10: npx --no-install eksik paket → true (ts-prune kurulu değil = skip)", () => {
    expect(
      isMissingCommand(
        r({
          code: 1,
          stderr: 'npm error npx canceled due to missing packages and no YES option: ["ts-prune@0.10.3"]',
        }),
      ),
    ).toBe(true);
  });
  it("gerçek test/lint fail (araç VAR, çıktı fail) → false (skip DEĞİL)", () => {
    expect(
      isMissingCommand(r({ code: 1, stdout: "2 problems (2 errors)", stderr: "ESLint found errors" })),
    ).toBe(false);
  });
  it("code 0 → false", () => {
    expect(isMissingCommand(r({ code: 0, stdout: "All passed" }))).toBe(false);
  });
});
