// base/qa-askq-cli-backend — qa-askq fazlarının (Faz 1/2/9) CLI karşılığı.
//
// SDK QaAskqBaseController ile birebir davranır: custom tool (ask_clarifying /
// approval / abandon / tweak / failure) yerine text-JSON blokları. ALAN ADLARI
// SDK tool input'larıyla AYNI (question/options/suggested_answer, approval summary
// vb.) → outcome.approvalInput/abandonInput/... faz controller'larına değişmeden
// gider (parite). Faz-ortası soru (clarifying/approval) --resume ile sürdürülür.
//
// Ajan dosya yazmaz (Read/Grep/Glob/Bash araştırma; Write/Edit disallowed).
// Abonelik (cli-session API key enjekte etmez).

import { randomUUID } from "node:crypto";
import { MAIN_AGENT_LANGUAGE_RULE } from "../agent-language.js";
import { extractKindBlock } from "../cli-json.js";
import { runClaudeCliSession } from "../cli-session.js";
import { autoFallbackBackend } from "../cli-rate-limit.js";
import { isClaudeAvailable } from "../codegen/cli-backend.js";
import { backendForRole, isAutoMode } from "../config.js";
import { appendHistory } from "../history-loader.js";
import { localizeOptionLabels, t } from "../i18n.js";
import { emitAskq, emitChatMessage, emitClaudeStream, emitError } from "../ipc.js";
import { log } from "../logger.js";
import { translate } from "../translator.js";
import {
  IMPACT_OPTION_TR_MAP,
  QaAskqBaseController,
  type QaAskqBackend,
  type QaAskqOutcome,
  type QaAskqRunOpts,
} from "./qa-askq-controller.js";

const ABORT_SENTINEL = Symbol("qa-askq-cli-aborted");

/** Tool→kind eşlemesi (sadece tanımlı olanlar instruction'a girer). */
function buildOutputInstruction(opts: QaAskqRunOpts): string {
  const { askq, tools } = opts;
  const schemaOf = (name?: string): string => {
    const tool = name ? tools.find((tt) => tt.name === name) : undefined;
    return JSON.stringify(tool?.input_schema ?? {});
  };
  // v15.9: zorunlu alan adlarını belirgin listele — ajan generic "summary"/"title"
  // yerine TAM şema alanlarını (örn. enriched_summary) kullansın (Faz 2 contract bug fix).
  const requiredOf = (name?: string): string => {
    const tool = name ? tools.find((tt) => tt.name === name) : undefined;
    const req = (tool?.input_schema as { required?: string[] } | undefined)?.required ?? [];
    return req.length ? req.join(", ") : "(şemadaki alanlar)";
  };
  const lines: string[] = [];
  if (askq.clarifying_tool_name) {
    lines.push(
      `- Soru sormak için: {"kind":"askq", ...} — alanlar şu şemaya uy: ${schemaOf(askq.clarifying_tool_name)} ` +
        `(question + options[] zorunlu; suggested_answer opsiyonel, options'tan biri olmalı).`,
    );
  }
  lines.push(
    `- Onay/sonuç için: {"kind":"approval", ...} — ZORUNLU alanlar TAM bu adlarla ` +
      `(generic "summary"/"title" DEĞİL): ${requiredOf(askq.approval_tool_name)}. ` +
      `Tam şema: ${schemaOf(askq.approval_tool_name)}.`,
  );
  if (askq.abandon_tool_name) {
    lines.push(`- Vazgeçmek için: {"kind":"abandon", ...} — alanlar: ${schemaOf(askq.abandon_tool_name)}.`);
  }
  if (askq.tweak_tool_name) {
    lines.push(`- UI değişiklik için: {"kind":"tweak", ...} — alanlar: ${schemaOf(askq.tweak_tool_name)}.`);
  }
  if (askq.failure_tool_name) {
    lines.push(`- AC başarısızlığı için: {"kind":"ac_failure", ...} — alanlar: ${schemaOf(askq.failure_tool_name)}.`);
  }
  return `

---

## ÇIKTI FORMATI — CLI modu (tool YOK, text-JSON)

Tool ÇAĞIRAMAZSIN. CEVABININ TAMAMI tek bir JSON bloğu olmalı — blok DIŞINDA düz metin YAZMA
(ne öncesinde ne sonrasında). Geçerli JSON: çift tırnak, trailing comma yok. \`kind\` alanı
zorunlu. Blok içeriği (question/summary vb.) İngilizce. Kullanılabilir bloklar:
${lines.join("\n")}

DOSYAYA YAZMA (Read/Grep/Glob/Bash ile sadece araştır). Soru sorduğunda kullanıcı cevabını
bir sonraki mesajda alacaksın; ona göre devam et (sonra başka {"kind":"askq"} veya {"kind":"approval"}).`;
}

interface PendingAskq {
  options_en: string[];
  options_tr: string[];
}

export class CliQaAskqBackend implements QaAskqBackend {
  private pendingAskq: PendingAskq | null = null;
  private pendingResolver: ((selected_tr: string) => void) | null = null;
  private pendingRejecter: ((reason: unknown) => void) | null = null;
  private currentAskqId: string | null = null;
  private aborted = false;

  constructor(private readonly opts: QaAskqRunOpts) {}

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

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    log.info(this.opts.tag, "cli abort requested");
    const rejecter = this.pendingRejecter;
    this.pendingResolver = null;
    this.pendingRejecter = null;
    this.pendingAskq = null;
    this.currentAskqId = null;
    if (rejecter) rejecter(ABORT_SENTINEL);
  }

  async run(): Promise<QaAskqOutcome> {
    const { opts } = this;
    const askq = opts.askq;
    const sessionId = randomUUID();
    const systemPrompt = opts.systemPrompt + buildOutputInstruction(opts);
    const effort = opts.config.claude_code_flags.effort;
    // max_questions clarifying turu + onay + birkaç resume/nudge için tampon.
    const maxTurns = askq.max_questions + 4;

    emitClaudeStream({
      sub: "init",
      text: `cli-${opts.tag}`,
      model: opts.modelId,
      cwd: opts.state.project_root,
    });
    emitChatMessage("system", `🤖 Claude Code CLI (abonelik) — ${opts.tag} (model: ${opts.modelId})…`);

    let resume = false;
    let userMessage = opts.initialUserMessage;
    let nudged = false;
    let fieldNudgeUsed = false; // v15.9: terminal blok eksik-zorunlu-alan nudge'ı (1×)

    for (let turn = 0; turn < maxTurns; turn++) {
      if (this.aborted) return { kind: "aborted" };

      const res = await runClaudeCliSession({
        sessionId,
        resume,
        userMessage,
        systemPrompt: resume ? undefined : systemPrompt,
        modelId: opts.modelId,
        cwd: opts.state.project_root,
        allowedTools: ["Read", "Grep", "Glob", "Bash"],
        disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
        effort,
        onText: (text) => emitClaudeStream({ sub: "text", text }),
        // tool_use'ları yüzeye çıkar: review-yoğun fazlar (Faz 9) onlarca
        // Read/Grep/Bash çağrısı yapar; bunlar görünmezse UI/izleyici "asılı"
        // sanır ve idle-kill eder. Her tool_use bir ilerleme event'i.
        observer: (tu) =>
          emitClaudeStream({ sub: "tool_use", tool_name: tu.name, tool_input: tu.input }),
      });
      if (this.aborted) return { kind: "aborted" };
      if (res.usage) emitClaudeStream({ sub: "token_usage", usage: res.usage });
      if (!res.ok) {
        return { kind: "failed", reason: `claude CLI failed: ${res.error ?? "bilinmeyen"}` };
      }

      const block = extractKindBlock(res.text, [
        "askq",
        "approval",
        "abandon",
        "tweak",
        "ac_failure",
      ]);
      if (block === null) {
        if (nudged) {
          return { kind: "failed", reason: `${opts.tag}: geçerli JSON blok üretilemedi` };
        }
        nudged = true;
        resume = true;
        userMessage =
          "Geçerli JSON blok yoktu. SADECE tek bir {\"kind\":\"askq\"|\"approval\"|...} bloğu yaz, başka metin yok.";
        continue;
      }
      nudged = false;

      // v15.9: terminal blok (approval/abandon/tweak/ac_failure) ZORUNLU alan
      // doğrulaması. Ajan generic {summary,title} emit edip tüketicinin beklediği
      // alanı (örn. enriched_summary) eksik bırakırsa: nudge (1×); hâlâ eksikse
      // GÖRÜNÜR fail. Aksi halde malformed blok downstream'e geçer → faz "missing"
      // hatası + pipeline asılması (Faz 2 contract bug'ının kökü).
      if (block.kind !== "askq") {
        const kindToToolName: Record<string, string | undefined> = {
          approval: askq.approval_tool_name,
          abandon: askq.abandon_tool_name,
          tweak: askq.tweak_tool_name,
          ac_failure: askq.failure_tool_name,
        };
        const toolName = kindToToolName[String(block.kind)];
        const tool = toolName ? opts.tools.find((tt) => tt.name === toolName) : undefined;
        const required =
          (tool?.input_schema as { required?: string[] } | undefined)?.required ?? [];
        const missing = required.filter((f) => {
          const v = (block as Record<string, unknown>)[f];
          return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
        });
        if (missing.length > 0) {
          if (fieldNudgeUsed) {
            return {
              kind: "failed",
              reason: `${opts.tag}: '${String(block.kind)}' bloğu zorunlu alan eksik (${missing.join(", ")}) — nudge sonrası da düzelmedi`,
            };
          }
          fieldNudgeUsed = true;
          resume = true;
          userMessage =
            `'${String(block.kind)}' bloğun ZORUNLU alan(lar) eksik: ${missing.join(", ")}. ` +
            `${toolName} şemasındaki TAM alan adlarıyla {"kind":"${String(block.kind)}", ...} bloğunu ` +
            `YENİDEN yaz (generic "summary"/"title" KULLANMA — örn. enriched_summary gibi tam adları kullan).`;
          continue;
        }
      }

      // Terminal kind'ler (askq emit YOK — kullanıcı kararı zaten verilmiş).
      const dropKind = (b: Record<string, unknown>): Record<string, unknown> => {
        const o = { ...b };
        delete o.kind;
        return o;
      };
      if (block.kind === "abandon") {
        return { kind: "abandoned", abandonInput: dropKind(block) };
      }
      if (block.kind === "tweak") {
        return { kind: "ui_tweak", tweakInput: dropKind(block) };
      }
      if (block.kind === "ac_failure") {
        return { kind: "ac_failure", failureInput: dropKind(block) };
      }

      if (block.kind === "approval") {
        let decision: "approve" | "revise" | "cancel";
        try {
          decision = await this.askApproval(block);
        } catch (err) {
          if (err === ABORT_SENTINEL) return { kind: "aborted" };
          return { kind: "failed", reason: `approval flow failed: ${String(err)}` };
        }
        if (decision === "approve") {
          return { kind: "approved", approvalInput: dropKind(block) };
        }
        if (decision === "cancel") {
          return { kind: "cancelled" };
        }
        resume = true;
        userMessage = "Kullanıcı revizyon istedi. Güncellenmiş {\"kind\":\"approval\",...} (veya gerekiyorsa {\"kind\":\"askq\"}) yaz.";
        continue;
      }

      // block.kind === "askq" (clarifying)
      let answerEn: string;
      try {
        answerEn = await this.askClarifying(block);
      } catch (err) {
        if (err === ABORT_SENTINEL) return { kind: "aborted" };
        return { kind: "failed", reason: `clarifying flow failed: ${String(err)}` };
      }
      resume = true;
      userMessage = answerEn;
    }

    log.warn(opts.tag, "cli max turns reached without approval");
    return { kind: "failed", reason: "max questions reached" };
  }

  /** Clarifying askq: question+options TR'ye çevir, emit, cevabı EN'e map et. */
  private async askClarifying(block: Record<string, unknown>): Promise<string> {
    const question_en = String(block.question ?? "");
    const options_en = Array.isArray(block.options) ? (block.options as string[]).map(String) : [];
    const rawSugg = typeof block.suggested_answer === "string" ? block.suggested_answer.trim() : null;
    const suggested_en = rawSugg && options_en.includes(rawSugg) ? rawSugg : null;

    const [qRes, ...oRes] = await Promise.all([
      translate(this.opts.config, question_en, "en-to-tr"),
      ...options_en.map((o) => {
        const norm = o.trim().toLowerCase().replace(/\s+/g, "-");
        const override = IMPACT_OPTION_TR_MAP[norm];
        if (override !== undefined) return Promise.resolve({ text: override });
        return translate(this.opts.config, o, "en-to-tr");
      }),
    ]);
    const question_tr = qRes.text;
    const options_tr = oRes.map((r) => r.text);

    const selected_tr = await this.emitAndAwait(question_tr, options_tr, options_en, true, suggested_en);

    const trIdx = options_tr.indexOf(selected_tr);
    if (trIdx >= 0) return options_en[trIdx];
    // Freeform ("Other") → EN'e çevir (fallback yok).
    const r = await translate(this.opts.config, selected_tr, "tr-to-en");
    return r.text;
  }

  /** Approval askq: summary TR + suffix, Approve/Revise/Cancel. */
  private async askApproval(block: Record<string, unknown>): Promise<"approve" | "revise" | "cancel"> {
    const suffixKey = this.opts.askq.approval_suffix_key ?? "generic";
    const summaryField = this.opts.askq.approval_summary_field ?? "summary";
    const summary_en = String(block[summaryField] ?? block.summary ?? block.pitch ?? "");
    const options_en = ["Approve", "Revise", "Cancel"];
    const options_tr = localizeOptionLabels(options_en, "tr");
    const r = await translate(this.opts.config, summary_en, "en-to-tr");
    const question_tr = `${r.text}${t(`askq.approval_suffix.${suffixKey}`, "tr")}`;

    const selected_tr = await this.emitAndAwait(question_tr, options_tr, options_en, false, null);
    const trIdx = options_tr.indexOf(selected_tr);
    const selected_en = trIdx >= 0 ? options_en[trIdx] : selected_tr;
    if (/^approve$/i.test(selected_en.trim())) return "approve";
    if (/^cancel$/i.test(selected_en.trim())) return "cancel";
    return "revise";
  }

  /** Ortak askq emit + cevap bekleme (SDK base ile aynı tesisat). */
  private emitAndAwait(
    question_tr: string,
    options_tr: string[],
    options_en: string[],
    allowOther: boolean,
    suggested_en: string | null,
  ): Promise<string> {
    const askqId = randomUUID();
    this.currentAskqId = askqId;
    this.pendingAskq = { options_en, options_tr };
    // Soruyu history'ye yaz (askq card zaten gösteriyor — live chat'e emit etme).
    appendHistory(this.opts.state.project_root, {
      ts: Date.now(),
      kind: "chat_message",
      data: { role: "system", text: question_tr },
    }).catch((err) => log.warn(this.opts.tag, "askq history fail", err));
    let suggested_option_tr: string | undefined;
    if (suggested_en) {
      const idx = options_en.indexOf(suggested_en);
      if (idx >= 0 && idx < options_tr.length) suggested_option_tr = options_tr[idx];
    }
    emitAskq({
      id: askqId,
      question: question_tr,
      options: options_tr,
      allow_other: allowOther,
      suggested_option: suggested_option_tr,
    });
    return new Promise<string>((resolve, reject) => {
      this.pendingResolver = resolve;
      this.pendingRejecter = reject;
    }).finally(() => {
      this.pendingAskq = null;
      this.currentAskqId = null;
    });
  }
}

/**
 * Aktif config'e göre qa-askq backend'i seç (Faz 1/2/9 factory). main rolü "cli"
 * + claude → CLI; "cli" ama claude yok → görünür fail (sessiz API YOK); aksi SDK.
 */
export function createQaAskqBackend(opts: QaAskqRunOpts): QaAskqBackend {
  // v15.11: main ajan yalnız İngilizce yazar (genel kural, CLI+SDK). Çevirmen hariç.
  opts = { ...opts, systemPrompt: opts.systemPrompt + MAIN_AGENT_LANGUAGE_RULE };
  const wantCli = backendForRole(opts.config, "main") === "cli";
  if (wantCli) {
    if (isClaudeAvailable()) {
      log.info(opts.tag, "using CLI qa-askq backend (abonelik)");
      // Auto Mode: limit faz ortasında dolarsa API'ye kesintisiz geç.
      if (isAutoMode(opts.config, "main")) {
        return autoFallbackBackend<QaAskqOutcome, QaAskqBackend>(
          () => new CliQaAskqBackend(opts),
          () => new QaAskqBaseController(opts),
        );
      }
      return new CliQaAskqBackend(opts);
    }
    const m =
      `Main 'Claude Code Aboneliği' (CLI) seçili ama \`claude\` bulunamadı — ` +
      `${opts.tag} çalıştırılamadı. API'ye SESSİZCE DÜŞÜLMEDİ. \`claude\` kur ya da ` +
      `Ayarlar → Modeller'den main'i 'API' yap.`;
    log.warn(opts.tag, "CLI seçili ama claude yok — görünür fail");
    return {
      run: async (): Promise<QaAskqOutcome> => {
        emitError(`${opts.tag}: claude bulunamadı (CLI backend)`, m);
        emitChatMessage("system", `🔴 ${m}`);
        return { kind: "failed", reason: m };
      },
      abort: () => {},
      submitAskqAnswer: () => {},
    };
  }
  return new QaAskqBaseController(opts);
}
