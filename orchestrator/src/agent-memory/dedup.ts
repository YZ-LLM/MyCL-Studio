// agent-memory/dedup — recurring topic detection (LLM semantic).
//
// User talebi (v15.6): "aynı konu için 2 kere teyit aldığı konuları" hafızaya
// önerme. Topic_slug match'i tek başına yetmez (agent farklı zamanlarda farklı
// slug üretebilir). LLM semantic karşılaştırma:
//
//   1. `<project>/.mycl/agent-decisions.jsonl`'den son N kayıt yüklenir.
//   2. Her kayıt Chunk'a dönüştürülür (text = user_text + topic_slug).
//   3. `relevance/classifier.ts:scoreChunks` reuse — current user mesajı query.
//   4. En yüksek skor ≥ 7 ise → recurring=true (bu konu daha önce görüldü).
//   5. Agent system prompt'una "BU KONU TEKRAR EDİYOR" notu eklenir →
//      agent isterse `save_memory_proposal` action seçer.

import { relevanceApiKey, relevanceModelId, type MyclConfig } from "../config.js";
import { log } from "../logger.js";
import { scoreChunks } from "../relevance/classifier.js";
import type { Chunk } from "../relevance/types.js";
import { readAgentDecisionLog } from "./store.js";

export interface RecurringTopicResult {
  recurring: boolean;
  previous_ts?: number;
  previous_topic_slug?: string;
  previous_user_text?: string;
  similarity_score?: number;
}

const DEDUP_HISTORY_LIMIT = 20;
const RECURRING_SCORE_THRESHOLD = 7;

/**
 * Status/meta/sohbet mesajları memory-worthy DEĞİL — dedup atlanır.
 * Pre-filter: LLM call'dan önce regex ile yakala (token tasarrufu + false
 * positive engelleme). Engineering pattern olmayan mesajları erken eler.
 * Kasıtlı broad: false positive (bir actionable mesajı statu sansa) düşük
 * maliyet (hafıza önerisi gelmez ama agent normal cevap verir). False
 * negative (statü mesajını actionable sansa) yüksek maliyet (hatalı save
 * önerisi → kullanıcı kafa karışıklığı).
 */
const META_QUESTION_PATTERNS = [
  // Statü / meta sorular
  /\bneler?\s+yapt[iı]k\b/i,
  /\bne\s+yapt[iı]k\b/i,
  /\bne\s+durumda(?:y[iı]z)?\b/i,
  /\bne\s+a[şs]amada(?:y[iı]z)?\b/i,
  /\bhangi\s+fazda(?:y[iı]z)?\b/i,
  /\bdurum\s+ne\b/i,
  /\b[şs]u\s+anda\b/i,
  /\bnas[iı]l\s+gid(?:iyor|ecek)\b/i,
  /\bbitti\s+mi\b/i,
  /\btamamland[iı]\s+m[iı]\b/i,
  /\banlat\b/i,
  /\bnas[iı]l\s+[çc]al[iı][şs][iı]yor\b/i,
  // Sohbet
  /\b(selam|merhaba|te[şs]ekk[uü]r|sa[ğg]ol|tamam|ok|peki|anla[şs][iı]ld[iı])\b/i,
  // Pipeline / iterasyon kontrol komutları — anlık komut, pattern değil
  /\b(yeni|tekrar|ba[şs]ka)\s+(?:bi(?:r)?\s+)?iterasyon\b/i,
  /\biterasyon\s+(ba[şs]lat|a[çc]|kapat|durdur|bitir)\b/i,
  /\b(?:yeniden\s+)?ba[şs](?:la|lat)\b/i,
  /\b(devam|iptal|vazge[çc]|durdur)\b/i,
  /\b(onayla|onay|revize|kabul)\b/i,
  // Link / dev server istekleri — bunlar build değil
  /\b(link\s+ver|sayfa\s+linki|aç(?:ar\s+m[iı]s[iı]n)?)\b/i,
  /\btarayic[iı](?:da|y[iı])?\b/i,
  // Hata bildirimi — debug triage'a gider, save memory'ye değil
  /\b(t[iı]klanm[iı]yor|çal[iı][şs]m[iı]yor|açılm[iı]yor|kırıld[iı]|broke?n|hata)\b/i,
];

function isMetaOrStatusQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Çok kısa mesajlar (1-2 kelime, status/onay olma ihtimali yüksek)
  if (trimmed.split(/\s+/).length <= 2) return true;
  return META_QUESTION_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Mevcut user mesajı geçmiş onaylı agent kararlarıyla semantic karşılaştırılır.
 * En yüksek skor threshold üzerindeyse recurring=true. Hata durumunda
 * recurring=false (fail-safe — agent normal akışa devam eder).
 */
export async function detectRecurringTopic(
  config: MyclConfig,
  projectRoot: string,
  currentUserText: string,
): Promise<RecurringTopicResult> {
  // v15.6 (2026-05-24): Auto-proposal devre dışı — kullanıcı talebi: "hafıza
  // kontrolümüz çok agresif çalışıyor". Pre-filter ne kadar genişletilse de
  // semantic dedup false positive üretmeye devam ediyor (yarım kalan işleri
  // unut, yeni iş başlat gibi pipeline kontrol komutları yanlış tetikliyor).
  // Memory storage çalışıyor (manuel save için reserved), RELEVANT MEMORY
  // hâlâ agent system prompt'una inject ediliyor — sadece "BU KONU TEKRAR
  // EDİYOR" notu agent'a gönderilmiyor. Re-enable için bu early-return'ü kaldır.
  return { recurring: false };
  // eslint-disable-next-line no-unreachable
  try {
    // Pre-filter: statü/meta/sohbet mesajları memory-worthy değil — LLM call
    // atla, sessizce non-recurring dön. False positive (hatalı save proposal)
    // engelleme + token tasarrufu.
    if (isMetaOrStatusQuestion(currentUserText)) {
      log.info("agent-memory/dedup", "skip — meta/status question");
      return { recurring: false };
    }
    const recentDecisions = await readAgentDecisionLog(
      projectRoot,
      DEDUP_HISTORY_LIMIT,
    );
    // En az 1 confirmed decision yoksa: ilk turn, recurring değil
    const confirmed = recentDecisions.filter((d) => d.confirmed);
    if (confirmed.length === 0) {
      return { recurring: false };
    }

    // Chunk'a dönüştür — text = user_text + topic_slug (semantic karşılaştırma input'u)
    const chunks: Chunk[] = confirmed.map((d) => ({
      id: `agent-decision-${d.ts}`,
      source: "agent-decisions" as const,
      text: `[${d.topic_slug}] ${d.user_text}`,
      metadata: { ts: d.ts },
    }));

    const apiKey = relevanceApiKey(config.api_keys);
    const modelId = relevanceModelId(config.selected_models);

    const scored = await scoreChunks(
      config,
      apiKey,
      modelId,
      currentUserText,
      chunks,
    );

    // En yüksek skor entry
    if (scored.length === 0) return { recurring: false };
    const top = scored.reduce((a, b) => (a.score >= b.score ? a : b));

    log.info("agent-memory/dedup", "scored", {
      candidates: chunks.length,
      top_score: top.score,
      threshold: RECURRING_SCORE_THRESHOLD,
    });

    if (top.score >= RECURRING_SCORE_THRESHOLD) {
      // Match'in original decision'ını bul (metadata.ts ile)
      const matchedDecision = confirmed.find((d) => d.ts === top.metadata.ts);
      return {
        recurring: true,
        previous_ts: matchedDecision?.ts,
        previous_topic_slug: matchedDecision?.topic_slug,
        previous_user_text: matchedDecision?.user_text,
        similarity_score: top.score,
      };
    }
    return { recurring: false };
  } catch (err) {
    log.warn("agent-memory/dedup", "detectRecurringTopic failed (fail-safe)", err);
    return { recurring: false };
  }
}
