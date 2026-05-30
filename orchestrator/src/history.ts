// history — Faz başına Claude conversation history'sini diske JSONL olarak
// kaydeder; resume desteği için.
//
// Yer: <project_root>/.mycl/phase-history-{N}.jsonl
// Format: her satır bir `ApiMessage` (rol + content). Tool_use ve tool_result
// blokları content içinde structured (Anthropic SDK formatı).
//
// Lifecycle:
//   - Faz başlangıcı (initialUserMessage push) → saveHistoryStep
//   - Her turn (assistant + user/tool_result message) → saveHistoryStep × 2
//   - Faz "done" (gate pass) → clearHistory (sonraki run temiz başlasın)
//   - Faz "aborted" veya "failed" → history KORUNUR (resume için)
//
// Mimari yasak: Bu modül sadece append eder; Claude veya başka subprocess
// burayı okumaz. Resume kontrolü orchestrator/controller seviyesinde.

import { promises as fs } from "node:fs";
import { open as openSync } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApiMessage } from "./claude-api.js";
import type { PhaseId } from "./types.js";

const HISTORY_DIR = ".mycl";

export class HistoryError extends Error {
  override readonly name = "HistoryError";
}

function historyPath(projectRoot: string, phase: PhaseId): string {
  return join(projectRoot, HISTORY_DIR, `phase-history-${phase}.jsonl`);
}

/**
 * Tek bir mesajı history'e append eder. NDJSON benzeri atomic line write
 * (POSIX append guarantee).
 */
export async function saveHistoryStep(
  projectRoot: string,
  phase: PhaseId,
  message: ApiMessage,
): Promise<void> {
  const p = historyPath(projectRoot, phase);
  await fs.mkdir(dirname(p), { recursive: true });
  const line = JSON.stringify(message) + "\n";
  const fh = await openSync(p, "a");
  try {
    await fh.write(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Tüm history'i okur. Dosya yoksa boş array (yeni faz). Bozuk satır error
 * fırlatır — fallback YOK (Ümit kuralı: hata gizleme).
 */
export async function loadHistory(
  projectRoot: string,
  phase: PhaseId,
): Promise<ApiMessage[]> {
  const p = historyPath(projectRoot, phase);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new HistoryError(`history read failed: ${String(err)}`);
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const messages: ApiMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as ApiMessage);
    } catch (err) {
      throw new HistoryError(
        `bad history line: ${line.slice(0, 100)} (${String(err)})`,
      );
    }
  }
  return messages;
}

/**
 * History dosyasını siler. Faz başarıyla tamamlandığında çağrılır — sonraki
 * çalıştırma temiz başlasın.
 */
export async function clearHistory(
  projectRoot: string,
  phase: PhaseId,
): Promise<void> {
  const p = historyPath(projectRoot, phase);
  try {
    await fs.unlink(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new HistoryError(`history clear failed: ${String(err)}`);
    }
  }
}
