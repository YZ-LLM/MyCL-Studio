// relevance/classifier — LLM-based chunk relevance scoring.
//
// Haiku 4.5 (selected_models.relevance ?? selected_models.translator) ile
// batched `score_chunks` tool çağrısı. Her chunk için 0-10 puan + kısa
// gerekçe döner. Tool-based output kullanılır çünkü SDK structured JSON
// validation'ı otomatik yapar (free-form text parse'ından daha sağlam).
//
// Batch size 20 — typik chunk ~150 char (~50 token), 20 chunk ≈ 1K input;
// intent + system ≈ 500 token; toplam ~1.5K input/batch. 20+ chunk varsa
// sequential batch'ler işler.
//
// Token caching DEVRE DIŞI — intent her enjeksiyon noktasında farklı
// (Phase 1 user_intent ≠ Phase 2 enriched_summary ≠ Phase 6 audit summary),
// system+chunks combo cache hit'i mümkün değil. Cost zaten ihmal edilebilir
// (~$0.0001/batch with Haiku).

import { runTurn, type ToolDef } from "../claude-api.js";
import { runClaudeCli } from "../cli-run.js";
import { extractKindBlock, extractLastJsonObject } from "../cli-json.js";
import type { MyclConfig } from "../config.js";
import { emitClaudeStream } from "../ipc.js";
import { log } from "../logger.js";
import type { Chunk, ScoredChunk } from "./types.js";
import { RelevanceError } from "./types.js";

const BATCH_SIZE = 20;

const TOOL_SCORE: ToolDef = {
  name: "score_chunks",
  description:
    "Score each chunk's relevance to the user's intent (0-10). 0=completely irrelevant, 10=highly relevant. Include one short reason per chunk.",
  input_schema: {
    type: "object",
    required: ["scores"],
    properties: {
      scores: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "score", "reason"],
          properties: {
            id: { type: "string" },
            score: { type: "number", minimum: 0, maximum: 10 },
            reason: { type: "string", maxLength: 120 },
          },
        },
      },
    },
  },
};

// TABAN prompt — çıktı talimatı YOK (API tool vs CLI text-JSON ayrı eklenir).
// v15.14: eskiden SYSTEM_PROMPT "Output via the score_chunks tool" diyordu; CLI yolu buna
// CLI_JSON_INSTRUCTION ("Do NOT call any tool") EKLİYORDU → ÇELİŞKİ → sonnet `relevance_scores`
// bloğunu üretmiyordu (cli classifier: no valid relevance_scores block). Çıktı talimatını ayır.
const SYSTEM_PROMPT_BASE = `You are a relevance classifier. The user has an INTENT. You are given a list of CHUNKS from the project's history (audit log, spec, abandoned intents, prior conversations, patterns).

For each chunk, decide how relevant it is to the user's CURRENT intent.

Scoring guide:
- 0-2: completely unrelated or trivial
- 3-5: tangentially related, low signal
- 6-7: related, useful background context
- 8-10: directly relevant, should definitely inform the response

Include all chunk ids; do not skip any.`;

// API (forced-tool) çıktı talimatı.
const SYSTEM_PROMPT = `${SYSTEM_PROMPT_BASE}\n\nOutput via the score_chunks tool.`;

/**
 * Tek batch'i skorla. Tool_use parse edilir; SDK input validation yapar.
 * API fail → RelevanceError throw (caller karar verir).
 */
async function scoreBatch(
  config: MyclConfig,
  apiKey: string,
  modelId: string,
  intent: string,
  chunks: Chunk[],
): Promise<ScoredChunk[]> {
  const chunksBlock = chunks
    .map((c) => `[id=${c.id}]\n${c.text}`)
    .join("\n\n---\n\n");
  const userMessage = `INTENT:\n${intent}\n\nCHUNKS:\n\n${chunksBlock}\n\nCall score_chunks with one entry per chunk.`;

  // Transparency (2026-05-21): kullanıcı tüm LLM call'larını Claude Code
  // panelinde görsün diye init + request + stream emit edilir. `relevance_call`
  // sub event'i banner için ayrı korunur.
  const callTs = Date.now();
  emitClaudeStream({
    sub: "init",
    text: "sdk-relevance-classifier",
    model: modelId,
    turn: 1,
    max_turns: 1,
    ts: callTs,
  });
  emitClaudeStream({
    sub: "request",
    system: SYSTEM_PROMPT,
    user_message: userMessage,
    model: modelId,
    turn: 1,
    max_turns: 1,
    ts: callTs,
  });

  let result;
  try {
    result = await runTurn(
      config,
      apiKey,
      {
        messages: [{ role: "user", content: userMessage }],
        system: SYSTEM_PROMPT,
        role: "main", // ⑤ relevance main-pipeline alt-işidir → main sağlayıcısını izler

        model: modelId,
        tools: [TOOL_SCORE],
        // Force-tool: intent-router/classifier.ts ile aynı consistency —
        // küçük model end_turn'le düz metin dönmesin, score_chunks call'ı
        // zorunlu. Aksi halde `score_chunks tool_use bulunamadı` hatası
        // emit edilir (zaten upstream RelevanceError yakalar ama edge case
        // sıkça yaşanmasın).
        tool_choice: { type: "tool", name: "score_chunks" },
        max_tokens: 2048,
      },
      (ev) => {
        if (ev.type === "text_delta") {
          emitClaudeStream({ sub: "text", text: ev.text, ts: callTs });
        } else if (ev.type === "tool_use") {
          emitClaudeStream({
            sub: "tool_use",
            tool_name: ev.name,
            tool_input: ev.input as Record<string, unknown>,
            ts: callTs,
          });
        } else if (ev.type === "message_end") {
          emitClaudeStream({ sub: "stop", text: ev.stop_reason, ts: callTs });
        }
      },
    );
  } catch (err) {
    throw new RelevanceError(`classifier API failed: ${String(err)}`);
  }
  if (result.usage) {
    emitClaudeStream({
      sub: "token_usage",
      usage: result.usage,
      model: modelId,
      ts: callTs,
    });
  }

  // Relevance call'larını cumulative token sayacına dahil et (token_usage
  // event'i runTurn içinde zaten emit edilmiş; ek olarak relevance_call sub
  // event'i ayrı bir ipucu olarak gönderiyoruz — UI sonraki turda ayrı
  // göstermek isterse).
  emitClaudeStream({
    sub: "relevance_call",
    model: modelId,
    text: `scored ${chunks.length} chunks`,
  });

  const toolUse = result.toolUses.find((t) => t.name === "score_chunks");
  if (!toolUse) {
    throw new RelevanceError(
      `classifier returned no score_chunks tool_use (stop_reason=${result.stop_reason})`,
    );
  }

  const input = toolUse.input as { scores?: Array<{ id: string; score: number; reason: string }> };
  const scores = input.scores;
  if (!Array.isArray(scores)) {
    throw new RelevanceError(`classifier tool_use input.scores not an array`);
  }

  return mergeScoresWithChunks(chunks, scores);
}

/**
 * Pure helper: LLM tool_use input'unun `scores` array'iyle chunks'ı eşleştir.
 * Eksik chunk → score=0 (model atladıysa); clamp 0-10. Export edildi çünkü
 * unit test edilmesi gereken tek pure logic.
 */
export function mergeScoresWithChunks(
  chunks: Chunk[],
  scores: unknown[],
): ScoredChunk[] {
  const scoreMap = new Map<string, { score: number; reason: string }>();
  for (const s of scores) {
    if (typeof s !== "object" || s === null) continue;
    const sc = s as { id?: unknown; score?: unknown; reason?: unknown };
    // CLI yolunda ajan JSON'u ELLE yazar → score "8" (string) veya "8/10" gelebilir.
    // API yolunda input_schema number'a zorlar. parseFloat ile coerce et ki CLI
    // skoru sessizce 0'a düşüp recall'dan kaybolmasın (API↔CLI parite).
    const rawScore =
      typeof sc.score === "number"
        ? sc.score
        : typeof sc.score === "string"
          ? parseFloat(sc.score)
          : NaN;
    if (typeof sc.id === "string" && Number.isFinite(rawScore)) {
      scoreMap.set(sc.id, {
        score: Math.max(0, Math.min(10, rawScore)),
        reason: typeof sc.reason === "string" ? sc.reason : "",
      });
    }
  }

  return chunks.map((c) => {
    const sc = scoreMap.get(c.id);
    return {
      ...c,
      score: sc?.score ?? 0,
      reason: sc?.reason ?? "(not scored by model)",
    };
  });
}

/**
 * Chunk listesini batch'lere bölüp sequential olarak skorla. Her batch ayrı
 * API call'ı; 20+ chunk varsa birden fazla call.
 *
 * Fail policy: tek batch fail → tüm operasyon RelevanceError throw. Caller
 * (relevance-engine) bunu yakalayıp emitError + boş array fallback yapar.
 */
export async function scoreChunks(
  config: MyclConfig,
  apiKey: string,
  modelId: string,
  intent: string,
  chunks: Chunk[],
): Promise<ScoredChunk[]> {
  if (chunks.length === 0) return [];

  log.info("relevance/classifier", "scoring", {
    chunk_count: chunks.length,
    model: modelId,
  });

  const batches: Chunk[][] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    batches.push(chunks.slice(i, i + BATCH_SIZE));
  }

  const all: ScoredChunk[] = [];
  for (const batch of batches) {
    const scored = await scoreBatch(config, apiKey, modelId, intent, batch);
    all.push(...scored);
  }

  log.info("relevance/classifier", "scoring done", {
    chunks_scored: all.length,
    above_5: all.filter((c) => c.score > 5).length,
  });

  return all;
}

// ───────────────── Abonelik (CLI) modu — text-JSON scoring ─────────────────
// v15.x (2026-06-04): saf-abonelik modunda relevance ARTIK atlanmaz. `claude -p`
// forced-tool (score_chunks) desteklemediği için project-type'taki (classifyViaCli)
// kanıtlı text-JSON desenini uygula: ajan tek JSON bloğu yazar, extractKindBlock +
// mergeScoresWithChunks (aynı saf merge) ile parse edilir. Böylece abonelik kullanıcısı
// da gerçek recall sıralaması alır (MyCL "hiçbir şeyi unutmuyor" + "sessiz fallback yok").

const CLI_JSON_INSTRUCTION = `\n\nDo NOT call any tool. Output your result as ONE JSON block at the very end and nothing after it:
{"kind":"relevance_scores","scores":[{"id":"<chunk id>","score":<0-10>,"reason":"<short>"}]}
Include exactly one entry per chunk id; do not skip any.`;

/**
 * SAF: CLI text-JSON çıktısından scores'u çıkar + chunks ile eşleştir. Geçerli
 * `relevance_scores` bloğu yoksa RelevanceError (caller boş-array fallback yapar —
 * API yolundaki "no tool_use" davranışıyla simetrik). Test edilebilir.
 */
export function parseCliScores(text: string, chunks: Chunk[]): ScoredChunk[] {
  const block = extractKindBlock(text, ["relevance_scores"]);
  if (block && Array.isArray(block.scores)) {
    return mergeScoresWithChunks(chunks, block.scores as unknown[]);
  }
  // Dayanıklılık: "kind" alanı eksik olsa bile `scores[]` içeren SON JSON objesini kabul et
  // (küçük/CLI modeli kind'i atlayabilir). API yolundaki tool-input ile aynı şekil.
  const fallback = extractLastJsonObject(text, (o) => Array.isArray(o.scores));
  if (fallback && Array.isArray(fallback.scores)) {
    return mergeScoresWithChunks(chunks, fallback.scores as unknown[]);
  }
  throw new RelevanceError("cli classifier: no valid relevance_scores block");
}

/** Tek batch'i CLI ile skorla (runClaudeCli + text-JSON parse). */
async function scoreBatchViaCli(
  modelId: string,
  intent: string,
  chunks: Chunk[],
): Promise<ScoredChunk[]> {
  const chunksBlock = chunks
    .map((c) => `[id=${c.id}]\n${c.text}`)
    .join("\n\n---\n\n");
  const userMessage = `INTENT:\n${intent}\n\nCHUNKS:\n\n${chunksBlock}`;

  // Tek deneme: claude'u çağır + parse et. Hata (exit=1/timeout/parse) → RelevanceError.
  const attempt = async (): Promise<ScoredChunk[]> => {
    const callTs = Date.now();
    emitClaudeStream({
      sub: "init",
      text: "cli-relevance-classifier",
      model: modelId,
      turn: 1,
      max_turns: 1,
      ts: callTs,
    });
    let res;
    try {
      res = await runClaudeCli({
        // TABAN + CLI text-JSON (tool-mention YOK → çelişki giderildi).
        systemPrompt: SYSTEM_PROMPT_BASE + CLI_JSON_INSTRUCTION,
        userMessage,
        modelId,
        cwd: process.cwd(), // skorlama yalnız intent+chunks metninden — proje erişimi gerekmez
        timeoutMs: 120_000,
      });
    } catch (err) {
      throw new RelevanceError(`cli classifier failed: ${String(err)}`);
    }
    if (!res.ok) {
      throw new RelevanceError(`cli classifier failed: ${res.error ?? "unknown"}`);
    }
    emitClaudeStream({
      sub: "relevance_call",
      model: modelId,
      text: `scored ${chunks.length} chunks (cli)`,
    });
    try {
      return parseCliScores(res.text, chunks);
    } catch (err) {
      // Teşhis (v15.14): ham çıktının başını logla — deployed-bağlamda neden parse-edilemediğini sonra çöz.
      log.warn("relevance/classifier", "cli parse failed — ham çıktı başı", {
        head: (res.text ?? "").slice(0, 200),
      });
      throw err;
    }
  };

  // v15.14: BİR KEZ retry — geçici claude exit=1 / timeout / truncation'ı atlat; sonra caller graceful-degrade.
  try {
    return await attempt();
  } catch (err) {
    log.warn("relevance/classifier", "cli batch başarısız, bir kez yeniden deneniyor", {
      error: String(err).slice(0, 160),
    });
    return await attempt();
  }
}

/**
 * scoreChunks'ın abonelik-modu eşi: batch'leri `claude -p` text-JSON ile skorlar.
 * Tek batch fail → RelevanceError (caller emitError + boş-array fallback).
 */
export async function scoreChunksViaCli(
  modelId: string,
  intent: string,
  chunks: Chunk[],
): Promise<ScoredChunk[]> {
  if (chunks.length === 0) return [];
  log.info("relevance/classifier", "scoring (cli)", {
    chunk_count: chunks.length,
    model: modelId,
  });
  const all: ScoredChunk[] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    all.push(...(await scoreBatchViaCli(modelId, intent, batch)));
  }
  log.info("relevance/classifier", "scoring done (cli)", {
    chunks_scored: all.length,
    above_5: all.filter((c) => c.score > 5).length,
  });
  return all;
}
