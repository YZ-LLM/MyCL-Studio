import { describe, expect, it } from "vitest";
import { isApiAccountError } from "../src/claude-api.js";

describe("isApiAccountError (YZLLM: kredi/hesap hatası ≠ proje hatası, tırmanma/analiz YAPMA)", () => {
  it("credit balance too low → true", () => {
    expect(isApiAccountError("Anthropic API isteği geçersiz: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.")).toBe(true);
  });
  it("auth + permission + quota → true", () => {
    expect(isApiAccountError("Anthropic API anahtarı geçersiz veya yetersiz.")).toBe(true);
    expect(isApiAccountError("permission_error: no access")).toBe(true);
    expect(isApiAccountError("quota exceeded")).toBe(true);
  });
  it("normal proje/derleme hatası → false (escalation/analiz çalışmalı)", () => {
    expect(isApiAccountError("TypeError: cannot read property x of undefined")).toBe(false);
    expect(isApiAccountError("lint failed: 3 errors")).toBe(false);
    expect(isApiAccountError("Anthropic API rate limit aşıldı")).toBe(false); // transient, hesap değil
  });
});

import { isEnvironmentError } from "../src/claude-api.js";
describe("isEnvironmentError (YZLLM: escalation yalnız PROJE hatasında)", () => {
  it("dev-ortam hataları → true (tırmanma YOK)", () => {
    expect(isEnvironmentError("spawn claude E2BIG")).toBe(true);
    expect(isEnvironmentError("listen EADDRINUSE: address already in use :::5173")).toBe(true);
    expect(isEnvironmentError("Your credit balance is too low")).toBe(true); // hesap da ortam
    expect(isEnvironmentError("sh: vite: command not found")).toBe(true);
  });
  it("OS/kaynak errno'ları → true (proje-fix döngüsüne SIZMAZ; 2026-06-22 tıkanma-envanteri)", () => {
    expect(isEnvironmentError("spawn vitest EAGAIN")).toBe(true); // proses/kaynak tükendi
    expect(isEnvironmentError("Cannot allocate memory: ENOMEM")).toBe(true); // OOM
    expect(isEnvironmentError("write ENOSPC: no space left on device")).toBe(true); // disk dolu
    expect(isEnvironmentError("Error: EMFILE: too many open files")).toBe(true); // fd limiti
    expect(isEnvironmentError("EPERM: operation not permitted, open '/x'")).toBe(true); // izin/TCC
    expect(isEnvironmentError("ELOOP: too many symbolic links")).toBe(true); // symlink döngüsü
  });
  it("execCmd [ENV] timeout/spawn işareti → true (code:1'e yıkanan ortam-faultu yakalanır; döngü-kökü)", () => {
    expect(isEnvironmentError("[ENV] command timed out / process killed after 60000ms (no exit code) — Command failed")).toBe(true);
    expect(isEnvironmentError("[ENV] spawn failed (EAGAIN) — Command failed: vitest")).toBe(true);
  });
  it("proje/kod hatası → false (tırmanma ÇALIŞIR)", () => {
    expect(isEnvironmentError("TypeError: x is not a function")).toBe(false);
    expect(isEnvironmentError("Test failed: expected 3 got 5")).toBe(false);
    expect(isEnvironmentError("lint: 'foo' is assigned but never used")).toBe(false);
  });
});

import { isSpawnEnvFailure } from "../src/base/mechanical-runner.js";
describe("isSpawnEnvFailure (testler KOŞMADI = tdd-unverified; fix-döngüsü tetiklenmez)", () => {
  const r = (stderr: string) => ({ code: 1, stdout: "", stderr });
  it("E2BIG/ENOMEM/EAGAIN/posix_spawn → true", () => {
    expect(isSpawnEnvFailure(r("spawn vitest E2BIG"))).toBe(true);
    expect(isSpawnEnvFailure(r("Cannot allocate memory ENOMEM"))).toBe(true);
    expect(isSpawnEnvFailure(r("spawn node EAGAIN"))).toBe(true);
  });
  it("execCmd [ENV] timeout/spawn işareti → true (errno metni olmayan timeout yakalanır)", () => {
    expect(isSpawnEnvFailure(r("[ENV] command timed out / process killed after 60000ms (no exit code)"))).toBe(true);
    expect(isSpawnEnvFailure(r("[ENV] spawn failed (ENOMEM) — x"))).toBe(true);
  });
  it("gerçek proje fail (lint/test) → false (fix-döngüsü ÇALIŞMALI)", () => {
    expect(isSpawnEnvFailure(r("2 problems (2 errors, 0 warnings)"))).toBe(false);
    expect(isSpawnEnvFailure(r("AssertionError: expected 3 to equal 5"))).toBe(false);
  });
});
