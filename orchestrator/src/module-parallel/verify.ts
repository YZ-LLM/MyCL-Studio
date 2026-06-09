// module-parallel/verify — Çoklu Ajan Seçimi paralel build SONRASI kalite kapıları.
//
// Paralel yazılan kodu "yazıldı" bırakmayız → typecheck + lint + test (stack profilinden) koşulur. Profilde komut
// yoksa o kapı atlanır (skip, fail değil). Hız fazlarının (Faz 10-17) tam pipeline'ı yerine LEAN doğrulama —
// "paralel kod gerçekten derleniyor/çalışıyor mu" sorusunu yanıtlar. Güvenlik (semgrep) sonraki artım.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { loadProfile, resolveCommand, type ProfileCommandKey } from "../profile-loader.js";
import { safeEnv } from "../safe-env.js";
import type { State } from "../types.js";

const execp = promisify(exec);
// Kullanıcının istediği kapılar: build (derleme/typecheck), lint, test, güvenlik. Profilde olmayan atlanır.
const GATES: ProfileCommandKey[] = ["build", "lint", "test", "security"];
const GATE_TIMEOUT_MS = 180_000;

export interface GateResult {
  key: ProfileCommandKey;
  ran: boolean;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  allOk: boolean;
  results: GateResult[];
}

/**
 * Stack profilinden typecheck/lint/test koşar (proje kökünde). Komut yoksa skip (ok). Komut fail → ok:false +
 * kısa hata. Her kapı korumalı (biri patlasa diğerleri koşar). Salt-okunur doğrulama — kod yazmaz.
 */
export async function verifyBuild(state: State): Promise<VerifyResult> {
  if (!state.stack) {
    return { allOk: true, results: [{ key: "build", ran: false, ok: true, detail: "stack yok → kapı atlandı" }] };
  }
  const profile = await loadProfile(state.stack);
  const results: GateResult[] = [];
  for (const key of GATES) {
    const cmd = resolveCommand(profile, key);
    if (!cmd) {
      results.push({ key, ran: false, ok: true, detail: "komut yok → atlandı" });
      continue;
    }
    try {
      await execp(cmd, { cwd: state.project_root, env: safeEnv(), timeout: GATE_TIMEOUT_MS });
      results.push({ key, ran: true, ok: true, detail: "geçti" });
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string };
      const detail = (err.stderr || err.stdout || String(e)).slice(0, 300);
      results.push({ key, ran: true, ok: false, detail });
    }
  }
  return { allOk: results.every((r) => r.ok), results };
}

/** Kullanıcıya yazılacak özet (Türkçe). */
export function formatVerifyResult(v: VerifyResult): string {
  const lines = v.results.map((r) => {
    const icon = !r.ran ? "⏭️" : r.ok ? "✅" : "❌";
    return `  ${icon} ${r.key}: ${r.ran ? (r.ok ? "geçti" : r.detail) : "atlandı"}`;
  });
  const head = v.allOk
    ? "✅ Kalite kapıları geçti (paralel build doğrulandı):"
    : "⚠️ Kalite kapılarında sorun var (paralel build — düzeltme gerek):";
  return [head, ...lines].join("\n");
}
