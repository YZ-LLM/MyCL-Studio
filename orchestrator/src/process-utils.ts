// process-utils — Cross-platform process management helpers.
//
// v15.8 (2026-05-28): Production-readiness cross-platform Stage 3.
//
// Önceki dağınık `process.kill(pid, 0)` (POSIX-only) çağrıları Windows'ta
// `ENOTSUP` ile fail ediyordu (signal 0 desteklenmiyor). Bu modül
// platform-aware abstraction sağlar:
//
//   - `isProcessAlive(pid)`: POSIX'te `kill -0`, Windows'ta `tasklist /FI`.
//   - İleride genişlemeye açık (e.g., killProcessTree zaten dev-server-
//     launcher'da var; oradan da buraya taşınabilir).
//
// Tüm fonksiyonlar exception-safe — fail durumunda `false` döner, çağıran
// tarafı bilgi olarak kullanır.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";

const execAsync = promisify(exec);

/**
 * Bir PID'nin yaşıyor olup olmadığını platform-bağımsız kontrol eder.
 *
 * **POSIX (macOS/Linux)**: `process.kill(pid, 0)` — signal göndermez,
 * sadece varlık check'i yapar. ESRCH → ölmüş, EPERM → yaşıyor ama signal
 * yetkin yok (yine alive sayılır).
 *
 * **Windows**: `tasklist /FI "PID eq <pid>"` çıktısı PID içeriyorsa alive.
 * `taskkill` yerine `tasklist` — sadece okuma, kill semantik değil.
 *
 * @returns true: alive, false: ölü veya kontrol edilemedi.
 */
export async function isProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    try {
      const { stdout } = await execAsync(
        `tasklist /FI "PID eq ${pid}" /NH`,
        { timeout: 3000, windowsHide: true },
      );
      // Output: PID dead → "INFO: No tasks are running with the specified criteria."
      // Alive → "<image_name>  <pid>  ..."
      return stdout.includes(String(pid));
    } catch (err) {
      log.warn("process-utils", "tasklist failed", { pid, err: String(err).slice(0, 200) });
      return false;
    }
  }
  // POSIX path
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as { code?: string };
    // EPERM: process exists but no permission to signal — still alive
    if (e.code === "EPERM") return true;
    // ESRCH or other: dead
    return false;
  }
}

/**
 * Sync version — boot-time veya throw-safe konteksler için. Async tercih
 * edilir; bu sadece eski (synchronous) call site'lar için backward-compat.
 *
 * **Uyarı**: Windows'ta `false` döner — eski POSIX `process.kill` davranışı
 * sync'di ama Windows için sync `tasklist` Node API'sinde yok. Async helper
 * kullanılması önerilir.
 */
export function isProcessAliveSync(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    // Sync tasklist yok; pessimistic false döner. Async helper'a geçilmeli.
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as { code?: string };
    return e.code === "EPERM";
  }
}
