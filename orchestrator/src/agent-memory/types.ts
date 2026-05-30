// agent-memory/types — hafıza şemaları (v15.6 base + v15.7 scope/tech_stack).
//
// İki dosya:
//   - `<project>/.mycl/agent-memory.jsonl`   — projeye özel hafıza
//   - `~/.mycl/agent-memory-general.jsonl`   — genel hafıza (cross-project)
//
// v15.7 (2026-05-26) — Cross-project leak koruması: `scope` ("universal" |
// "stack-specific") + `tech_stack` alanları eklendi. General memory read
// sırasında current_stack ile uyumsuz entry'ler skip edilir (store.ts
// readGeneralMemory). Eski kayıtlar (scope yok) defansif olarak skip.
//
// Ek olarak `<project>/.mycl/agent-decisions.jsonl` — agent'ın her onaylı
// kararının raw log'u. 2. confirmation detection için kullanılır (LLM semantic
// karşılaştırma input'u).

export class AgentMemoryError extends Error {
  override readonly name = "AgentMemoryError";
}

/**
 * Hafıza girişi. type="project" → projeye özel; type="general" → cross-project.
 * Genel kayıtlar UYGULAMA pattern'i tarif eder; projeye özel kayıtlar bu
 * projenin spesifik DAVRANIŞINI.
 */
export interface AgentMemoryEntry {
  /** Epoch ms. */
  ts: number;
  /** Agent-generated kategorize anahtarı (kebab-case). Aynı slug = aynı konu. */
  topic_slug: string;
  /** Hafıza tipi. */
  type: "project" | "general";
  /** 1-3 cümle TR özet. */
  summary: string;
  /** Original user mesajı (referans için). */
  user_text: string;
  /** AgentAction (string olarak; type circular import'ı engellemek için). */
  decision_action: string;
  /** Etkilenen dosyalar (projeye özel için tipik). */
  affected_files?: string[];
  /** Etkilenen DB tabloları. */
  affected_db_tables?: string[];
  /** Dokunulan algoritmalar/kavramlar (örn. "JWT", "bcrypt"). */
  affected_algorithms?: string[];
  /** Yapılan değişikliğin TR açıklaması. */
  change_description?: string;
  /** User Evet timestamp (kayıt onayı). */
  confirmed_at: number;
  /**
   * v15.7 (2026-05-26): Cross-project leak koruması.
   * - "universal" → Tüm projelerde injecte edilir (örn. "ben kısa cevap isterim" gibi
   *   tamamen stack-bağımsız davranış tercihi).
   * - "stack-specific" → Sadece aynı tech_stack'teki projelerde injecte edilir.
   * Default `stack-specific` — orkestratör save_memory_proposal'da explicit olarak
   * "universal" işaretlemediği sürece tech_stack zorunlu. Eski kayıtlar (field
   * yok) read tarafında "stack-specific" + state.stack ile backfill edilir.
   */
  scope?: "universal" | "stack-specific";
  /**
   * v15.7 (2026-05-26): scope="stack-specific" için kaydedildiği projenin stack'i
   * (örn. "node-npm", "python-pip", "rust-cargo"). Read sırasında current
   * state.stack ile eşleşmezse skip edilir. scope="universal" ise undefined.
   */
  tech_stack?: string;
}

/**
 * Agent karar log'u (raw). Her onaylı agent kararı buraya append edilir.
 * Memory entry'lerinden ayrı — daha sade + dedup detection input'u.
 */
export interface AgentDecisionLogEntry {
  ts: number;
  user_text: string;
  topic_slug: string;
  action: string;
  reason: string;
  /** Decision execute edildi mi? false = user "Hayır" dedi. */
  confirmed: boolean;
}
