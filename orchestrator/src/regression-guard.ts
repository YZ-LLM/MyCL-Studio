// regression-guard — fix/debug SONRASI tam test regresyonu (Ümit 2026-06-12: "güveni kökten sağlamlaştır").
//
// SORUN: Faz 8 (TDD) testleri bir kez geçince, SONRAKİ fazlardaki (10-17 lint/perf/güvenlik) gate-autofix VEYA
// debug düzeltmeleri kodu değiştirir ama testleri YENİDEN KOŞMAZ → bir fix başka bir özelliği sessizce bozabilir
// (regresyon) ve "yeşil" sahte olur. Bu guard: bir fix uygulandıktan sonra TÜM test takımını koşar; kırmızıysa
// regresyon yakalanır (sessiz bozulma engellenir). Faz 8'in anchor'ıyla aynı test komutunu kullanır.

import { promisify } from "node:util";
import { exec } from "node:child_process";
import { resolveMechanicalCmd } from "./base/mechanical-runner.js";
import { isApiAccountError, isEnvironmentError } from "./claude-api.js";
import { safeEnv } from "./safe-env.js";
import { appendAudit } from "./audit.js";
import { emitChatMessage } from "./ipc.js";
import type { MyclConfig } from "./config.js";
import type { PhaseId, State } from "./types.js";

const execAsync = promisify(exec);

export interface RegressionResult {
  ran: boolean; // test takımı gerçekten koşturuldu mu
  pass?: boolean; // koştuysa geçti mi
  note: string;
}

/**
 * Bir fix sonrası tam test takımını koş (regresyon guard). Test komutu yoksa/çalıştırılamazsa `ran:false` (sessiz —
 * yanlış-red yazma). Çevre/hesap hatasında da ran:false (proje hatası değil). Görünür mesaj + audit (regresyonsa fail).
 */
export async function runRegressionGuard(
  state: State,
  config: MyclConfig,
  afterPhase: PhaseId,
): Promise<RegressionResult> {
  void config;
  const cmd = await resolveMechanicalCmd({ type: "profile_key", key: "test" }, state).catch(() => null);
  if (!cmd) return { ran: false, note: "test komutu yok — regresyon guard atlandı" };
  emitChatMessage("system", `🛡️ Regresyon guard (Faz ${afterPhase} düzeltmesi sonrası) — tüm testleri yeniden koşuyorum: \`${cmd.slice(0, 70)}\``);
  let code: number;
  let out = "";
  try {
    await execAsync(cmd, { cwd: state.project_root, timeout: 300_000, maxBuffer: 8 * 1024 * 1024, env: { ...safeEnv(), LC_ALL: "C" } });
    code = 0;
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    code = typeof err.code === "number" ? err.code : 1;
    out = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
  }
  // Çevre/hesap hatası (komut yok, E2BIG, kredi) → proje regresyonu DEĞİL → sessiz atla (yanlış-red yazma).
  if (isApiAccountError(out) || isEnvironmentError(out)) {
    return { ran: false, note: "ortam/hesap hatası — regresyon değil, atlandı" };
  }
  const pass = code === 0;
  await appendAudit(state.project_root, {
    ts: Date.now(),
    phase: afterPhase,
    event: pass ? "regression-guard-pass" : "regression-guard-fail",
    caller: "mycl-orchestrator",
    detail: pass ? `fix sonrası tam test geçti` : `fix REGRESYON yarattı — testler kırmızı: ${out.trim().slice(0, 150)}`,
  });
  emitChatMessage(
    "system",
    pass
      ? "✅ Regresyon guard: fix başka bir yeri bozmadı — tüm testler geçti."
      : "🔴 Regresyon guard: bu fix BAŞKA testleri bozdu (regresyon)! Sessiz bozulma yakalandı — düzeltilmeli.",
  );
  return { ran: true, pass, note: pass ? "geçti" : "regresyon" };
}
