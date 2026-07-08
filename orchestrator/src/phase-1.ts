// phase-1 — Intent Gathering (qa-askq).
//
// Faz-spesifik mantık: TR niyetini EN'e çevir, template'e enjekte et, base
// qa-askq controller'ı çalıştır. Approval geldiğinde özet alanı state'in
// `intent_summary` alanına gider (Phase 4 input'u olur).

import { escalatedModelEffort } from "./escalation.js";
import { readFile } from "node:fs/promises";
import { appendAudit } from "./audit.js";
import type { QaAskqBackend } from "./base/qa-askq-controller.js";
import { createQaAskqBackend } from "./base/qa-askq-cli-backend.js";
import type { ToolDef } from "./claude-api.js";
import type { MyclConfig } from "./config.js";
import { log } from "./logger.js";
import { buildCodebaseSnapshot } from "./phase-1-codebase-probe.js";
import { eddGroundingForState } from "./edd/grounding.js";
import { buildRelevantProjectContext } from "./relevance/injectors.js";
import { substitute } from "./template-engine.js";
import {
  buildConversationContext,
  renderConversationSection,
} from "./conversation-context.js";
import { translate } from "./translator.js";
import { buildClarifyResumeBlock } from "./clarify-log.js";
import type { PhaseDeps } from "./phase-deps.js";
import type { PhaseSpec, State } from "./types.js";

const TOOL_ASK_CLARIFYING: ToolDef = {
  name: "ask_clarifying",
  description:
    "Ask the user a single clarifying question. Use this tool once per turn.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "Short, specific clarifying question.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description:
          "2-4 short option labels. The user picks one (or 'Other' freeform).",
        minItems: 2,
        maxItems: 4,
      },
      suggested_answer: {
        type: "string",
        description:
          "OPTIONAL but RECOMMENDED — your best guess of the most likely answer for this user, based on project context and prior intent. MUST EXACTLY MATCH one of the option labels (case-sensitive). Used to highlight a suggested choice in the UI. Omit only if all options are truly equally likely.",
      },
    },
    required: ["question", "options"],
  },
};

const TOOL_APPROVE_INTENT: ToolDef = {
  name: "request_intent_approval",
  description:
    "Once all critical ambiguities are resolved, summarize the intent (3-5 sentences) and ask the user to approve.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Concise intent summary (3-5 sentences).",
      },
    },
    required: ["summary"],
  },
};

export class Phase1Controller {
  private base: QaAskqBackend | null = null;
  /** Approve sırasında modelin verdiği niyet özeti (EN) — Phase 4 input olur. */
  public approvedSummary: string | null = null;
  /** Fail durumunda kullanıcıya gösterilecek mesaj için error context. */
  public lastFailReason?: string;

  private readonly state: State;
  private readonly config: MyclConfig;
  private readonly spec: PhaseSpec;
  private readonly isolatedIntent: boolean;
  constructor(deps: PhaseDeps) {
    this.state = deps.state;
    this.config = deps.config;
    this.spec = deps.spec;
    this.isolatedIntent = deps.isolatedIntent ?? false;
  }

  submitAskqAnswer(askqId: string, selected_tr: string): void {
    this.base?.submitAskqAnswer(askqId, selected_tr);
  }

  abort(): void {
    this.base?.abort();
  }

  async run(user_intent_tr: string): Promise<"complete" | "fail"> {
    log.info("phase-1", "run start", { intent_len: user_intent_tr.length });

    if (!this.spec.askq_config) {
      log.error("phase-1", "askq_config missing in spec");
      // FROZEN-GOAL #8: emitError + failPhase = çift bildirim. lastFailReason'a yaz → failPhase TEK mesajla yüzeye çıkarır.
      this.lastFailReason = "Faz 1: askq_config eksik (spec hatası).";
      return "fail";
    }

    let intent_en: string;
    try {
      const tr = await translate(this.config, user_intent_tr, "tr-to-en");
      intent_en = tr.text;
      log.info("phase-1", "intent translated", { out_len: intent_en.length });
    } catch (err) {
      log.error("phase-1", "translator failed (intent)", err);
      this.lastFailReason = `Faz 1: niyet çevirisi başarısız — ${String(err).slice(0, 150)}`;
      return "fail";
    }

    // Phase 1 relevance: proje bağlamı (spec/brief/audit/abandoned/patterns/git)
    // intent_en'e göre filtrelenip prompt'a enjekte edilir. Yeni iterasyonda
    // Claude TodoMaster'ın **mevcut özelliklerini** görür → "yeni uygulama mı?"
    // gibi bağlamsız sorular sormaz. Yeni proje (chunks=0) → sentinel.
    // Fail-safe: relevance call fail → engine emitError + boş array; injector
    // sentinel döner; faz çökmez.
    const projectContext = await buildRelevantProjectContext(
      this.config,
      this.state,
      intent_en,
    );

    // v15.7 (2026-05-26): Konuşma bağlamı — son 3 user mesajı + opsiyonel
    // özet. Ana ajan kullanıcı niyetini tek "USER_INTENT" değil tüm konuşma
    // akışıyla görür. Cache'li (process-local), fail-safe.
    // İzolasyon (YZLLM 2026-06-15): iş-listesinden gelen TEK iş işlenirken konuşma
    // geçmişini KATMA — yoksa geçmişteki birleşik "iki sorun var" mesajından öteki
    // işi çekip iki işi tek niyette birleştiriyor. İş metni zaten kendi başına yeterli.
    let convSection = "";
    if (!this.isolatedIntent) {
      try {
        const conv = await buildConversationContext(this.config, this.state, { recentLanguage: "en" });
        convSection = renderConversationSection(conv, { forMainAgent: true });
      } catch (err) {
        log.warn("phase-1", "conversation context fetch failed", err);
      }
    }

    // v15.7 (2026-05-27): Deterministik kodbase snapshot (top-level dirs, src tree, deps, routes) prompt'a enjekte
    // edilir → ana ajan yapıyı ARAŞTIRMADAN önünde bulur, "frontend mi backend mi eksik?" gibi yanıtı zaten kodda olan
    // soruları sormaz, WHAT-user-wants'a odaklanır. (Not: qa-askq CLI backend'i 2026-06-13'ten beri Read/Grep/Glob'lu —
    // snapshot artık "araştıramıyor" için değil, keşfi ATLATIP anında zemin verdiği için değerli.)
    const codebaseSnapshot = await buildCodebaseSnapshot(this.state.project_root);
    // EDD (foreign, Faz 3): mevcut davranışın kompakt zemini → niyet ajanı var olan davranıştan HABERDAR olur (iş-listesi
    // dışı/mevcut davranışa dokunan istekte daha yerinde netleştirme). İnline özet + (Read'li CLI backend için) edd-analysis.md
    // pointer — grounding koşullu üretir. MyCL kökeninde "" (no-op). Best-effort, bloke etmez.
    const eddOverview = (await eddGroundingForState(this.state)) ?? "";

    let systemPrompt: string;
    try {
      const tmpl = await readFile(this.spec.prompt_template_path!, "utf-8");
      systemPrompt = substitute(tmpl, {
        USER_INTENT: intent_en,
        PROJECT_CONTEXT_DIGEST: projectContext,
        CONVERSATION_CONTEXT: convSection,
        CODEBASE_SNAPSHOT: codebaseSnapshot + eddOverview,
      });
    } catch (err) {
      log.error("phase-1", "template load failed", err);
      this.lastFailReason = `Faz 1: şablon yüklenemedi — ${String(err).slice(0, 150)}`;
      return "fail";
    }
    // Escalation (YZLLM 2026-06-11): model+efor merdivenden (escalation_rung set ise); değilse eski config[role].
    const escMe = escalatedModelEffort(this.state, this.config, "intent");
    // YZLLM 2026-07-03: yarım iterasyon kapat-aç → bu iterasyonda ZATEN yanıtlanan netleştirme Q&A'sını enjekte et
    // (clarify-log). Ajan aynı soruları TEKRAR sormaz, cevapları kullanıp devam eder. Boşsa "" → değişmez (geriye uyumlu).
    const clarifyResume = await buildClarifyResumeBlock(this.state.project_root, this.state.iteration_count ?? 1);
    this.base = createQaAskqBackend({
      tag: "phase-1",
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: escMe.modelId,
      effortOverride: escMe.effort,
      apiKey: this.config.api_keys.main,
      initialUserMessage: "Begin Phase 1 intent clarification now." + clarifyResume,
      tools: [TOOL_ASK_CLARIFYING, TOOL_APPROVE_INTENT],
      askq: this.spec.askq_config,
    });

    const outcome = await this.base.run();

    if (outcome.kind === "approved") {
      const summary = String(outcome.approvalInput.summary ?? "").trim();
      // FROZEN-GOAL #7: boş özet = geçersiz onay. Eski kod yine 'complete' dönüp intent_summary=null ile
      // ilerliyordu → sonraki TÜM fazlar anlamsız çıktı üretiyordu (sessiz-bad-proceed). Boşsa fail → escalate.
      if (!summary) {
        this.lastFailReason = "Faz 1: niyet özeti boş — onay geçersiz (özet alanı doldurulmalı)";
        return "fail";
      }
      this.approvedSummary = summary;
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 1,
        event: "phase-1-intent-approve",
        caller: "user",
        detail: summary.slice(0, 200),
      });
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 1,
        event: "phase-1-complete",
        caller: "mycl-orchestrator",
      });
      log.info("phase-1", "approved");
      return "complete";
    }
    if (outcome.kind === "cancelled") {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 1,
        event: "phase-1-intent-cancel",
        caller: "user",
      });
      log.info("phase-1", "user cancelled");
      this.lastFailReason = "user cancelled";
      return "fail";
    }
    if (outcome.kind === "aborted") {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 1,
        event: "phase-1-aborted",
        caller: "user",
      });
      log.info("phase-1", "aborted");
      this.lastFailReason = "aborted";
      return "fail";
    }
    if (outcome.kind === "abandoned") {
      // Phase 1 abandon_tool_name set etmediği için bu kola düşmemeli;
      // defensive log + fail (silent ignore yok — YZLLM kuralı).
      log.warn("phase-1", "unexpected abandoned outcome");
      this.lastFailReason = "unexpected abandoned outcome";
      return "fail";
    }
    if (outcome.kind === "ui_tweak") {
      // Phase 1 tweak_tool_name set etmediği için bu kola düşmemeli; defensive.
      log.warn("phase-1", "unexpected ui_tweak outcome");
      this.lastFailReason = "unexpected ui_tweak outcome";
      return "fail";
    }
    if (outcome.kind === "ac_failure") {
      // Phase 1 failure_tool_name set etmediği için bu kola düşmemeli; defensive.
      log.warn("phase-1", "unexpected ac_failure outcome");
      this.lastFailReason = "unexpected ac_failure outcome";
      return "fail";
    }
    log.warn("phase-1", "failed", { reason: outcome.reason });
    this.lastFailReason = outcome.reason;
    return "fail";
  }
}
