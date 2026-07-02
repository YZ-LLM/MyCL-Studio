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
import { MAIN_AGENT_LANGUAGE_RULE, USER_FACING_CLARITY_RULE } from "../agent-language.js";
import { coerceToSchema, extractKindBlock, schemaToSkeleton } from "../cli-json.js";
import { runClaudeCliSession } from "../cli-session.js";
import { PURE_REASONING_DISALLOWED_TOOLS } from "../tool-policy.js";
import { autoAnswerSuggested } from "../auto-answer.js";
import { selectEffortForTask } from "../model-catalog.js";
import { autoBackendPair } from "../cli-rate-limit.js";
import { isApiAccountError } from "../claude-api.js";
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
    return req.length ? req.join(", ") : "(fields from the schema)";
  };
  // Somut örnek: şemadan tam şekli üret (iç içe dizileri GÖSTERİR → ajan düzyazıya
  // çevirmesin; v15.12 "dimensions düzyazı" takılmasının proaktif çözümü).
  const exampleOf = (kind: string, name?: string): string | null => {
    const tool = name ? tools.find((tt) => tt.name === name) : undefined;
    if (!tool) return null;
    const skel = schemaToSkeleton(tool.input_schema as Record<string, unknown>) as Record<string, unknown>;
    return JSON.stringify({ kind, ...skel });
  };
  const examples = [
    askq.clarifying_tool_name ? exampleOf("askq", askq.clarifying_tool_name) : null,
    exampleOf("approval", askq.approval_tool_name),
    askq.abandon_tool_name ? exampleOf("abandon", askq.abandon_tool_name) : null,
    askq.tweak_tool_name ? exampleOf("tweak", askq.tweak_tool_name) : null,
    askq.failure_tool_name ? exampleOf("ac_failure", askq.failure_tool_name) : null,
  ].filter((x): x is string => x !== null);
  const lines: string[] = [];
  if (askq.clarifying_tool_name) {
    lines.push(
      `- To ask a question: {"kind":"askq", ...} — fields must match this schema: ${schemaOf(askq.clarifying_tool_name)} ` +
        `(question + options[] required; suggested_answer optional, must be one of options).`,
    );
  }
  lines.push(
    `- To approve/conclude: {"kind":"approval", ...} — REQUIRED fields with EXACTLY these names ` +
      `(NOT generic "summary"/"title"): ${requiredOf(askq.approval_tool_name)}. ` +
      `Full schema: ${schemaOf(askq.approval_tool_name)}.`,
  );
  if (askq.abandon_tool_name) {
    lines.push(`- To abandon: {"kind":"abandon", ...} — fields: ${schemaOf(askq.abandon_tool_name)}.`);
  }
  if (askq.tweak_tool_name) {
    lines.push(`- For a UI change: {"kind":"tweak", ...} — fields: ${schemaOf(askq.tweak_tool_name)}.`);
  }
  if (askq.failure_tool_name) {
    lines.push(`- For AC failure: {"kind":"ac_failure", ...} — fields: ${schemaOf(askq.failure_tool_name)}.`);
  }
  return `

---

## OUTPUT FORMAT — CLI mode (no tools, text-JSON)

You CANNOT call tools. Your ENTIRE answer must be a single JSON block — write NO plain text
outside the block (neither before nor after). Valid JSON: double quotes, no trailing comma.
The \`kind\` field is required. Block content (question/summary/etc.) is in English. Available blocks:
${lines.join("\n")}

### EXACT shape — copy this structure (note nested arrays of objects; do NOT write them as prose):
${examples.join("\n")}

DO NOT write to disk or run commands — investigate ONLY with Read/Grep/Glob (read-only review;
applying any "fix" is a later phase's job, not yours). When you ask a question you will
receive the user's answer in the next message; continue accordingly (then another {"kind":"askq"} or {"kind":"approval"}).`;
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
    // Oto-efor (YZLLM): niyet/netleştirme hafif iş → high tavanı (max gereksiz düşünme).
    const effort = opts.effortOverride ?? selectEffortForTask("intent", opts.config.claude_code_flags.effort);
    // max_questions clarifying turu + onay + birkaç resume/nudge için tampon.
    const maxTurns = askq.max_questions + 4;

    emitClaudeStream({
      sub: "init",
      text: `cli-${opts.tag}`,
      model: opts.modelId,
      cwd: opts.state.project_root,
    });
    emitChatMessage("system", `🤖 Claude Code CLI (abonelik) — ${opts.tag} (model: ${opts.modelId})…`);

    // v15.12 dayanıklılık: onay bloğunun somut örneği (nudge + son-çare sentez için).
    const approvalTool = opts.tools.find((tt) => tt.name === askq.approval_tool_name);
    const approvalExample = approvalTool
      ? JSON.stringify({
          kind: "approval",
          ...(schemaToSkeleton(approvalTool.input_schema as Record<string, unknown>) as Record<string, unknown>),
        })
      : null;

    let resume = false;
    let userMessage = opts.initialUserMessage;
    let noJsonNudges = 0; // JSON yok → örnekli nudge (≤2), sonra prose'tan sentez (takılma yok)
    let fieldNudges = 0; // eksik zorunlu alan → örnekli nudge (≤2), sonra coerce + devam

    for (let turn = 0; turn < maxTurns; turn++) {
      if (this.aborted) return { kind: "aborted" };

      const res = await runClaudeCliSession({
        sessionId,
        resume,
        userMessage,
        systemPrompt: resume ? undefined : systemPrompt,
        modelId: opts.modelId,
        cwd: opts.state.project_root,
        // YZLLM 2026-06-13: qa-askq fazları (Faz 1/2/9 niyet/hassasiyet/risk-inceleme) SALT-OKUNUR analizdir →
        // yazma + Bash + alt-ajan (Agent/Task) hepsi yasak. İki kanıtlı kaçış: (1) Bash AÇIKKEN ajan
        // `cat > admin.js << EOF` ile production kodunu EZDİ; (2) Agent çağrılınca alt-ajan üst-kısıta tabi
        // olmadan koştu + 200+ sn donma. Read/Grep/Glob okumaya yeter. Risk-incelemesi kod YAZMAZ — "fix"
        // kararı Faz 8'in işidir. Tek doğruluk kaynağı: tool-policy.ts.
        allowedTools: ["Read", "Grep", "Glob"],
        disallowedTools: PURE_REASONING_DISALLOWED_TOOLS,
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

      let block = extractKindBlock(res.text, [
        "askq",
        "approval",
        "abandon",
        "tweak",
        "ac_failure",
      ]);
      if (block === null) {
        if (noJsonNudges < 2) {
          noJsonNudges++;
          resume = true;
          userMessage =
            "No valid JSON block found. Write ONLY a single JSON block (no prose, no text around it). " +
            (approvalExample ? `Copy this EXACT shape: ${approvalExample}` : "");
          continue;
        }
        // v15.12: 2 nudge sonrası hâlâ JSON yok → ASLA takılma. Ajanın metnini onay
        // bloğu olarak sentezle (prose = içerik), eksikleri coerce et, GÖRÜNÜR uyarı ver.
        if (!approvalTool) {
          return { kind: "failed", reason: `${opts.tag}: geçerli JSON blok üretilemedi (onay aracı yok)` };
        }
        const { coerced, defaulted } = coerceToSchema(
          {},
          approvalTool.input_schema as Record<string, unknown>,
          res.text,
        );
        block = { kind: "approval", ...coerced };
        emitChatMessage(
          "system",
          `⚠️ ${opts.tag}: ajan yapılandırılmış blok üretmedi; mevcut metinle devam edildi (dolduruldu: ${defaulted.join(", ") || "—"}).`,
        );
      }

      // v15.9 + v15.12: terminal blok (approval/abandon/tweak/ac_failure) ZORUNLU alan
      // doğrulaması. Ajan generic {summary,title} emit eder veya dizi alanını (dimensions)
      // düzyazıya çevirip atlarsa: örnekli nudge (≤2). Hâlâ eksikse ASLA hard-fail ETME →
      // coerceToSchema ile tip-güvenli doldur (array→[], string→alias/ham-metin) + GÖRÜNÜR
      // uyarı + DEVAM. Pipeline takılmaz; downstream boş diziyi zaten tolere eder.
      if (block.kind !== "askq") {
        const kindToToolName: Record<string, string | undefined> = {
          approval: askq.approval_tool_name,
          abandon: askq.abandon_tool_name,
          tweak: askq.tweak_tool_name,
          ac_failure: askq.failure_tool_name,
        };
        const toolName = kindToToolName[String(block.kind)];
        const tool = toolName ? opts.tools.find((tt) => tt.name === toolName) : undefined;
        const schema = (tool?.input_schema as Record<string, unknown> | undefined) ?? {};
        const required = (schema.required as string[] | undefined) ?? [];
        const missing = required.filter((f) => {
          const v = (block as Record<string, unknown>)[f];
          return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
        });
        if (missing.length > 0) {
          if (fieldNudges < 2) {
            fieldNudges++;
            resume = true;
            const ex = tool
              ? JSON.stringify({
                  kind: block.kind,
                  ...(schemaToSkeleton(schema) as Record<string, unknown>),
                })
              : "";
            userMessage =
              `Your '${String(block.kind)}' block is missing REQUIRED field(s): ${missing.join(", ")}. ` +
              `REWRITE the block with the EXACT field names + shapes (arrays of objects must be JSON arrays, NOT prose). ` +
              (ex ? `Copy this shape: ${ex}` : "");
            continue;
          }
          // v15.12: nudge sonrası hâlâ eksik → takılma yerine coerce + görünür uyarı + devam.
          const { coerced, defaulted } = coerceToSchema(block, schema, res.text);
          block = { ...coerced, kind: block.kind };
          emitChatMessage(
            "system",
            `⚠️ ${opts.tag}: '${String(block.kind)}' bloğunda eksik alan vardı — mevcut bilgiyle dolduruldu, devam edildi (${defaulted.join(", ") || "—"}).`,
          );
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
        userMessage = "The user requested a revision. Write an updated {\"kind\":\"approval\",...} block (or {\"kind\":\"askq\"} if needed).";
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
    // v15.13 (saha 3/5): Oto-cevap ON → kullanıcıya sormadan yanıtla (görünür not).
    // YZLLM 2026-06-15: öneri YOKSA bile (onaylar suggested_en=null geçer) ASKIDA KALMA
    // → ilk seçeneği seç. Onay askq'larında ilk seçenek "Onayla"dır → pipeline kendiliğinden
    // akar (Faz 6 görsel-incelemesi AYRI; o bu backend'den geçmez, kullanıcı sürer).
    // YZLLM 2026-06-17: ÖNEMLİ kullanıcı-tercihi (Faz 1/2 NETLEŞTİRME — allowOther=true,
    // yani !is_approval) oto-cevapla GEÇİLMEZ; kullanıcı seçer. Onaylar (allowOther=false)
    // + diğer fazlar (Faz 9 risk dahil) oto-cevaba dahil.
    const isUserPreferenceClarify =
      allowOther && (this.opts.tag === "phase-1" || this.opts.tag === "phase-2");
    if (
      autoAnswerSuggested() &&
      !isUserPreferenceClarify &&
      (suggested_option_tr !== undefined || options_tr.length > 0)
    ) {
      const pick = suggested_option_tr ?? options_tr[0]!;
      this.pendingAskq = null;
      this.currentAskqId = null;
      emitChatMessage(
        "system",
        suggested_option_tr !== undefined
          ? `🤖 Oto-cevap (öneri): "${question_tr}" → "${pick}"`
          : `🤖 Oto-cevap (otomatik onay/ilk seçenek): "${question_tr}" → "${pick}"`,
      );
      return Promise.resolve(pick);
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
  opts = { ...opts, systemPrompt: opts.systemPrompt + MAIN_AGENT_LANGUAGE_RULE + USER_FACING_CLARITY_RULE };
  // Auto Mode: simetrik çift-yön (limit yokken CLI birincil, limitliyse API birincil);
  // birincil KALICI başarısızsa diğerine kesintisiz geçer. claude yoksa → API.
  if (isAutoMode(opts.config, "main")) {
    if (!isClaudeAvailable()) {
      emitChatMessage("system", "ℹ️ Auto Mode: `claude` bulunamadı → API kullanılıyor.");
      return new QaAskqBaseController(opts);
    }
    return autoBackendPair<QaAskqOutcome, QaAskqBackend>(
      backendForRole(opts.config, "main"),
      () => new CliQaAskqBackend(opts),
      () => new QaAskqBaseController(opts),
      isApiAccountError, // kredi/yetki hatasında CLI↔API boş döngüsünü kır
    );
  }
  const wantCli = backendForRole(opts.config, "main") === "cli";
  if (wantCli) {
    if (isClaudeAvailable()) {
      log.info(opts.tag, "using CLI qa-askq backend (abonelik)");
      return new CliQaAskqBackend(opts);
    }
    const m =
      `Main 'Claude Code Aboneliği' (CLI) seçili ama \`claude\` bulunamadı — ` +
      `${opts.tag} çalıştırılamadı. API'ye SESSİZCE DÜŞÜLMEDİ. \`claude\` kur ya da ` +
      `Ayarlar → Modeller'den main'i 'API' yap.`;
    log.warn(opts.tag, "CLI seçili ama claude yok — görünür fail");
    return {
      run: async (): Promise<QaAskqOutcome> => {
        emitError(`${opts.tag}: claude bulunamadı (CLI arka ucu)`, m);
        emitChatMessage("system", `🔴 ${m}`);
        return { kind: "failed", reason: m };
      },
      abort: () => {},
      submitAskqAnswer: () => {},
    };
  }
  return new QaAskqBaseController(opts);
}
