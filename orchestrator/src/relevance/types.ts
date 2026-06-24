// relevance/types — chunk + relevance scoring tipleri.
//
// Bu modül saf type definitions; runtime davranışı yok. Relevance engine'in
// her katmanı (chunk-store, classifier, engine, injectors) bu tipleri kullanır.
//
// Tasarım kararı: ChunkSource union literal — derleme zamanı discriminated
// narrowing için. "git" sonraki turda eklenir (plan kapsamı dışında).

export type ChunkSource =
  | "audit"
  | "spec"
  | "abandoned"
  | "history"
  | "patterns"
  | "brief"
  | "git"
  | "agent-decisions"  // v15.6 — orkestrator ajan recurring topic dedup için
  | "features"  // v15.11 — yaşayan özellik dökümantasyonu (.mycl/features.md)
  | "user-guide"  // v15.11 — UI kullanma kılavuzu (.mycl/user-guide.md)
  | "decisions";  // ADR — mimari karar kayıtları (.mycl/decisions/ADR-*.md)

export interface ChunkMetadata {
  ts?: number;
  phase?: number;
  iteration?: number;
  /** spec.md veya patterns.md için section heading'i (örn. "Scope", "Risks"). */
  heading?: string;
  /** audit event'i için event name (örn. "tdd-green", "phase-1-intent-approve"). */
  event?: string;
  /** audit event'i için caller (mycl-orchestrator | mycl-bridge | user). */
  caller?: string;
}

export interface Chunk {
  /** Stabil id — aynı kaynak + aynı pozisyon → aynı id. Score request/response
   * eşleştirmesi için kullanılır. Örn: "audit-1737...", "spec-Scope",
   * "abandoned-iter2-1737...". */
  id: string;
  source: ChunkSource;
  /** Chunk içeriği. Tipik 100-500 char; LLM batch'inde token bütçesi. */
  text: string;
  metadata: ChunkMetadata;
}

export interface ScoredChunk extends Chunk {
  /** LLM relevance puanı, 0-10. 0=ilgisiz, 10=yüksek alakalı. */
  score: number;
  /** LLM'in kararına kısa gerekçe (debug + audit transparency için). */
  reason: string;
}

export interface RelevanceQueryOptions {
  /** Hangi kaynaklardan chunk toplanacak. Boş array → boş sonuç. */
  sources: ChunkSource[];
  /** Mevcut kullanıcı niyeti veya enriched summary — relevance hedefi. */
  intent: string;
  /** LLM scoring sonrası dönecek max chunk sayısı. Default: 5. */
  max_chunks?: number;
  /** Bu skor altındaki chunk'lar filtrelenir. Default: 6 (10 üzerinden). */
  min_score?: number;
  /** Keyword pre-filter sonrası LLM'e gönderilen aday sayısı. Default: 20. */
  keyword_top_k?: number;
  /** history kaynak için faz id'si zorunlu — hangi phase-history-N.jsonl. */
  history_phase?: number;
  /**
   * Audit kaynağı için faz filtresi. Set edilirse audit chunks'tan sadece
   * `metadata.phase === audit_phase` olanlar geçer; diğer source'lar etkilenmez.
   * Phase 6 (audit_phase=6), Phase 9/19 (audit_phase=9) için kullanılır.
   */
  audit_phase?: number;
}

/**
 * Relevance call sırasında oluşan hata tipi — caller fail-safe karar verir
 * (boş array döndürmek veya throw etmek). Engine layer boş array döndürür +
 * emitError; caller (Phase 2 vs.) sentinel ile devam eder.
 */
export class RelevanceError extends Error {
  override readonly name = "RelevanceError";
}
