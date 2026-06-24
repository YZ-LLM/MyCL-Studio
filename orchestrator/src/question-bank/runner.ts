// İkili Soru Bankası — gerçek CmdRunner (I/O, Dilim 3a).
//
// Bir check komutunu hedef cwd'de exec eder; base/mechanical-runner.ts'in exec
// desenini aynalar (promisify(exec) + cwd + timeout + safeEnv). Slice-2 lock
// motoruna ve slice-3 gate'e enjekte edilir.
//
// Exit kodu normalleştirme — INCONCLUSIVE'e maplenecek durumlar SAYISAL koda
// çevrilir (classifyExit yorumlar): timeout/kill → 124, spawn/env-fault
// (ENOENT/E2BIG/EAGAIN/ENOMEM) → 127. Böylece "değerlendirilemedi" ASLA sessizce
// PASS olmaz (katı kural #4: sessiz-fallback yok).

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { safeEnv } from "../safe-env.js";
import type { CmdRunResult, CmdRunner } from "./lock.js";

const execp = promisify(exec);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export interface RealRunnerOpts {
  timeoutMs?: number;
  maxBuffer?: number;
}

/** exec hatasını {code,...}'a normalleştir — sayısal kod classifyExit'e gider. */
export function normalizeExecError(err: unknown): CmdRunResult {
  const e = err as {
    code?: number | string;
    killed?: boolean;
    signal?: string;
    stdout?: unknown;
    stderr?: unknown;
  };
  const stdout = e.stdout != null ? String(e.stdout) : "";
  const stderr = e.stderr != null ? String(e.stderr) : "";
  // timeout / sinyalle öldürüldü → 124 (değerlendirilemedi, INCONCLUSIVE)
  if (e.killed || e.signal === "SIGTERM" || e.signal === "SIGKILL") {
    return { code: 124, stdout, stderr };
  }
  // spawn/env-fault: errno string (ENOENT/E2BIG/EAGAIN/ENOMEM) → 127 (çalıştırılamadı)
  if (typeof e.code === "string") {
    return { code: 127, stdout, stderr };
  }
  // normal nonzero exit
  if (typeof e.code === "number") {
    return { code: e.code, stdout, stderr };
  }
  // bilinmeyen → 127 (fail-closed: yeşile çökme yok)
  return { code: 127, stdout, stderr };
}

/** Gerçek exec-tabanlı CmdRunner üret. */
export function createCmdRunner(opts: RealRunnerOpts = {}): CmdRunner {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return async (cmd: string, cwd: string): Promise<CmdRunResult> => {
    try {
      const { stdout, stderr } = await execp(cmd, {
        cwd,
        timeout,
        maxBuffer,
        env: safeEnv(),
      });
      return { code: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (err) {
      return normalizeExecError(err);
    }
  };
}
