import { describe, expect, it } from "vitest";
import {
  isMyclToolBroken,
  isMissingCommand,
  invokesMyclTool,
  invokesTsOnlyTool,
} from "../src/base/mechanical-runner.js";

const TOOL_DIR = "/Applications/MyCL Studio.app/Contents/Resources/_up_/orchestrator";
const OWN = `node "${TOOL_DIR}/csp-check.mjs"`;
const TSPRUNE = "npx --no-install ts-prune";

// 2026-06-10 (YZLLM logları): MyCL'in kendi bozuk aracını PROJE hatası sanıp sqlite3-v6 yükseltmeye çalıştı.
describe("isMyclToolBroken (MyCL kendi aracı bozuk → skip, proje hatası değil)", () => {
  it("bundle path module-not-found → true (csp-check/headers-check çöküşü)", () => {
    expect(
      isMyclToolBroken({
        code: 1,
        stdout: "",
        stderr: "Error: Cannot find module '/Applications/MyCL Studio.app/Contents/Resources/_up_/assets/x'",
      }, OWN, TOOL_DIR),
    ).toBe(true);
    expect(
      isMyclToolBroken({ code: 1, stdout: "", stderr: "ERR_MODULE_NOT_FOUND ... /_up_/csp_evaluator" }, OWN, TOOL_DIR),
    ).toBe(true);
  });
  it("PROJENİN kendi 'Cannot find module'ı (bare paket/proje yolu) → false (gerçek fail kalır)", () => {
    expect(
      isMyclToolBroken({
        code: 1,
        stdout: "",
        stderr: "Cannot find module 'react' from '/Users/u/adminpanel/src/App.tsx'",
      }, OWN, TOOL_DIR),
    ).toBe(false);
  });
  it("alakasız hata → false", () => {
    expect(isMyclToolBroken({ code: 1, stdout: "", stderr: "ESLint found 3 errors" }, OWN, TOOL_DIR)).toBe(false);
  });
  // KAÇIŞ YOLU AVI (2026-11-26): sınıflandırma yalnız MyCL'in KENDİ aracı koşturulduysa yapılır. Projenin test
  // komutunun çıktısında aynı metin geçmesi (iddia iletisi, günlük satırı) kapıyı atlatamaz.
  it("PROJE komutunun çıktısında aynı metin geçse de → false (kapı atlanmaz)", () => {
    const out = "AssertionError: expected \"Cannot find module '/Applications/MyCL Studio.app/Contents/x'\" to be ''";
    expect(isMyclToolBroken({ code: 1, stdout: out, stderr: "" }, "npm test")).toBe(false);
    expect(isMyclToolBroken({ code: 1, stdout: out, stderr: "" }, "npx vitest run")).toBe(false);
    expect(invokesMyclTool(OWN, TOOL_DIR)).toBe(true);
    // Biçime değil KONUMA bakılır: projenin kendi .mjs betiği MyCL aracı değildir (~/Applications altında olsa da).
    expect(invokesMyclTool("node scripts/check.mjs", TOOL_DIR)).toBe(false);
    expect(invokesMyclTool('node "/Users/u/Applications/proj/scripts/check.mjs"', TOOL_DIR)).toBe(false);
    expect(invokesMyclTool(`node "${TOOL_DIR}/alt/x.mjs"`, TOOL_DIR)).toBe(false);
    expect(
      isMyclToolBroken(
        { code: 1, stdout: "", stderr: 'Error: Cannot find module "/Users/u/Applications/proj/lib/x.js"' },
        "node scripts/check.mjs",
        TOOL_DIR,
      ),
    ).toBe(false);
    // Varsayılan dizin gerçek orchestrator köküdür: oradaki bir araç tanınır.
    expect(invokesMyclTool(`node "${process.cwd()}/csp-check.mjs"`)).toBe(true);
  });
  it("isMissingCommand'dan ayrı (127 ≠ tool-broken)", () => {
    expect(isMyclToolBroken({ code: 127, stdout: "", stderr: "command not found" }, OWN, TOOL_DIR)).toBe(false);
    expect(isMissingCommand({ code: 127, stdout: "", stderr: "command not found" })).toBe(true);
  });
});

// 2026-06-10 (YZLLM): TS-only araç JS projesinde → uygulanamaz (skip), proje hatası değil.
import { isTsToolNotApplicable } from "../src/base/mechanical-runner.js";
describe("isTsToolNotApplicable (TS aracı JS projesinde)", () => {
  it("ts-morph FileNotFoundError → true", () => {
    expect(isTsToolNotApplicable({ code: 1, stdout: "", stderr: "@ts-morph/common ... throw this.getFileNotFoundErrorIfNecessary(err, filePath)" }, TSPRUNE)).toBe(true);
  });
  it("ts-prune + tsconfig not found → true", () => {
    expect(isTsToolNotApplicable({ code: 1, stdout: "", stderr: "ts-prune: could not find a tsconfig.json" }, TSPRUNE)).toBe(true);
  });
  it("normal lint hatası → false (gerçek fail kalır)", () => {
    expect(isTsToolNotApplicable({ code: 1, stdout: "", stderr: "ESLint: 'x' is assigned but never used" }, TSPRUNE)).toBe(false);
  });
  // KAÇIŞ YOLU AVI (2026-11-26, YÜKSEK): başarısız vitest / eslint çıktısında "tsc" ve "FileNotFoundError"
  // sözcükleri geçince kapı nötr "uygulanamaz" sayılıp atlanıyor, hüküm GEÇTİ çıkıyordu.
  it("TEST ya da LINT komutunun çıktısında sihirli sözcükler geçse de → false", () => {
    const vitestFail = " FAIL  sum.test.js > sum adds (tsc FileNotFoundError guard)\n Tests  1 failed (1)";
    const eslintOut = "  3:7  error  'tsc' is assigned a value but never used\n  4:7  error  'FileNotFoundError' is defined but never used";
    expect(isTsToolNotApplicable({ code: 1, stdout: vitestFail, stderr: "" }, "npm test")).toBe(false);
    expect(isTsToolNotApplicable({ code: 1, stdout: vitestFail, stderr: "" }, "npx vitest run")).toBe(false);
    expect(isTsToolNotApplicable({ code: 1, stdout: eslintOut, stderr: "" }, "npm run lint")).toBe(false);
    expect(isTsToolNotApplicable({ code: 1, stdout: eslintOut, stderr: "" }, "npx eslint .")).toBe(false);
  });
  it("araç başarıyla çıktıysa (kod 0) uygulanamaz denmez; komut tanıma", () => {
    expect(isTsToolNotApplicable({ code: 0, stdout: "ts-prune: could not find a tsconfig.json", stderr: "" }, TSPRUNE)).toBe(false);
    expect(invokesTsOnlyTool("npx --no-install ts-prune")).toBe(true);
    expect(invokesTsOnlyTool("npx tsc --noEmit")).toBe(true);
    expect(invokesTsOnlyTool("./node_modules/.bin/tsc -p .")).toBe(true);
    expect(invokesTsOnlyTool("npm test")).toBe(false);
    expect(invokesTsOnlyTool("npx vitest run src/tsconfig.test.ts")).toBe(false);
    expect(invokesTsOnlyTool("node scripts/etsc.js")).toBe(false);
    // Yalnız ÇALIŞTIRILAN programın adı: bağımsız değişkendeki yol parçası ya da betik adı araç değildir.
    expect(invokesTsOnlyTool("vitest run src/tsc")).toBe(false);
    expect(invokesTsOnlyTool('eslint "bin/tsc"')).toBe(false);
    expect(invokesTsOnlyTool("npm run tsc:check")).toBe(false);
    expect(invokesTsOnlyTool("pnpm exec tsc --noEmit")).toBe(true);
    expect(invokesTsOnlyTool("yarn tsc -p .")).toBe(true);
  });
});

// 2026-06-11 (YZLLM "1 saniyede geçti — normal mi?"): echo-stub gate + tsconfig-kalıntılı JS projesi.
import { isStubGateCommand } from "../src/base/mechanical-runner.js";
describe("isStubGateCommand (echo-stub gate = doğrulama değil)", () => {
  it("echo 'perf check passed' → stub", () => {
    expect(isStubGateCommand("vite build --mode production && echo 'perf check passed'")).toBe(true);
    expect(isStubGateCommand('echo "ok"')).toBe(true);
  });
  it("gerçek komutlar → stub değil", () => {
    expect(isStubGateCommand("vitest run")).toBe(false);
    expect(isStubGateCommand("eslint . --max-warnings 0")).toBe(false);
    expect(isStubGateCommand("npx ts-prune --error")).toBe(false);
  });
});
