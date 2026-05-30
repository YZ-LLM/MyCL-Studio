// intent-router/handlers/chat — sohbet / küçük konuşma için kısa LLM cevap.
//
// Pipeline başlatmaz, state.current_phase'i değiştirmez. Pure side-effect:
// kullanıcıya bir assistant chat mesajı yazar. Proje context'i (varsa)
// relevance engine ile enjekte edilir — kısa cevap için kaynak.

import { runTurn } from "../../claude-api.js";
import type { MyclConfig } from "../../config.js";
import { emitChatMessage, emitClaudeStream } from "../../ipc.js";
import { log } from "../../logger.js";
import { buildRelevantProjectContext } from "../../relevance/injectors.js";
import type { State } from "../../types.js";
import type { IntentClassification } from "../types.js";

const SYSTEM_PROMPT = `You are MyCL Studio's assistant chatting briefly with the user.

Keep responses SHORT (1-3 sentences). Use Turkish (TR) — the user writes in Turkish.

Style:
- Friendly but not effusive.
- If the user greeted, greet back briefly and ask if they want to work on the project.
- If the user said thanks, acknowledge briefly.
- If the user chatted about something off-topic, respond briefly and gently bring focus back if useful.
- Do NOT propose code changes or start a new feature — that requires explicit "develop" intent.
- If project context below is non-empty AND relevant, you may mention it briefly.

Project context (relevant memories, may be empty):
---
{{PROJECT_CONTEXT}}
---`;

export async function handleChatIntent(
  state: State,
  config: MyclConfig,
  text: string,
  _intent: IntentClassification,
): Promise<void> {
  log.info("chat-handler", "start", { text_len: text.length });

  // Proje context — kısa, sadece relevance için. Fail-safe: relevance fail
  // olursa "(no prior project context — fresh project)" sentinel.
  let projectCtx = "(no prior project context — fresh project)";
  try {
    projectCtx = await buildRelevantProjectContext(config, state, text);
  } catch (err) {
    log.warn("chat-handler", "project context fetch failed (non-fatal)", err);
  }

  const systemPrompt = SYSTEM_PROMPT.replace("{{PROJECT_CONTEXT}}", projectCtx);

  // Claude Code panel transparency: init + request emit edilir; stream
  // sırasında text_delta + tool_use + stop akar; sonunda token_usage. Hepsi
  // aynı `callTs` ile cross-panel correlation için işaretlenir. Kullanıcı
  // "gizli saklı bişey olmasın" (2026-05-21) — tüm LLM call'lar şeffaf.
  const callTs = Date.now();
  const chatModel = config.selected_models.translator;
  emitClaudeStream({
    sub: "init",
    text: "sdk-chat-handler",
    model: chatModel,
    cwd: state.project_root,
    turn: 1,
    max_turns: 1,
    ts: callTs,
  });
  emitClaudeStream({
    sub: "request",
    system: systemPrompt,
    user_message: text,
    model: chatModel,
    turn: 1,
    max_turns: 1,
    ts: callTs,
  });

  let assistantText = "";
  try {
    const result = await runTurn(
      config,
      config.api_keys.translator,
      {
        messages: [{ role: "user", content: text }],
        system: systemPrompt,
        model: chatModel,
        max_tokens: 256,
      },
      (ev) => {
        if (ev.type === "text_delta") {
          assistantText += ev.text;
          emitClaudeStream({ sub: "text", text: ev.text, ts: callTs });
        } else if (ev.type === "tool_use") {
          emitClaudeStream({
            sub: "tool_use",
            tool_name: ev.name,
            tool_input: ev.input as Record<string, unknown>,
            ts: callTs,
          });
        } else if (ev.type === "message_end") {
          emitClaudeStream({
            sub: "stop",
            text: ev.stop_reason,
            ts: callTs,
          });
        }
      },
    );
    if (result.usage) {
      emitClaudeStream({
        sub: "token_usage",
        usage: result.usage,
        model: chatModel,
        ts: callTs,
      });
    }
    // runTurn finalMessage'te text blocklarını collect etmez — text_delta'lardan
    // birikiyoruz. Backup: result.assistantContent içinden de derlenebilir ama
    // text_delta'lar daha temiz.
    if (!assistantText) {
      // Fallback: assistantContent array'inden text block topla
      const content = result.assistantContent;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type?: string }).type === "text" &&
            "text" in block
          ) {
            assistantText += String((block as { text?: string }).text ?? "");
          }
        }
      }
    }
  } catch (err) {
    // runTurn humanizeAnthropicError'ı zaten emit etti. Burada sadece fail-safe
    // chat mesajı; kullanıcı yine "geliştirme istersen yaz" sinyali alır.
    log.error("chat-handler", "LLM call failed", err);
    emitChatMessage(
      "system",
      "Sohbet cevabı şu an üretilemedi — birazdan tekrar deneyebilirsin. Geliştirme isteğin için ne istediğini yazabilirsin.",
    );
    return;
  }

  const trimmed = assistantText.trim();
  if (trimmed.length === 0) {
    emitChatMessage("system", "(cevap boş döndü — tekrar deneyebilirsin.)");
    return;
  }

  emitChatMessage("assistant", trimmed);
  log.info("chat-handler", "done", { reply_len: trimmed.length });
}
