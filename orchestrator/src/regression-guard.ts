// regression-guard — fix/debug SONRASI tam test regresyonu (YZLLM 2026-06-12: "güveni kökten sağlamlaştır").
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
import { log } from "./logger.js";
import type { MyclConfig } from "./config.js";
import type { PhaseId, State } from "./types.js";
import { baselineFromRun, regressionVerdict, type RegressionBaseline } from "./regression-diff.js";

const execAsync = promisify(exec);

async function runSuite(cmd: string, root: string): Promise<{ code: number; out: string }> {
  try {
    const r = await execAsync(cmd, { cwd: root, timeout: 300_000, maxBuffer: 8 * 1024 * 1024, env: { ...safeEnv(), LC_ALL: "C" } });
    return { code: 0, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : 1, out: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
  }
}

/**
 * Kapı düzeltmesi BAŞLAMADAN önce test temeli (2026-11-28, ekransız deneme koşusu 32). KANIT: takım düzeltmeden önce
 * de 4 kırık testle kırmızıydı; Faz 10'un lint düzeltmesinden sonra denetim "bu fix BAŞKA testleri bozdu" dedi ve akış
 * ikinci bir Faz 9'a döndü (24 dk 46 sn). Faz 8 aynı işi temel alarak yapıyordu; kural aynı (`baselineFromRun`).
 * Test komutu yok / çözümlenemedi / ortam hatası / çıktı ayrıştırılamadı → null (denetim bugünkü mutlak davranışta kalır;
 * komut ve ortam sorunlarını denetimin kendisi görünür söyler).
 */
export async function captureRegressionBaseline(state: State, afterPhase: PhaseId): Promise<RegressionBaseline | null> {
  let cmd: string | null;
  try {
    cmd = await resolveMechanicalCmd({ type: "profile_key", key: "test" }, state);
  } catch (e) {
    log.warn("regression-guard", "temel: test komutu çözümlenemedi", { error: String(e) });
    return null;
  }
  if (!cmd) return null;
  emitChatMessage("system", `📋 Faz ${afterPhase} düzeltmesi öncesi test temeli alınıyor (önceden kırık testleri yeni kırılmalardan ayırmak için)…`);
  const { code, out } = await runSuite(cmd, state.project_root);
  if (code !== 0 && (isApiAccountError(out) || isEnvironmentError(out))) return null;
  const base = baselineFromRun(code, out);
  emitChatMessage(
    "system",
    base === null
      ? "📋 Test temeli: takım kırmızı ama kırık testler ayrıştırılamadı — düzeltme sonrası kırmızı, regresyon sayılacak."
      : base.green
        ? "📋 Test temeli YEŞİL — düzeltme sonrası herhangi bir kırık regresyon sayılır."
        : `📋 Test temeli: ${base.failures.size} test düzeltmeden ÖNCE de kırık. Düzeltme sonrası yalnız YENİ kırılma regresyon sayılır.`,
  );
  return base;
}

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
  /** `captureRegressionBaseline` sonucu; null = temel yok (mutlak davranış). */
  baseline: RegressionBaseline | null = null,
): Promise<RegressionResult> {
  void config;
  // resolveMechanicalCmd null = "test komutu tanımlı değil" (meşru). AMA throw = profil/çözümleme
  // SORUNU — bunu "komut yok" sanıp sessiz atlamak, regresyonu doğrulanmadığı halde "güvenli" gösterir.
  let cmd: string | null;
  try {
    cmd = await resolveMechanicalCmd({ type: "profile_key", key: "test" }, state);
  } catch (e) {
    log.error("regression-guard", "test komutu çözümlenemedi (profil sorunu olabilir)", { error: String(e) });
    emitChatMessage(
      "system",
      `⚠️ Regresyon guard (Faz ${afterPhase}): test komutu ÇÖZÜMLENEMEDİ → fix regresyon açısından DOĞRULANAMADI (ne onaylandı ne reddedildi). Profil/ortamı kontrol et.`,
    );
    return { ran: false, note: "test komutu çözümlenemedi — regresyon doğrulanamadı (görünür)" };
  }
  if (!cmd) return { ran: false, note: "test komutu yok — regresyon guard atlandı" };
  emitChatMessage("system", `🛡️ Regresyon guard (Faz ${afterPhase} düzeltmesi sonrası) — tüm testleri yeniden koşuyorum: \`${cmd.slice(0, 70)}\``);
  const run = await runSuite(cmd, state.project_root);
  const code = run.code;
  // Eskisiyle aynı: yeşil koşunun çıktısı ortam/hesap denetimine girmez.
  const out = code === 0 ? "" : run.out;
  // Çevre/hesap hatası (komut yok, E2BIG, kredi) → proje regresyonu DEĞİL → yanlış-red yazma. AMA sessizce
  // geçme (sessiz-fallback denetimi): regresyon ne onaylandı ne reddedildi → fix DOĞRULANMADI; bunu GÖRÜNÜR
  // kıl ki "yeşil" sanılmasın (kullanıcı/müfettiş regresyonun kontrol EDİLMEDİĞİNİ bilsin).
  if (isApiAccountError(out) || isEnvironmentError(out)) {
    emitChatMessage(
      "system",
      `⚠️ Regresyon guard (Faz ${afterPhase}): testler ORTAM/hesap hatası verdi (proje regresyonu değil) → fix ` +
        `regresyon açısından DOĞRULANAMADI (ne onay ne red). Ortamı düzeltip tekrar koşman önerilir. (${out.trim().slice(0, 100)})`,
    );
    return { ran: false, note: "ortam/hesap hatası — regresyon doğrulanamadı (görünür)" };
  }
  const v = regressionVerdict(baseline, code, out);
  const pass = v.kind === "green" || v.kind === "no-new";
  const shown = v.kind === "new" ? `${v.regressed.slice(0, 5).join(" | ").slice(0, 200)}${v.regressed.length > 5 ? ` (+${v.regressed.length - 5} daha)` : ""}` : "";
  await appendAudit(state.project_root, {
    ts: Date.now(),
    phase: afterPhase,
    event: pass ? "regression-guard-pass" : "regression-guard-fail",
    caller: "mycl-orchestrator",
    detail:
      v.kind === "green"
        ? "fix sonrası tam test geçti"
        : v.kind === "no-new"
          ? `no-regression (pre-existing ${v.preExisting} fail, fix added 0)`
          : v.kind === "new"
            ? `fix REGRESYON yarattı — yeni kırılan: ${shown}`
            : `fix sonrası testler kırmızı (temel yok ya da ayrıştırılamadı): ${out.trim().slice(0, 150)}`,
  });
  emitChatMessage(
    "system",
    v.kind === "green"
      ? "✅ Regresyon guard: fix başka bir yeri bozmadı — tüm testler geçti."
      : v.kind === "no-new"
        ? `✅ Regresyon guard: önceden kırık ${v.preExisting} test var, bu düzeltme yeni bir şey kırmadı.`
        : v.kind === "new"
          ? `🔴 Regresyon guard: bu düzeltme şu testleri YENİ kırdı: ${shown}` +
            `${v.preExisting > 0 ? ` (önceden kırık ${v.preExisting} test ayrı)` : ""}. Düzeltilmeli.`
          : "🔴 Regresyon guard: düzeltmeden sonra testler kırmızı; düzeltme öncesi durum bilinmediği ya da çıktı ayrıştırılamadığı için kırmızı regresyon sayıldı.",
  );
  return { ran: true, pass, note: pass ? (v.kind === "no-new" ? "yeni kırılma yok" : "geçti") : "regresyon" };
}
