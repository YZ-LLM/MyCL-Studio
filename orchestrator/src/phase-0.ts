// phase-0 — Debug Triage (multi-stage state machine D1 → D2 → D3).
//
// Akış (Ümit 2026-05-21):
//   D1: Claude Read/Grep/Bash ile araştırır → `report_root_cause` tool ile
//       root cause + 2-4 çözüm seçeneği döner → orchestrator EN→TR çevirir →
//       chat'e "🔍 Tespit" yazar + askq emit eder (Vazgeç dahil).
//   D2: kullanıcı askq'dan seçer → answerAskq → index.ts continueWithSelection
//       çağırır. "Vazgeç" → abort.
//   D3: seçilen plan ile yeni codegen tour (Edit/Write/Bash) → `report_fix_done`
//       tool ile bitirir → dev server restart (P6 pattern reuse) → tarayıcı aç.
//
// Phase 0 standalone — iteration_count + current_phase korunur. D2_WAITING
// state'inde Phase 0 "askıya alınmış" sayılır; phase event'i complete YAPMAZ.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { appendAudit, formatDecisions, readDecisions } from "./audit.js";
import { extractKindBlock } from "./cli-json.js";
import { runClaudeCli } from "./cli-run.js";
import { createCodegenBackend, type CodegenBackend } from "./codegen/backend.js";
import { isClaudeAvailable } from "./codegen/cli-backend.js";
import { runPreD1UiProbe } from "./phase-0-ui-probe.js";
import { runTurn, type ToolDef } from "./claude-api.js";
import { runHypothesisFanout } from "./design-fanout.js";
import { backendForRole, type MyclConfig } from "./config.js";
import { ensureErrorCatalog } from "./errors-db.js";
import { buildReverseImportGraph, getAffected } from "./fix/dep-graph/index.js";
import { buildFixEvidence, extractFilePaths } from "./fix/evidence.js";
import { clearHistory } from "./history.js";
// v15.7 (2026-05-26): runtime-error-watcher / vite-runtime-injector /
// dev-server-launcher / command handler import'ları kaldırıldı — Phase 0 D3
// silinince bu helper'lar bu modülde gereksiz. Faz 5 (UI tweak mode) ve
// command handler kendi modüllerinde reuse ediyor.
import {
  emitAskq,
  emitChatMessage,
  emitClaudeStream,
  emitError,
  emitPhaseChanged,
  emitPhaseIdle,
  emitPhaseRunning,
} from "./ipc.js";
import { MAIN_AGENT_LANGUAGE_RULE } from "./agent-language.js";
import { log } from "./logger.js";
import { buildRelevantProjectContext } from "./relevance/injectors.js";
import { substitute } from "./template-engine.js";
import { TOOLS_CODEGEN, type ToolContext } from "./tool-handlers.js";
import { translate } from "./translator.js";
import type { PhaseDeps } from "./phase-deps.js";
import type { PhaseSpec, State } from "./types.js";

export type FixPlanKind =
  | "ui-only"
  | "backend-only"
  | "full-stack"
  | "new-iteration";

const FIX_PLAN_KINDS: ReadonlyArray<FixPlanKind> = [
  "ui-only",
  "backend-only",
  "full-stack",
  "new-iteration",
];

function isFixPlanKind(v: unknown): v is FixPlanKind {
  return (
    typeof v === "string" && FIX_PLAN_KINDS.includes(v as FixPlanKind)
  );
}

interface FixOptionRaw {
  label_en: string;
  description_en: string;
  plan_summary_en: string;
  plan_kind: FixPlanKind;
}

/**
 * D1 tool: Claude araştırmayı bitirince root cause + 2-4 fix önerisi döner.
 */
export const TOOL_REPORT_ROOT_CAUSE: ToolDef = {
  name: "report_root_cause",
  description:
    "Conclude D1 (investigation) by reporting the root cause and 2-4 fix options. Call EXACTLY ONCE after thorough investigation with Read/Grep/Bash. Auto-apply was removed (v15.7) — orchestrator ALWAYS opens askq for user confirmation. Therefore: ALWAYS provide 2-4 fix_options with real trade-offs. confidence='high' = you are sure all options are safe; 'uncertain' = user judgment really matters. Never return 1 option — that creates a useless askq.",
  input_schema: {
    type: "object",
    required: ["root_cause_en", "confidence", "fix_options"],
    properties: {
      root_cause_en: {
        type: "string",
        description:
          "Short plain-language root cause for non-engineers. 1-2 sentences, ideally under 150 chars. File/line refs go in plan_summary_en, not here.",
        maxLength: 400,
      },
      confidence: {
        type: "string",
        enum: ["high", "uncertain"],
        description:
          "'high' = you are sure all options would safely fix the bug; 'uncertain' = user judgment matters between meaningful trade-offs. Note: v15.7 auto-apply REMOVED — orchestrator always opens askq, so confidence is just metadata for the user. Always provide 2-4 options regardless.",
      },
      fix_options: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: {
          type: "object",
          required: [
            "label_en",
            "description_en",
            "plan_summary_en",
            "plan_kind",
          ],
          properties: {
            label_en: { type: "string", maxLength: 60 },
            description_en: { type: "string", maxLength: 300 },
            plan_summary_en: { type: "string", maxLength: 800 },
            plan_kind: {
              type: "string",
              enum: ["ui-only", "backend-only", "full-stack", "new-iteration"],
              description:
                "Routing classification of this fix plan. 'ui-only' = only frontend files (component/page/css). 'backend-only' = only API/DB/server files. 'full-stack' = both UI + backend touched. 'new-iteration' = scope so large it's effectively a new feature (orchestrator restarts pipeline from Phase 1). YOU classify this — the orchestrator does NOT second-guess.",
            },
          },
        },
      },
    },
  },
};

// v15.7 (2026-05-26): TOOL_REPORT_FIX_DONE + runD3 + restartDevServer kaldırıldı.
// YENİ MİMARİ (Yorum B): Phase 0 sadece teşhis (D1) + plan sunma (D2). Kullanıcı
// plan seçince orkestratör Faz 5'ten itibaren pipeline tetikler (Faz 5 tweak
// mode ile fix uygulanır). Phase 0 D3 codegen + dev server restart logic
// silindi — kullanıcı kuralı: "her faz sadece kendi görevini yapsın".

export type Phase0Outcome =
  | {
      kind: "d1_root_cause";
      rootCauseTR: string;
      options: Array<{ label: string; description: string; planSummary: string }>;
    }
  | { kind: "failed"; reason: string }
  | { kind: "aborted" };

export class Phase0Controller {
  public statePatch: Partial<State> = {};
  public lastOutcome: Phase0Outcome | null = null;
  private base: CodegenBackend | null = null;

  private readonly state: State;
  private readonly config: MyclConfig;
  private readonly spec: PhaseSpec;
  private readonly bugReport: string;
  constructor(deps: PhaseDeps & { bugReport: string }) {
    this.state = deps.state;
    this.config = deps.config;
    this.spec = deps.spec;
    this.bugReport = deps.bugReport;
  }

  abort(): void {
    this.base?.abort();
  }

  /**
   * D1 — araştırma + rapor + askq emit. Bittikten sonra Phase 0 controller
   * "askıya alınır" (D2_WAITING); kullanıcı askq'yu cevaplayınca index.ts
   * `continueWithSelection`'a köprü eder.
   */
  async run(_text: string): Promise<"complete" | "fail"> {
    log.info("phase-0", "D1 start", { bug_len: this.bugReport.length });
    const previousPhase = this.state.current_phase;
    emitPhaseChanged(previousPhase, 0, "running");
    emitPhaseRunning("🔍 Hata araştırılıyor", "Phase 0 D1");
    try {
      return await this.runD1();
    } finally {
      emitPhaseIdle();
      // D2_WAITING durumunda phase event'i complete YAPMA — askq açık, Phase 0
      // hala "aktif". continueWithSelection'da kapatılacak.
      const stillWaiting =
        this.statePatch.pending_diagnostic?.phase === "D2_WAITING";
      if (!stillWaiting) {
        emitPhaseChanged(0, previousPhase, "complete");
      }
    }
  }

  private async runD1(): Promise<"complete" | "fail"> {
    // Yeni bug raporu = fresh D1 sessiyonu. Önceki Phase 0 turn'lerinden
    // kalan mesaj history'sini sil — aksi takdirde CodegenBaseController
    // diskten yüklüyor ve içinde tool_use sonrası tool_result eksik
    // olduğunda Anthropic API isteği reddediyor ("messages.X: tool_use
    // ids were found without tool_result blocks").
    try {
      await clearHistory(this.state.project_root, 0);
    } catch (err) {
      log.warn("phase-0", "clearHistory failed (non-fatal)", err);
    }
    // Eski projeler (pipeline güncellemelerinden önce üretilmiş) error_folder
    // yoksa otomatik kur. Idempotent — varsa dokunulmaz.
    const ensured = await ensureErrorCatalog(this.state.project_root);
    if (ensured.created) {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 0,
        event: "error-catalog-ensured",
        caller: "mycl-orchestrator",
        detail: ensured.dbPath,
      });
      emitChatMessage(
        "system",
        "🗂 Hata kataloğu yeni oluşturuldu (`error_folder/errors.db`). Mevcut çalışmalardan hata kaydı yok — şu anki rapora dayanılarak araştırılıyor.",
        { persist: false },
      );
    }

    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 0,
      event: "debug-d1-start",
      caller: "user",
      detail: this.bugReport.slice(0, 200),
    });

    // v15.7 (2026-05-26): Ana ajan saf İngilizce dünyada çalışır. Kullanıcı
    // raporu TR olabilir → translator ile EN'e çevir. Audit'te orijinal TR
    // korunur (kullanıcı görür). Translate fail → orijinali kullan (fail-safe,
    // EN içerikse zaten verbatim döner — bkz. translator.ts isLikelyTurkish).
    let bugReportEn = this.bugReport;
    try {
      const tr = await translate(this.config, this.bugReport, "tr-to-en");
      bugReportEn = tr.text;
    } catch (err) {
      log.warn("phase-0", "bug report translation failed", err);
    }

    let projectCtx = "(no prior project context)";
    try {
      projectCtx = await buildRelevantProjectContext(
        this.config,
        this.state,
        bugReportEn,
      );
    } catch (err) {
      log.warn("phase-0", "context fetch failed", err);
    }

    // ADR tüketimi: geçmiş kararları (son 5) debug ajanına ver — "şu neden böyle
    // yapılmıştı"ı bilsin (decisions.jsonl, Brief/Spec/DB fazlarınca yazılır).
    let pastDecisions = "(no prior decisions recorded)";
    try {
      pastDecisions = formatDecisions((await readDecisions(this.state.project_root)).slice(-5));
    } catch (err) {
      log.warn("phase-0", "decisions read failed (non-blocking)", err);
    }

    let systemPrompt: string;
    try {
      const tmpl = await readFile(this.spec.prompt_template_path!, "utf-8");
      systemPrompt = substitute(tmpl, {
        PROJECT_ROOT: this.state.project_root,
        USER_BUG_REPORT: bugReportEn,
        PROJECT_CONTEXT: projectCtx,
        PAST_DECISIONS: pastDecisions,
      });
    } catch (err) {
      log.error("phase-0", "template load failed", err);
      emitError("template load failed", String(err));
      return "fail";
    }

    // v15.7 (2026-05-27): Pre-D1 Playwright probe — deterministik gate.
    // LLM'e bırakmak yerine kod tarafında karar: UI keyword + dev server alive
    // + Playwright kurulu → probe ÇALIŞIR, çıktı D1 initial message'a inject.
    // Skip durumları silent (chat'e mesaj YOK, audit'e bilgi event).
    const probeOutput = await runPreD1UiProbe(
      this.state.project_root,
      this.bugReport,
      this.state.stack,
    );

    // v15.9: D1'e DETERMİNİSTİK kanıt besle (errors.db + git blame + son
    // commit penceresi). LLM yok; model tahmin etmesin, kanıta atıfla
    // yorumlasın. Fail-safe — kanıt yoksa boş string (probe gibi koşullu eklenir).
    let evidenceBlock = "";
    try {
      evidenceBlock = await buildFixEvidence({
        projectRoot: this.state.project_root,
        dbPath: ensured.dbPath,
        extraText: `${bugReportEn}\n${probeOutput ?? ""}`,
      });
    } catch (err) {
      log.warn("phase-0", "fix evidence build failed (non-fatal)", err);
    }
    // Probe çıktısı + kanıt bloğu tek bir context ek'ine birleşir; D1 user
    // message'ına (SDK ve CLI yolları) eklenir.
    const contextSuffix = [probeOutput, evidenceBlock]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n\n");

    // v15.13 (debug fan-out): agent_teams_optin açıksa D1'den ÖNCE çok-perspektifli kök-neden
    // hipotezleri üret (state/async/integration; saf-akıl-yürütme, kanıt üzerine — Bash YOK) →
    // D1 araştırmasına rehber (tünel-görüşünü önler). Başarısız/azsa sessizce atla; D1 yine normal
    // koşar (regresyon yok). Tam paralel-İNCELEME (Bash'li, gerçek Workflow tool) ileride.
    let contextWithHypotheses = contextSuffix;
    if (this.config.claude_code_flags.agent_teams_optin) {
      try {
        const hyps = await runHypothesisFanout(
          this.config,
          this.state.project_root,
          bugReportEn,
          contextSuffix,
        );
        if (hyps.length >= 2) {
          emitChatMessage(
            "system",
            `🔬 ${hyps.length} kök-neden hipotezi (çok-perspektifli) üretildi → D1 araştırmasına rehber.`,
          );
          const block =
            "## Candidate root-cause hypotheses (multi-perspective — confirm or refute each during investigation)\n" +
            hyps.map((h, i) => `${i + 1}. ${h}`).join("\n");
          contextWithHypotheses = contextSuffix ? `${contextSuffix}\n\n${block}` : block;
          await appendAudit(this.state.project_root, {
            ts: Date.now(),
            phase: 0,
            event: "debug-hypotheses-generated",
            caller: "mycl-orchestrator",
            detail: `count=${hyps.length}`,
          });
        }
      } catch (err) {
        log.warn("phase-0", "hypothesis fan-out failed (non-fatal)", err);
      }
    }

    const role = this.spec.model_role!;
    const toolCtx: ToolContext = {
      project_root: this.state.project_root,
      extra_denied_paths: this.spec.denied_paths,
    };
    const tools: ToolDef[] = [
      ...(TOOLS_CODEGEN as unknown as ToolDef[]),
      TOOL_REPORT_ROOT_CAUSE,
    ];

    // v15.8: main='Claude Code Aboneliği' → D1'i CLI ile koş. report_root_cause
    // custom tool'u `claude -p`'de yok → text-JSON {kind:"root_cause"} ile sonuçlandır.
    // D1 dosya yazmaz (sadece Read/Grep/Bash araştırma) → single-shot runClaudeCli.
    const wantCli = backendForRole(this.config, "main") === "cli";
    if (wantCli && !isClaudeAvailable()) {
      const m =
        "Main 'Claude Code Aboneliği' (CLI) seçili ama `claude` bulunamadı — " +
        "Faz 0 (Hata Ayıklama) çalıştırılamadı. API'ye SESSİZCE DÜŞÜLMEDİ. " +
        "`claude` kur ya da Ayarlar → Modeller'den main'i 'API' yap.";
      emitError("phase-0: claude bulunamadı (CLI)", m);
      emitChatMessage("system", `🔴 ${m}`);
      this.lastOutcome = { kind: "failed", reason: "claude not found (CLI backend)" };
      return "fail";
    }

    let reportTool: { name: string; input: Record<string, unknown> } | null = null;
    if (wantCli) {
      reportTool = await this.runD1Cli(
        systemPrompt,
        (this.config.selected_models[role] ?? this.config.selected_models.main) as string,
        contextWithHypotheses,
      );
    } else {
    this.base = createCodegenBackend({
      tag: "phase-0-d1",
      phaseId: 0,
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: this.config.selected_models[role],
      apiKey: this.config.api_keys.main,
      initialUserMessage:
        "D1 — Investigation phase. Use Read/Grep/Bash to find the root cause. When ready, call `report_root_cause` with root_cause_en + 2-4 fix_options. Do NOT call any other tool to conclude." +
        (contextWithHypotheses ? `\n\n${contextWithHypotheses}` : ""),
      tools,
      allowed_tool_names: [
        ...(this.spec.allowed_tools ?? []),
        "report_root_cause",
      ],
      toolContext: toolCtx,
      betas: this.config.claude_code_flags.betas,
      // v15.8 (2026-05-30): Maliyet optimizasyonu — D1 sınırsız keşfe daldı
      // (88 turn, lsof/ps/netstat tangentleri). Cerrahi araştırma: 10. turn'de
      // "sonuçlan" nudge, 18'de hard cap (force-report devreye girer).
      softTurnBudget: 10,
      budgetNudge:
        "⚠ INVESTIGATION BUDGET: You have used 10 steps. STOP exploring now and call `report_root_cause` with your CURRENT findings. Do not run more commands — name the most likely root cause from what you already know.",
      maxTurns: 18,
      observer: async (ctx) => {
        if (ctx.result.is_error) return;
        if (ctx.tool_use.name === "report_root_cause") {
          reportTool = {
            name: "report_root_cause",
            input: ctx.tool_use.input as Record<string, unknown>,
          };
        }
      },
    });

    const outcome = await this.base.run();
    if (outcome.kind === "aborted") {
      this.lastOutcome = { kind: "aborted" };
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 0,
        event: "debug-d1-aborted",
        caller: "user",
      });
      return "fail";
    }
    if (outcome.kind === "failed") {
      this.lastOutcome = { kind: "failed", reason: outcome.reason };
      return "fail";
    }

    } // else — SDK (createCodegenBackend) yolu

    let finalTool = reportTool as
      | { name: string; input: Record<string, unknown> }
      | null;

    // Son şans tek-atış: codegen loop Claude tool yerine end_turn'le bittiyse,
    // yeni runTurn'de `tool_choice: { type: "tool" }` ZORLAMA ile bir kez daha
    // dene. Önceki araştırma context'i Claude'da yok ama bug raporu + project
    // context system prompt'ta hala mevcut → "best guess" rapor üretilir;
    // boşa harcanan token'ları telafi eder.
    if (!finalTool && !wantCli) {
      log.warn("phase-0", "no tool call after codegen loop — force retry");
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 0,
        event: "debug-d1-force-retry-start",
        caller: "mycl-orchestrator",
      });
      emitChatMessage(
        "system",
        "⏳ Claude tool çağrısı atlattı — son atış zorlanıyor (ekstra ~2-3sn)…",
      );
      try {
        const forceResult = await runTurn(
          this.config,
          this.config.api_keys.main,
          {
            messages: [
              {
                role: "user",
                content:
                  "You completed investigation but ended with plain text instead of the required tool call. NOW call `report_root_cause` with ALL required fields:\n- `root_cause_en`: 1-2 sentences\n- `confidence`: \"high\" or \"uncertain\"\n- `fix_options`: ALWAYS 2-4 options (v15.7: auto-apply removed, user always picks)\n- Each option needs `plan_kind`: \"ui-only\" / \"backend-only\" / \"full-stack\" / \"new-iteration\"\nOmitting any required field will fail. This is your ONLY remaining action.",
              },
            ],
            system: systemPrompt,
            model: this.config.selected_models[role],
            tools: [TOOL_REPORT_ROOT_CAUSE],
            tool_choice: {
              type: "tool",
              name: "report_root_cause",
            },
            max_tokens: 2048,
          },
          () => {},
        );
        const forced = forceResult.toolUses.find(
          (t) => t.name === "report_root_cause",
        );
        if (forced) {
          finalTool = {
            name: forced.name,
            input: forced.input as Record<string, unknown>,
          };
          log.info("phase-0", "force retry succeeded");
          await appendAudit(this.state.project_root, {
            ts: Date.now(),
            phase: 0,
            event: "debug-d1-force-retry-success",
            caller: "mycl-orchestrator",
          });
        }
      } catch (err) {
        log.warn("phase-0", "force retry failed", err);
      }
    }

    if (!finalTool) {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 0,
        event: "debug-d1-force-retry-fail",
        caller: "mycl-orchestrator",
      });
      emitChatMessage(
        "error",
        "❌ D1 araştırması tamamlandı ama Claude `report_root_cause` çağırmadı (force retry da başarısız). Tekrar deneyebilirsin.",
      );
      this.lastOutcome = { kind: "failed", reason: "no_root_cause_report" };
      return "fail";
    }

    const data = finalTool.input;
    const rootCauseEn = String(data.root_cause_en ?? "");
    const confidence =
      String(data.confidence ?? "uncertain") === "high"
        ? ("high" as const)
        : ("uncertain" as const);
    const fixOptionsRaw = Array.isArray(data.fix_options)
      ? (data.fix_options as FixOptionRaw[])
      : [];
    if (rootCauseEn.length === 0 || fixOptionsRaw.length === 0) {
      emitChatMessage("error", "❌ D1 raporu eksik.");
      this.lastOutcome = { kind: "failed", reason: "empty_report" };
      return "fail";
    }

    // EN→TR çevirisi — paralel (Promise.allSettled). Sıralı yapılırsa
    // 1 + 2N (N=4) = 9 sıralı translator call ≈ 10-20sn. Paralelde ~2-3sn.
    // allSettled: tek bir translate fail ederse pipeline duralmaz; o alan
    // EN olarak kalır (kullanıcıya kısmi TR görünür, kabul edilebilir).
    const translateOrFallback = async (
      en: string,
    ): Promise<string> => {
      try {
        const r = await translate(this.config, en, "en-to-tr");
        return r.text;
      } catch (err) {
        log.warn("phase-0", "translate fail; using EN fallback", err);
        return en;
      }
    };
    const allTranslations = await Promise.all([
      translateOrFallback(rootCauseEn),
      ...fixOptionsRaw.flatMap((opt) => [
        translateOrFallback(opt.label_en),
        translateOrFallback(opt.description_en),
      ]),
    ]);
    const rootCauseTR = allTranslations[0];
    const optionsTR: Array<{
      label: string;
      description: string;
      planSummary: string;
      planKind: FixPlanKind;
    }> = [];
    for (let i = 0; i < fixOptionsRaw.length; i++) {
      const labelTR = allTranslations[1 + i * 2];
      const descTR = allTranslations[2 + i * 2];
      // plan_kind tool schema'da required + enum kısıtı; yine de defensive.
      // Invalid/eksik → "full-stack" defaults (en güvenli — yeni iterasyona
      // benzer kapsamlı işlem, kullanıcı veriyi kaybetmez).
      const rawKind = fixOptionsRaw[i].plan_kind;
      const planKind: FixPlanKind = isFixPlanKind(rawKind) ? rawKind : "full-stack";
      if (!isFixPlanKind(rawKind)) {
        log.warn("phase-0", "plan_kind missing or invalid; defaulting to full-stack", {
          option_index: i,
          got: rawKind,
        });
      }
      optionsTR.push({
        label: labelTR,
        description: descTR,
        planSummary: fixOptionsRaw[i].plan_summary_en,
        planKind,
      });
    }

    emitChatMessage("system", `🔍 **Tespit**\n\n${rootCauseTR}`);

    // D2 BLAST-RADIUS (Ümit: "kök nedene dokunulursa başka nereler etkilenir").
    // DETERMİNİSTİK bağımlılık grafiğinden — model üretmez. Seed: kök neden +
    // plan özetleri + kanıttaki şüpheli dosyalar. Grafik kurulamazsa (analyzer
    // yok / dosya yok) sessizce atlanır (kaba plan_kind fallback).
    let affected: Array<{ module: string; why: string; risk: "high" | "medium" | "low" }> = [];
    try {
      const graph = await buildReverseImportGraph(this.state.project_root);
      if (graph.available) {
        const seedText = `${rootCauseEn}\n${fixOptionsRaw
          .map((o) => o.plan_summary_en)
          .join("\n")}\n${contextSuffix}`;
        const seeds = extractFilePaths(seedText).map((p) =>
          isAbsolute(p) ? p : join(this.state.project_root, p),
        );
        affected = getAffected(graph, seeds, 2, this.state.project_root);
      }
    } catch (err) {
      log.warn("phase-0", "blast-radius hesaplanamadı (non-fatal)", err);
    }
    if (affected.length > 0) {
      const top = affected
        .slice(0, 8)
        .map((a) => `- ${a.module} — **${a.risk}** (${a.why})`)
        .join("\n");
      emitChatMessage(
        "system",
        `📊 **Etki alanı** (deterministik — bu kök nedene dokunmak şunları etkiler):\n${top}`,
      );
    }

    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 0,
      event: "debug-d1-complete",
      caller: "mycl-orchestrator",
      detail: `confidence=${confidence} options=${optionsTR.length} affected=${affected.length}`,
    });

    // v15.7 (2026-05-26): Auto-apply path KALDIRILDI. Yeni mimari: Phase 0
    // sadece teşhis + plan sunma. Uygulama Faz 5'in işi (orkestratör
    // tetikler). High-confidence single option olsa bile askq açılır;
    // kullanıcı her zaman onay verir. Bu hem tutarlı UX hem Phase 0 boundary
    // disiplini (kullanıcı kuralı: "her faz sadece kendi görevini yapsın").

    // Her durumda askq aç.
    const askqId = randomUUID();
    const askqOptions = [...optionsTR.map((o) => o.label), "Vazgeç"];
    emitAskq({
      id: askqId,
      question: "Hangi çözümü uygulayalım?",
      options: askqOptions,
      allow_other: false,
    });

    this.statePatch = {
      pending_diagnostic: {
        phase: "D2_WAITING",
        askq_id: askqId,
        rootCauseTR,
        options: optionsTR,
        affected,
        ts: Date.now(),
      },
    };
    this.lastOutcome = {
      kind: "d1_root_cause",
      rootCauseTR,
      options: optionsTR,
    };
    return "complete";
  }

  /**
   * D1'i CLI (abonelik) ile koş — tek-atış araştırma + text-JSON root_cause.
   * report_root_cause custom tool'u `claude -p`'de yok → {kind:"root_cause",...}
   * bloğu parse edilir (alanlar TOOL_REPORT_ROOT_CAUSE şemasıyla aynı). Bulunamazsa
   * görünür hata + null döner (caller fail eder; API force-retry YOK — abonelik).
   */
  private async runD1Cli(
    systemPrompt: string,
    modelId: string,
    contextSuffix: string,
  ): Promise<{ name: string; input: Record<string, unknown> } | null> {
    const schema = JSON.stringify(TOOL_REPORT_ROOT_CAUSE.input_schema);
    const sys = `${systemPrompt}

---

## ÇIKTI FORMATI — CLI modu (tool YOK, text-JSON)
\`report_root_cause\` TOOL'U YOKTUR. Read/Grep/Bash ile araştır (DOSYAYA YAZMA), sonra
CEVABININ TAMAMI tek bir JSON bloğu olsun (blok DIŞINDA düz metin YAZMA): {"kind":"root_cause", ...}.
Alanlar AYNEN şu şemaya uy (kind hariç): ${schema}`;
    emitClaudeStream({ sub: "init", text: "cli-phase-0-d1", model: modelId, cwd: this.state.project_root });
    const res = await runClaudeCli({
      systemPrompt: sys + MAIN_AGENT_LANGUAGE_RULE,
      userMessage:
        'D1 — investigate with Read/Grep/Bash, then conclude by emitting the {"kind":"root_cause",...} JSON block (root_cause_en + 2-4 fix_options).' +
        (contextSuffix ? `\n\n${contextSuffix}` : ""),
      modelId,
      cwd: this.state.project_root,
      allowedTools: ["Read", "Grep", "Glob", "Bash"],
      disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
      effort: this.config.claude_code_flags.effort,
      onText: (text) => emitClaudeStream({ sub: "text", text }),
      // tool_use aktivitesini yüzeye çıkar (D1 araştırması Read/Grep/Bash yoğun).
      observer: (tu) => emitClaudeStream({ sub: "tool_use", tool_name: tu.name, tool_input: tu.input }),
    });
    if (res.usage) emitClaudeStream({ sub: "token_usage", usage: res.usage });
    if (!res.ok) {
      emitChatMessage("error", `❌ Faz 0 D1 (CLI) başarısız: ${res.error ?? "bilinmeyen"}`);
      return null;
    }
    const block = extractKindBlock(res.text, ["root_cause"]);
    if (!block) {
      emitChatMessage("error", "❌ Faz 0 D1 (CLI): `root_cause` JSON bloğu üretilmedi.");
      return null;
    }
    const input: Record<string, unknown> = { ...block };
    delete input.kind;
    return { name: "report_root_cause", input };
  }
}
