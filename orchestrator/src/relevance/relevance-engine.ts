// relevance/relevance-engine — chunk pipeline.
//
// Akış:
//   1. Chunk-store'dan istenen source'lar için tüm chunk'ları topla
//   2. Keyword pre-filter (Jaccard overlap) → top-K aday (cheap, no API)
//   3. Classifier (LLM) ile top-K'yi skorla
//   4. score >= min_score filtrele, ilk max_chunks döndür
//
// Fail policy: classifier API fail → RelevanceError yakalanır, emitError +
// log.warn, boş array döner. Caller (Phase 2 injector vs.) sentinel ile
// devam eder. Faz çökmez; relevance opsiyonel yan-yarar.

import { relevanceApiKey, relevanceModelId, type MyclConfig } from "../config.js";
import { isSubscriptionMode } from "../subscription-mode.js";
import { emitChatMessage } from "../ipc.js";
import { log } from "../logger.js";
import type { State } from "../types.js";
import {
  extractAbandonedChunks,
  extractAuditChunks,
  extractBriefChunks,
  extractFeatureChunks,
  extractGitChunks,
  extractHistoryChunks,
  extractPatternsChunks,
  extractSpecChunks,
  extractUserGuideChunks,
} from "./chunk-store.js";
import { scoreChunks, scoreChunksViaCli } from "./classifier.js";
import type { Chunk, RelevanceQueryOptions, ScoredChunk } from "./types.js";

// İngilizce stopword'ler (common, basic). Türkçe yok — bilinçli karar:
// pipeline'da relevance'a giren tüm metinler EN'de (Faz 1 user_intent TR→EN
// translate sonrası geliyor; spec.md, abandoned-intents, audit, history,
// patterns hepsi EN). Daha geniş liste / dil agnostik tokenizasyon sonraki tur.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on",
  "at", "for", "with", "by", "from", "is", "was", "are", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "this",
  "that", "these", "those", "it", "its", "as", "not", "no",
]);

/**
 * Pure helper: intent text'inden anlamlı keyword'ler çıkar. Lowercase, split
 * by non-alphanumeric, stopword filter, min 3 char.
 */
export function extractKeywords(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/**
 * Pure helper: Jaccard overlap |A ∩ B| / |A ∪ B|. İki set arasında 0-1.
 */
export function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Pure helper: chunks'ı intent'e göre Jaccard overlap ile sırala, top-K döndür.
 * Tüm chunk'ları skorlamak yerine pre-filter — LLM call maliyetini azaltır.
 */
export function keywordPreFilter(
  intent: string,
  chunks: Chunk[],
  topK: number,
): Chunk[] {
  const intentKeywords = extractKeywords(intent);
  if (intentKeywords.size === 0) {
    // Intent çok kısa veya sadece stopword içeriyorsa pre-filter yapma —
    // ilk topK chunk'ı geç (downstream classifier final kararı verir).
    return chunks.slice(0, topK);
  }
  const scored = chunks.map((c) => ({
    chunk: c,
    overlap: jaccardOverlap(intentKeywords, extractKeywords(c.text)),
  }));
  scored.sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, topK).map((s) => s.chunk);
}

/**
 * Source listesine göre chunk-store'lardan paralel olarak chunk'ları topla.
 * history kaynağı history_phase parametresi gerektirir; verilmemişse atla.
 * brief/git source'ları opsiyonel — eksik dosya/git repo → boş array.
 */
async function gatherChunks(
  projectRoot: string,
  options: RelevanceQueryOptions,
): Promise<Chunk[]> {
  const sources = new Set(options.sources);
  const tasks: Array<Promise<Chunk[]>> = [];
  if (sources.has("audit")) tasks.push(extractAuditChunks(projectRoot));
  if (sources.has("spec")) tasks.push(extractSpecChunks(projectRoot));
  if (sources.has("abandoned")) tasks.push(extractAbandonedChunks(projectRoot));
  if (sources.has("patterns")) tasks.push(extractPatternsChunks(projectRoot));
  if (sources.has("brief")) tasks.push(extractBriefChunks(projectRoot));
  if (sources.has("features")) tasks.push(extractFeatureChunks(projectRoot));
  if (sources.has("user-guide")) tasks.push(extractUserGuideChunks(projectRoot));
  if (sources.has("git")) tasks.push(extractGitChunks(projectRoot));
  if (sources.has("history") && typeof options.history_phase === "number") {
    tasks.push(extractHistoryChunks(projectRoot, options.history_phase));
  }
  const lists = await Promise.all(tasks);
  let all = lists.flat();

  // audit_phase post-filter: sadece audit source'unu daraltır. Phase 6
  // (audit_phase=6), Phase 9/19 (audit_phase=9) için kullanılır.
  if (typeof options.audit_phase === "number") {
    const ap = options.audit_phase;
    all = all.filter((c) => c.source !== "audit" || c.metadata.phase === ap);
  }
  return all;
}

/**
 * Pipeline: gather → pre-filter → LLM scoring → threshold → max.
 *
 * Fail-safe: classifier fail → emitError + log.warn, boş array döner.
 */
export async function getRelevantChunks(
  config: MyclConfig,
  state: State,
  options: RelevanceQueryOptions,
): Promise<ScoredChunk[]> {
  // v15.x (2026-06-04): saf abonelik modunda relevance ARTIK atlanmaz — text-JSON
  // CLI ile skorlanır (scoreChunksViaCli, project-type deseni). Önceden boş sentinel
  // dönüyordu → abonelik kullanıcısı recall sıralaması alamıyordu (MyCL "hiçbir şeyi
  // unutmuyor" + "sessiz fallback yok" ihlali). Backend seçimi scoring adımında.
  const maxChunks = options.max_chunks ?? 5;
  const minScore = options.min_score ?? 6;
  const topK = options.keyword_top_k ?? 20;

  log.info("relevance/engine", "query start", {
    sources: options.sources,
    intent_len: options.intent.length,
    max_chunks: maxChunks,
    min_score: minScore,
    top_k: topK,
  });

  const allChunks = await gatherChunks(state.project_root, options);
  if (allChunks.length === 0) {
    log.info("relevance/engine", "no chunks gathered");
    return [];
  }

  const candidates = keywordPreFilter(options.intent, allChunks, topK);

  let scored: ScoredChunk[];
  try {
    // Backend: saf-abonelik → text-JSON CLI (forced-tool yok); aksi → SDK forced-tool.
    scored = isSubscriptionMode(config)
      ? await scoreChunksViaCli(
          relevanceModelId(config.selected_models),
          options.intent,
          candidates,
        )
      : await scoreChunks(
          config,
          relevanceApiKey(config.api_keys),
          relevanceModelId(config.selected_models),
          options.intent,
          candidates,
        );
  } catch (err) {
    // Relevance fail-safe: faz çökmesin; YUMUŞAK bilgi notu (KIRMIZI hata DEĞİL) + log.warn + boş array.
    // Relevance NON-kritik — caller "(no relevant ... found)" sentinel'iyle bağlamsız devam eder; kullanıcıyı
    // korkutucu kırmızı banner'la alarma sokma (v15.14: emitError → emitChatMessage system). Detay log'da.
    log.warn("relevance/engine", "classifier failed (degraded)", err);
    emitChatMessage("system", "ℹ️ Geçmiş bağlam alınamadı; bu adım bağlamsız sürüyor (akış etkilenmez).");
    return [];
  }

  const filtered = scored
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks);

  log.info("relevance/engine", "query done", {
    gathered: allChunks.length,
    pre_filtered: candidates.length,
    scored: scored.length,
    above_threshold: filtered.length,
  });

  return filtered;
}
