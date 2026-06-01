// base/qa-askq-controller — qa-askq tipi fazların ortak akışı.
//
// Sorumlulukları:
//   - Anthropic SDK ile multi-turn konuşma yürüt
//   - Faza özgü tool definition'ları alıp tool_use'ları askq'ya çevir
//   - Statik option label'larını i18n'den, dinamik question text'ini
//     translator'dan getir (Aşama I tasarrufu)
//   - Approval karar tool'unu özel olarak işle ve outcome döndür
//
// Faz controller'ları (Phase 1, P2, P7, P10, P19) bu sınıfı kullanır;
// kendi audit yazma + state mutasyon mantığını ekler. Bu sınıf audit yazmaz.

import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { runTurn, type ApiMessage, type ToolDef } from "../claude-api.js";
import type { MyclConfig } from "../config.js";
import { localizeOptionLabels, t } from "../i18n.js";
import { appendHistory } from "../history-loader.js";
import { emitAskq, emitClaudeStream, emitError } from "../ipc.js";
import { log } from "../logger.js";
import { translate } from "../translator.js";
import type { AskqConfig, State } from "../types.js";

export interface QaAskqRunOpts {
  /** Çağırıcının log etiketi (örn. "phase-1"). */
  tag: string;
  state: State;
  config: MyclConfig;
  systemPrompt: string;
  modelId: string;
  apiKey: string;
  initialUserMessage: string;
  /** Faza özgü tool definition'ları — askq + approval tool'ları. */
  tools: ToolDef[];
  askq: AskqConfig;
  /** Beta header'ları — örn. 1M context. */
  betas?: string[];
}

export type QaAskqOutcome =
  | { kind: "approved"; approvalInput: Record<string, unknown> }
  /**
   * Claude `askq.abandon_tool_name` adlı tool'u çağırınca (Faz 2 compliance
   * check sonrası kullanıcı "Vazgeç" dediğinde) bu outcome döner. Caller
   * faz controller'ı abandonInput'tan reason/concerns'i çıkarıp orchestrator'a
   * iletir; orchestrator state'i Faz 1'e döndürür ve abandoned-intents.jsonl'a
   * kalıcı kayıt yazar.
   */
  | { kind: "abandoned"; abandonInput: Record<string, unknown> }
  /**
   * Claude `askq.tweak_tool_name` adlı tool'u çağırınca (Faz 6 UI Review'da
   * kullanıcı "şu butonu değiştir" gibi UI tweak istediğinde) bu outcome
   * döner. Caller (Phase 6) tweakInput.description'ı çıkarıp orchestrator'a
   * iletir; orchestrator state.pending_ui_tweak set edip Faz 5 mini-loop'una
   * döner.
   */
  | { kind: "ui_tweak"; tweakInput: Record<string, unknown> }
  /**
   * Claude `askq.failure_tool_name` adlı tool'u çağırınca (Faz 6 AC fail
   * bridge — kullanıcı "Giriş başarısız" gibi functional fail raporlarsa
   * Claude `report_ac_failure` çağırır) bu outcome döner. Phase 6 controller
   * failureInput'tan scope hint'leri çıkarıp `runSingleFix` ile fix uygular,
   * sonra base'i aynı AC için yeniden instantiate eder.
   */
  | { kind: "ac_failure"; failureInput: Record<string, unknown> }
  | { kind: "cancelled" }
  | { kind: "aborted" }
  | { kind: "failed"; reason: string };

/**
 * SDK ve CLI backend'lerinin ortak arayüzü — qa-askq faz controller'ları (Faz
 * 1/2/9) bu tipe karşı çalışır, factory hangisini döndürdüğünü bilmez.
 */
export interface QaAskqBackend {
  run(): Promise<QaAskqOutcome>;
  abort(): void;
  submitAskqAnswer(askqId: string, selected_tr: string): void;
}

/** abort() çağrısı askq pendingResolver'ı bu instance ile reject eder. */
const ABORT_SENTINEL = Symbol("askq-aborted");

/**
 * Faz 9 (Risk) impact classification token'ları için doğal TR override (CLI
 * backend ile paylaşılır). LLM safe-rollout|needs-migration|breaking-change döner.
 */
export const IMPACT_OPTION_TR_MAP: Record<string, string> = {
  "safe-rollout": "Sakın kodu değiştirme",
  "needs-migration": "Kodu düzelt, sorun çıkmaz.",
  "breaking-change": "Mutlaka düzelt.",
};

// Impact override için paylaşımlı IMPACT_OPTION_TR_MAP kullanılır (yukarıda).

interface PendingAskq {
  tool_use_id: string;
  options_en: string[];
  options_tr: string[];
  is_approval: boolean;
}

export class QaAskqBaseController implements QaAskqBackend {
  private pendingAskq: PendingAskq | null = null;
  private pendingResolver: ((selected_tr: string) => void) | null = null;
  private pendingRejecter: ((reason: unknown) => void) | null = null;
  private currentAskqId: string | null = null;
  private aborted = false;

  constructor(private readonly opts: QaAskqRunOpts) {}

  /**
   * Kullanıcı abort_phase komutu gönderdiğinde çağrılır. Bekleyen askq varsa
   * sentinel ile reject — run() loop'u catch eder, outcome "aborted" döner.
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

  /**
   * Orchestrator UI'dan gelen askq cevabını base'e teslim eder. Faz
   * controller'ı bu çağrıyı direkt forward eder.
   */
  submitAskqAnswer(askqId: string, selected_tr: string): void {
    if (!this.pendingAskq || this.currentAskqId !== askqId) {
      emitError("stale askq answer", { askqId });
      return;
    }
    const resolver = this.pendingResolver;
    this.pendingResolver = null;
    if (resolver) resolver(selected_tr);
  }

  async run(): Promise<QaAskqOutcome> {
    const { tag, opts, askq } = { tag: this.opts.tag, opts: this.opts, askq: this.opts.askq };
    const suffixKey = askq.approval_suffix_key ?? "generic";

    // v15.8 (2026-05-30): Delegasyon kuralı — TÜM qa-askq fazları (Phase 1/2/9)
    // için ortak. Kullanıcı "sen tespit et / sen karar ver" derse veya soruyu
    // cevaplamazsa: ana ajan soruyu TEKRARLAMAMALI; makul varsayım yapıp
    // ilerlemeli. Aksi halde (özellikle Haiku) takılıp tool'suz düz metin
    // döner → pipeline fail (gözlemlendi: Faz 2 "sen tespit et" → crash).
    const systemPrompt = `${opts.systemPrompt}

## DELEGATION — user says "you decide" / "sen tespit et" (CRITICAL)
If the user's answer is a delegation or non-answer ("sen tespit et", "sen karar ver", "sen bil", "you decide", "farketmez", "bilmiyorum", "her neyse"), DO NOT re-ask the same question. Instead: pick the most reasonable default for that point, state your assumption briefly inside the next tool call, and MOVE ON — either ask the NEXT question or, if you have enough, call the approval/conclusion tool. NEVER respond with plain text; ALWAYS call exactly one tool.`;

    emitClaudeStream({
      sub: "init",
      text: `sdk-${tag}`,
      model: opts.modelId,
      cwd: opts.state.project_root,
    });

    // Claude'a giden EN system + initial user mesajı — ADR-009 doğrulama.
    emitClaudeStream({
      sub: "request",
      system: systemPrompt,
      user_message: opts.initialUserMessage,
      turn: 1,
      max_turns: askq.max_questions,
    });

    const messages: ApiMessage[] = [
      { role: "user", content: opts.initialUserMessage },
    ];
    // v15.7 (2026-05-27): Batch A5 — no-tool-use retry guard. Bir kez retry
    // sonrası tekrar plain text dönerse failed.
    let noToolUseRetried = false;
    // v15.8 (2026-05-30): Retry turn'ünde tool_choice:any ile tool çağrısını
    // ZORLA — Haiku düz metin döndüğünde deterministik kurtarma (crash yerine).
    let forceToolNextTurn = false;

    for (let turn = 0; turn < askq.max_questions; turn++) {
      if (this.aborted) {
        log.info(tag, "aborted at turn boundary", { turn });
        return { kind: "aborted" };
      }
      emitClaudeStream({
        sub: "init",
        text: `sdk-${tag}`,
        model: opts.modelId,
        turn: turn + 1,
        max_turns: askq.max_questions,
      });
      log.info(tag, "turn start", {
        turn,
        messages_count: messages.length,
        model: opts.modelId,
      });

      let turnResult;
      try {
        turnResult = await runTurn(
          opts.config,
          opts.apiKey,
          {
            messages,
            system: systemPrompt,
            model: opts.modelId,
            tools: opts.tools,
            max_tokens: 4096,
            betas: opts.betas,
            // v15.8: retry turn'ünde tool çağrısını zorla (Haiku düz-metin fix).
            tool_choice: forceToolNextTurn ? { type: "any" } : undefined,
          },
          (ev) => this.handleStreamEvent(ev),
        );
        forceToolNextTurn = false;
      } catch (err) {
        log.error(tag, "runTurn failed", err);
        return { kind: "failed", reason: `claude api failed: ${String(err)}` };
      }

      messages.push({ role: "assistant", content: turnResult.assistantContent });

      if (turnResult.toolUses.length === 0) {
        // v15.7 (2026-05-27): Batch A5 — 1 kez retry. Ana ajan askq cevabı
        // sonrası plain text dönerse pipeline durmasın; "tool çağırmak ZORUNLU"
        // diye sertçe hatırlat + 1 daha turn. 2. fail → outcome.failed.
        if (!noToolUseRetried) {
          noToolUseRetried = true;
          forceToolNextTurn = true; // v15.8: bir sonraki turn tool_choice:any
          log.warn(tag, "no tool_use — retrying with forced tool_choice");
          messages.push({
            role: "user",
            content:
              "ERROR: Your last response had no tool call (plain text only). " +
              "This breaks the pipeline. You MUST call exactly ONE tool to respond. " +
              "Choose the appropriate tool (clarifying / approval / abandon / fix) and " +
              "call it now. Do NOT write any text outside the tool call.",
          });
          await appendHistory(this.opts.state.project_root, {
            ts: Date.now(),
            kind: "claude_stream",
            data: { sub: "retry", text: "no_tool_use_retry", ts: Date.now() },
          }).catch(() => {});
          continue;
        }
        log.error(tag, "no tool_use after retry — failed");
        return { kind: "failed", reason: "model stopped without tool_use (after 1 retry)" };
      }

      const toolResults: Anthropic.MessageParam["content"] = [];

      for (const tu of turnResult.toolUses) {
        const isApproval = tu.name === askq.approval_tool_name;
        const isClarifying =
          askq.clarifying_tool_name !== undefined &&
          tu.name === askq.clarifying_tool_name;
        const isAbandon =
          askq.abandon_tool_name !== undefined &&
          tu.name === askq.abandon_tool_name;
        const isTweak =
          askq.tweak_tool_name !== undefined &&
          tu.name === askq.tweak_tool_name;
        const isFailure =
          askq.failure_tool_name !== undefined &&
          tu.name === askq.failure_tool_name;

        // Abandon: Claude bu tool'u çağırırsa askq emit YOK, translate YOK —
        // kararı kullanıcı zaten clarifying askq'da vermiş, Claude sadece
        // sonuçlandırıyor. Caller faz controller'ı abandonInput'tan reason +
        // concerns'i çıkaracak.
        if (isAbandon) {
          log.info(tag, "abandon tool called", { name: tu.name });
          return {
            kind: "abandoned",
            abandonInput: tu.input as Record<string, unknown>,
          };
        }

        // UI Tweak: aynı abandon pattern'ı — kullanıcı Phase 6'de askq'da
        // "şu butonu büyült" gibi tweak istemiş, Claude bunu request_ui_tweak
        // tool'una description ile gönderir. Outcome'da orchestrator Phase 5
        // mini-loop'una döner.
        if (isTweak) {
          log.info(tag, "ui_tweak tool called", { name: tu.name });
          return {
            kind: "ui_tweak",
            tweakInput: tu.input as Record<string, unknown>,
          };
        }

        // AC Failure: Phase 6 fail bridge — kullanıcı bir AC için functional
        // failure raporladığında Claude `report_ac_failure` çağırır. Bu noktada
        // askq emit YOK, translate YOK; outcome dönüp Phase 6 controller fix
        // loop'u başlatsın. Fix sonrası caller base'i yeniden instantiate eder.
        if (isFailure) {
          log.info(tag, "ac_failure tool called", { name: tu.name });
          return {
            kind: "ac_failure",
            failureInput: tu.input as Record<string, unknown>,
          };
        }

        if (!isApproval && !isClarifying) {
          log.warn(tag, "unknown tool", { name: tu.name });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: t("chat.error.unknown_tool", "en"),
            is_error: true,
          });
          continue;
        }

        const input = tu.input as Record<string, unknown>;
        const { question_en, options_en, suggested_en } = this.composeQuestion(
          isApproval,
          input,
          askq.approval_summary_field ?? "summary",
          suffixKey,
        );

        let question_tr: string;
        let options_tr: string[];
        try {
          ({ question_tr, options_tr } = await this.localize(
            question_en,
            options_en,
            isApproval,
            input,
            suffixKey,
          ));
        } catch (err) {
          log.error(tag, "askq localize failed (fail-fast)", err);
          return {
            kind: "failed",
            reason: `translate failed: ${String(err)}`,
          };
        }

        const askqId = randomUUID();
        this.currentAskqId = askqId;
        this.pendingAskq = {
          tool_use_id: tu.id,
          options_en,
          options_tr,
          is_approval: isApproval,
        };
        log.info(tag, "askq opened", {
          askqId,
          is_approval: isApproval,
          options_count: options_en.length,
        });
        // Soruyu history'ye yansıt ama LIVE chat'e EMİT ETME — askq card
        // zaten soruyu gösteriyor (kullanıcı 2026-05-24 talebi: duplicate
        // görünüm istemiyor). History'de korunması cevap/abort sonrası
        // tarihsel iz için gerekli — direkt appendHistory ile yaz.
        appendHistory(this.opts.state.project_root, {
          ts: Date.now(),
          kind: "chat_message",
          data: { role: "system", text: question_tr },
        }).catch((err) => log.warn(tag, "askq question history fail", err));
        // v15.7 (2026-05-26): suggested_answer (Faz 1/2 ana ajan önerisi) —
        // options_en içinden EN match'i bulunup options_tr'daki TR karşılığı
        // UI'a gönderilir. UI bu seçeneği highlight eder.
        let suggested_option_tr: string | undefined;
        if (suggested_en) {
          const idx = options_en.indexOf(suggested_en);
          if (idx >= 0 && idx < options_tr.length) {
            suggested_option_tr = options_tr[idx];
          }
        }
        emitAskq({
          id: askqId,
          question: question_tr,
          options: options_tr,
          allow_other: !isApproval,
          suggested_option: suggested_option_tr,
        });

        let selected_tr: string;
        try {
          selected_tr = await new Promise<string>((resolve, reject) => {
            this.pendingResolver = resolve;
            this.pendingRejecter = reject;
          });
        } catch (err) {
          if (err === ABORT_SENTINEL) {
            log.info(tag, "askq aborted mid-question");
            return { kind: "aborted" };
          }
          throw err;
        }
        this.pendingAskq = null;
        this.currentAskqId = null;

        // Bilinen option label (Approve/Revise/Cancel + dynamic options): TR→EN
        // mapping listeden gelir. "Other" freeform cevap olursa translate edilir;
        // translate fail durumunda fallback YOK (Ümit kuralı).
        const trIdx = options_tr.indexOf(selected_tr);
        let selected_en: string;
        if (trIdx >= 0) {
          selected_en = options_en[trIdx];
        } else {
          try {
            const r = await translate(opts.config, selected_tr, "tr-to-en");
            selected_en = r.text;
          } catch (err) {
            log.error(tag, "answer translate failed (fail-fast)", err);
            return {
              kind: "failed",
              reason: `answer translate failed: ${String(err)}`,
            };
          }
        }
        // "→ Claude'a: <EN>" mesajı kullanıcı için anlamsız (EN cevap çevirisi);
        // Claude Code panelinde zaten görünür. MyCL panelini sade tut.

        if (isApproval) {
          if (/^approve$/i.test(selected_en.trim())) {
            return { kind: "approved", approvalInput: input };
          }
          if (/^cancel$/i.test(selected_en.trim())) {
            return { kind: "cancelled" };
          }
          // Revise — Claude'a "kullanıcı revize istedi" mesajı geri verilir.
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "User asked to revise. Update and call the tool again.",
          });
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: selected_en,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
    }

    log.warn(this.opts.tag, "max questions reached without approval");
    return { kind: "failed", reason: "max questions reached" };
  }

  private composeQuestion(
    isApproval: boolean,
    input: Record<string, unknown>,
    summaryField: string,
    suffixKey: string,
  ): { question_en: string; options_en: string[]; suggested_en: string | null } {
    if (isApproval) {
      const summary = String(input[summaryField] ?? "");
      return {
        question_en: `${summary}${t(`askq.approval_suffix.${suffixKey}`, "en")}`,
        options_en: ["Approve", "Revise", "Cancel"],
        suggested_en: null,
      };
    }
    const question = String(input.question ?? "");
    const opts = Array.isArray(input.options) ? (input.options as string[]) : [];
    // v15.7 (2026-05-26): Faz 1/2 ask_clarifying tool'larında opsiyonel
    // suggested_answer alanı — ana ajan en olası cevabı önerir, UI bunu
    // vurgular. Sadece options listesinde exact match olan değerler kabul
    // edilir; uydurma label false-positive engellenir.
    const rawSugg = typeof input.suggested_answer === "string"
      ? input.suggested_answer.trim()
      : null;
    const suggested_en = rawSugg && opts.includes(rawSugg) ? rawSugg : null;
    return { question_en: question, options_en: opts, suggested_en };
  }

  private async localize(
    question_en: string,
    options_en: string[],
    isApproval: boolean,
    input: Record<string, unknown>,
    suffixKey: string,
  ): Promise<{ question_tr: string; options_tr: string[] }> {
    // Translate fail durumunda fallback YOK (Ümit'in kuralı). Translate
    // başarısızsa throw eder ve run() catch'inde "failed" outcome'a dönüşür.
    // Karışık dilli askq metni göstermek kullanıcıyı yanıltır.
    if (isApproval) {
      const summary = String(input[this.opts.askq.approval_summary_field ?? "summary"] ?? "");
      const r = await translate(this.opts.config, summary, "en-to-tr");
      return {
        question_tr: `${r.text}${t(`askq.approval_suffix.${suffixKey}`, "tr")}`,
        options_tr: localizeOptionLabels(options_en, "tr"),
      };
    }
    // Clarifying: question + options dinamik. Bilinen impact classification
    // token'ları (Faz 19) için deterministik TR override — translator'ın
    // literal çevirileri ("güvenli dağıtım / taşıma-gerekli / kırılan
    // değişiklik") kullanıcıya anlam ifade etmiyor (Ümit 2026-05-23).
    //
    // v15.7 (2026-05-26): Ana ajan SADECE İngilizce konuşur (kullanıcı kuralı).
    // Tüm askq question + options için her zaman EN→TR translator çağrılır;
    // TR-detect heuristic kaldırıldı. Template'lerden "DİL — TÜRKÇE ZORUNLU"
    // blokları da silindi — ana ajan EN üretir, biz TR'ye çeviririz.
    const [qRes, ...oRes] = await Promise.all([
      translate(this.opts.config, question_en, "en-to-tr"),
      ...options_en.map((o) => {
        const norm = o.trim().toLowerCase().replace(/\s+/g, "-");
        const override = IMPACT_OPTION_TR_MAP[norm];
        if (override !== undefined) return Promise.resolve({ text: override });
        return translate(this.opts.config, o, "en-to-tr");
      }),
    ]);
    return {
      question_tr: qRes.text,
      options_tr: oRes.map((r) => r.text),
    };
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
