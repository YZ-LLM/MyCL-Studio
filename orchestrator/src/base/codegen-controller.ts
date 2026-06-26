// base/codegen-controller — codegen tipi fazların ortak akışı (P6, P9).
//
// Pattern:
//   - Anthropic SDK + tool_use loop (Read/Write/Edit/Bash/Glob/Grep)
//   - Her tool_use → client-side executeTool → tool_result → observer (audit)
//   - end_turn (tool_use yok) → success; max_turns aşılırsa fail
//
// Audit observer hook'u faz controller'ı sağlar — TDD'de tdd-test-write,
// tdd-prod-write, tdd-green/red; UI build'de farklı event'ler.

import type Anthropic from "@anthropic-ai/sdk";
import { runTurn, type ApiMessage, type ToolDef } from "../claude-api.js";
import type { MyclConfig } from "../config.js";
import {
  clearHistory,
  loadHistory,
  saveHistoryStep,
} from "../history.js";
import { randomUUID } from "node:crypto";
import { emitAskq, emitChatMessage, emitClaudeStream, emitError } from "../ipc.js";
import { autoAnswerPick } from "../auto-answer.js";
import { log } from "../logger.js";
import { executeTool, type ToolContext } from "../tool-handlers.js";
import { translate } from "../translator.js";
import type { PhaseId, State } from "../types.js";

export interface CodegenObserverContext {
  tool_use: { name: string; input: Record<string, unknown> };
  result: { is_error: boolean };
}

export type CodegenObserver = (ctx: CodegenObserverContext) => Promise<void>;

/**
 * v15.7 (2026-05-25): Resume edilen history'de "dangling tool_use" repair.
 *
 * Problem: Önceki Phase 8 run'ı abort/crash olduysa, son assistant mesajında
 * tool_use block'u kaydedilmiş ama sonraki user tool_result mesajı diske
 * yazılmadan iş kesilmiş olabilir. Resume sırasında Anthropic API bu bozuk
 * history'yi reddeder (HTTP 400 — "tool_use ids were found without tool_result
 * blocks immediately after").
 *
 * Çözüm: Her assistant mesajındaki tool_use id'lerini topla → bir sonraki user
 * mesajında tool_result olarak karşılığı var mı kontrol et. Eksik tool_result
 * varsa synthetic "interrupted" stub enjekte et (is_error=true). Claude'a
 * "önceki tool kesintiye uğradı, devam et" sinyali verir.
 *
 * Edge case: Son mesaj assistant ise (tool_use'lu, sonraki user yok) → synthetic
 * user mesajı ekle. Tüm tool_use'lara karşılık verir.
 */
export function repairDanglingToolUse(history: ApiMessage[]): ApiMessage[] {
  if (history.length === 0) return history;
  const out: ApiMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]!;
    out.push(msg);
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const toolUseIds: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "tool_use"
      ) {
        const id = (block as { id?: string }).id;
        if (id) toolUseIds.push(id);
      }
    }
    if (toolUseIds.length === 0) continue;
    // Sonraki user mesajındaki tool_result_id'leri topla
    const next = history[i + 1];
    const fulfilledIds = new Set<string>();
    if (next && next.role === "user" && Array.isArray(next.content)) {
      for (const block of next.content) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as { type?: string }).type === "tool_result"
        ) {
          const id = (block as { tool_use_id?: string }).tool_use_id;
          if (id) fulfilledIds.add(id);
        }
      }
    }
    const missingIds = toolUseIds.filter((id) => !fulfilledIds.has(id));
    if (missingIds.length === 0) continue;
    // Eksik tool_result'lar — synthetic stub enjekte et
    const syntheticResults = missingIds.map((id) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content:
        "ERROR: tool execution interrupted by previous abort/crash. Retry the operation.",
      is_error: true,
    }));
    if (next && next.role === "user" && Array.isArray(next.content)) {
      // Mevcut user mesajına ekle
      next.content = [...next.content, ...syntheticResults];
    } else {
      // Yeni user mesajı oluştur ve aralığa ekle
      out.push({
        role: "user",
        content: syntheticResults,
      } as ApiMessage);
    }
  }
  return out;
}

export interface CodegenRunOpts {
  tag: string;
  phaseId: PhaseId;
  state: State;
  config: MyclConfig;
  systemPrompt: string;
  modelId: string;
  /** Escalation efor override (YZLLM 2026-06-11): set ise config.claude_code_flags.effort YERİNE bu kullanılır. */
  effortOverride?: string;
  apiKey: string;
  initialUserMessage: string;
  tools: ToolDef[];
  toolContext: ToolContext;
  betas?: string[];
  /** Her tool execution sonrası audit yazmak için hook. */
  observer?: CodegenObserver;
  /**
   * v15.8: CLI backend'e özel — ajanın metin akışındaki `MYCL_TEST_RESULT: green|red`
   * marker'ı parse edilince çağrılır (CLI stream-json tool_result.is_error taşımadığı
   * için Faz 8 TDD red/green ayrımı bununla yapılır). SDK backend KULLANMAZ. Faz 8 bağlar.
   */
  onTestResult?: (green: boolean, detail: string) => void;
  /**
   * PhaseSpec.allowed_tools allowlist'i. Verilirse `tools` bu set ile süzülür
   * (SDK'ya yalnız izinli tool tanımları gönderilir). undefined → tüm tools
   * geçer (legacy davranış).
   */
  allowed_tool_names?: string[];
  /**
   * v15.8 (2026-05-30): Turn bütçesi (opt-in — undefined = SINIRSIZ, legacy
   * davranış korunur; codegen fazları 5/8/9 etkilenmez). Faz 0 D1 (debug
   * triage) maliyet optimizasyonu için: ajan 88 turn boyunca OS forensiğine
   * dalmasın.
   *
   * softTurnBudget: bu turn'de (bir kez) budgetNudge tool_result'a eklenir →
   *   ajan elindeki bulgularla sonuçlansın (context korunur).
   * maxTurns: bu turn'e ulaşılınca loop kesilir (caller force-conclude eder).
   */
  softTurnBudget?: number;
  budgetNudge?: string;
  maxTurns?: number;
}

export type CodegenOutcome =
  | { kind: "done"; turns: number }
  | { kind: "aborted"; turns: number }
  | { kind: "failed"; reason: string };

/** Eskalasyon (AskUserQuestion) askq'sının abort sinyali. */
const ABORT_SENTINEL = Symbol("codegen-aborted");

interface PendingAskq {
  options_en: string[];
  options_tr: string[];
}

export class CodegenBaseController {
  private aborted = false;
  // v15.8 (2026-05-31): doubt-driven eskalasyon — codegen (Faz 5/8) kritik,
  // geri-dönüşsüz, net cevabı olmayan kararlarda kullanıcıya sorabilsin.
  // Mevcut askq tesisatı (emitAskq + submitAskqAnswer) yeniden kullanılır.
  private pendingAskq: PendingAskq | null = null;
  private pendingResolver: ((selected_tr: string) => void) | null = null;
  private pendingRejecter: ((reason: unknown) => void) | null = null;
  private currentAskqId: string | null = null;

  constructor(private readonly opts: CodegenRunOpts) {}

  /** index.ts askq routing buraya yönlendirir (qa/production ile aynı imza). */
  submitAskqAnswer(askqId: string, selected_tr: string): void {
    if (!this.pendingAskq || this.currentAskqId !== askqId) {
      emitError("stale askq answer", { askqId });
      return;
    }
    const resolver = this.pendingResolver;
    this.pendingResolver = null;
    this.pendingRejecter = null;
    if (resolver) resolver(selected_tr);
  }

  /**
   * Codegen base abort — turn boundary'de yakalanır. SDK çağrısı orta yerden
   * kesilemez (Anthropic SDK signal yok); bir turn tamamlanır, sonra abort
   * outcome döner. Bekleyen bir eskalasyon askq'sı varsa onu da reject eder.
   */
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    log.info(this.opts.tag, "abort requested");
    const rejecter = this.pendingRejecter;
    this.pendingResolver = null;
    this.pendingRejecter = null;
    this.pendingAskq = null;
    this.currentAskqId = null;
    if (rejecter) rejecter(ABORT_SENTINEL);
  }

  async run(): Promise<CodegenOutcome> {
    const { opts } = this;
    // Sınır YOK: doğal end_turn (Claude "tool kullanmadım" der) veya abort
    // ile biter. Runaway koruması abort_phase + bash-guard + safeEnv +
    // denied_paths katmanlarında.

    // PhaseSpec.allowed_tools enforcement — verildiyse SDK'ya yalnız izinli
    // tool tanımları gönderilir. Claude ek tool çağıramaz; geriye gönderilmez.
    const tools = opts.allowed_tool_names
      ? opts.tools.filter((t) => opts.allowed_tool_names!.includes(t.name))
      : opts.tools;
    log.info(opts.tag, "tools resolved", {
      requested: opts.tools.map((t) => t.name),
      allowed: opts.allowed_tool_names ?? null,
      effective: tools.map((t) => t.name),
    });

    emitClaudeStream({
      sub: "init",
      text: `sdk-${opts.tag}`,
      model: opts.modelId,
      cwd: opts.state.project_root,
    });

    // Resume: önceki turn'lerden kalan history varsa yükle. Faz fail/abort
    // sonrası "devam et" akışında Claude'un nereden devam edeceğini bilmesi
    // için tüm conversation kaydedilir (her turn).
    const existingHistoryRaw = await loadHistory(
      opts.state.project_root,
      opts.phaseId,
    );
    // v15.7 (2026-05-25): Resume edilen history'de "dangling tool_use" repair.
    // Önceki run abort/crash olduysa son assistant mesajında tool_use block'u
    // varken sonraki user mesajındaki tool_result eksik kalmış olabilir.
    // Anthropic API bu durumda 400 reddeder ("tool_use ids were found without
    // tool_result blocks"). Eksik tool_result'lar için synthetic "interrupted"
    // stub enjekte et — history continuity korunur, Claude devam edebilir.
    const existingHistory = repairDanglingToolUse(existingHistoryRaw);
    const messages: ApiMessage[] =
      existingHistory.length > 0 ? [...existingHistory] : [];

    if (existingHistory.length > 0) {
      log.info(opts.tag, "resuming with history", {
        message_count: existingHistory.length,
        repaired: existingHistory.length !== existingHistoryRaw.length,
      });
      emitChatMessage(
        "system",
        `Faz ${opts.phaseId} kaldığı yerden devam ediyor (${existingHistory.length} mesaj history yüklendi).`,
      );
      // Resume sırasında system prompt'u UI'a yine de yansıt — kullanıcı
      // hangi talimatla devam edildiğini görsün.
      emitClaudeStream({
        sub: "request",
        system: opts.systemPrompt,
        user_message: `(resumed — ${existingHistory.length} prior messages)`,
        turn: 1,
      });
    } else {
      // Yeni başlangıç: initial user message'ı history'ye kaydet.
      const initialMsg: ApiMessage = {
        role: "user",
        content: opts.initialUserMessage,
      };
      messages.push(initialMsg);
      await saveHistoryStep(opts.state.project_root, opts.phaseId, initialMsg);
      // ADR-009 doğrulama: Claude'a giden EN system + initial user.
      emitClaudeStream({
        sub: "request",
        system: opts.systemPrompt,
        user_message: opts.initialUserMessage,
        turn: 1,
      });
    }

    for (let turn = 0; ; turn++) {
      if (this.aborted) {
        log.info(opts.tag, "aborted at turn boundary", { turn });
        return { kind: "aborted", turns: turn };
      }
      // v15.8 (2026-05-30): Hard turn cap (opt-in). Bütçe aşıldıysa loop'u kes;
      // caller (Faz 0) elindeki bilgiyle force-conclude eder. Tangent/runaway
      // koruması — sınırsız keşif maliyetini keser.
      if (opts.maxTurns !== undefined && turn >= opts.maxTurns) {
        log.warn(opts.tag, "max turn budget reached — stopping loop", {
          turn,
          maxTurns: opts.maxTurns,
        });
        await clearHistory(opts.state.project_root, opts.phaseId);
        return { kind: "done", turns: turn };
      }
      log.info(opts.tag, "turn start", {
        turn,
        messages_count: messages.length,
        model: opts.modelId,
      });
      // Progress feedback — UI banner'da "Turn N" göster.
      emitClaudeStream({
        sub: "init",
        text: `sdk-${opts.tag}`,
        model: opts.modelId,
        turn: turn + 1,
      });

      let turnResult;
      try {
        turnResult = await runTurn(
          opts.config,
          opts.apiKey,
          {
            messages,
            system: opts.systemPrompt,
            model: opts.modelId,
            role: "main", // ⑤ main-pipeline → Sağlayıcı=Z.AI seçiliyse GLM'e yönlenir
            tools,
            max_tokens: 8192,
            betas: opts.betas,
            effortOverride: opts.effortOverride, // escalation: API modunda efor merdiveni
          },
          (ev) => this.handleStreamEvent(ev),
        );
      } catch (err) {
        log.error(opts.tag, "runTurn failed", err);
        return { kind: "failed", reason: `claude api failed: ${String(err)}` };
      }

      const assistantMsg: ApiMessage = {
        role: "assistant",
        content: turnResult.assistantContent,
      };
      messages.push(assistantMsg);
      // History persist: her assistant turn'ünü diske yaz.
      await saveHistoryStep(
        opts.state.project_root,
        opts.phaseId,
        assistantMsg,
      );

      if (turnResult.toolUses.length === 0) {
        log.info(opts.tag, "no tool_use, end_turn", {
          stop_reason: turnResult.stop_reason,
        });
        // Faz başarıyla bitti — history'i temizle, sonraki run sıfırdan.
        await clearHistory(opts.state.project_root, opts.phaseId);
        return { kind: "done", turns: turn };
      }

      const toolResults: Anthropic.MessageParam["content"] = [];
      for (const tu of turnResult.toolUses) {
        const input = tu.input as Record<string, unknown>;
        // doubt-driven eskalasyon: AskUserQuestion executeTool'a (dosya-op) gitmez
        // — mevcut askq tesisatıyla kullanıcıya sorulur, cevap tool_result olur.
        if (tu.name === "AskUserQuestion") {
          let answer: string;
          try {
            answer = await this.askUser(input);
          } catch (err) {
            if (err === ABORT_SENTINEL) {
              log.info(opts.tag, "aborted during escalation", { turn });
              return { kind: "aborted", turns: turn };
            }
            answer =
              "ERROR: escalation unavailable; proceed with your best judgment and state the assumption explicitly in your output.";
          }
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: answer });
          continue;
        }
        const result = await executeTool(tu.name, input, opts.toolContext);
        // v15.7 (2026-05-25): tool_result content cap — Bash test output'ları
        // ve büyük Read sonuçları her turn history'e ham eklenirse token
        // patlaması olur (30 turn × 50KB output = 1.5 MB ≈ 400K input token).
        // Orchestrator agent zaten 8KB cap kullanıyor. Codegen daha geniş 12KB
        // (test çıktısı için fail/pass satırları + diff görmesi lazım).
        const TOOL_RESULT_CAP = 12_000;
        const cappedContent =
          typeof result.content === "string" && result.content.length > TOOL_RESULT_CAP
            ? result.content.slice(0, TOOL_RESULT_CAP) +
              `\n\n[...output truncated (${result.content.length - TOOL_RESULT_CAP} chars more)]`
            : result.content;
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: cappedContent,
          is_error: result.is_error,
        });
        if (opts.observer) {
          try {
            await opts.observer({
              tool_use: { name: tu.name, input },
              result: { is_error: result.is_error },
            });
          } catch (err) {
            log.error(opts.tag, "observer threw", err);
          }
        }
      }

      // v15.8 (2026-05-30): Soft turn budget — bu turn'de tool_result'ların
      // ardına nudge ekle (tool_result + text aynı user mesajında geçerli).
      // Ajan ELİNDEKİ bulgularla sonuçlansın (force-conclude'dan farklı:
      // context korunur). Bir kez (turn === softTurnBudget).
      if (
        opts.softTurnBudget !== undefined &&
        turn === opts.softTurnBudget &&
        opts.budgetNudge
      ) {
        toolResults.push({ type: "text", text: opts.budgetNudge });
        log.info(opts.tag, "soft turn budget nudge injected", { turn });
      }

      const userMsg: ApiMessage = { role: "user", content: toolResults };
      messages.push(userMsg);
      // History persist: tool_result'lı user mesajını da diske yaz.
      // Faz fail/abort olursa resume tam buradan devam edebilir.
      await saveHistoryStep(opts.state.project_root, opts.phaseId, userMsg);
    }
  }

  /**
   * Eskalasyon: codegen ajanı AskUserQuestion çağırınca kullanıcıya sorar,
   * EN cevabı döner (ajan EN konuşur). EN→TR (göster) + seçilen TR→EN (geri besle).
   * production-schema askApproval ile aynı askq tesisatı; abort → ABORT_SENTINEL.
   */
  private async askUser(input: Record<string, unknown>): Promise<string> {
    const question_en = String(input.question ?? "A decision is needed to proceed.");
    const rawOpts = Array.isArray(input.options) ? input.options.map(String) : [];
    const options_en = rawOpts.length > 0 ? rawOpts : ["Proceed", "Stop"];
    const context_en = typeof input.context === "string" ? input.context : "";

    // EN → TR (ajan EN, kullanıcı TR görür). Translate fail → throw (fallback yok).
    const fullQ_en = context_en ? `${question_en}\n\n${context_en}` : question_en;
    const question_tr = (await translate(this.opts.config, fullQ_en, "en-to-tr")).text;
    const options_tr = await Promise.all(
      options_en.map((o) =>
        translate(this.opts.config, o, "en-to-tr").then((r) => r.text || o),
      ),
    );

    const askqId = randomUUID();
    // Oto-cevap (YZLLM 2026-06-15): açıksa codegen eskalasyon kararını UI'a göstermeden ilk
    // seçenekle yanıtla → Faz 8 takılmaz. Önceden bu yol autoAnswer'ı kaçırıyordu.
    let selected_tr: string;
    const auto = autoAnswerPick(options_tr);
    if (auto !== null) {
      emitChatMessage("system", `🤖 Otomatik cevap (otomatik onay/ilk seçenek): "${auto}"`);
      selected_tr = auto;
    } else {
      this.currentAskqId = askqId;
      this.pendingAskq = { options_en, options_tr };
      emitAskq({
        id: askqId,
        question: question_tr,
        options: options_tr,
        allow_other: true,
      });

      selected_tr = await new Promise<string>((resolve, reject) => {
        this.pendingResolver = resolve;
        this.pendingRejecter = reject;
      });
      this.pendingAskq = null;
      this.currentAskqId = null;
    }

    const idx = options_tr.indexOf(selected_tr);
    let selected_en: string;
    if (idx >= 0) {
      selected_en = options_en[idx]!;
    } else {
      // "Diğer" — kullanıcı serbest TR yazdı; ajana EN besle.
      selected_en =
        (await translate(this.opts.config, selected_tr, "tr-to-en")).text || selected_tr;
    }
    emitChatMessage("system", `→ Claude'a: ${selected_en}`);
    return selected_en;
  }

  private async handleStreamEvent(
    ev:
      | { type: "text_delta"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
      | { type: "message_start" }
      | { type: "message_end"; stop_reason?: string },
  ): Promise<void> {
    if (ev.type === "text_delta") {
      emitClaudeStream({ sub: "text", text: ev.text });
    } else if (ev.type === "tool_use") {
      emitClaudeStream({
        sub: "tool_use",
        tool_name: ev.name,
        tool_input: ev.input as Record<string, unknown>,
      });
    } else if (ev.type === "message_end") {
      emitClaudeStream({ sub: "stop" });
    }
  }
}
