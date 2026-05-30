// task-queue/types — kullanıcı talep kuyruğu için tipler.
//
// Kullanıcı talebi (v15.7, 2026-05-24): "çalışırken müşteriden yeni talepler
// geliyor. o talepleri iş kuyruğuna atabilmek için..."
//
// Proje-spesifik kuyruk (`<project>/.mycl/task-queue.jsonl`). NDJSON append-
// only; silme tombstone ile (`_deleted: id`). v15.6 record-context metadata
// (`_schema_v`, `_session`, `_iter`, `_phase`, `_record_ts`) otomatik eklenir.

export interface TaskQueueItem {
  /** UUID v4 — silme tombstone bağlamak için. */
  id: string;
  /** Eklenme zamanı (ms epoch). */
  ts: number;
  /** Kullanıcının composer'a yazdığı ham metin. */
  text: string;
}

/** Tombstone: silinen task'ı işaretler. Read tarafı bunu filter eder. */
export interface TaskQueueTombstone {
  _deleted: string; // silinmiş task id
  ts: number;
}

export class TaskQueueError extends Error {
  override readonly name = "TaskQueueError";
}
