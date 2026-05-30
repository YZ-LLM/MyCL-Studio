// record-context — NDJSON kayıtlarına otomatik metadata enjeksiyonu.
//
// Amaç (v15.6 — 2026-05-24, kullanıcı talebi: "sağlam ve ilerde veriseti
// olarak kullanabileceğimiz bi yapıda tutmak istiyorum"): Her append edilen
// satır, hangi session/iterasyon/faz bağlamında oluştuğunu içersin ki ilerde
// dataset analizi yaparken cross-file join + filter kolay olsun.
//
// Pattern: process-wide singleton context. Caller'ların imza değişmiyor;
// audit.ts / history-loader.ts / agent-memory/store.ts gibi modüller
// `enrichRecord()` çağırıyor, alanlar otomatik dolduruluyor.
//
// Context update: handleOpenProject (boot), advanceToNextPhase (phase change),
// new iteration handler — index.ts'den setRecordContext ile push edilir.
//
// Metadata alanları underscore prefix'li (`_session`, `_iter`, `_phase`,
// `_schema_v`) — domain alanlarından ayrılır, ileride filter'a kolaylık
// (örn. parquet'a çevirirken `_*` kolonları metadata olarak gruplanır).

/** Şu an enjekte edilecek metadata. Schema değişirse `_schema_v` bump et. */
export interface RecordMetadata {
  /** Her kayıt için sabit — şu an v1. Field eklenir/kaldırılırsa v2. */
  _schema_v: number;
  /** Mevcut MyCL session — state.session_id. Process lifetime boyunca sabit. */
  _session?: string;
  /** Mevcut iterasyon — state.iteration_count. Yeni iterasyonla artar. */
  _iter?: number;
  /** Mevcut faz — state.current_phase. advanceToNextPhase ile değişir. */
  _phase?: number;
  /** Kayıt zamanı (ms epoch). Domain `ts` alanı varsa onu bozmaz; bu metadata
   *  alanı sadece append anını gösterir (bazen domain ts'i geçmiş olabilir). */
  _record_ts: number;
}

interface ContextState {
  session_id?: string;
  iteration?: number;
  phase?: number;
}

let ctx: ContextState = {};

/**
 * Bağlamı günceller. Verilmeyen alanlar mevcut değerlerini korur (partial
 * update). undefined yazmak isteniyorsa explicit undefined geç (örn. iterasyon
 * resetlemeyi düşürmek için).
 */
export function setRecordContext(update: Partial<ContextState>): void {
  ctx = { ...ctx, ...update };
}

/** Mevcut bağlamı kopyalayıp döner — test ve debug için. */
export function getRecordContext(): Readonly<ContextState> {
  return { ...ctx };
}

/** Test / shutdown — bağlamı temizler. */
export function resetRecordContext(): void {
  ctx = {};
}

/**
 * NDJSON satırına metadata enjekte eder. Mevcut alanları üzerine yazmaz (eğer
 * caller `_schema_v` set etmek isterse override eder). Domain field'larıyla
 * çakışma yok (underscore prefix).
 *
 * @param record  Domain payload (örn. AuditEvent, ChatMessage, ...)
 * @param schemaVersion  Bu record tipinin schema sürümü (genelde 1)
 */
export function enrichRecord<T extends object>(
  record: T,
  schemaVersion = 1,
): T & RecordMetadata {
  const meta: RecordMetadata = {
    _schema_v: schemaVersion,
    _session: ctx.session_id,
    _iter: ctx.iteration,
    _phase: ctx.phase,
    _record_ts: Date.now(),
  };
  return { ...meta, ...record };
}
