// conversation-context — Konuşma bağlamı: son 5 user mesajı + öncekilerin özeti.
//
// v15.7 (2026-05-26) — Kullanıcı kuralı:
//   "orkestra ajanı: herşeyi bilir.
//    translator ajan: sadece çeviri yapar.
//    ana ajan: bilmesi gerekeni bilir ki işi düzgün yapsın."
//
// Hem orkestratör hem ana ajan (Phase 1/2/3/4/7/9) konuşma bağlamını görür:
//   - Son 3 user mesajı: ORKESTRATÖR'e RAW (TR); ANA AJAN'a İngilizce ÇEVRİLEREK
//     (recentLanguage:"en" → translate; ana ajan Türkçe görmemeli — v15.12).
//   - Önceki mesajlar (5+ user mesajı varsa) 1-2 cümle özet (EN)
//
// Özet üretimi translator modeli ile yapılır (Haiku 4.5, ucuz). Cache:
//   process-local Map<hash, summary> — restart'ta sıfırlanır (bir kez ek call).
//   State'e yazılmaz (schema migration kaçınılır + multi-window safe).

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { MyclConfig } from "./config.js";
import { isSubscriptionMode } from "./subscription-mode.js";
import { runClaudeCli } from "./cli-run.js";
import { loadMessages } from "./history-loader.js";
import { log } from "./logger.js";
import { translate } from "./translator.js";
import type { State } from "./types.js";

const RECENT_LIMIT = 5; // Doğru-karar/recall (2026-06-04): 3→5 (daha derin konuşma bağlamı)
const SUMMARY_TRIGGER = 7; // 7+ user mesajı varsa özet üret (RECENT_LIMIT'in üstünde kalmalı)
const HISTORY_LOOKBACK = 50; // history.log'tan son N event oku
const SUMMARY_MAX_TOKENS = 200;

export interface ConversationContext {
  /** Son 3 user mesajı, kronolojik (eskiden yeniye). TR/raw — ORKESTRATÖR içindir. */
  recent_messages: string[];
  /**
   * Son 3 user mesajının İngilizce çevirisi (recentLanguage:"en" ile doldurulur) —
   * ANA AJAN içindir (yalnız İngilizce görmeli). Çeviri başarısızsa boş; renderer
   * forMainAgent modunda ham TR'ye ASLA düşmez (Türkçe sızıntısı engeli).
   */
  recent_messages_en?: string[];
  /** 4. ve öncesi mesajların 1-2 cümle özeti (EN). 5+ user mesajı yoksa null. */
  earlier_summary: string | null;
  /** Toplam user mesajı sayısı (debug için). */
  total_user_messages: number;
}

// Process-local cache: hash → summary. Aynı eski-mesaj setine yeniden özet
// üretmek için LLM call yapma. Yeni mesaj geldiğinde hash değişir → cache miss.
const summaryCache = new Map<string, string>();
// Aynı desen: son-mesaj setinin İngilizce çevirisi (ana ajan için). Set değişince miss.
const recentEnCache = new Map<string, string[]>();

function hashMessages(messages: string[]): string {
  return createHash("sha256")
    .update(messages.join("\n---\n"))
    .digest("hex")
    .slice(0, 16);
}

// Özet sistem promptu — SDK ve CLI yolları aynı talimatı kullanır (drift yok).
const SUMMARY_SYSTEM =
  "You summarize a conversation between a user (developer, Turkish-speaking) and an AI assistant (MyCL Studio, an AI development IDE). Output 1-2 SHORT English sentences capturing what the user has been asking about. No preamble, no quotes, no 'The user...' prefix — just the topic in plain English. Example: 'User is debugging a survey creation page; reported it doesn't work, then asked for clarification of the issue.'";

function summaryUserMessage(olderMessages: string[]): string {
  const numbered = olderMessages.map((m, i) => `${i + 1}. ${m}`).join("\n");
  return `Summarize these user messages (chronological, oldest first):\n\n${numbered}`;
}

async function generateSummary(
  config: MyclConfig,
  olderMessages: string[],
): Promise<string> {
  const client = new Anthropic({ apiKey: config.api_keys.translator });
  const model = config.selected_models.translator;
  const response = await client.messages.create({
    model,
    max_tokens: SUMMARY_MAX_TOKENS,
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user", content: summaryUserMessage(olderMessages) }],
  });
  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return text || "(summary unavailable)";
}

/**
 * Abonelik (CLI) modu özet — düz-metin `claude -p` (forced-tool DEĞİL, sadece
 * SDK yerine CLI). v15.x (2026-06-04): önceden saf-abonelik modunda özet
 * atlanıyordu; artık CLI ile üretilir (bağlam-zenginleştirme paritesi).
 */
async function generateSummaryViaCli(
  config: MyclConfig,
  olderMessages: string[],
): Promise<string> {
  const res = await runClaudeCli({
    systemPrompt: SUMMARY_SYSTEM,
    userMessage: summaryUserMessage(olderMessages),
    modelId: config.selected_models.translator,
    cwd: process.cwd(), // özet yalnız mesaj metninden — proje erişimi gerekmez
    timeoutMs: 120_000,
  });
  if (!res.ok) throw new Error(res.error ?? "cli summary failed");
  return res.text.trim() || "(summary unavailable)";
}

export async function buildConversationContext(
  config: MyclConfig,
  state: State,
  opts?: { recentLanguage?: "raw" | "en" },
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

  // ANA AJAN için: son mesajları İngilizce'ye çevir (yalnız EN görmeli). translate()
  // backend moduna göre (subscription→CLI / api→SDK / auto) çalışır; set-hash cache'li.
  // Başarısızsa boş bırak → renderer ham TR'ye DÜŞMEZ (Türkçe sızıntısı engeli).
  let recentEn: string[] | undefined;
  if (opts?.recentLanguage === "en" && recent.length > 0) {
    const key = hashMessages(recent);
    const cached = recentEnCache.get(key);
    if (cached) {
      recentEn = cached;
    } else {
      try {
        recentEn = await Promise.all(
          recent.map((m) => translate(config, m, "tr-to-en").then((r) => r.text.trim())),
        );
        recentEnCache.set(key, recentEn);
        if (recentEnCache.size > 50) {
          const firstKey = recentEnCache.keys().next().value;
          if (firstKey !== undefined) recentEnCache.delete(firstKey);
        }
      } catch (err) {
        log.warn("conversation-context", "recent translate failed — main agent recents omitted", err);
        recentEn = []; // ham TR'ye DÜŞME
      }
    }
  }

  let summary: string | null = null;
  // v15.x (2026-06-04): özet saf-abonelik modunda da üretilir — SDK yerine CLI
  // (generateSummaryViaCli). Önceden atlanıyordu (best-effort skip); parite için
  // artık her iki backend'de de çalışır. Cache ortak.
  if (total >= SUMMARY_TRIGGER && olderMessages.length > 0) {
    const key = hashMessages(olderMessages);
    const cached = summaryCache.get(key);
    if (cached) {
      summary = cached;
    } else {
      try {
        summary = isSubscriptionMode(config)
          ? await generateSummaryViaCli(config, olderMessages)
          : await generateSummary(config, olderMessages);
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
    recent_messages_en: recentEn,
    earlier_summary: summary,
    total_user_messages: total,
  };
}

/**
 * ConversationContext → Markdown section. Hem orkestratör system prompt'a hem ana
 * ajan template'lerine inject edilir.
 *   - `forMainAgent:true` → son mesajlar İngilizce (`recent_messages_en`); çeviri yoksa
 *     "Last N" bloğu ATLANIR (ham TR'ye düşmez — ana ajan Türkçe görmemeli).
 *   - aksi (orkestratör) → bugünkü ham TR davranışı.
 * Boş-sohbet sentinel'i İngilizce (her iki caller için güvenli).
 */
export function renderConversationSection(
  ctx: ConversationContext,
  opts?: { forMainAgent?: boolean },
): string {
  if (ctx.total_user_messages === 0) {
    return "\n\n---\n\n## RECENT CONVERSATION\n\n(New conversation — no user messages yet.)";
  }
  const lines: string[] = ["", "---", "", "## RECENT CONVERSATION", ""];
  if (ctx.earlier_summary) {
    lines.push("### Earlier (summary)");
    lines.push("");
    lines.push(ctx.earlier_summary);
    lines.push("");
  }
  // Ana ajan: İngilizce çeviriler; orkestratör: ham TR.
  const recent = opts?.forMainAgent ? (ctx.recent_messages_en ?? []) : ctx.recent_messages;
  if (recent.length > 0) {
    lines.push(`### Last ${recent.length} user message(s)`);
    lines.push("");
    for (let i = 0; i < recent.length; i++) {
      const msg = recent[i] ?? "";
      lines.push(`${i + 1}. "${msg.slice(0, 300)}"`);
    }
  }
  return lines.join("\n");
}

/** Test helper: cache'leri temizle. */
export function _clearSummaryCache(): void {
  summaryCache.clear();
  recentEnCache.clear();
}
