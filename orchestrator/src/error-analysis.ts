// error-analysis — F1: bir HATA olunca MyCL analiz eder. 2026-06-10 (Ümit: "kolayca
// çözebileceği şeyi bile soruyor — kendisi en iyi çözümü bulup çözsün"): varsayılan artık
// OTO-ÇÖZÜM — ajan best_index ile en iyi çözümü seçer, failPhase sormadan uygular (kullanıcı
// kararı + alternatifleri chat'te görür). askq yalnız fallback: çözüm üretilemedi / oto-deneme
// limiti (failPhase guard) doldu / güvenlik override (Kabul et, devam et — hep insan kararı).
// Faz-fail bir helper'dan (failPhase, index.ts) tetiklenir.
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
import Anthropic from "@anthropic-ai/sdk";
import { runClaudeCli } from "./cli-run.js";
import { makeAnthropicClient } from "./claude-api.js";
import { backendForRole, type MyclConfig } from "./config.js";
import { selectEffortForTask } from "./model-catalog.js";
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
  /**
   * Güvenlik-baseline Unit 2: BLOCKING gate (örn. Faz 13 güvenlik). true ise askq
   * "Kabul et, devam et" (OPT_ACCEPT_CONTINUE) seçeneği EKLER + blocking'e zorlar —
   * "TAMAMLANDI deme" (soft→blocking) ama "takılma yok" (kullanıcı override edebilir).
   */
  allowAcceptContinue?: boolean;
  /**
   * "Kabul et, devam et" seçilirse hangi fazın `phase-N-complete`
   * (detail:"security_accepted_by_user") yazılıp advanceToNextPhase(N) çağrılacağı.
   * allowAcceptContinue=true iken set edilmeli (yoksa accept-continue dalı no-op).
   */
  acceptContinuePhase?: number;
}

/** Ajanın döndüğü analiz bloğu (parse + doğrulama sonrası). */
export interface ErrorAnalysis {
  blocking: boolean;
  summary_tr: string;
  solutions_tr: string[];
  /** Ajanın UYGULAYACAĞI çözümün 0-tabanlı index'i (doğruluk önce, sonra en düşük risk). */
  best_index: number;
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
  /**
   * Güvenlik-baseline Unit 2: "Kabul et, devam et" seçilirse phase-N-complete
   * (detail:"security_accepted_by_user") yazılıp advanceToNextPhase(N) çağrılacak faz.
   * undefined → accept-continue seçeneği sunulmadı (normal hata akışı).
   */
  acceptContinuePhase?: number;
  /**
   * 2026-06-10 (Ümit: "hata çözümünü sorma, kendisi çözsün"): set ise askq AÇILMAMIŞTIR;
   * failPhase bu çözümü handleAskqAnswer ile otomatik route eder (aynı yol, soru yok).
   */
  auto_selected_solution?: string;
}

// Sabit seçenek etiketleri (TR — orkestrator çıktısı UI'da gösterilir).
// EXPORT: index.ts handleAskqAnswer branch'i bu BİREBİR string'lerle eşleşir
// (elle yeniden yazınca TR-karakter/yazım drift'i eşlemeyi kırardı → tek kaynak).
export const OPT_SOLVE = "Çöz";
export const OPT_REANALYZE = "Tekrar analiz et";
export const OPT_QUEUE = "İş listesine kaydet, çözmeden devam et";
// Güvenlik-baseline Unit 2: blocking gate'te kullanıcı override (bulguyu kabul edip devam).
export const OPT_ACCEPT_CONTINUE = "Kabul et, devam et";

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
  opts?: { allowAcceptContinue?: boolean },
): { options: AskqOption[] } {
  const allowAcceptContinue = opts?.allowAcceptContinue === true;
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
  } else if (!blocking || allowAcceptContinue) {
    // Çözüm üretilemedi → jenerik "Çöz" (debug akışı tetiklensin). Non-blocking'de
    // ya da blocking-ama-accept-continue (güvenlik gate) durumunda bir solve yolu şart.
    options.push(OPT_SOLVE);
  }
  if (allowAcceptContinue) {
    // Güvenlik-baseline Unit 2: blocking gate'te kullanıcı bulguyu kabul edip
    // devam edebilir (override). "İş listesine kaydet" değil — bu blocking, kabul+devam.
    options.push(OPT_ACCEPT_CONTINUE);
  }
  // Her şekilde en sonda yeniden analiz.
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
  const rawBest = (block as Record<string, unknown>).best_index;
  const best_index =
    typeof rawBest === "number" && Number.isInteger(rawBest) && rawBest >= 0 && rawBest < solutions_tr.length
      ? rawBest
      : 0;
  return { blocking, summary_tr: summary.trim(), solutions_tr, best_index };
}

/** Pure: orkestratör analiz prompt'unu kur (test edilebilir). canInvestigate=false → API tek-atış (tool yok). */
export function buildErrorAnalysisPrompt(errCtx: ErrorContext, canInvestigate = true): string {
  return [
    "You are MyCL Studio's orchestrator. A phase in the build pipeline just FAILED.",
    canInvestigate
      ? "Inspect the codebase (Read/Grep/Glob/Bash are available) to understand the failure,"
      : "Reason from the error message and raw detail below (no tools available — use the given evidence),",
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
    '{"kind":"error_analysis","blocking":<true|false>,"summary_tr":"<1-3 sentence root-cause summary IN TURKISH>","solutions_tr":["<concrete solution option 1 IN TURKISH>","<option 2>","..."],"best_index":<0-based index of the solution YOU would apply>}',
    "",
    "Rules: summary_tr and every solutions_tr entry MUST be written in Turkish (the",
    "developer reads Turkish). Each solution must be a distinct, actionable option",
    "(not a restatement of the error). 2-4 solutions is ideal. Do NOT include a",
    '"queue it" / "re-analyze" option — MyCL adds those automatically.',
    "",
    "DIAGNOSE THE ACTUAL ERROR, not generic causes. If a 'Spawn output' / 'actual error'",
    "is provided above, the root cause is IN THAT OUTPUT — read it. Common classes:",
    "- 'argument list too long' / E2BIG → the ENVIRONMENT (shell env too large), NOT the",
    "  project. Fix: trim env / new shell — do NOT touch project code, deps, or ports.",
    "- 'command not found' / ENOENT → missing script or dependency, NOT a port issue.",
    "- 'EADDRINUSE' / port in use → port conflict (free the port / pick another).",
    "- the SAME failure persists after a fix → the cause is NOT what you changed; widen",
    "  the diagnosis (environment/external), do NOT repeat project-level edits.",
    "best_index: pick the solution YOU would apply (correctness first, then lowest",
    "risk) — MyCL may AUTO-APPLY it without asking the user. RANK by reversibility &",
    "cost: cheap reversible code/config edits FIRST; slow/destructive actions (deleting",
    "node_modules, full reinstall, wiping caches) LAST and only if the error output",
    "clearly points to corrupted deps. Prefer fixes MyCL can execute over manual ones.",
  ].join("\n");
}

/**
 * IMPURE: hatayı orkestratör rolüyle analiz et, UI'a özet + askq bas, runtime
 * pending eşlemesi için kaydı döndür. NON-BLOCKING — askq açar, ana akışı
 * kilitlemez. Fail-closed: claude hatası / blok üretilememesi → görünür hata
 * mesajı + audit + null (caller askq açmaz, sessiz fallback YOK).
 *
 * Backend-aware (2026-06-10): orkestratör cli → runClaudeCli (araştırmalı); api → Anthropic SDK
 * tek-atış triage (tool yok; derin araştırmayı seçilen fix downstream yapar). İkisi de aynı JSON'u üretir.
 *
 * @returns PendingErrorAnalysis (caller runtime.pendingErrorAnalysis'e yazar) ya
 *   da analiz başarısızsa null.
 */
export async function analyzeAndAskError(
  state: State,
  config: MyclConfig,
  errCtx: ErrorContext,
  opts?: {
    /**
     * 2026-06-10 (Ümit): true → askq AÇMA; ajanın best_index çözümünü auto_selected_solution
     * olarak döndür (failPhase otomatik route eder). Çözüm üretilemediyse askq'ya düşer.
     * "Kabul et, devam et" (güvenlik override) ASLA otomatik seçilmez — o hep insan kararı.
     */
    autoResolve?: boolean;
  },
): Promise<PendingErrorAnalysis | null> {
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
  try {
    // Hata analizi ORKESTRATÖR rolüdür. Backend'e göre: cli → araştırmalı (Read/Grep/Bash);
    // api → tek-atış triage (Ümit 2026-06-10 "bunu çözmüştük" — API modunda da çalışmalı).
    // Tek-atışta derin araştırmayı SEÇİLEN FİX downstream (Faz 0 / SDK) yapar → triage hızlı + yeterli.
    const analysisModel = config.selected_models.orchestrator ?? config.selected_models.main;
    const useCli = backendForRole(config, "orchestrator") === "cli";
    emitChatMessage("system", "🔎 Hata analiz ediliyor (orkestratör)…");
    let analysisText: string;
    if (useCli) {
      emitClaudeStream({ sub: "init", text: "cli-error-analysis", model: analysisModel, cwd: state.project_root });
      const res = await runClaudeCli({
        systemPrompt: buildErrorAnalysisPrompt(errCtx, true),
        userMessage: "Inspect the failure and emit the error_analysis JSON block now.",
        modelId: analysisModel,
        cwd: state.project_root,
        allowedTools: ["Read", "Grep", "Glob", "Bash"],
        disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
        effort: selectEffortForTask("verification", config.claude_code_flags.effort),
        onText: (t) => emitClaudeStream({ sub: "text", text: t }),
        observer: (tu) =>
          emitClaudeStream({ sub: "tool_use", tool_name: tu.name, tool_input: tu.input }),
        timeoutMs: 300_000,
      });
      if (res.usage) emitClaudeStream({ sub: "token_usage", usage: res.usage });
      if (!res.ok) return await fail("Hata analizi yapılamadı (claude hatası).", String(res.error ?? ""));
      analysisText = res.text;
    } else {
      // API yolu — Anthropic SDK tek-atış (tool yok; hata mesajı + detail'den triage).
      try {
        const client = makeAnthropicClient(
          config.api_keys.orchestrator ?? config.api_keys.main,
          { timeoutMs: 120_000 },
        );
        const response = await client.messages.create({
          model: analysisModel,
          max_tokens: 2048,
          system: buildErrorAnalysisPrompt(errCtx, false),
          messages: [
            {
              role: "user",
              content:
                "Emit the error_analysis JSON block now, reasoning from the error message and detail provided.",
            },
          ],
        });
        analysisText = response.content
          .filter((c): c is Anthropic.TextBlock => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      } catch (e) {
        return await fail("Hata analizi yapılamadı (API hatası).", String(e));
      }
    }

    const analysis = parseErrorAnalysisBlock(analysisText);
    if (!analysis) {
      return await fail("Hata analizi bloğu üretilemedi.", "no valid {kind:error_analysis} block");
    }

    // Güvenlik-baseline Unit 2: allowAcceptContinue (blocking gate) → blocking'e zorla
    // (LLM "non-blocking" dese bile gate bloklayıcı; askq "Kabul et, devam et" sunar).
    const blocking = errCtx.allowAcceptContinue ? true : analysis.blocking;
    const { options } = buildErrorAnalysisAskq(analysis.solutions_tr, blocking, {
      allowAcceptContinue: errCtx.allowAcceptContinue,
    });
    const optionLabels = options.map((o) => (typeof o === "string" ? o : o.label));

    const id = `error_analysis_${randomUUID()}`;

    // 2026-06-10 (Ümit: "kolayca çözebileceği şeyi bile soruyor — kendisi çözsün"):
    // autoResolve + somut çözüm varsa askq AÇILMAZ; en iyi çözüm otomatik seçilir,
    // failPhase aynı routing'i (handleAskqAnswer) otomatik sürer. Güvenlik override'ı
    // (Kabul et, devam et) hiçbir zaman otomatik seçilmez — auto yol hep ÇÖZMEYİ dener.
    const best = analysis.solutions_tr[analysis.best_index];
    if (opts?.autoResolve && typeof best === "string" && best.trim() !== "") {
      const others = analysis.solutions_tr.filter((_, i) => i !== analysis.best_index);
      emitChatMessage(
        "assistant",
        `${analysis.summary_tr}\n\n🤖 **En iyi çözüm otomatik seçildi:** ${best}` +
          (others.length > 0
            ? `\nDeğerlendirilen alternatifler:\n${others.map((s) => `- ${s}`).join("\n")}`
            : ""),
      );
      await appendAudit(state.project_root, {
        ts: Date.now(),
        phase: errCtx.phase,
        event: "error-analysis",
        caller: "mycl-orchestrator",
        detail: `blocking=${blocking} solutions=${analysis.solutions_tr.length} auto_selected=true`,
      }).catch(() => {});
      return {
        id,
        phase: errCtx.phase,
        blocking,
        options: optionLabels,
        solutions_tr: analysis.solutions_tr,
        acceptContinuePhase: errCtx.acceptContinuePhase,
        auto_selected_solution: best.trim(),
      };
    }

    // UI'da özet (orkestratör TR çıktısı). Bloklayıcı durumu ayrıca yüzeye çıkar.
    emitChatMessage(
      "assistant",
      blocking
        ? `${analysis.summary_tr}\nBu hata çözülmeden ilerlemek mümkün değil. Nasıl ilerleyelim?`
        : `${analysis.summary_tr}\nNasıl ilerleyelim?`,
    );

    // askq emit → OS bildirimi mevcut askq yolundan OTOMATİK tetiklenir.
    emitAskq({
      id,
      question: blocking
        ? `Faz ${errCtx.phase} hatası — çözülmeden ilerlenemez. Nasıl ilerleyelim?`
        : `Faz ${errCtx.phase} hatası. Nasıl ilerleyelim?`,
      options,
    });

    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: errCtx.phase,
      event: "error-analysis",
      caller: "mycl-orchestrator",
      detail: `blocking=${blocking} solutions=${analysis.solutions_tr.length}`,
    }).catch(() => {});

    return {
      id,
      phase: errCtx.phase,
      blocking,
      options: optionLabels,
      solutions_tr: analysis.solutions_tr,
      acceptContinuePhase: errCtx.acceptContinuePhase,
    };
  } catch (err) {
    // Hiçbir koşulda ana akışı bozma — görünür hata + log (sessiz değil).
    log.warn("error-analysis", "analyzeAndAskError failed (non-fatal)", err);
    emitChatMessage("error", "⚠️ Hata analizi beklenmedik bir nedenle yapılamadı.");
    return null;
  }
}
