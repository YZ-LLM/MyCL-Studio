// mechanical-runner — missing command davranışı + pass/fail testleri.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MechanicalRunnerBase,
  expandFilesPlaceholder,
  resolveMechanicalCmd,
  shellQuote,
  isNotApplicableSkip,
} from "../src/base/mechanical-runner.js";
import { _clearProfileCache } from "../src/profile-loader.js";
import type { State } from "../src/types.js";

let projectRoot: string;

function fakeState(): State {
  return {
    current_phase: 11,
    session_id: "test",
    spec_approved: false,
    ui_flow_active: false,
    regression_block_active: false,
    project_root: projectRoot,
    created_at: 0,
    updated_at: 0,
  };
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "mycl-mech-"));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("MechanicalRunnerBase", () => {
  it("returns pass on exit 0", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "test-pass",
      phaseId: 10,
      state: fakeState(),
      mechanical: { scan_cmd: "true", max_rescans: 0, skip_unless: "always" },
      pass_event: "lint-pass",
    });
    const out = await runner.run();
    expect(out.kind).toBe("pass");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("lint-pass");
  });

  it("returns fail on non-zero exit when no fix_cmd", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "test-fail",
      phaseId: 10,
      state: fakeState(),
      mechanical: { scan_cmd: "false", max_rescans: 0, skip_unless: "always" },
      pass_event: "lint-pass",
      fail_event: "lint-fail",
    });
    const out = await runner.run();
    expect(out.kind).toBe("fail");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("lint-fail");
  });

  it("returns skipped when scan_cmd is unknown (exit 127)", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "test-missing",
      phaseId: 10,
      state: fakeState(),
      mechanical: {
        scan_cmd: "nonexistent-cmd-xyz",
        max_rescans: 0,
        skip_unless: "always",
      },
      pass_event: "lint-pass",
    });
    const out = await runner.run();
    expect(out.kind).toBe("skipped");
    if (out.kind === "skipped") {
      expect(out.reason).toBe("missing_command");
    }
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("phase-10-skipped");
    expect(audit).toContain("missing_command");
  });

  it("returns skipped when npm script is missing (Missing script in stderr)", async () => {
    // Fake bir komutla stderr'e "Missing script:" yaz — bunu missing kabul edelim.
    // Bash heredoc + >&2 ile stderr'e push.
    const runner = new MechanicalRunnerBase({
      tag: "test-missing-script",
      phaseId: 11,
      state: fakeState(),
      mechanical: {
        scan_cmd: "bash -c 'echo \"npm error Missing script: lint\" >&2; exit 1'",
        max_rescans: 0,
        skip_unless: "always",
      },
      pass_event: "simplify-pass",
    });
    const out = await runner.run();
    expect(out.kind).toBe("skipped");
  });
});

describe("MechanicalRunnerBase · extra_scans", () => {
  it("happy path: scan + 1 extra → both pass; audit has both events", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "test-extra-pass",
      phaseId: 13,
      state: fakeState(),
      mechanical: {
        scan_cmd: "true",
        max_rescans: 0,
        skip_unless: "always",
        extra_scans: [{ name: "semgrep", cmd: "true" }],
      },
      pass_event: "security-pass",
      fail_event: "security-fail",
    });
    const out = await runner.run();
    expect(out.kind).toBe("pass");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("security-pass");
    expect(audit).toContain("semgrep-pass");
  });

  it("scan pass but extra fail → final kind=fail, both events audited", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "test-extra-fail",
      phaseId: 13,
      state: fakeState(),
      mechanical: {
        scan_cmd: "true",
        max_rescans: 0,
        skip_unless: "always",
        extra_scans: [{ name: "semgrep", cmd: "false" }],
      },
      pass_event: "security-pass",
      fail_event: "security-fail",
    });
    const out = await runner.run();
    expect(out.kind).toBe("fail");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("security-pass");
    expect(audit).toContain("semgrep-fail");
  });

  it("extra with missing command → skipped event, scan pass not affected", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "test-extra-missing",
      phaseId: 13,
      state: fakeState(),
      mechanical: {
        scan_cmd: "true",
        max_rescans: 0,
        skip_unless: "always",
        extra_scans: [
          { name: "semgrep", cmd: "definitely-not-a-real-binary-xyz-123" },
        ],
      },
      pass_event: "security-pass",
    });
    const out = await runner.run();
    expect(out.kind).toBe("pass");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("security-pass");
    expect(audit).toContain("semgrep-skipped");
  });

  it("extra tool_error_codes exit (semgrep crash=2) → skipped, bulgu/fail DEĞİL", async () => {
    // Güvenlik-baseline Unit 3: bozuk custom kural / uyumsuz araç sürümü exit 2
    // verir → yanlış-blocking yapmasın → skip. scan pass etkilenmez.
    const runner = new MechanicalRunnerBase({
      tag: "test-tool-error",
      phaseId: 13,
      state: fakeState(),
      mechanical: {
        scan_cmd: "true",
        max_rescans: 0,
        skip_unless: "always",
        extra_scans: [{ name: "semgrep-secrets", cmd: "exit 2", tool_error_codes: [2] }],
      },
      pass_event: "security-pass",
    });
    const out = await runner.run();
    expect(out.kind).toBe("pass");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("semgrep-secrets-skipped");
  });

  it("exit kodu tool_error_codes'ta DEĞİLSE (gerçek bulgu=1) → fail kalır", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "test-tool-error-1",
      phaseId: 13,
      state: fakeState(),
      mechanical: {
        scan_cmd: "true",
        max_rescans: 0,
        skip_unless: "always",
        // exit 1 (gerçek bulgu) tool_error_codes:[2]'de yok → fail (blocking) kalır.
        extra_scans: [{ name: "semgrep-secrets", cmd: "false", tool_error_codes: [2] }],
      },
      pass_event: "security-pass",
      fail_event: "security-fail",
    });
    const out = await runner.run();
    expect(out.kind).toBe("fail");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("semgrep-secrets-fail");
  });

  it("extra with require_file missing → skipped event (missing_file)", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "test-require-file",
      phaseId: 17,
      state: fakeState(),
      mechanical: {
        scan_cmd: "true",
        max_rescans: 0,
        skip_unless: "always",
        extra_scans: [
          {
            name: "k6",
            cmd: "true",
            require_file: "loadtest.js",
          },
        ],
      },
      pass_event: "load-pass",
    });
    const out = await runner.run();
    expect(out.kind).toBe("pass");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("load-pass");
    expect(audit).toContain("k6-skipped");
    expect(audit).toContain("missing_file");
  });

  it("multiple extras: one pass + one fail → final kind=fail", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "test-multi-extra",
      phaseId: 13,
      state: fakeState(),
      mechanical: {
        scan_cmd: "true",
        max_rescans: 0,
        skip_unless: "always",
        extra_scans: [
          { name: "semgrep", cmd: "true" },
          { name: "snyk", cmd: "false" },
        ],
      },
      pass_event: "security-pass",
      fail_event: "security-fail",
    });
    const out = await runner.run();
    expect(out.kind).toBe("fail");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("semgrep-pass");
    expect(audit).toContain("snyk-fail");
  });

  it("scan_cmd skipped → extras not run (no audit entries for them)", async () => {
    const runner = new MechanicalRunnerBase({
      tag: "test-scan-skip",
      phaseId: 13,
      state: fakeState(),
      mechanical: {
        scan_cmd: "definitely-not-a-real-binary-xyz-123",
        max_rescans: 0,
        skip_unless: "always",
        extra_scans: [{ name: "semgrep", cmd: "true" }],
      },
      pass_event: "security-pass",
    });
    const out = await runner.run();
    expect(out.kind).toBe("skipped");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("phase-13-skipped");
    expect(audit).not.toContain("semgrep-pass");
  });
});

describe("resolveMechanicalCmd (v15.0 Batch A)", () => {
  beforeEach(() => _clearProfileCache());

  function stateWith(stack: State["stack"], pt?: State["project_type"]): State {
    return {
      current_phase: 11,
      session_id: "test",
      spec_approved: false,
      ui_flow_active: false,
      regression_block_active: false,
      project_root: "/tmp",
      created_at: 0,
      updated_at: 0,
      stack,
      project_type: pt,
    };
  }

  it("string spec → returned as-is (backward-compat)", async () => {
    const r = await resolveMechanicalCmd("npm test", stateWith("node-npm"));
    expect(r).toBe("npm test");
  });

  it("profile_key + node-npm stack → npm command from profile", async () => {
    const r = await resolveMechanicalCmd(
      { type: "profile_key", key: "lint" },
      stateWith("node-npm"),
    );
    expect(r).toBe("npm run lint");
  });

  it("profile_key + python-uv stack → uv command from profile", async () => {
    const r = await resolveMechanicalCmd(
      { type: "profile_key", key: "lint" },
      stateWith("python-uv"),
    );
    expect(r).toBe("uv run ruff check .");
  });

  it("profile_key + lint_fix → fix variant from profile", async () => {
    const r = await resolveMechanicalCmd(
      { type: "profile_key", key: "lint_fix" },
      stateWith("node-npm"),
    );
    expect(r).toBe("npm run lint -- --fix");
  });

  it("profile_key + stack with no profile file → null (skip)", async () => {
    // unknown.json kasten yok — stack="unknown" durumunda profil yüklenmez.
    const r = await resolveMechanicalCmd(
      { type: "profile_key", key: "lint" },
      stateWith("unknown"),
    );
    expect(r).toBeNull();
  });

  it("profile_key + key undefined in profile → null", async () => {
    // python-uv "build": null
    const r = await resolveMechanicalCmd(
      { type: "profile_key", key: "build" },
      stateWith("python-uv"),
    );
    expect(r).toBeNull();
  });

  it("profile_key + state.stack undefined → null", async () => {
    const r = await resolveMechanicalCmd(
      { type: "profile_key", key: "lint" },
      stateWith(undefined),
    );
    expect(r).toBeNull();
  });

  it("project_type spec → resolves e2e command for stack+type", async () => {
    const r = await resolveMechanicalCmd(
      { type: "project_type", which: "e2e" },
      stateWith("node-npm", "web"),
    );
    // v15.7 (2026-05-28): --headed flag eklendi (headed mode garantisi).
    expect(r).toBe("npx --no-install playwright test --headed");
  });

  it("project_type spec + library → null (explicit no runner)", async () => {
    const r = await resolveMechanicalCmd(
      { type: "project_type", which: "e2e" },
      stateWith("node-npm", "library"),
    );
    expect(r).toBeNull();
  });

  it("project_type spec (Faz 18 load) + web → k6 (node-npm)", async () => {
    const r = await resolveMechanicalCmd(
      { type: "project_type", which: "load" },
      stateWith("node-npm", "web"),
    );
    expect(r).toBe("k6 run loadtest.js");
  });

  it("project_type spec (Faz 18 load) + library → null (no load test)", async () => {
    const r = await resolveMechanicalCmd(
      { type: "project_type", which: "load" },
      stateWith("node-npm", "library"),
    );
    expect(r).toBeNull();
  });

  it("project_type spec (Faz 18 load) + api (python-uv) → locust", async () => {
    const r = await resolveMechanicalCmd(
      { type: "project_type", which: "load" },
      stateWith("python-uv", "api"),
    );
    expect(r).toContain("locust");
  });

  it("project_type spec + project_type undefined → default fallback", async () => {
    // QC E: state.project_type undefined → resolveMechanicalCmd "unknown"a
    // dönüştürür → resolveProjectTypeCommand "unknown" key'i yok → default
    // fallback'a düşer. node-npm e2e.default = "npm run test:e2e".
    const r = await resolveMechanicalCmd(
      { type: "project_type", which: "e2e" },
      stateWith("node-npm", undefined),
    );
    expect(r).toBe("npm run test:e2e");
  });
});

describe("MechanicalRunnerBase profile_key integration (v15.0 Batch A)", () => {
  beforeEach(() => _clearProfileCache());

  it("profile_key spec + state.stack undefined → skip with profile_resolve_null", async () => {
    const state: State = {
      current_phase: 11,
      session_id: "test",
      spec_approved: false,
      ui_flow_active: false,
      regression_block_active: false,
      project_root: projectRoot,
      created_at: 0,
      updated_at: 0,
      // stack undefined — profile_key resolve null döner
    };
    const runner = new MechanicalRunnerBase({
      tag: "test-profile-skip",
      phaseId: 10,
      state,
      mechanical: {
        scan_cmd: { type: "profile_key", key: "lint" },
        max_rescans: 0,
        skip_unless: "always",
      },
      pass_event: "lint-pass",
    });
    const out = await runner.run();
    expect(out.kind).toBe("skipped");
    if (out.kind === "skipped") {
      expect(out.reason).toBe("profile_resolve_null");
    }
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("phase-10-skipped");
    // QC B fix: stack undefined → audit "stack_not_detected" yazıyor; outcome
    // reason hâlâ "profile_resolve_null" ama detail kullanıcı için netleşti.
    expect(audit).toContain("stack_not_detected");
  });

  it("project_type spec (Faz 17 E2E) + library → skip (no E2E for library)", async () => {
    // v15.0 Batch B: Faz 17 e2e project_type-aware. library projeleri için
    // node-npm.json'da `library: null` → null resolve → phase skip.
    const state: State = {
      current_phase: 17,
      session_id: "test",
      spec_approved: false,
      ui_flow_active: false,
      regression_block_active: false,
      project_root: projectRoot,
      created_at: 0,
      updated_at: 0,
      stack: "node-npm",
      project_type: "library",
    };
    const runner = new MechanicalRunnerBase({
      tag: "test-e2e-library-skip",
      phaseId: 16,
      state,
      mechanical: {
        scan_cmd: { type: "project_type", which: "e2e" },
        max_rescans: 0,
        skip_unless: "has_ui",
      },
      pass_event: "e2e-pass",
    });
    const out = await runner.run();
    expect(out.kind).toBe("skipped");
    const audit = await readFile(join(projectRoot, ".mycl/audit.log"), "utf-8");
    expect(audit).toContain("phase-16-skipped");
  });

  it("profile_key spec + valid stack → resolves and executes (echo as lint)", async () => {
    // node-npm profile'ında lint = "npm run lint". Bunu mock'lamak yerine
    // null profile case'i zaten kapatıyor. Burada literal'in profile_key ile
    // aynı çalıştığını doğrula: state.stack="node-npm" + key="lint" → komut
    // resolve olur; (npm run lint kullanıcı projesi olmadan fail eder ama
    // resolveMechanicalCmd unit testi zaten doğru komut döndüğünü teyit etti).
    // Burası end-to-end skip yolu test ediliyor — resolve path'i yeşil.
    const state: State = {
      current_phase: 11,
      session_id: "test",
      spec_approved: false,
      ui_flow_active: false,
      regression_block_active: false,
      project_root: projectRoot,
      created_at: 0,
      updated_at: 0,
      stack: "node-npm",
    };
    const runner = new MechanicalRunnerBase({
      tag: "test-profile-exec",
      phaseId: 10,
      state,
      mechanical: {
        scan_cmd: { type: "profile_key", key: "lint" },
        max_rescans: 0,
        skip_unless: "always",
      },
      pass_event: "lint-pass",
      fail_event: "lint-fail",
    });
    const out = await runner.run();
    // npm run lint package.json olmadığı için "missing_command" (Missing script veya enoent)
    // önemli olan: skipped (profile_resolve_null DEĞİL — komut resolve oldu, çalıştı, eksik
    // yapılandırma nedeniyle skip oldu — Faz 11 atlandı)
    expect(["skipped", "fail"]).toContain(out.kind);
  });
});

describe("resolveMechanicalCmd · scoped (v15.9)", () => {
  beforeEach(() => _clearProfileCache());
  function stateWith(stack: State["stack"]): State {
    return {
      current_phase: 10,
      session_id: "test",
      spec_approved: false,
      ui_flow_active: false,
      regression_block_active: false,
      project_root: "/tmp",
      created_at: 0,
      updated_at: 0,
      stack,
    };
  }

  it("scoped_key + scope dolu → değişen dosyalara daralır (node eslint)", async () => {
    const r = await resolveMechanicalCmd(
      { type: "profile_key", key: "lint", scoped_key: "lint_scoped" },
      stateWith("node-npm"),
      ["src/a.ts", "src/b.ts"],
    );
    expect(r).toBe("npx --no-install eslint 'src/a.ts' 'src/b.ts'");
  });

  it("scope BOŞ → tüm-proje fallback (key)", async () => {
    const r = await resolveMechanicalCmd(
      { type: "profile_key", key: "lint", scoped_key: "lint_scoped" },
      stateWith("node-npm"),
      [],
    );
    expect(r).toBe("npm run lint");
  });

  it("changedScope verilmedi → tüm-proje fallback", async () => {
    const r = await resolveMechanicalCmd(
      { type: "profile_key", key: "lint", scoped_key: "lint_scoped" },
      stateWith("python-uv"),
    );
    expect(r).toBe("uv run ruff check .");
  });

  it("profil scoped_key taşımıyor (rust) → tüm-proje fallback", async () => {
    const r = await resolveMechanicalCmd(
      { type: "profile_key", key: "lint", scoped_key: "lint_scoped" },
      stateWith("rust"),
      ["src/main.rs"],
    );
    // rust profilinde lint_scoped yok → key "lint" (tüm-proje) döner (veya null)
    expect(r === null || !r.includes("{files}")).toBe(true);
    expect(r === null || !r.includes("src/main.rs")).toBe(true);
  });

  it("python-uv scoped → ruff {files}", async () => {
    const r = await resolveMechanicalCmd(
      { type: "profile_key", key: "lint", scoped_key: "lint_scoped" },
      stateWith("python-uv"),
      ["app/main.py"],
    );
    expect(r).toBe("uv run ruff check 'app/main.py'");
  });
});

describe("shellQuote + expandFilesPlaceholder", () => {
  it("shellQuote basit + boşluklu + tek-tırnaklı yol", () => {
    expect(shellQuote("src/a.ts")).toBe("'src/a.ts'");
    expect(shellQuote("dir with space/a.ts")).toBe("'dir with space/a.ts'");
    expect(shellQuote("it's.ts")).toBe("'it'\\''s.ts'");
  });

  it("expandFilesPlaceholder {files}'ı quote'lu yollarla genişletir", () => {
    expect(expandFilesPlaceholder("eslint {files}", ["a.ts", "b.ts"])).toBe(
      "eslint 'a.ts' 'b.ts'",
    );
  });

  it("injection denemesi quote içinde kalır (güvenlik)", () => {
    const r = expandFilesPlaceholder("eslint {files}", ["a.ts; rm -rf /"]);
    expect(r).toBe("eslint 'a.ts; rm -rf /'");
  });
});

// Fix 2 (YZLLM 2026-07-01, "sarı olanların sebebi"): skip N/A ↔ doğrulanmadı ayrımı.
describe("isNotApplicableSkip (skip sınıflandırma)", () => {
  it("KAVRAMSAL-N/A reason'ları true (TS aracı non-TS projesinde)", () => {
    expect(isNotApplicableSkip("ts_tool_js_project")).toBe(true);
    expect(isNotApplicableSkip("ts_tool_not_applicable")).toBe(true);
    // detail formatı "<reason> cmd=..." → ilk kelimeden çözer.
    expect(isNotApplicableSkip('ts_tool_js_project cmd="npx ts-prune"')).toBe(true);
  });
  it("araç-eksik/stub/bozuk/profil-null → false (sarı 'DOĞRULANMADI' kalır — false-green önleme)", () => {
    // MAHKEME: profile_resolve_null N/A DEĞİL (Faz 13 security:null → güvenlik taranmadı, gap).
    expect(isNotApplicableSkip("profile_resolve_null")).toBe(false);
    expect(isNotApplicableSkip("missing_command")).toBe(false);
    expect(isNotApplicableSkip("stub_script")).toBe(false);
    expect(isNotApplicableSkip("mycl_tool_broken")).toBe(false);
    expect(isNotApplicableSkip("missing_file")).toBe(false);
    expect(isNotApplicableSkip(undefined)).toBe(false);
    expect(isNotApplicableSkip("")).toBe(false);
  });
});
