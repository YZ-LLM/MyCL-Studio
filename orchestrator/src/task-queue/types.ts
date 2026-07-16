// task-queue/types — kullanıcı talep kuyruğu için tipler.
//
// Kullanıcı talebi (v15.7, 2026-05-24): "çalışırken müşteriden yeni talepler
// geliyor. o talepleri iş kuyruğuna atabilmek için..."
//
// Proje-spesifik kuyruk (`<project>/.mycl/task-queue.jsonl`). NDJSON append-
// only; silme tombstone ile (`_deleted: id`). v15.6 record-context metadata
// (`_schema_v`, `_session`, `_iter`, `_phase`, `_record_ts`) otomatik eklenir.

/**
 * İş yaşam döngüsü (YZLLM 2026-06-14 "her iş Faz 1'den başlar + sıralı kuyruk"):
 *  - pending : kuyrukta, henüz işlenmedi.
 *  - running : şu an Faz 1'den itibaren işleniyor.
 *  - done    : tamamlandı (Faz 4 sonrasına geçip pipeline'ı bitirdi) → KİLİTLİ, tekrar uygulanamaz.
 *  - dropped : (a) erken fazlar (1-4) gürültü/uygulanamaz buldu → Faz 4'ü geçemedi, VEYA (b) pipeline sonuna ulaştı
 *              ama DELIVERABLE ÜRETMEDİ (boş-build → 'done' KİLİDİ yerine 'dropped'; sahte-tamamlanma önleme, 2026-07-14).
 *              İki durumda da UI "Yeniden Ekle" gösterir → kullanıcı sorunu çözüp yeniden gönderebilir.
 */
export type TaskStatus = "pending" | "running" | "done" | "dropped";

/** İş kaynağı — kim/ne ekledi. Yeni kaynak eklerken TASK_SOURCES setine de ekle
 *  (store.ts okuma doğrulaması oradan yürür; unutulursa kaynak sessizce düşerdi). */
export type TaskSource = "manual" | "auto" | "security" | "full-test" | "maintenance" | "plan";

export interface TaskQueueItem {
  /** UUID v4 — silme tombstone bağlamak için. */
  id: string;
  /** Eklenme zamanı (ms epoch). */
  ts: number;
  /** Kullanıcının composer'a yazdığı ham metin. */
  text: string;
  /**
   * Öncelik: 1=en yüksek. Çok-problem önceliklendirmesinden gelir; alan yoksa
   * sıralamada en sona düşer (eski kayıtlar + öncelendirilmemiş işler).
   */
  priority?: number;
  /** Yaşam döngüsü. Alan yoksa "pending" sayılır (eski kayıtlarla geriye-uyumlu). */
  status?: TaskStatus;
  /** status="running" olunca damgalanan başlangıç zamanı (ms epoch). Süre = completed_at - started_at (YZLLM 2026-07-13). */
  started_at?: number;
  /** status="done" olunca damgalanan tamamlanma zamanı (ms epoch). */
  completed_at?: number;
  /** Kaynak: kullanıcı manuel mi ekledi (manual), çok-problem/Faz-4-sonrası otomatik mi (auto),
   *  güvenlik/sızma-testi bulgusu mu (security = "sistem işi", YZLLM 2026-06-19),
   *  Full Test bulgusu mu (full-test), bakım turu bulgusu mu (maintenance),
   *  yoksa plan modu adımı mı (plan) — 2026-07-16. */
  source?: TaskSource;
  /** YZLLM 2026-06-19: güvenlik/pentest sistem-işi bu fazdan BAŞLAR (niyet bulgudan türetildiği için
   *  Faz 1/2 atlanır → genelde 3=Mühendislik Brifingi). Yoksa normal akış (Faz 1). */
  from_phase?: number;
}

/** Tombstone: silinen task'ı işaretler. Read tarafı bunu filter eder. */
export interface TaskQueueTombstone {
  _deleted: string; // silinmiş task id
  ts: number;
}

/**
 * Patch: var olan bir task'ın alanlarını günceller (append-only → tombstone'un
 * ikizi). Read tarafı id başına en SON patch'i taban kayda merge eder. Yalnız
 * verilen alanlar değişir (kısmî güncelleme).
 */
export interface TaskQueuePatch {
  _patch: string; // güncellenecek task id
  ts: number;
  priority?: number;
  status?: TaskStatus;
  started_at?: number;
  completed_at?: number;
}

/** Geçerli durum değerleri — patch/parse doğrulaması için. */
export const TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "pending",
  "running",
  "done",
  "dropped",
]);

/** Geçerli kaynak değerleri — store.ts okuma doğrulaması buradan (tek kaynak). */
export const TASK_SOURCES: ReadonlySet<TaskSource> = new Set<TaskSource>([
  "manual",
  "auto",
  "security",
  "full-test",
  "maintenance",
  "plan",
]);

export class TaskQueueError extends Error {
  override readonly name = "TaskQueueError";
}
