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
 *  - dropped : YALNIZ kullanıcı iptali (YZLLM 2026-07-18: "kuyrukta 'düştü' işaretleme seçeneğini kaldır —
 *              sorunları çözmeye çalışsın; çözemiyorsa bakış açısını değiştirsin"). MyCL kendi başarısızlığında
 *              işi ASLA düşürmez: iş `pending`'e döner (attempts+1, last_fail dolar) ve FARKLI yaklaşımla
 *              yeniden denenir; MAX_TASK_AUTO_RETRIES aşılırsa otomatik seçilmez ama kuyrukta GÖRÜNÜR bekler
 *              (kaybolmaz; kullanıcı yeni talimatla sürdürür). Eski kayıtlardaki dropped değerleri geçerli kalır.
 */
export type TaskStatus = "pending" | "running" | "done" | "dropped";

/** İş kaynağı — kim/ne ekledi. Yeni kaynak eklerken TASK_SOURCES setine de ekle
 *  (store.ts okuma doğrulaması oradan yürür; unutulursa kaynak sessizce düşerdi).
 *  verify-gap (2026-07-24): doğrulama özetinde "araç yok/stub" nedeniyle atlanan gate boyutu →
 *  aracı kurup gate'i gerçekten koşturma işi (YZLLM: "aracı eklemeye karar vermesi ve çalıştırması gerekiyordu"). */
export type TaskSource = "manual" | "auto" | "security" | "full-test" | "maintenance" | "plan" | "verify-gap";

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
  /** Tamamlanamayan otomatik deneme sayısı (YZLLM 2026-07-18 "düşürme, çöz"): her pending'e dönüşte +1.
   *  MAX_TASK_AUTO_RETRIES'e ulaşınca otomatik seçim durur (iş kuyrukta görünür bekler, kaybolmaz). */
  attempts?: number;
  /** Son tamamlanamama nedeni (kısa) — yeniden denemede ajana "farklı yaklaşım" bağlamı olarak verilir. */
  last_fail?: string;
  /** SİSTEM işlerinin kanonik tekrar anahtarı (2026-07-30) — `kaynak:tür:konu`. Metinden BAĞIMSIZ:
   *  şablon cümlesi değişse de aynı bulgu aynı anahtarı alır → aynı iş ikinci kez açılmaz.
   *  Kullanıcının kendi yazdığı işlerde yoktur (onlar intake'in semantik ayıklamasından geçer). */
  dedup_key?: string;
  /** Aynı bulgunun kaç kez yeniden tespit edildiği (tekrar açmak yerine sayaç artar) — görünürlük. */
  seen_count?: number;
  /** KESİNTİDEN DÖNÜŞ (2026-07-30): iş sağlayıcı kesintisinde bu fazda duraklamıştı → erişim dönünce
   *  Faz 1'den DEĞİL buradan sürer (canlı cave: 23 kez baştan başlayıp spec/niyeti yeniden üretti).
   *  from_phase'ten AYRI alan: from_phase "bu iş şu fazdan BAŞLAR" (güvenlik işleri), bu ise
   *  "bu iş şu fazda KALDI". Karıştırılırsa full-test/bakım işleri sessizce Faz 3'e kayardı. */
  resume_phase?: number;
  /** resume_phase'in ait olduğu iterasyon damgası — state ile eşleşmezse resume YAPILMAZ (bayat koruma). */
  resume_iter_ts?: number;
}

/** Bir işin ard arda otomatik yeniden denenme tavanı — sonrası görünür bekleme (sonsuz döngü/token yakımı yok). */
export const MAX_TASK_AUTO_RETRIES = 3;

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
  attempts?: number;
  last_fail?: string;
  seen_count?: number;
  resume_phase?: number;
  resume_iter_ts?: number;
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
  "verify-gap",
]);

export class TaskQueueError extends Error {
  override readonly name = "TaskQueueError";
}
