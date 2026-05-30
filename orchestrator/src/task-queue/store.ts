// task-queue/store — append/read/remove (tombstone) helpers.
//
// Pattern: abandoned-intents.ts + agent-memory/store.ts reuse. Atomic POSIX
// O_APPEND + fsync. Silme = tombstone append (`{ _deleted: id }`). Read tarafı
// tombstone'ları matchedID'leri filter eder.

import { promises as fs } from "node:fs";
import { open as openSync } from "node:fs/promises";
import { dirname, join } from "node:path";
import { enrichRecord } from "../record-context.js";
import {
  TaskQueueError,
  type TaskQueueItem,
  type TaskQueueTombstone,
} from "./types.js";

const MYCL_DIR = ".mycl";
const QUEUE_FILE = "task-queue.jsonl";

function queuePath(projectRoot: string): string {
  return join(projectRoot, MYCL_DIR, QUEUE_FILE);
}

async function appendLine<T extends object>(
  path: string,
  entry: T,
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  // v15.6 metadata enrichment (_session, _iter, _phase, _schema_v, _record_ts)
  const enriched = enrichRecord(entry, 1);
  const line = JSON.stringify(enriched) + "\n";
  const fh = await openSync(path, "a");
  try {
    await fh.write(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function appendTask(
  projectRoot: string,
  task: TaskQueueItem,
): Promise<void> {
  await appendLine(queuePath(projectRoot), task);
}

export async function removeTask(
  projectRoot: string,
  taskId: string,
): Promise<void> {
  const tombstone: TaskQueueTombstone = {
    _deleted: taskId,
    ts: Date.now(),
  };
  await appendLine(queuePath(projectRoot), tombstone);
}

/**
 * Tüm aktif (silinmemiş) task'ları kronolojik sırada döner.
 * Tombstone'lar `id`'ye göre filter eder.
 */
export async function readTasks(
  projectRoot: string,
): Promise<TaskQueueItem[]> {
  const p = queuePath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new TaskQueueError(`read failed: ${p} — ${String(err)}`);
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const items: TaskQueueItem[] = [];
  const deletedIds = new Set<string>();
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new TaskQueueError(
        `bad line in ${p}: ${line.slice(0, 100)} (${String(err)})`,
      );
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj._deleted === "string") {
      deletedIds.add(obj._deleted);
      continue;
    }
    if (
      typeof obj.id === "string" &&
      typeof obj.ts === "number" &&
      typeof obj.text === "string"
    ) {
      items.push({ id: obj.id, ts: obj.ts, text: obj.text });
    }
  }
  return items.filter((it) => !deletedIds.has(it.id));
}
