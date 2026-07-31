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
  MAX_TASK_AUTO_RETRIES,
  TASK_SOURCES,
  TASK_STATUSES,
  TaskQueueError,
  type TaskQueueItem,
  type TaskQueuePatch,
  type TaskQueueTombstone,
  type TaskSource,
  type TaskStatus,
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
 * Var olan bir task'ın alanlarını günceller (append-only patch). Yalnız verilen
 * alanlar değişir; read tarafı id başına en SON patch'i taban kayda merge eder.
 * `status="done"` ile birlikte `completed_at` damgalanmalıdır (çağıran sorumlu).
 */
export async function patchTask(
  projectRoot: string,
  taskId: string,
  patch: Pick<
    TaskQueuePatch,
    "priority" | "status" | "started_at" | "completed_at" | "attempts" | "last_fail" | "seen_count"
  >,
): Promise<void> {
  const record: TaskQueuePatch = { _patch: taskId, ts: Date.now(), ...patch };
  await appendLine(queuePath(projectRoot), record);
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
  // id → birikmiş patch (en son patch alanı kazanır; kısmî alanlar merge edilir).
  const patches = new Map<string, Partial<TaskQueueItem>>();
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
    if (typeof obj._patch === "string") {
      const merged = { ...(patches.get(obj._patch) ?? {}) };
      if (typeof obj.priority === "number") merged.priority = obj.priority;
      if (typeof obj.status === "string" && TASK_STATUSES.has(obj.status as TaskStatus))
        merged.status = obj.status as TaskStatus;
      if (typeof obj.started_at === "number") merged.started_at = obj.started_at;
      if (typeof obj.completed_at === "number") merged.completed_at = obj.completed_at;
      if (typeof obj.attempts === "number") merged.attempts = obj.attempts;
      if (typeof obj.last_fail === "string") merged.last_fail = obj.last_fail;
      if (typeof obj.seen_count === "number") merged.seen_count = obj.seen_count;
      patches.set(obj._patch, merged);
      continue;
    }
    if (
      typeof obj.id === "string" &&
      typeof obj.ts === "number" &&
      typeof obj.text === "string"
    ) {
      const item: TaskQueueItem = { id: obj.id, ts: obj.ts, text: obj.text };
      // Opsiyonel alanlar — taban kayıtta varsa oku (geriye-uyumlu; eskiler yok).
      if (typeof obj.priority === "number") item.priority = obj.priority;
      if (typeof obj.status === "string" && TASK_STATUSES.has(obj.status as TaskStatus))
        item.status = obj.status as TaskStatus;
      if (typeof obj.started_at === "number") item.started_at = obj.started_at;
      if (typeof obj.completed_at === "number") item.completed_at = obj.completed_at;
      if (typeof obj.attempts === "number") item.attempts = obj.attempts;
      if (typeof obj.last_fail === "string") item.last_fail = obj.last_fail;
      if (typeof obj.source === "string" && TASK_SOURCES.has(obj.source as TaskSource))
        item.source = obj.source as TaskSource;
      if (typeof obj.from_phase === "number") item.from_phase = obj.from_phase;
      if (typeof obj.dedup_key === "string") item.dedup_key = obj.dedup_key;
      if (typeof obj.seen_count === "number") item.seen_count = obj.seen_count;
      items.push(item);
    }
  }
  return items
    .filter((it) => !deletedIds.has(it.id))
    .map((it) => {
      const patch = patches.get(it.id);
      return patch ? { ...it, ...patch } : it;
    });
}

/** Bir task'ın efektif durumu (alan yoksa "pending" — geriye-uyumlu). */
export function taskStatus(item: TaskQueueItem): TaskStatus {
  return item.status ?? "pending";
}

/**
 * Sıradaki işlenecek iş: status="pending" olanlar arasından öncelik (1=en
 * yüksek; alan yoksa Infinity = en sona) sonra eklenme zamanı (FIFO). Yoksa null.
 */
export function nextPendingTask(items: TaskQueueItem[]): TaskQueueItem | null {
  // YZLLM 2026-07-18 ("düşürme, çöz"): MAX_TASK_AUTO_RETRIES'i doldurmuş işler otomatik SEÇİLMEZ ama
  // kuyrukta pending olarak GÖRÜNÜR kalır (kaybolmaz) — kullanıcı yeni talimat verince/elle tetikleyince sürer.
  const pending = items.filter(
    (it) => taskStatus(it) === "pending" && (it.attempts ?? 0) < MAX_TASK_AUTO_RETRIES,
  );
  if (pending.length === 0) return null;
  pending.sort((a, b) => {
    const pa = a.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return a.ts - b.ts;
  });
  return pending[0] ?? null;
}
