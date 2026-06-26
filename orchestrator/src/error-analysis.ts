// error-analysis — F1: bir HATA olunca MyCL analiz eder. 2026-06-10 (YZLLM: "kolayca
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
import { READ_ONLY_DISALLOWED_TOOLS } from "./tool-policy.js";
import { resolveLlmClient, isApiAccountError } from "./claude-api.js";
import { backendForRole, orchestratorModelId, type MyclConfig } from "./config.js";
import { buildProjectFacts } from "./project-facts.js";
import { type AskqOption, emitAskq, emitChatMessage, emitClaudeStream } from "./ipc.js";
import { VERIFY_BEFORE_CLAIM, DECISION_PRINCIPLES } from "./agent-language.js";
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
   * 2026-06-10 (YZLLM: "hata çözümünü sorma, kendisi çözsün"): set ise askq AÇILMAMIŞTIR;
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
  opts?: { allowAcceptContinue?: boolean; permanentNoProvider?: boolean },
): { options: AskqOption[] } {
  const allowAcceptContinue = opts?.allowAcceptContinue === true;
  const permanentNoProvider = opts?.permanentNoProvider === true;
  const seen = new Set<string>();
  const solutions: string[] = [];
  for (const s of solutions_tr) {
    const t = typeof s === "string" ? s.trim() : "";
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    solutions.push(t);
  }

  const options: string[] = [];
  // KALICI sağlayıcı-yok (kredi/yetki bitti): "Çöz", çözüm-uygula ve "Tekrar analiz" HEPSİ bir sağlayıcı
  // (CLI/API/z.ai) ister → hep aynı hatayı verir → sonsuz döngü (canlı bug). Yalnız "kaydet + devam"
  // (+ blocking gate'te kabul) sun; sağlayıcı dönünce iş listesinden tekrar denenir.
  if (permanentNoProvider) {
    options.push(OPT_QUEUE);
    if (allowAcceptContinue) options.push(OPT_ACCEPT_CONTINUE);
    return { options };
  }
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

/** Pure: orkestratör analiz prompt'unu kur (test edilebilir). canInvestigate=false → API tek-atış (tool yok).
 *  projectFacts: proje-gerçekleri özeti (dil JS/TS, framework...) — ajan körüne karar vermesin. */
export function buildErrorAnalysisPrompt(
  errCtx: ErrorContext,
  canInvestigate = true,
  projectFacts?: string,
): string {
  return [
    "You are MyCL Studio's orchestrator. A phase in the build pipeline just FAILED.",
    canInvestigate
      ? "Inspect the codebase (Read/Grep/Glob/Bash are available) to understand the failure,"
      : "Reason from the error message and raw detail below (no tools available — use the given evidence),",
    "then produce a short root-cause analysis and concrete next steps for the developer.",
    "",
    ...(projectFacts && projectFacts.trim()
      ? [
          projectFacts.trim(),
          "Use these facts: do NOT propose changes that contradict the project's nature (e.g. adding a tsconfig",
          "or TypeScript tooling to a JavaScript project). A tool that doesn't fit the project type is the TOOL's",
          "problem (skip it), not a project defect.",
          "",
        ]
      : []),
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
    "- Claude account/credit/usage-limit error ('credit balance too low', usage limit, billing/auth) → an",
    "  EXTERNAL provider/billing issue, NOT a code bug. MyCL HAS an automatic z.ai (GLM) fallback for",
    "  main/orchestrator/translator turns (both SDK and CLI) when a z.ai key is configured — do NOT tell the",
    "  user 'there is no fallback / no architectural z.ai switch'. The only blocking case is when z.ai is ALSO",
    "  missing or failing; then advise topping up Claude credit OR adding a z.ai key. Do NOT retry a dead provider.",
    "GATE INTEGRITY: NEVER propose a solution that makes a gate pass by WEAKENING it — no deleting/skipping",
    "tests, loosening assertions, disabling lint rules, eslint-disable, lowering thresholds, or editing the",
    "gate/lint/tsconfig config to ignore the failure. Fix the underlying CODE so the gate passes honestly.",
    "best_index: pick the solution YOU would apply (correctness first, then lowest",
    "risk) — MyCL may AUTO-APPLY it without asking the user. RANK by reversibility &",
    "cost: cheap reversible code/config edits FIRST; slow/destructive actions (deleting",
    "node_modules, full reinstall, wiping caches) LAST and only if the error output",
    "clearly points to corrupted deps. Prefer fixes MyCL can execute over manual ones.",
    "",
    VERIFY_BEFORE_CLAIM, // YZLLM 2026-06-12: kök-neden bir HİPOTEZDIR — doğrulamadan fix uygulama (yanlış-fix önle).
    "",
    DECISION_PRINCIPLES, // Parça 3: no-silent-fallback / kuşkuda-fail-closed / correct-by-construction (YZLLM gibi karar).
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
     * 2026-06-10 (YZLLM): true → askq AÇMA; ajanın best_index çözümünü auto_selected_solution
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
  // KALICI sağlayıcı-yok (kredi/yetki): analizin KENDİSİ de bir sağlayıcı ister → "tekrar analiz" hep aynı
  // hatayı verir → SONSUZ DÖNGÜ (canlı bug). Döngüyü kır: net durum mesajı + yalnız "kaydet + devam" askq'sı
  // (Çöz/Tekrar-analiz YOK). Sağlayıcı (kredi/z.ai) dönünce iş listesinden tekrar denenir.
  const failPermanent = async (provDetail: string): Promise<PendingErrorAnalysis> => {
    const id = `error_analysis_${randomUUID()}`;
    const blocking = !!errCtx.allowAcceptContinue;
    const { options } = buildErrorAnalysisAskq([], blocking, {
      allowAcceptContinue: errCtx.allowAcceptContinue,
      permanentNoProvider: true,
    });
    const optionLabels = options.map((o) => (typeof o === "string" ? o : o.label));
    emitChatMessage(
      "assistant",
      `⛔ Faz ${errCtx.phase} hata analizi YAPILAMADI: tüm sağlayıcılar tükendi (Claude kredisi/limiti + z.ai). ` +
        `Bu bir ortam sorunu, kod hatası değil — "tekrar analiz" hep aynı hatayı verir. İşi kaydedip devam et; ` +
        `kredi yükleyince ya da z.ai dönünce iş listesinden tekrar denenir.`,
    );
    emitAskq({
      id,
      question: `Faz ${errCtx.phase}: hata analizi yapılamadı (sağlayıcı tükendi). Ne yapalım?`,
      options,
    });
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: errCtx.phase,
      event: "error-analysis-no-provider",
      caller: "mycl-orchestrator",
      detail: provDetail.slice(0, 200),
    }).catch(() => {});
    return {
      id,
      phase: errCtx.phase,
      blocking,
      options: optionLabels,
      solutions_tr: [],
      acceptContinuePhase: errCtx.acceptContinuePhase,
    };
  };
  try {
    // Hata analizi ORKESTRATÖR rolüdür. Backend'e göre: cli → araştırmalı (Read/Grep/Bash);
    // api → tek-atış triage (YZLLM 2026-06-10 "bunu çözmüştük" — API modunda da çalışmalı).
    // Tek-atışta derin araştırmayı SEÇİLEN FİX downstream (Faz 0 / SDK) yapar → triage hızlı + yeterli.
    // YZLLM 2026-06-12: hata-analizi orkestratör BEYİN rolü → merdiven-dışı strong tier (Opus 4.8). Düşük
    // modelde gerçek testleri okumadan kök-neden uyduruyordu; strong + max ile sağlam akıl yürütme.
    const analysisModel = orchestratorModelId(config.selected_models);
    const useCli = backendForRole(config, "orchestrator") === "cli";
    // Proje-gerçeklerini ajana ver (YZLLM: "proje bilgisini cömertçe ver → daha iyi yanıt"; ajan JS/TS bilsin).
    const facts = await buildProjectFacts(state.project_root).catch(() => null);
    const factsSummary = facts?.summary;
    emitChatMessage("system", "🔎 Hata analiz ediliyor (orkestratör)…");
    let analysisText: string;
    if (useCli) {
      emitClaudeStream({ sub: "init", text: "cli-error-analysis", model: analysisModel, cwd: state.project_root });
      const res = await runClaudeCli({
        systemPrompt: buildErrorAnalysisPrompt(errCtx, true, factsSummary),
        userMessage: "Inspect the failure and emit the error_analysis JSON block now.",
        modelId: analysisModel,
        cwd: state.project_root,
        allowedTools: ["Read", "Grep", "Glob", "Bash"],
        disallowedTools: READ_ONLY_DISALLOWED_TOOLS, // salt-okunur hata analizi: yazma + alt-ajan yasak, Bash açık
        effort: "max", // orkestratör beyin → en yüksek efor (kabul edilen tavan: Opus 4.8 · max)
        onText: (t) => emitClaudeStream({ sub: "text", text: t }),
        observer: (tu) =>
          emitClaudeStream({ sub: "tool_use", tool_name: tu.name, tool_input: tu.input }),
        // idle-kill KAPALI (YZLLM 2026-06-18 — canlı Faz 8 derail KÖKÜ): Opus 4.8 max-efor düşünme
        // İÇERİĞİNİ varsayılan GİZLER → uzun sessiz düşünme `--include-partial-messages` ile bile
        // stdout satırı akıtmaz → sabit idle-timeout (eski 300s) meşru düşünmeyi YANLIŞ öldürüyordu
        // ("cli idle timeout 300000ms" → error-analysis fail → ana iş "düştü" → pipeline raydan çıktı,
        // kuyruktaki alt-işe saptı). Tek-atış analiz → idle yok.
        timeoutMs: 0,
        // Hang-timeout (YZLLM gate-fix #4, 2026-06-19): error-analysis bir TRIAGE — çoğu 1-3 dk'da biter.
        // 30dk default wall-clock hang için fazla uzun (canlı 44dk "model çalışıyor" donması). 15dk'ya sık:
        // derin araştırma+düşünme için bol, no-output hang'i 30→15dk'ya yarılar (idle yok, thinking ölmez).
        wallClockMs: 900_000,
      });
      if (res.usage) emitClaudeStream({ sub: "token_usage", usage: res.usage });
      if (!res.ok) {
        const et = String(res.error ?? "");
        // Kredi/yetki (kalıcı) → döngü-kıran failPermanent; aksi halde normal fail (reanalyze yardımcı olabilir).
        return isApiAccountError(et) ? await failPermanent(et) : await fail("Hata analizi yapılamadı (claude hatası).", et);
      }
      analysisText = res.text;
    } else {
      // API yolu — Anthropic SDK tek-atış (tool yok; hata mesajı + detail'den triage).
      try {
        // z.ai Aşama 2 ⑤b: Sağlayıcı=Z.AI ise hata-analizi turu GLM'e (z.ai key+endpoint) gider; claude'da AYNEN korunur.
        const { client, model } = resolveLlmClient(
          config,
          "orchestrator",
          config.api_keys.orchestrator ?? config.api_keys.main,
          analysisModel,
          { timeoutMs: 120_000 },
        );
        const response = await client.messages.create({
          model,
          max_tokens: 2048,
          system: buildErrorAnalysisPrompt(errCtx, false, factsSummary),
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
        const et = String(e);
        return isApiAccountError(et) ? await failPermanent(et) : await fail("Hata analizi yapılamadı (API hatası).", et);
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

    // 2026-06-10 (YZLLM: "kolayca çözebileceği şeyi bile soruyor — kendisi çözsün"):
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
    }).catch((e) => log.error("error-analysis", "error-analysis audit yazılamadı (denetim izi eksik)", { error: String(e) }));

    return {
      id,
      phase: errCtx.phase,
      blocking,
      options: optionLabels,
      solutions_tr: analysis.solutions_tr,
      acceptContinuePhase: errCtx.acceptContinuePhase,
    };
  } catch (err) {
    // Hiçbir koşulda ana akışı bozma — ama GÖRÜNÜR + tanılanabilir (sessiz-fallback denetimi: iç fail()
    // ile aynı seviye). log.warn→log.error + hata detayını mesaja kat + audit'e yaz (müfettiş trajectory'si görsün).
    log.error("error-analysis", "analyzeAndAskError beklenmedik hata (non-fatal)", err);
    emitChatMessage("error", `⚠️ Hata analizi beklenmedik bir nedenle yapılamadı: ${String(err).slice(0, 200)}`);
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: errCtx.phase,
      event: "error-analysis-failed",
      caller: "mycl-orchestrator",
      detail: String(err).slice(0, 200),
    }).catch(() => {});
    return null;
  }
}
