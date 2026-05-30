// abandoned-intents — Faz 2 compliance check sonrası kullanıcı niyetten
// vazgeçerse `.mycl/abandoned-intents.jsonl`'a kalıcı kayıt.
//
// "MyCL hiç birşeyi unutmaz" garantisi: vazgeçilen niyetler diskte JSON
// Lines olarak tutulur, gelecek Faz 2 çağrılarında digestAbandonedIntents()
// ile özet prompt'a enjekte edilir → Claude "daha önce benzer bir niyetten
// vazgeçilmişti" diyebilir.
//
// Pattern: audit.ts appendAudit (POSIX O_APPEND + fsync, PIPE_BUF altında
// atomic) deseninin taklidi. history.ts'in HistoryError fail-fast yaklaşımı
// ile bozuk satırlarda silent fallback yok — Ümit kuralı.

import { promises as fs } from "node:fs";
import { open as openSync } from "node:fs/promises";
import { dirname, join } from "node:path";
import { enrichRecord } from "./record-context.js";

const MYCL_DIR = ".mycl";
const ABANDONED_FILE = "abandoned-intents.jsonl";

export class AbandonedIntentError extends Error {
  override readonly name = "AbandonedIntentError";
}

export interface AbandonedIntent {
  ts: number;
  iteration: number;
  phase: number;
  /** Vazgeçme anındaki intent_summary (Faz 2 enriched veya Faz 1 ham). */
  intent: string;
  /** Compliance check'te listelenen handikaplar. */
  concerns: string[];
  /** Claude'un abandon_iteration tool'una verdiği "neden" alanı. */
  reason: string;
}

function abandonedPath(projectRoot: string): string {
  return join(projectRoot, MYCL_DIR, ABANDONED_FILE);
}

/**
 * Tek vazgeçilen niyet kaydını append eder. Atomic line write (O_APPEND).
 */
export async function appendAbandonedIntent(
  projectRoot: string,
  entry: AbandonedIntent,
): Promise<void> {
  const p = abandonedPath(projectRoot);
  await fs.mkdir(dirname(p), { recursive: true });
  // v15.6: metadata enrichment — sabit anchor alanları (_session, _iter,
  // _phase, _schema_v, _record_ts).
  const enriched = enrichRecord(entry, 1);
  const line = JSON.stringify(enriched) + "\n";
  const fh = await openSync(p, "a");
  try {
    await fh.write(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Tüm vazgeçme history'sini okur. Dosya yoksa boş array (yeni proje).
 * Bozuk JSON satırı → AbandonedIntentError (fallback YOK).
 */
export async function readAbandonedIntents(
  projectRoot: string,
): Promise<AbandonedIntent[]> {
  const p = abandonedPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AbandonedIntentError(`read failed: ${String(err)}`);
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const entries: AbandonedIntent[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AbandonedIntent);
    } catch (err) {
      throw new AbandonedIntentError(
        `bad line: ${line.slice(0, 100)} (${String(err)})`,
      );
    }
  }
  return entries;
}

/**
 * Faz 2 promptuna enjekte için kısa özet üretir. En son `max` vazgeçme
 * listelenir. Hiç yoksa "(none)" döner.
 */
export async function digestAbandonedIntents(
  projectRoot: string,
  max = 5,
): Promise<string> {
  const all = await readAbandonedIntents(projectRoot);
  if (all.length === 0) return "(none)";
  const recent = all.slice(-max);
  const lines = recent.map((e) => {
    const date = new Date(e.ts).toISOString().slice(0, 10);
    const intentSnip = e.intent.slice(0, 120).replace(/\s+/g, " ");
    const concerns = e.concerns.length > 0 ? e.concerns.join("; ") : "(none)";
    const reason = e.reason.slice(0, 200);
    return `- Iter ${e.iteration} (${date}, phase ${e.phase}): "${intentSnip}"\n  Concerns: ${concerns}\n  Reason: ${reason}`;
  });
  return lines.join("\n");
}
