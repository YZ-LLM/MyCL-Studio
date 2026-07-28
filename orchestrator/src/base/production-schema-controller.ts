// base/production-schema-controller — production-schema fazlarının ortak akışı.
//
// Pattern (Faz 3, 4, 7):
//   - Anthropic SDK ile multi-turn, JSON schema'lı write_X tool ve approval tool
//   - write_X geldiğinde: tool input → artifact (renderer fonksiyonu), dosyaya
//     yaz, sha256, opsiyonel audit event (spec-block gibi)
//   - approval geldiğinde: askq aç (sabit Approve/Revise/Cancel — i18n)
//   - Faz controller'ı state.spec_approved gibi state mutasyonu + faz-spesifik
//     audit (phase-N-complete) yazar

import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { appendAudit } from "../audit.js";
import { runTurn, type ApiMessage, type ToolDef } from "../claude-api.js";
import type { MyclConfig } from "../config.js";
import { localizeOptionLabels, t } from "../i18n.js";
import { emitAskq, emitChatMessage, emitClaudeStream, emitError } from "../ipc.js";
import { autoAnswerPick } from "../auto-answer.js";
import { log } from "../logger.js";
import { translate } from "../translator.js";
import { runComprehensionGate } from "../spec-comprehension.js";
import type { PhaseId, ProductionConfig, State } from "../types.js";

// Tur sınırı yok — Claude doğal end_turn ile çıkar veya kullanıcı abort eder.

export interface ProductionRunOpts {
  tag: string;
  /** Faz numarası — audit kayıtları için. */
  phaseId: PhaseId;
  state: State;
  config: MyclConfig;
  systemPrompt: string;
  modelId: string;
  /** Escalation efor override (YZLLM 2026-06-11): set ise config eforu YERİNE bu. */
  effortOverride?: string;
  apiKey: string;
  initialUserMessage: string;
  tools: ToolDef[];
  production: ProductionConfig;
  betas?: string[];
  /** write tool input'u dosya içeriğine çevir. */
  artifactRenderer: (input: Record<string, unknown>) => string;
  /** Audit detail string'i — örn. "sha256=... title=..." */
  artifactAuditDetail?: (input: Record<string, unknown>, hash: string) => string;
  /**
   * v15.15: Onay (askApproval) ÖNCESİ çağrılır — pre-hoc bağımsız kör-nokta merceği için. writeInput
   * = son yazılan artefakt girdisi (örn. spec). Side-effect (mercek koş + bulguları GÖRÜNÜR emit);
   * onayı BLOKLAMAZ. SDK + CLI backend'lerin İKİSİ de çağırır (abonelik paritesi). Hata yutulur.
   */
  preApprovalHook?: (writeInput: Record<string, unknown>) => Promise<void>;
}

export type ProductionOutcome =
  | {
      kind: "approved";
      artifact_path: string;
      artifact_hash: string;
      writeInput: Record<string, unknown>;
    }
  | { kind: "cancelled" }
  | { kind: "aborted" }
  | { kind: "failed"; reason: string };

/**
 * SDK ve CLI backend'lerinin ortak arayüzü — faz controller'ları (Faz 3/4/7) bu
 * tipe karşı çalışır, factory hangisini döndürdüğünü bilmez.
 */
export interface ProductionBackend {
  run(): Promise<ProductionOutcome>;
  abort(): void;
  submitAskqAnswer(askqId: string, selected_tr: string): void;
}

/** İki transport'un ortak abort işareti (mahkeme denetimi 2026-07-11: dosya-başına ayrı Symbol kopyası tekleştirildi). */
export const PRODUCTION_ABORT_SENTINEL = Symbol("production-aborted");

interface PendingAskq {
  options_en: string[];
  options_tr: string[];
}

/** Artefakt hash'i — iki transport'un ortak fonksiyonu (mahkeme denetimi 2026-07-11: ikinci kopya kaldırıldı). */
export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

/**
 * SDK (base) + CLI transport'larının ORTAK, transport-dışı çekirdeği (mahkeme denetimi 2026-07-11).
 * Bu üyeler eskiden iki dosyada birebir kopyaydı ve ÇOKTAN sapmıştı ("→ Claude'a" echo'su bir ailede silinip
 * burada kalmıştı) — tek kaynağa hoist edildi; transport sınıfları yalnız run()/stream katmanını taşır.
 * Kapsam: askq state-machine (submit/abort), askOnce (kavrama-kapısı), askApproval (Approve/Revise/Cancel),
 * artefakt diske yazma (sha256 + audit + 📄 mesajı).
 */
export abstract class ProductionSchemaSharedCore {
  protected pendingAskq: PendingAskq | null = null;
  protected pendingResolver: ((selected_tr: string) => void) | null = null;
  protected pendingRejecter: ((reason: unknown) => void) | null = null;
  protected currentAskqId: string | null = null;
  protected lastArtifactPath: string | null = null;
  protected lastArtifactHash: string | null = null;
  protected lastWriteInput: Record<string, unknown> | null = null;
  protected aborted = false;

  constructor(protected readonly opts: ProductionRunOpts) {}

  submitAskqAnswer(askqId: string, selected_tr: string): void {
    if (!this.pendingAskq || this.currentAskqId !== askqId) {
      emitError("Yanıt geçersiz (soru güncelliğini yitirmiş)", { askqId });
      return;
    }
    const resolver = this.pendingResolver;
    this.pendingResolver = null;
    this.pendingRejecter = null;
    if (resolver) resolver(selected_tr);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    log.info(this.opts.tag, "abort requested");
    const rejecter = this.pendingRejecter;
    this.pendingResolver = null;
    this.pendingRejecter = null;
    this.pendingAskq = null;
    this.currentAskqId = null;
    if (rejecter) rejecter(PRODUCTION_ABORT_SENTINEL);
  }

  /** Tek askq emit + cevabı bekle (pendingResolver). allowOther=serbest metin ("okudum anladım"). */
  protected async askOnce(question_tr: string, options_tr: string[], allowOther: boolean): Promise<string> {
    // Oto-cevap (YZLLM 2026-06-15): açıksa askq'yi UI'a göstermeden ilk seçenekle yanıtla (CLI+SDK parite).
    // askOnce YALNIZ runComprehensionGate'ten çağrılır (kavrama-ack "okudum anladım") → safe-flow (foreign'de de oto).
    const auto = autoAnswerPick(options_tr, undefined, "safe-flow", { isApproval: true });
    if (auto !== null) {
      emitChatMessage("system", `🤖 Otomatik cevap (otomatik onay/ilk seçenek): "${auto}"`);
      return auto;
    }
    const askqId = randomUUID();
    this.currentAskqId = askqId;
    this.pendingAskq = { options_en: options_tr, options_tr };
    emitAskq({ id: askqId, question: question_tr, options: options_tr, allow_other: allowOther });
    const sel = await new Promise<string>((resolve, reject) => {
      this.pendingResolver = resolve;
      this.pendingRejecter = reject;
    });
    this.pendingAskq = null;
    this.currentAskqId = null;
    return sel;
  }

  /** Approve/Revise/Cancel onay askq'sı (kavrama-kapısı + i18n + translate) — CLI+SDK birebir tek kaynak. */
  protected async askApproval(pitch_en: string): Promise<"approve" | "revise" | "cancel"> {
    // #6 deliği (YZLLM): spec'i okumadan onay YOK. Paylaşılan kapı doğru cevap gelene dek döner (AC yoksa atlar).
    await runComprehensionGate(this.opts.config, this.opts.state.project_root, this.opts.phaseId, (q, o, a) =>
      this.askOnce(q, o, a),
    );
    const suffixKey = this.opts.production.approval_suffix_key ?? "generic";
    const options_en = ["Approve", "Revise", "Cancel"];
    const options_tr = localizeOptionLabels(options_en, "tr");
    // Translate fail durumunda fallback YOK (YZLLM kuralı). Throw eder; run() catch'i "failed" outcome'a dönüştürür.
    const r = await translate(this.opts.config, pitch_en, "en-to-tr");
    const question_tr = r.text + t(`askq.approval_suffix.${suffixKey}`, "tr");

    // Oto-cevap (YZLLM 2026-06-15): açıksa onayı UI'a göstermeden ilk seçenekle (Onayla) ver — CLI+SDK parite.
    // Kategori (YZLLM 2026-07-08): Faz 4 spec onayı = safe-flow (foreign'de oto); Faz 7 DB onayı = dangerous-write
    // (foreign'de kullanıcıda — DB şema aşağı-akışta migration/kod tetikler).
    const auto = autoAnswerPick(options_tr, undefined, this.opts.phaseId === 7 ? "dangerous-write" : "safe-flow", {
      isApproval: true,
    });
    let selected_tr: string;
    if (auto !== null) {
      emitChatMessage("system", `🤖 Otomatik cevap (otomatik onay): "${auto}"`);
      selected_tr = auto;
    } else {
      const askqId = randomUUID();
      this.currentAskqId = askqId;
      this.pendingAskq = { options_en, options_tr };
      emitAskq({
        id: askqId,
        question: question_tr,
        options: options_tr,
        allow_other: false,
      });

      selected_tr = await new Promise<string>((resolve, reject) => {
        this.pendingResolver = resolve;
        this.pendingRejecter = reject;
      });
      this.pendingAskq = null;
      this.currentAskqId = null;
    }

    const trIdx = options_tr.indexOf(selected_tr);
    const selected_en = trIdx >= 0 ? options_en[trIdx] : selected_tr;
    // "→ Claude'a: <EN>" echo'su KALDIRILDI (YZLLM 2026-07-11 parite kararı): qa-askq ailesi bunu "kullanıcıya
    // anlamsız (EN cevap çevirisi)" diye bilinçli silmişti; UX kararı tüm askq ailelerine eşitlendi.

    if (/^approve$/i.test(selected_en.trim())) return "approve";
    if (/^cancel$/i.test(selected_en.trim())) return "cancel";
    return "revise";
  }

  /** Render edilmiş artefaktı diske yaz: sha256 + audit + 📄 mesajı + son-yazım alanları (CLI+SDK tek kaynak). */
  protected async writeArtifactToDisk(
    md: string,
    writeInput: Record<string, unknown>,
  ): Promise<{ path: string; hash: string }> {
    const { opts } = this;
    const hash = sha256(md);
    const path = join(opts.state.project_root, opts.production.output_artifact_path);
    await writeFile(path, md, { encoding: "utf-8" });
    this.lastArtifactPath = path;
    this.lastArtifactHash = hash;
    this.lastWriteInput = writeInput;
    log.info(opts.tag, "artifact written", { path, sha256: hash, len: md.length });
    if (opts.production.artifact_audit_event) {
      const detail = opts.artifactAuditDetail
        ? opts.artifactAuditDetail(writeInput, hash)
        : `sha256=${hash}`;
      await appendAudit(opts.state.project_root, {
        ts: Date.now(),
        phase: opts.phaseId,
        event: opts.production.artifact_audit_event,
        caller: "mycl-bridge",
        detail,
      });
    }
    emitChatMessage("system", `📄 ${path} (sha256: ${hash.slice(0, 12)}…)`);
    return { path, hash };
  }
}

export class ProductionSchemaBaseController extends ProductionSchemaSharedCore implements ProductionBackend {
  async run(): Promise<ProductionOutcome> {
    const { opts } = this;

    emitClaudeStream({
      sub: "init",
      text: `sdk-${opts.tag}`,
      model: opts.modelId,
      cwd: opts.state.project_root,
    });

    // Claude'a giden EN system + initial user mesajı — ADR-009 doğrulama.
    emitClaudeStream({
      sub: "request",
      system: opts.systemPrompt,
      user_message: opts.initialUserMessage,
      turn: 1,
    });

    const messages: ApiMessage[] = [
      { role: "user", content: opts.initialUserMessage },
    ];

    for (let turn = 0; ; turn++) {
      if (this.aborted) {
        log.info(opts.tag, "aborted at turn boundary", { turn });
        return { kind: "aborted" };
      }
      emitClaudeStream({
        sub: "init",
        text: `sdk-${opts.tag}`,
        model: opts.modelId,
        turn: turn + 1,
      });
      log.info(opts.tag, "turn start", {
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
            system: opts.systemPrompt,
            model: opts.modelId,
            role: "main",
            tools: opts.tools,
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

      messages.push({ role: "assistant", content: turnResult.assistantContent });

      if (turnResult.toolUses.length === 0) {
        log.info(opts.tag, "no tool_use, ending");
        return { kind: "failed", reason: "model stopped without tool_use" };
      }

      const toolResults: Anthropic.MessageParam["content"] = [];

      for (const tu of turnResult.toolUses) {
        if (tu.name === opts.production.write_tool_name) {
          const input = tu.input as Record<string, unknown>;
          const md = opts.artifactRenderer(input);
          // Ortak çekirdek: sha256 + yaz + audit + 📄 (mahkeme 2026-07-11 — CLI ile tek kaynak).
          const { path, hash } = await this.writeArtifactToDisk(md, input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({
              saved: true,
              path,
              sha256: hash,
            }),
          });
        } else if (tu.name === opts.production.approval_tool_name) {
          const input = tu.input as Record<string, unknown>;
          const pitch_en = String(input.pitch ?? input.summary ?? "");
          // v15.15: onaydan ÖNCE pre-hoc kör-nokta merceği (side-effect; onayı bloklamaz).
          if (this.lastWriteInput) {
            try {
              await opts.preApprovalHook?.(this.lastWriteInput);
            } catch (e) {
              log.warn(opts.tag, "preApprovalHook failed (non-blocking)", e);
            }
          }
          let result: "approve" | "revise" | "cancel";
          try {
            result = await this.askApproval(pitch_en);
          } catch (err) {
            if (err === PRODUCTION_ABORT_SENTINEL) {
              log.info(opts.tag, "aborted during approval askq");
              return { kind: "aborted" };
            }
            // Translate fail veya başka error — fallback yok, fail-fast.
            log.error(opts.tag, "askApproval failed", err);
            return {
              kind: "failed",
              reason: `approval flow failed: ${String(err)}`,
            };
          }
          if (result === "approve") {
            if (!this.lastArtifactPath || !this.lastArtifactHash || !this.lastWriteInput) {
              log.error(opts.tag, "approve before write");
              return {
                kind: "failed",
                reason: t("chat.error.approve_before_spec_saved", "en"),
              };
            }
            return {
              kind: "approved",
              artifact_path: this.lastArtifactPath,
              artifact_hash: this.lastArtifactHash,
              writeInput: this.lastWriteInput,
            };
          }
          if (result === "cancel") {
            return { kind: "cancelled" };
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `User asked to revise. Update via ${opts.production.write_tool_name}.`,
          });
        } else {
          log.warn(opts.tag, "unknown tool", { name: tu.name });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: t("chat.error.unknown_tool", "en"),
            is_error: true,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  // askOnce/askApproval ORTAK çekirdeğe taşındı (ProductionSchemaSharedCore — mahkeme denetimi 2026-07-11).

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
