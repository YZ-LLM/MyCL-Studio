import { describe, expect, it } from "vitest";
import { isMyclToolBroken, isMissingCommand } from "../src/base/mechanical-runner.js";

// 2026-06-10 (Ümit logları): MyCL'in kendi bozuk aracını PROJE hatası sanıp sqlite3-v6 yükseltmeye çalıştı.
describe("isMyclToolBroken (MyCL kendi aracı bozuk → skip, proje hatası değil)", () => {
  it("bundle path module-not-found → true (csp-check/headers-check çöküşü)", () => {
    expect(
      isMyclToolBroken({
        code: 1,
        stdout: "",
        stderr: "Error: Cannot find module '/Applications/MyCL Studio.app/Contents/Resources/_up_/assets/x'",
      }),
    ).toBe(true);
    expect(
      isMyclToolBroken({ code: 1, stdout: "", stderr: "ERR_MODULE_NOT_FOUND ... /_up_/csp_evaluator" }),
    ).toBe(true);
  });
  it("PROJENİN kendi 'Cannot find module'ı (bare paket/proje yolu) → false (gerçek fail kalır)", () => {
    expect(
      isMyclToolBroken({
        code: 1,
        stdout: "",
        stderr: "Cannot find module 'react' from '/Users/u/adminpanel/src/App.tsx'",
      }),
    ).toBe(false);
  });
  it("alakasız hata → false", () => {
    expect(isMyclToolBroken({ code: 1, stdout: "", stderr: "ESLint found 3 errors" })).toBe(false);
  });
  it("isMissingCommand'dan ayrı (127 ≠ tool-broken)", () => {
    expect(isMyclToolBroken({ code: 127, stdout: "", stderr: "command not found" })).toBe(false);
    expect(isMissingCommand({ code: 127, stdout: "", stderr: "command not found" })).toBe(true);
  });
});

// 2026-06-10 (Ümit): TS-only araç JS projesinde → uygulanamaz (skip), proje hatası değil.
import { isTsToolNotApplicable } from "../src/base/mechanical-runner.js";
describe("isTsToolNotApplicable (TS aracı JS projesinde)", () => {
  it("ts-morph FileNotFoundError → true", () => {
    expect(isTsToolNotApplicable({ code: 1, stdout: "", stderr: "@ts-morph/common ... throw this.getFileNotFoundErrorIfNecessary(err, filePath)" })).toBe(true);
  });
  it("ts-prune + tsconfig not found → true", () => {
    expect(isTsToolNotApplicable({ code: 1, stdout: "", stderr: "ts-prune: could not find a tsconfig.json" })).toBe(true);
  });
  it("normal lint hatası → false (gerçek fail kalır)", () => {
    expect(isTsToolNotApplicable({ code: 1, stdout: "", stderr: "ESLint: 'x' is assigned but never used" })).toBe(false);
  });
});
