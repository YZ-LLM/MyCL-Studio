// conversation-context — Konuşma bağlamı: son 3 user mesajı + öncekilerin özeti.
//
// v15.7 (2026-05-26) — Kullanıcı kuralı:
//   "orkestra ajanı: herşeyi bilir.
//    translator ajan: sadece çeviri yapar.
//    ana ajan: bilmesi gerekeni bilir ki işi düzgün yapsın."
//
// Hem orkestratör hem ana ajan (Phase 1/2/3/4/7/9) konuşma bağlamını görür:
//   - Son 3 user mesajı RAW (TR olarak; ana ajan EN'e mental çevirir)
//   - Önceki mesajlar (5+ user mesajı varsa) 1-2 cümle özet
//
// Özet üretimi translator modeli ile yapılır (Haiku 4.5, ucuz). Cache:
//   process-local Map<hash, summary> — restart'ta sıfırlanır (bir kez ek call).
//   State'e yazılmaz (schema migration kaçınılır + multi-window safe).

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { MyclConfig } from "./config.js";
import { isSubscriptionMode } from "./subscription-mode.js";
import { loadMessages } from "./history-loader.js";
import { log } from "./logger.js";
import type { State } from "./types.js";

const RECENT_LIMIT = 3;
const SUMMARY_TRIGGER = 5; // 5+ user mesajı varsa özet üret
const HISTORY_LOOKBACK = 50; // history.log'tan son N event oku
const SUMMARY_MAX_TOKENS = 200;

export interface ConversationContext {
  /** Son 3 user mesajı, kronolojik (eskiden yeniye). TR/raw. */
  recent_messages: string[];
  /** 4. ve öncesi mesajların 1-2 cümle özeti (EN). 5+ user mesajı yoksa null. */
  earlier_summary: string | null;
  /** Toplam user mesajı sayısı (debug için). */
  total_user_messages: number;
}

// Process-local cache: hash → summary. Aynı eski-mesaj setine yeniden özet
// üretmek için LLM call yapma. Yeni mesaj geldiğinde hash değişir → cache miss.
const summaryCache = new Map<string, string>();

function hashMessages(messages: string[]): string {
  return createHash("sha256")
    .update(messages.join("\n---\n"))
    .digest("hex")
    .slice(0, 16);
}

async function generateSummary(
  config: MyclConfig,
  olderMessages: string[],
): Promise<string> {
  const client = new Anthropic({ apiKey: config.api_keys.translator });
  const model = config.selected_models.translator;
  const numbered = olderMessages.map((m, i) => `${i + 1}. ${m}`).join("\n");
  const response = await client.messages.create({
    model,
    max_tokens: SUMMARY_MAX_TOKENS,
    system:
      "You summarize a conversation between a user (developer, Turkish-speaking) and an AI assistant (MyCL Studio, an AI development IDE). Output 1-2 SHORT English sentences capturing what the user has been asking about. No preamble, no quotes, no 'The user...' prefix — just the topic in plain English. Example: 'User is debugging a survey creation page; reported it doesn't work, then asked for clarification of the issue.'",
    messages: [
      {
        role: "user",
        content: `Summarize these user messages (chronological, oldest first):\n\n${numbered}`,
      },
    ],
  });
  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return text || "(summary unavailable)";
}

export async function buildConversationContext(
  config: MyclConfig,
  state: State,
): Promise<ConversationContext> {
  let userMessages: string[] = [];
  try {
    const result = await loadMessages(state.project_root, {
      since_ts: 0,
      limit: HISTORY_LOOKBACK,
    });
    for (const ev of result.events) {
      if (ev.kind !== "chat_message") continue;
      const data = ev.data as { role?: string; text?: string } | null;
      if (data?.role !== "user" || typeof data.text !== "string") continue;
      const trimmed = data.text.trim();
      if (trimmed.length === 0) continue;
      userMessages.push(trimmed);
    }
  } catch (err) {
    log.warn("conversation-context", "loadMessages failed", err);
    return { recent_messages: [], earlier_summary: null, total_user_messages: 0 };
  }

  const total = userMessages.length;
  const recent = userMessages.slice(-RECENT_LIMIT);
  const olderMessages = userMessages.slice(0, -RECENT_LIMIT);

  let summary: string | null = null;
  // v15.8: saf abonelik modunda özet (translator SDK çağrısı) atlanır → null
  // (caller recent_messages ile devam eder; özet best-effort bağlam zenginleştirme).
  if (total >= SUMMARY_TRIGGER && olderMessages.length > 0 && !isSubscriptionMode(config)) {
    const key = hashMessages(olderMessages);
    const cached = summaryCache.get(key);
    if (cached) {
      summary = cached;
    } else {
      try {
        summary = await generateSummary(config, olderMessages);
        summaryCache.set(key, summary);
        // Cache bloat'ı önle: 50 entry sınırı (FIFO).
        if (summaryCache.size > 50) {
          const firstKey = summaryCache.keys().next().value;
          if (firstKey !== undefined) summaryCache.delete(firstKey);
        }
      } catch (err) {
        log.warn("conversation-context", "summary generation failed", err);
        summary = null;
      }
    }
  }

  return {
    recent_messages: recent,
    earlier_summary: summary,
    total_user_messages: total,
  };
}

/**
 * ConversationContext → Markdown section. Hem orkestratör system prompt'a
 * hem ana ajan template'lerine inject edilir.
 */
export function renderConversationSection(ctx: ConversationContext): string {
  if (ctx.total_user_messages === 0) {
    return "\n\n---\n\n## RECENT CONVERSATION\n\n(Yeni sohbet — henüz kullanıcı mesajı yok)";
  }
  const lines: string[] = ["", "---", "", "## RECENT CONVERSATION", ""];
  if (ctx.earlier_summary) {
    lines.push("### Earlier (summary)");
    lines.push("");
    lines.push(ctx.earlier_summary);
    lines.push("");
  }
  lines.push(`### Last ${ctx.recent_messages.length} user message(s)`);
  lines.push("");
  for (let i = 0; i < ctx.recent_messages.length; i++) {
    const msg = ctx.recent_messages[i] ?? "";
    lines.push(`${i + 1}. "${msg.slice(0, 300)}"`);
  }
  return lines.join("\n");
}

/** Test helper: cache temizle. */
export function _clearSummaryCache(): void {
  summaryCache.clear();
}
