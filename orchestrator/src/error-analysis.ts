// error-analysis — F1: bir HATA olunca MyCL analiz etsin, kullanıcıya askq +
// (OS bildirimi mevcut askq yolundan otomatik) göndersin, FINAL kararı kullanıcı
// versin. Faz-fail bir helper'dan (failPhase, index.ts) tetiklenir; analiz
// NON-BLOCKING — askq açar, ana akışı kilitlemez.
//
// Backend: ORKESTRATÖR rolü (ana ajana/codegen'e GİTMEZ — kullanıcı kuralı).
// living-docs.ts deseni birebir: abonelik/CLI modunda runClaudeCli (Read/Grep/
// Glob/Bash açık → ajan kodu/hatayı inceler). Ajan tek bir {"kind":"error_analysis",
// ...} JSON bloğu döner; extractKindBlock ile parse. TR çıktı UI'da gösterilir
// (orkestrator rolü, ana ajan değil → TR meşru). Görünür + fail-closed: claude
// hatası ya da blok üretilememesi → görünür hata mesajı + audit + null id döner
// (caller askq açmaz). Sessiz fallback YOK.

import { randomUUID } from "node:crypto";
import { appendAudit } from "./audit.js";
import { extractKindBlock } from "./cli-json.js";
import { runClaudeCli } from "./cli-run.js";
import { backendForRole, type MyclConfig } from "./config.js";
import { type AskqOption, emitAskq, emitChatMessage, emitClaudeStream } from "./ipc.js";
import { log } from "./logger.js";
import type { PhaseId, State } from "./types.js";

/** Faz-fail bağlamı — caller (failPhase) doldurur. */
export interface ErrorContext {
  /** Hatanın oluştuğu faz (audit + UI için). */
  phase: PhaseId;
  /** Kullanıcıya gösterilecek hata mesajı (phaseFailMessage çıktısı). */
  message: string;
  /** Opsiyonel ham hata detayı (stderr/exception) — prompt'a beslenir. */
  detail?: string;
}

/** Ajanın döndüğü analiz bloğu (parse + doğrulama sonrası). */
export interface ErrorAnalysis {
  blocking: boolean;
  summary_tr: string;
  solutions_tr: string[];
}

/**
 * runtime.pendingErrorAnalysis ile eşleştirilen kayıt. handleAskqAnswer yeni
 * branch'i bu id ile askq cevabını analiz seçeneklerine eşler.
 */
export interface PendingErrorAnalysis {
  id: string;
  phase: PhaseId;
  blocking: boolean;
  /** Sıralı askq seçenekleri (UI'daki sırayla — index eşlemesi için). */
  options: string[];
  /** Ajanın önerdiği çözümler (TR). "Çöz" → debug akışına bunlar bağlam olur. */
  solutions_tr: string[];
}

// Sabit seçenek etiketleri (TR — orkestrator çıktısı UI'da gösterilir).
// EXPORT: index.ts handleAskqAnswer branch'i bu BİREBİR string'lerle eşleşir
// (elle yeniden yazınca TR-karakter/yazım drift'i eşlemeyi kırardı → tek kaynak).
export const OPT_SOLVE = "Çöz";
export const OPT_REANALYZE = "Tekrar analiz et";
export const OPT_QUEUE = "İş listesine kaydet, çözmeden devam et";

/**
 * SAF: analiz çıktısından askq seçeneklerini kur (test edilebilir, yan etki yok).
 *
 * İki şekil:
 * - blocking → çözüm seçenekleri + "Tekrar analiz et" (çözmeden ilerlemek
 *   imkânsız; "iş listesine kaydet" YOK).
 * - non-blocking → ["İş listesine kaydet, çözmeden devam et", ...çözümler]
 *   + "Tekrar analiz et". Çözüm yoksa jenerik "Çöz" konur (akış tıkanmasın).
 *
 * Çözümler trim + boş eleme + dedup; her şekilde sonda "Tekrar analiz et".
 */
export function buildErrorAnalysisAskq(
  solutions_tr: string[],
  blocking: boolean,
): { options: AskqOption[] } {
  const seen = new Set<string>();
  const solutions: string[] = [];
  for (const s of solutions_tr) {
    const t = typeof s === "string" ? s.trim() : "";
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    solutions.push(t);
  }

  const options: string[] = [];
  if (!blocking) {
    // Bloklayıcı değil: çözmeden devam etme seçeneği en başta.
    options.push(OPT_QUEUE);
  }
  if (solutions.length > 0) {
    options.push(...solutions);
  } else if (!blocking) {
    // Non-blocking + çözüm üretilemedi → jenerik "Çöz" (debug akışı tetiklensin).
    options.push(OPT_SOLVE);
  }
  // Her iki şekilde de en sonda yeniden analiz.
  options.push(OPT_REANALYZE);

  return { options };
}

/**
 * SAF: ajan serbest metninden {kind:"error_analysis"} bloğunu parse + doğrula.
 * summary_tr zorunlu (boş olamaz); solutions_tr string dizisi (yoksa []).
 * Bulunamazsa / geçersizse null (caller görünür hata verir, sessiz değil).
 */
export function parseErrorAnalysisBlock(text: string): ErrorAnalysis | null {
  const block = extractKindBlock(text, ["error_analysis"]);
  if (!block) return null;
  const summary = (block as Record<string, unknown>).summary_tr;
  if (typeof summary !== "string" || summary.trim() === "") return null;
  const blocking = (block as Record<string, unknown>).blocking === true;
  const rawSolutions = (block as Record<string, unknown>).solutions_tr;
  const solutions_tr = Array.isArray(rawSolutions)
    ? rawSolutions.filter((s): s is string => typeof s === "string")
    : [];
  return { blocking, summary_tr: summary.trim(), solutions_tr };
}

/** Pure: orkestratör analiz prompt'unu kur (test edilebilir). */
export function buildErrorAnalysisPrompt(errCtx: ErrorContext): string {
  return [
    "You are MyCL Studio's orchestrator. A phase in the build pipeline just FAILED.",
    "Inspect the codebase (Read/Grep/Glob/Bash are available) to understand the failure,",
    "then produce a short root-cause analysis and concrete next steps for the developer.",
    "",
    `Failed phase: ${errCtx.phase}`,
    "Error message shown to the developer:",
    errCtx.message,
    ...(errCtx.detail && errCtx.detail.trim()
      ? ["", "Raw error detail:", errCtx.detail.slice(0, 4000)]
      : []),
    "",
    "Decide whether this error is BLOCKING (the pipeline genuinely cannot proceed",
    "until it is resolved) or NON-BLOCKING (work could continue and the fix queued).",
    "",
    "Emit EXACTLY ONE JSON object as the LAST thing in your reply, no other JSON:",
    '{"kind":"error_analysis","blocking":<true|false>,"summary_tr":"<1-3 sentence root-cause summary IN TURKISH>","solutions_tr":["<concrete solution option 1 IN TURKISH>","<option 2>","..."]}',
    "",
    "Rules: summary_tr and every solutions_tr entry MUST be written in Turkish (the",
    "developer reads Turkish). Each solution must be a distinct, actionable option",
    "(not a restatement of the error). 2-4 solutions is ideal. Do NOT include a",
    '"queue it" / "re-analyze" option — MyCL adds those automatically.',
  ].join("\n");
}

/**
 * IMPURE: hatayı orkestratör rolüyle analiz et, UI'a özet + askq bas, runtime
 * pending eşlemesi için kaydı döndür. NON-BLOCKING — askq açar, ana akışı
 * kilitlemez. Fail-closed: claude hatası / blok üretilememesi → görünür hata
 * mesajı + audit + null (caller askq açmaz, sessiz fallback YOK).
 *
 * v15.13 deseni (living-docs): orkestratör rolü CLI/abonelik modunda runClaudeCli.
 * API modunda görünür not + null (sessiz değil) — sonraki tur API yolu eklenir.
 *
 * @returns PendingErrorAnalysis (caller runtime.pendingErrorAnalysis'e yazar) ya
 *   da analiz başarısızsa null.
 */
export async function analyzeAndAskError(
  state: State,
  config: MyclConfig,
  errCtx: ErrorContext,
): Promise<PendingErrorAnalysis | null> {
  try {
    // F1: hata analizi ORKESTRATÖR rolüdür — ana ajana (codegen) GİTMEZ.
    if (backendForRole(config, "orchestrator") !== "cli") {
      emitChatMessage(
        "system",
        "ℹ️ Hata analizi şu an yalnız CLI/abonelik modunda yapılır (orkestratör rolü).",
      );
      return null;
    }
    // Orkestratör modeli (yoksa main'e fallback — SelectedModels.orchestrator opsiyonel).
    const analysisModel = config.selected_models.orchestrator ?? config.selected_models.main;
    const prompt = buildErrorAnalysisPrompt(errCtx);

    emitChatMessage("system", "🔎 Hata analiz ediliyor (orkestratör)…");
    emitClaudeStream({
      sub: "init",
      text: "cli-error-analysis",
      model: analysisModel,
      cwd: state.project_root,
    });
    const res = await runClaudeCli({
      systemPrompt: prompt,
      userMessage: "Inspect the failure and emit the error_analysis JSON block now.",
      modelId: analysisModel,
      cwd: state.project_root,
      allowedTools: ["Read", "Grep", "Glob", "Bash"],
      disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
      effort: config.claude_code_flags.effort,
      onText: (t) => emitClaudeStream({ sub: "text", text: t }),
      observer: (tu) =>
        emitClaudeStream({ sub: "tool_use", tool_name: tu.name, tool_input: tu.input }),
      timeoutMs: 300_000,
    });
    if (res.usage) emitClaudeStream({ sub: "token_usage", usage: res.usage });

    const fail = async (msg: string, detail: string): Promise<null> => {
      // Görünür hata (sadece log.warn değil) — fail-closed.
      emitChatMessage("error", `⚠️ ${msg}`);
      await appendAudit(state.project_root, {
        ts: Date.now(),
        phase: errCtx.phase,
        event: "error-analysis-failed",
        caller: "mycl-orchestrator",
        detail: detail.slice(0, 200),
      }).catch(() => {});
      return null;
    };

    if (!res.ok) {
      return await fail("Hata analizi yapılamadı (claude hatası).", String(res.error ?? ""));
    }
    const analysis = parseErrorAnalysisBlock(res.text);
    if (!analysis) {
      return await fail("Hata analizi bloğu üretilemedi.", "no valid {kind:error_analysis} block");
    }

    const { options } = buildErrorAnalysisAskq(analysis.solutions_tr, analysis.blocking);
    const optionLabels = options.map((o) => (typeof o === "string" ? o : o.label));

    // UI'da özet (orkestratör TR çıktısı). Bloklayıcı durumu ayrıca yüzeye çıkar.
    emitChatMessage(
      "assistant",
      analysis.blocking
        ? `${analysis.summary_tr}\nBu hata çözülmeden ilerlemek mümkün değil. Nasıl ilerleyelim?`
        : `${analysis.summary_tr}\nNasıl ilerleyelim?`,
    );

    const id = `error_analysis_${randomUUID()}`;
    // askq emit → OS bildirimi mevcut askq yolundan OTOMATİK tetiklenir.
    emitAskq({
      id,
      question: analysis.blocking
        ? `Faz ${errCtx.phase} hatası — çözülmeden ilerlenemez. Nasıl ilerleyelim?`
        : `Faz ${errCtx.phase} hatası. Nasıl ilerleyelim?`,
      options,
    });

    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: errCtx.phase,
      event: "error-analysis",
      caller: "mycl-orchestrator",
      detail: `blocking=${analysis.blocking} solutions=${analysis.solutions_tr.length}`,
    }).catch(() => {});

    return {
      id,
      phase: errCtx.phase,
      blocking: analysis.blocking,
      options: optionLabels,
      solutions_tr: analysis.solutions_tr,
    };
  } catch (err) {
    // Hiçbir koşulda ana akışı bozma — görünür hata + log (sessiz değil).
    log.warn("error-analysis", "analyzeAndAskError failed (non-fatal)", err);
    emitChatMessage("error", "⚠️ Hata analizi beklenmedik bir nedenle yapılamadı.");
    return null;
  }
}
