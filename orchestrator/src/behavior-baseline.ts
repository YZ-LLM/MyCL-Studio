// behavior-baseline — YABANCI projede entegrasyon ÖNCESİ test durumunu (geçen/kalan kümesi) anlık görüntüle.
// YZLLM 2026-07-03 (Layer B). Onaylı bir iterasyon SONRASI, önceden GEÇEN bir test yeni düşerse → onaysız
// davranış değişikliği (regresyon). Fix-modu baseline'ının (regression-diff.ts) aynı deterministik makinesi;
// tek fark kaynağın onboarding olması. Baseline güvenilmezse (komut yok / runner anlaşılamadı) → GÖRÜNÜR atla
// (testCmd:null), mutlak yola düş (KATI#4 — sessiz-fallback yok; sahte-yeşil önleme, phase-8.ts~553 deseni).

import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import type { State } from "./types.js";
import { safeEnv } from "./safe-env.js";
import { resolveMechanicalCmd, isMissingCommand, isSpawnEnvFailure } from "./base/mechanical-runner.js";
import { parseFailures, computeRegression } from "./regression-diff.js";

const execAsync = promisify(exec);
const MYCL_DIR = ".mycl";
const BASELINE_FILE = "behavior-baseline.json";

export interface BehaviorBaseline {
  ts: number;
  /** null → güvenilir baseline YOK (komut yok / runner anlaşılamadı) → regresyon kontrolü GÖRÜNÜR atlanır. */
  testCmd: string | null;
  green: boolean;
  failures: string[]; // parseFailures çıktısı (koşular arası tutarlı kimlikler)
}

function baselinePath(root: string): string {
  return join(root, MYCL_DIR, BASELINE_FILE);
}

/**
 * Test-suite süreç koşucusu — 2026-07-16'da export edildi (Full Test F1 aynı
 * koşucu/timeout/kısmi-çıktı semantiğini kullanır; kopya makine olmasın).
 */
export async function runSuiteProcess(
  cmd: string,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...safeEnv(), LC_ALL: "C" },
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    // Timeout/SIGKILL (mahkeme #1): süreç ZORLA sonlandırıldı → çıktı KISMİ (bazı testler hiç koşmadı).
    // Kısmi fail setiyle baseline kurmak YANLIŞ-regresyon üretir (koşmayan testler "geçiyordu" sanılır).
    // Çıktıyı BOŞALT → snapshot'ın "kırmızı ama 0 fail" guard'ı testCmd:null'a düşer (güvenilmez, görünür atla).
    if (e.killed) return { code: 1, stdout: "", stderr: String(e.stderr ?? e.message ?? "timeout") };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
    };
  }
}

async function writeBaseline(root: string, baseline: BehaviorBaseline): Promise<void> {
  const p = baselinePath(root);
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
}

/**
 * Entegrasyon öncesi test temelini al + `.mycl/behavior-baseline.json`'a yaz. Güvenilmezse testCmd:null.
 * `ts` çağıran tarafından (Date.now üst katmanda). Fail-soft: exec hatası testCmd:null'a düşer.
 */
export async function snapshotBehaviorBaseline(state: State, ts: number): Promise<BehaviorBaseline> {
  const cmd = await resolveMechanicalCmd({ type: "profile_key", key: "test" }, state);
  let baseline: BehaviorBaseline;
  if (!cmd) {
    baseline = { ts, testCmd: null, green: false, failures: [] };
  } else {
    const res = await runSuiteProcess(cmd, state.project_root);
    const failures = parseFailures(`${res.stdout}\n${res.stderr}`);
    if (isMissingCommand(res) || isSpawnEnvFailure(res) || (res.code !== 0 && failures.size === 0)) {
      // komut yok / ortam faulty / kırmızı-ama-0-fail (parser runner'ı anlamadı) → güvenilmez.
      baseline = { ts, testCmd: null, green: false, failures: [] };
    } else {
      baseline = { ts, testCmd: cmd, green: res.code === 0, failures: [...failures] };
    }
  }
  await writeBaseline(state.project_root, baseline);
  return baseline;
}

/**
 * Yüzeye çıkarılan regresyonları baseline'a KABUL ET (mahkeme #2): failures'a ekle + yeniden yaz → sonraki
 * iterasyonlarda AYNI kırık test tekrar tekrar bayrak çekmez; yalnız BİR SONRAKİ iterasyonun YENİ kırdığı
 * bildirilir. regressed boşsa no-op. Bu, "per-iterasyon delta" anlamı verir (her kırılma bir kez bildirilir).
 */
export async function acceptRegressionsIntoBaseline(
  root: string,
  baseline: BehaviorBaseline,
  regressed: string[],
): Promise<void> {
  if (regressed.length === 0) return;
  await writeBaseline(root, {
    ...baseline,
    failures: [...new Set([...baseline.failures, ...regressed])],
  });
}

export async function readBehaviorBaseline(root: string): Promise<BehaviorBaseline | null> {
  let raw: string;
  try {
    raw = await fs.readFile(baselinePath(root), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as BehaviorBaseline;
  } catch {
    return null;
  }
}

/**
 * SAF: iterasyon SONRASI test çıktısını baseline ile karşılaştır → önceden geçen ama şimdi düşen testler
 * (gerçek regresyon = onaysız davranış değişikliği adayı). Baseline güvenilmezse reliable:false (GÖRÜNÜR atla).
 * regressed BOŞ değilse çağıran GÖRÜNÜR bayrak verir (bloke DEĞİL — onaylı değişiklik eski testi kırmış olabilir;
 * dosya→sig eşlemesi kesin değil, bu yüzden gate değil kemer-üstü-kayış).
 */
export function verifyNoUnconsentedRegression(
  baseline: BehaviorBaseline | null,
  afterOutput: string,
): { reliable: boolean; regressed: string[] } {
  if (!baseline || baseline.testCmd === null) return { reliable: false, regressed: [] };
  const after = parseFailures(afterOutput);
  const reg = computeRegression(new Set(baseline.failures), after);
  return { reliable: true, regressed: reg.regressed };
}
