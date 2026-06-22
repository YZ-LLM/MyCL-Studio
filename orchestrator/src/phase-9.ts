// phase-9 — Risk Review (qa-askq).
//
// v15.7 (2026-05-27): Dosya header rot düzeltildi (eski "phase-10" yazıyordu).
// Phase9Controller → Phase 9 = Risk review.

import { escalatedModelEffort } from "./escalation.js";
import { readFile } from "node:fs/promises";
import { appendAudit } from "./audit.js";
import { currentSpecPath } from "./devs-paths.js";
import {
  buildRelevantPhase9Audit,
  getSpecSectionMarkdown,
} from "./relevance/injectors.js";
import type { QaAskqBackend } from "./base/qa-askq-controller.js";
import { createQaAskqBackend } from "./base/qa-askq-cli-backend.js";
import {
  collectIterationTechDebt,
  renderChangedFilesList,
  renderTechDebtFindings,
} from "./phase-9-tech-debt.js";
import { resolveCliProvider, type ToolDef } from "./claude-api.js";
import { backendForRole, resolveProvider, type MyclConfig } from "./config.js";
import { runDebateReview, DEBATE_AXES } from "./phase-9-debate-review.js";
import { emitChatMessage, emitError } from "./ipc.js";
import { log } from "./logger.js";
import { substitute } from "./template-engine.js";
import {
  buildConversationContext,
  renderConversationSection,
} from "./conversation-context.js";
import type { PhaseDeps } from "./phase-deps.js";
import type { PhaseSpec, State } from "./types.js";

const TOOL_ASK_RISK: ToolDef = {
  name: "ask_risk_decision",
  description: "Ask the user how to handle a specific risk: skip / fix / rule.",
  input_schema: {
    type: "object",
    // YZLLM 2026-06-13 ("orkestratör cevap vermedi"): suggested_answer ZORUNLU — sen incelemecisin,
    // her zaman bir öneri ver. Bu olmadan auto-answer (Oto-cevap) ASLA ateşlenmiyordu (composeQuestion
    // suggested_en=null) → her risk-kararı kullanıcıya düşüyordu. Bununla, Oto-cevap açıkken MyCL kendi yanıtlar.
    required: ["question", "options", "suggested_answer"],
    properties: {
      question: { type: "string" },
      options: {
        type: "array",
        items: { type: "string" },
        minItems: 2,
        maxItems: 4,
      },
      suggested_answer: {
        type: "string",
        description:
          "Your RECOMMENDED option — copy ONE of the `options` strings VERBATIM (must exactly match). " +
          "You are the reviewer; ALWAYS recommend. Prefer the conservative/secure choice (fix/rule); " +
          "NEVER recommend skipping an unverified risk. Auto-answer uses this so the user isn't asked.",
      },
    },
  },
};

const TOOL_COMPLETE: ToolDef = {
  name: "complete_risk_review",
  description: "Submit the risk classification summary.",
  input_schema: {
    type: "object",
    required: ["summary", "decisions"],
    properties: {
      summary: { type: "string" },
      decisions: {
        type: "array",
        items: {
          type: "object",
          required: ["risk", "decision"],
          properties: {
            risk: { type: "string" },
            decision: {
              type: "string",
              description: "skip | fix | rule",
            },
            detail: { type: "string" },
            // YZLLM 2026-06-13: "fix" kararları otomatik düzeltme fazına yönlendirilir. Domain'i SEN belirle:
            // 'ui' (Faz 5 — bileşen/sayfa/stil), 'db' (Faz 7 — şema/migration/index), 'code' (Faz 8 — backend/
            // mantık/validasyon/her şey). skip/rule için 'none'. Belirsizse 'code' (en genel codegen).
            fix_phase: {
              type: "string",
              description:
                "For 'fix' decisions, which phase applies it: 'ui' (Faz 5 UI), 'db' (Faz 7 schema/migration), " +
                "'code' (Faz 8 backend/logic — the general case). Use 'none' for skip/rule. When unsure, use 'code'.",
            },
          },
        },
      },
    },
  },
};

interface RiskDecision {
  risk: string;
  decision: string;
  detail?: string;
  /** "fix" kararının hangi fazda uygulanacağı (YZLLM 2026-06-13 risk-fix dispatch): ui|db|code|none. */
  fix_phase?: "ui" | "db" | "code" | "none";
}

export class Phase9Controller {
  private base: QaAskqBackend | null = null;
  /** Fail durumunda kullanıcıya gösterilecek mesaj için error context. */
  public lastFailReason?: string;
  public statePatch: Partial<State> = {};
  /**
   * YZLLM 2026-06-13: complete_risk_review'daki tüm risk kararları (yüzeye çıkarıldı). Orkestratör
   * (index.ts dispatchRiskFixes) "fix" kararlarını okuyup ilgili faza yönlendirir. Eskiden bu liste
   * yalnız audit'e yazılıp ATILIYORDU → risk bulunuyor ama düzeltilmiyordu (YZLLM'in gözlemi).
   */
  public riskDecisions: RiskDecision[] = [];

  private readonly state: State;
  private readonly config: MyclConfig;
  private readonly spec: PhaseSpec;
  constructor(deps: PhaseDeps) {
    this.state = deps.state;
    this.config = deps.config;
    this.spec = deps.spec;
  }

  submitAskqAnswer(askqId: string, selected_tr: string): void {
    this.base?.submitAskqAnswer(askqId, selected_tr);
  }

  abort(): void {
    this.base?.abort();
  }

  async run(): Promise<"complete" | "fail"> {
    log.info("phase-9", "run start");

    if (!this.spec.askq_config) {
      emitError("phase-10 askq_config missing", null);
      this.lastFailReason = "askq_config missing in spec";
      return "fail";
    }
    // Phase 2 sonrası gelir; defensive guard relevance injection için.
    if (!this.state.intent_summary) {
      emitError("phase-10: intent_summary missing — Phase 2 önce tamamlanmalı", null);
      this.lastFailReason = "intent_summary missing (Phase 2 incomplete)";
      return "fail";
    }

    // Context enjeksiyonu:
    //   - SPEC_RISKS: deterministic — spec'in Risks section'u olduğu gibi.
    //   - PHASE_9_AUDIT: relevance-filtered — TDD codegen event'lerinden
    //     mevcut intent'e en alakalı olanlar (eskiden last-30 capping idi).
    const [specRisks, phase9Audit, techDebt] = await Promise.all([
      getSpecSectionMarkdown(this.state.project_root, "Risks", currentSpecPath(this.state)),
      buildRelevantPhase9Audit(
        this.config,
        this.state,
        this.state.intent_summary,
      ),
      // v15.12: bu iterasyonda değişen üretim dosyalarında deterministik teknik
      // borç taraması (Faz 8 per-dosya gate'ini tamamlar; SADECE bu iterasyonun işi).
      collectIterationTechDebt(this.state),
    ]);

    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 9,
      event: "phase-9-tech-debt-scan",
      caller: "mycl-orchestrator",
      detail: `scanned=${techDebt.scannedCount} findings=${techDebt.totalFindings}${techDebt.truncated ? " (truncated)" : ""}`,
    });

    const escMe = escalatedModelEffort(this.state, this.config, "risk-review");

    // YZLLM 2026-06-13: CLI/abonelik → çok-ajanlı "bulan + çürüten" debate review (Anthropic /ultrareview
    // deseni). N uzman bulucu paralel tarar → bağımsız çürütücüler yanlış-pozitifi eler → ETKİLEŞİMSİZ
    // (onay yok) → doğrulanan bulgular decisions[] olarak risk-fix dispatch'ine akar. API modunda eski
    // tek-ajan qa-askq'ya düşer (review fan-out CLI-only açık-maddesi; görünür not).
    // ⑥ CLI/abonelik VEYA Sağlayıcı=Z.AI (main) → çok-ajanlı debate; z.ai'de tüm bulucu/çürütücü
    // claude CLI'ları z.ai endpoint'ine gider (çok-ajanlı z.ai — kullanıcı isteği). Aksi API → tek-ajan qa-askq.
    const mainProvP9 = resolveProvider(this.config, "main");
    if (backendForRole(this.config, "main") === "cli" || mainProvP9.isZai) {
      emitChatMessage(
        "system",
        `🔬 Risk incelemesi çok-ajanlı modda — ${DEBATE_AXES.length} uzman bulucu (STRIDE tehdit-modeli dahil) paralel tarıyor, sonra her bulgu bağımsız çürütücüyle doğrulanıyor (yanlış-pozitif elenir).`,
      );
      const cliP9 = resolveCliProvider(this.config, "main", escMe.modelId);
      const review = await runDebateReview(
        this.state.project_root,
        cliP9.model,
        escMe.effort,
        {
          specRisks,
          phase9Audit,
          techDebtFindings: renderTechDebtFindings(techDebt),
          changedFiles: renderChangedFilesList(techDebt),
        },
        cliP9.extraEnv,
      );
      if (!review.ok) {
        this.lastFailReason = review.reason ?? "debate review başarısız";
        emitError("phase-9 debate review failed", review.reason ?? null);
        return "fail";
      }
      const decisions: RiskDecision[] = review.findings.map((f) => ({
        risk: f.risk,
        decision: f.decision,
        detail: f.detail,
        fix_phase: f.fix_phase,
      }));
      const fixN = decisions.filter((d) => d.decision === "fix").length;
      const ruleN = decisions.filter((d) => d.decision === "rule").length;
      for (const d of decisions) {
        await appendAudit(this.state.project_root, {
          ts: Date.now(),
          phase: 9,
          event: "risk-decision",
          caller: "mycl-orchestrator",
          detail: `${d.decision}[${d.fix_phase ?? "?"}]=${d.risk.slice(0, 80)}`,
        });
      }
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 9,
        event: "phase-9-complete",
        caller: "mycl-orchestrator",
        detail: `debate: ${review.confirmedCount}/${review.rawCount} doğrulandı (${fixN} fix, ${ruleN} rule); ${review.axisOk}/${review.axisCount} eksen`,
      });
      this.riskDecisions = decisions;
      emitChatMessage(
        "system",
        `🔬 Risk incelemesi tamamlandı — ${review.axisOk}/${review.axisCount} eksen, ${review.rawCount} aday → **${review.confirmedCount} doğrulandı** (yanlış-pozitifler elendi). ${fixN} düzeltilecek, ${ruleN} kural.`,
      );
      log.info("phase-9", "debate complete", {
        confirmed: review.confirmedCount,
        raw: review.rawCount,
        axisOk: review.axisOk,
      });
      return "complete";
    }
    emitChatMessage(
      "system",
      "ℹ️ Çok-ajanlı risk incelemesi yalnız abonelik/CLI modunda; API modunda tek-ajan inceleme yapılıyor.",
    );

    let systemPrompt: string;
    try {
      const tmpl = await readFile(this.spec.prompt_template_path!, "utf-8");
      const convSection = await buildConversationContext(this.config, this.state, { recentLanguage: "en" })
        .then((c) => renderConversationSection(c, { forMainAgent: true }))
        .catch(() => "");
      systemPrompt = substitute(tmpl, {
        SPEC_RISKS: specRisks,
        PHASE_9_AUDIT: phase9Audit,
        TECH_DEBT_FINDINGS: renderTechDebtFindings(techDebt),
        TECH_DEBT_FILES: renderChangedFilesList(techDebt),
        CONVERSATION_CONTEXT: convSection,
      });
    } catch (err) {
      log.error("phase-9", "template load failed", err);
      emitError("template load failed", String(err));
      this.lastFailReason = `template load failed: ${String(err)}`;
      return "fail";
    }
    // escMe yukarıda (debate branch öncesi) hesaplandı — API yolu da onu kullanır.
    this.base = createQaAskqBackend({
      tag: "phase-9",
      state: this.state,
      config: this.config,
      systemPrompt,
      modelId: escMe.modelId,
      effortOverride: escMe.effort,
      apiKey: this.config.api_keys.main,
      initialUserMessage: "Begin Phase 9: Risk Review. Walk residual risks.",
      tools: [TOOL_ASK_RISK, TOOL_COMPLETE],
      askq: this.spec.askq_config,
    });

    const outcome = await this.base.run();
    if (outcome.kind !== "approved") {
      const o = outcome as { kind: string; reason?: string };
      this.lastFailReason =
        o.kind === "failed" ? o.reason ?? "unknown reason" : `outcome kind=${o.kind}`;
      return "fail";
    }

    // v15.10: Array.isArray guard — ajan `decisions`'ı non-array emit ederse
    // `?? []` yakalamaz, for...of çökerdi (bkz phase-2 dimensions fix).
    const rawDecs = outcome.approvalInput.decisions;
    const decisions = (Array.isArray(rawDecs) ? rawDecs : []) as RiskDecision[];
    if (rawDecs !== undefined && !Array.isArray(rawDecs)) {
      log.warn("phase-9", "decisions array değil — boş kabul edildi", { type: typeof rawDecs });
    }
    for (const d of decisions) {
      await appendAudit(this.state.project_root, {
        ts: Date.now(),
        phase: 9,
        event: "risk-decision",
        caller: "mycl-orchestrator",
        detail: `${d.decision}=${d.risk.slice(0, 80)}`,
      });
    }
    await appendAudit(this.state.project_root, {
      ts: Date.now(),
      phase: 9,
      // padding'siz "phase-9-complete" — resume-detection `phase-${n}-complete` (padding'siz) kuruyor;
      // eskiden "phase-09-complete" yazılınca eşleşmiyordu → Faz 9 boot-resume'da gereksiz tekrar koşuyordu.
      event: "phase-9-complete",
      caller: "user",
      detail: String(outcome.approvalInput.summary ?? "").slice(0, 200),
    });
    // Orkestratör risk-fix dispatch'i bu listeyi okur (fix kararlarını ilgili faza yönlendirir).
    this.riskDecisions = decisions;
    log.info("phase-9", "complete", { decisions: decisions.length });
    return "complete";
  }
}
