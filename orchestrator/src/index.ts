// MyCL v14 orchestrator entry.
//
// Tauri shell bu process'i spawn eder. stdin'den NDJSON komutlar gelir,
// stdout'a NDJSON event'ler yazılır. Bu modül komut yönlendiricisi ve
// session sahibi.

import { App, type IncomingCommand } from "./app.js";
import { IpcRouter } from "./ipc-router.js";
import {
  ApiKeyMissingError,
  ModelSelectionMissingError,
  loadConfig,
  persistApiKeys,
  hasUsableKeysAfterMerge,
  persistAgentBackends,
  persistFeatures,
  persistSelectedModels,
  persistDeclinedModelUpgrade,
  readAgentBackends,
  readClaudeCodeFlags,
  readFeatures,
  readSelectedModels,
  orchestratorModelId,
  type AgentBackends,
  type ApiKeys,
  type ClaudeCodeFlags,
  type SelectedModels,
} from "./config.js";
import { loadOrInit, save as saveState } from "./state.js";
import { ensurePendingIterationDir, currentSpecPath } from "./devs-paths.js";
import {
  runBehaviorConsentGate,
  resolveConsentAnswer,
  isConsentAskqId,
} from "./behavior-consent-gate.js";
import {
  runForeignWriteConsentGate,
  resolveForeignWriteConsent,
  isForeignWriteConsentAskqId,
  seedFilesFromText,
  describeTouchedForFiles,
} from "./foreign-write-consent.js";
import { extractFilePaths } from "./fix/evidence.js";
import { finalizeDevsArtifacts } from "./devs-finalize.js";
import { refreshDevsSpecs } from "./devs-spec-refresh.js";
import { clearHistory } from "./history.js";
import { appendAbandonedIntent } from "./abandoned-intents.js";
import {
  appendAudit as appendAuditModule,
  appendCost,
  appendAcceptedFinding,
  readCosts,
  readAuditLog,
  readAuditLogTail,
  wasPipelineCompleted,
} from "./audit.js";
import { computeVerdict, eventsSince, type HarnessVerdict } from "./harness-verdict.js";
import { classifyOpenedFolder, hasDeliverable, buildCodebaseSnapshot } from "./phase-1-codebase-probe.js";
import { buildPipelineEndLines } from "./pipeline-end-summary.js";
import {
  detectInterruptedPhase2To9Pure,
  decideBootQueueAction,
} from "./resume-detection.js";
import { clearClarifyLog } from "./clarify-log.js";
import { SerialWorkQueue } from "./serial-queue.js";
import {
  runDast,
  findingToTaskText,
  severityToPriority,
  dedupeFindingsByTemplate,
  toolInstalled,
  type DastSummary,
} from "./dast-runner.js";
import { decidePhase17 } from "./phase-17-decision.js";
import { runDependencyAudit, dependencyAuditLine } from "./dependency-audit.js";
import { runSemgrepScans, sastLine } from "./sast-scan.js";
import { ensureSecurityTools } from "./tool-ensure.js";
import { setRecordContext } from "./record-context.js";
import {
  appendTask,
  readTasks,
  removeTask,
  patchTask,
  nextPendingTask,
  taskStatus,
} from "./task-queue/store.js";
import { intakeAndEnqueue } from "./task-queue/intake.js";
import { MAX_TASK_AUTO_RETRIES, type TaskQueueItem } from "./task-queue/types.js";
import { textSimilarity } from "./task-queue/intake.js";
import {
  decideSystemTask,
  systemTaskKey,
  buildDeferredErrorTaskText,
  type DedupAction,
  type SystemTaskKind,
} from "./task-queue/system-task.js";
import {
  shouldPreserveIterationState,
  decideIterationStart,
  resumeWasStale,
} from "./resume-decision.js";
import { decideTaskCompletion } from "./task-completion.js";
import { WRITE_EVENTS } from "./fix/scope.js";
import {
  beginPhaseCost,
  clearActiveAskq,
  emit,
  emitAskq,
  emitAskqResolved,
  emitChatMessage,
  emitDirectiveReply,
  emitError,
  emitIterationIntent,
  emitPhaseChanged,
  emitNeededPhases,
  emitPhaseRunning,
  emitPhaseIdle,
  isPhaseIndicatorActive,
  emitTechDoc,
  getActiveAskq,
  setHistoryRoot,
  takePhaseCost,
  setAutonomousAskqHook,
  setChatModelIds,
  type ActiveAskqSnapshot,
} from "./ipc.js";
import {
  appendHistory,
  loadMessages as loadHistoryMessages,
} from "./history-loader.js";
import {
  analyzeAndAskError,
  type ErrorContext,
  OPT_ACCEPT_CONTINUE,
  OPT_ACCEPT_PERMANENT,
  OPT_STOP_MANUAL,
  OPT_QUEUE,
  OPT_REANALYZE,
  type PendingErrorAnalysis,
  emitBlockingFindingAskq,
  askqOffersAcceptOverride,
} from "./error-analysis.js";
import {
  type FindingQueue,
  findingKey,
  perFindingSig,
  advanceDecision,
  findingQueueAutoApply,
} from "./finding-queue.js";
import {
  recallAnswer,
  recordAnswer,
  markReuseApproved,
  classifyAnswer,
  REUSE_YES,
  REUSE_NO,
  type AnswerMemoryRecord,
} from "./answer-memory.js";
import { listModels } from "./models.js";
import {
  auditConfiguredModels,
  computeTiersFromModels,
  modelChoiceLineIfChanged,
  resetModelChoiceCache,
} from "./model-catalog.js";
import { predictPipelineCost } from "./cost-forecast.js";
import { getLastTechDebtFindings, acceptedFindingKey, resetLastTechDebtFindings } from "./tech-debt-scanner.js";
import { sumSecurityFindings, stepSecurityConvergence } from "./security-convergence.js";
import { runQualityAudit, DEFAULT_QUALITY_QUESTIONS } from "./quality-audit.js";
import { runRegressionGuard } from "./regression-guard.js";
import { isApiAccountError, isEnvironmentError, environmentErrorAdvice, isTimeoutHangOnly } from "./claude-api.js";
import { decideTimeoutDivert, runTimeoutMultiAngle, TIMEOUT_DIVERT_MAX } from "./timeout-diagnosis.js";
import { isClaudeAvailable } from "./codegen/cli-backend.js";
import { discoverModelsViaWeb, verifyModelCallable } from "./model-discovery.js";
import { ensureAgentSkills } from "./skills-setup.js";
import { ensureCodebaseMemoryMcp } from "./codebase-memory-setup.js";
import { ensureCognee } from "./cognee-setup.js";
import { runGateAutofix } from "./gate-autofix.js";
import { inspectGateFinding, mahkemeRuling, inspectClarify, recordMahkemeLesson, INSPECTOR_MODEL_DEFAULT, type MahkemeAction, type MahkemeRuling } from "./inspector.js";
import { Phase0Controller } from "./phase-0.js";
import { snapshotPrototype } from "./prototype-cache.js";
import { runPhaseContributionReport } from "./phase-contribution.js";
import { runLayerCostReport } from "./layer-cost-report.js";
import { specSignalMatches } from "./mechanical-skip-signal.js";
import { extractStockedModules } from "./module-stock.js";
import { generateGuideShots } from "./guide-shots.js";
import { promoteVisualBaseline } from "./visual-regression.js";
import {
  setRuntimeHttpTarget,
  startRuntimeHttpServer,
  stopRuntimeHttpServer,
} from "./runtime-http-server.js";
import { detachActiveWatcher, setPentestActive } from "./runtime-error-watcher.js";
import { Phase1Controller } from "./phase-1.js";
import { Phase2Controller } from "./phase-2.js";
import { Phase3Controller } from "./phase-3.js";
import { Phase4Controller } from "./phase-4.js";
import { resolveRiskFixTarget } from "./risk-fix-routing.js";
import { runParallelRiskFixes, type CodeFix } from "./risk-fix-parallel.js";
import { Phase5Controller } from "./phase-5.js";
import { Phase6Controller } from "./phase-6.js";
import { ensureDevServerForReview } from "./smoke-test.js";
import { runFullTest, formatFullTestReport, fixTasksFromReport, type FullTestDeps } from "./full-test.js";
import { runMaintenance, formatMaintenanceReport } from "./maintenance.js";
import {
  formatPlanTR,
  generatePlan,
  isPlanMode,
  persistPlan,
  setPlanMode,
  type PlanProposal,
} from "./plan-mode.js";
import { Phase7Controller } from "./phase-7.js";
import { Phase8Controller } from "./phase-8.js";
import { Phase9Controller } from "./phase-9.js";
import { getSpec, PHASE_SPECS, PHASE_TRANSITIONS } from "./phase-registry.js";
import type { DispatchOutcome, IntentKind } from "./intent-router/types.js";
import { respondAsOrchestrator } from "./orchestrator-agent/respond.js";
import { getAgentACL, phaseIdToAgentId } from "./agent-acl.js";
import type { AgentDecision, MemoryProposal } from "./orchestrator-agent/decision.js";
import {
  appendProjectMemory,
  appendGeneralMemory,
  appendAgentDecisionLog,
} from "./agent-memory/store.js";
import { randomUUID } from "node:crypto";
import { detectStack, handleCommandIntent } from "./intent-router/handlers/command.js";
import { createCheckpoint } from "./git.js";
import { snapshotBeforeAutofix, takeRollback, restoreSnapshot, disarmRollback } from "./fix-snapshot.js";
import { armLlmOutageWait, cancelLlmOutageWait, isLlmOutageWaiting, type OutageResumeResult } from "./llm-outage.js";
import { translate } from "./translator.js";
import { runChatSummary } from "./chat-summary.js";
import { shouldKickQueue, startLivenessWatchdog } from "./liveness-watchdog.js";
import { detectCliRateLimit, isCliUsageLimitError } from "./cli-rate-limit.js";
import { setSandboxPolicy } from "./agent-sandbox.js";
import { setCacheTtl } from "./codegen/cli-backend.js";
import { autoAnswerSuggested, autoAnswerPick, isAutoAnswerEnabled, setAutoAnswerSuggested, setIntegrateModeSuppression, setNeverAsk, isNeverAsk, isAutonomouslyAnswerableAskq, isCourtFirstAskqId, matchAnswerToOption, stripDestructiveOptions, pickConservativeDefault, shouldStopAutoAnswer } from "./auto-answer.js";
import { advisorStatusMessage } from "./advisor.js";
import { runContextTrimDoctor } from "./context-trim-doctor.js";
import { bootstrapLivingDocs, refreshDocsIfStale } from "./living-docs.js";
import { globalConfigDir } from "./paths.js";
import { appendUserDirective, buildDirectiveEvalPrompt, parseDirectiveVerdict } from "./user-directives.js";
import { pruneOldLogs } from "./log-retention.js";
import { getCachedProjectMap, clearProjectMapCache } from "./onboarding/project-map.js";
import { runOnboarding, onboardingSucceeded } from "./onboarding/onboard-existing.js";
import { maybeRunEdd } from "./edd/engine.js";
import { readEddProgress, summarizeProgress } from "./edd/progress.js";
import { composeOpenStatus, formatOpenStatus, type OpenStatusInput } from "./open-status.js";
import { attachEddCodegenNote } from "./edd/codegen-note.js";
import { runMultiAgentSelection } from "./module-parallel/select.js";
import { reviewMergedModules, formatReview } from "./module-parallel/review.js";
import { runParallelModules } from "./module-parallel/dispatch.js";
import { makeScopedCodegenWorker } from "./module-parallel/worker.js";
import { candidatesToModules, judgeBatch, MAX_BATCH } from "./task-batch.js";
import { isGitRepo, isWorkingTreeClean, getChangedFiles, ensureLocalGitRepo } from "./git.js";
import { realAppGateDecision, buildRealAppVerifyMarker, decideFullDevelopGate } from "./realapp-gate-signal.js";
import { setAgentTraceRoot } from "./agent-trace.js";
import { buildTouchpointSummary } from "./fix/touch-map.js";
import { formatBlastRadius } from "./fix/dep-graph/index.js";
import { MechanicalRunnerBase, isNotApplicableSkip, isToolInstallableSkip } from "./base/mechanical-runner.js";
import {
  computeChangedScope,
  shouldComputeScope,
  SCOPED_SKIP_PHASES,
} from "./fix/scope.js";
import {
  assessPhase16Verification,
  ensureAuthTemplate,
  ensurePlaywrightInstalled,
  ensurePlaywrightScaffold,
} from "./playwright-setup.js";
import { verifyFeatureHandler, runRealAppBugGate, verifyIntentAgainstApp, type RealAppGateOutcome } from "./verify-feature.js";
import {
  blindspotLensDecision,
  decisionIsConsequential,
} from "./pre-commit-lens-gate.js";
import { runBlindspotLens, formatLensFindings, type LensResult } from "./pre-commit-lens.js";
import { setPaused } from "./pause.js";
import { loadProfile } from "./profile-loader.js";
import { isProcessAlive } from "./process-utils.js";
import { stopActiveDevServer } from "./dev-server-launcher.js";
import { loadI18n, t } from "./i18n.js";
import { log } from "./logger.js";
import { readFile as fsReadFile, stat as fsStat, readdir as fsReaddir } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import type { CostRecord, PhaseId, PhaseSpec, PhaseStatus, State } from "./types.js";
import type { MyclConfig } from "./config.js";

/**
 * Phase 6 → Phase 5 UI tweak mini-loop'unun maksimum iter sayısı. Aşıldığında
 * orchestrator warning emit eder ve Phase 7'e zorla geçer. Daha fazla tweak
 * isteyen kullanıcı yeni iterasyon başlatır.
 */
// MAX_UI_TWEAKS — Phase 6 AC bridge kaldırıldığı için (deferred mod) artık
// kullanılmıyor. Revise loop'una limit lazımsa router/phase7 handler'da set.

// IncomingCommand v15.1 Core'da app.ts'ye taşındı (DI signature için).

// v15.1.1: Module-global mutable state'ler `runtime` struct'a taşındı.
// Tek bir nokta → multi-session geçişi (v15.2.x), test mock'lanması ve
// constructor injection refactor için ön koşul. AnyPhaseController forward
// declaration ile ileride aşağıda tanımlanan tipe `runtime.controller`
// ile bağlanır.
interface OrchestratorRuntime {
  state: State | null;
  config: MyclConfig | null;
  controller: AnyPhaseController | null;
  // v15.7 (2026-05-25): pendingIntent kaldırıldı — classifier confirm askq
  // akışı yok artık (agent direkt karar veriyor).
  pendingPhaseRun: {
    askqId: string;
    phaseId: PhaseId;
  } | null;
  // v15.6: Agent decision confirmation flow — chat'e doğal teyit + askq
  // sonrası user "Evet" derse executeDispatchedIntent çağrılır.
  pendingAgentDecision: {
    askqId: string;
    decision: AgentDecision;
    text: string;
  } | null;
  // v15.6: Memory save proposal pending — agent save_memory_proposal seçtiğinde
  // user "Projeye özel / Genel / Her İkisi / Hayır" cevabı bekleniyor.
  pendingMemoryProposal: {
    askqId: string;
    proposal: MemoryProposal;
    topic_slug: string;
    user_text: string;
    decision_action: string;
  } | null;
  // v15.6 (2026-05-24): Faz 3 sonrası iterasyon scope onayı bekleniyor.
  // LLM brief.md'de needed_optional_phases önerdi → kullanıcıya "Önerilen seti
  // onayla / Tüm fazları çalıştır / Vazgeç" askq emit edildi. Cevap geldiğinde
  // state.needed_phases set + autoAdvanceFrom(3) çağrılır.
  pendingPhaseScope: {
    askqId: string;
    proposed: number[];
    // YZLLM 2026-07-03 (cevap-hatırlama): true → kayıtlı kapsam cevabının YENİDEN uygulanması (Kademe 2/3);
    // cevap dalı bunu answer-memory'ye TEKRAR kaydetmez (reuseApproved'ı sıfırlamasın).
    fromRecall?: boolean;
  } | null;
  // F1 (2026-06-04): Faz-fail sonrası LLM hata analizi askq'ı bekleniyor.
  // failPhase → analyzeAndAskError askq emit etti; cevap geldiğinde
  // handleAskqAnswer bu kaydı id ile eşleyip "Çöz" / "İş listesine kaydet" /
  // "Tekrar analiz et" dalını işler. null → açık analiz-askq'ı yok.
  pendingErrorAnalysis: PendingErrorAnalysis | null;
  // YZLLM 2026-07-03 (teker teker sor): bir gate-fail birden çok DISTINCT finding bulduğunda kurulan
  // bulgu-kuyruğu — her finding sırayla sorulur (sor→çöz→sonraki), kuyruk bitince gate bir kez yeniden koşar.
  // null → tek-finding (bugünkü davranış) veya kuyruk yok. pendingErrorAnalysis MEVCUT finding'i temsil eder.
  findingQueue: FindingQueue | null;
  // WP4 DAST (2026-06-04): 🛡️ buton emitAskq onay kartı açtı; "Başlat"/"İptal"
  // cevabı bekleniyor. null → açık DAST onay-askq'ı yok. handleAskqAnswer KATI
  // eşleşmeyle (askqId === id && selected === Başlat) işler; tarama yalnız buradan
  // tetiklenir (tek çağrı-noktası → onay-baypası imkânsız).
  pendingDast: { askqId: string } | null;
  /** 🧪 Full Test onayı bekliyor (2026-07-16) — DAST deseni: askq onaysız koşum imkânsız. */
  pendingFullTest: { askqId: string } | null;
  /** 🧪 Full Test KOŞARKEN iptal denetleyicisi (2026-07-22) — faz controller'ından AYRI (Full Test lock
   *  tutmaz; cancel_full_test IPC concurrent çalışıp bunu abort eder). Koşum-dışı null. */
  fullTestAbort: AbortController | null;
  /** 🔧 Bakım Turu onayı bekliyor (2026-07-16) — aynı desen (bağımlılık YAZAR → onay şart). */
  pendingMaintenance: { askqId: string } | null;
  /** 🗺️ Plan onayı bekliyor (2026-07-16) — plan_approve_* korumalı askq + plan gövdesi. */
  pendingPlan: { askqId: string; plan: PlanProposal } | null;
  /** 🗺️ Plan revizyonu bekliyor — sonraki kullanıcı mesajı geri bildirim olarak işlenir. */
  pendingPlanEdit: { plan: PlanProposal } | null;
  /** ⚡ Aktif paralel iş kümesi (2026-07-16) — currentTaskId'den AYRI slot; asla ikisi birden set olmaz.
   *  Birleşik pipeline (9→17) koşarken iş kimlikleri + iş-başına entegre dosyalar (teslimat kanıtı). */
  currentBatch: { taskIds: string[]; filesByTask: Record<string, string[]> } | null;
  // İş kuyruğu (YZLLM 2026-06-14): şu an Faz 1'den işlenen kuyruk işinin id'si.
  // pipeline-end bunu "done"+tarih ile damgalar + sıradaki bekleyen işi başlatır.
  // null → kuyruk-dışı iterasyon (örn. resume) ya da çalışan iş yok.
  currentTaskId: string | null;
  // YZLLM 2026-06-26: ŞU AN işlenen Faz 1 niyet metni. iter=1'de audit'te `iteration-N-start` YOK
  // (detectInterruptedPhase1 null döner) → Faz 1'i PÜRÜZSÜZ tekrar koşabilmek için canlı niyeti
  // burada tut (taze proje senaryosu = bildirilen bug). null → Faz 1 aktif değil.
  lastPhase1Intent: string | null;
  // YZLLM 2026-07-03 (cevap-hatırlama merdiveni): Kademe 2 "aynı cevabı kullanayım mı?" onayı bekleniyor.
  // apply/fresh closure'ları aile-bağımsız yeniden-uygulama/taze-akış yollarını taşır (bellekte; persist YOK).
  // null → açık reuse-onay askq'ı yok. handleAskqAnswer id ile eşler.
  pendingAnswerReuse: {
    id: string;
    key: string;
    rec: AnswerMemoryRecord;
    apply: () => Promise<void>;
    fresh: () => Promise<void>;
  } | null;
}

const runtime: OrchestratorRuntime = {
  state: null,
  config: null,
  controller: null,
  pendingPhaseRun: null,
  pendingAgentDecision: null,
  pendingMemoryProposal: null,
  pendingPhaseScope: null,
  pendingErrorAnalysis: null,
  findingQueue: null,
  pendingDast: null,
  pendingFullTest: null,
  fullTestAbort: null,
  pendingMaintenance: null,
  pendingPlan: null,
  pendingPlanEdit: null,
  currentBatch: null,
  currentTaskId: null,
  lastPhase1Intent: null,
  pendingAnswerReuse: null,
};

// WP4 DAST: onay-askq seçenek etiketi + "çalışıyor" banner etiketi. handleAskqAnswer
// taramayı YALNIZ selected === DAST_START_LABEL iken çalıştırır (kesin string eşleşme).
const DAST_START_LABEL = "🛡️ Başlat";
const DAST_RUNNING_LABEL = "🛡️ Güvenlik Taraması (DAST)";
const FULL_TEST_START_LABEL = "🧪 Başlat";
const FULL_TEST_RUNNING_LABEL = "🧪 Full Test";
const MAINTENANCE_START_LABEL = "🔧 Başlat";

/**
 * Full Test İŞLEVSEL DOĞRULAMA deps'i (2026-07-22) — her belgelenmiş özelliği çalışan app'te gerçek E2E ile
 * doğrulayan seam. snapshot + authConfigured BİR KEZ (lazy, promise-cache) hesaplanıp N özellik arası paylaşılır
 * (maliyet). Dev-server + Playwright scaffold'unu runFullTest'in ensureE2E'si kurar (verifyIntentAgainstApp hazır
 * varsayar). Full Test askq VE bakım turu AYNI helper'ı kullanır → tek kaynak. Seam beklenmedik istisna verirse
 * cannot_run("error") → verdict'i düşürMEZ (verifyDocumentedFeatures "kanıtlanamadı" sayar).
 */
function makeFunctionalVerifyDeps(
  st: State,
  ac: AbortController,
  runningLabel: string,
): Pick<FullTestDeps, "signal" | "onProgress" | "verifyIntent"> {
  let snapshotP: Promise<string> | null = null;
  let authP: Promise<boolean> | null = null;
  return {
    signal: ac.signal,
    // Banner LABEL'ı sabit tutulur (akışa göre: Full Test veya Bakım) — yalnız detay "i/N: özellik" değişir.
    // Yoksa bakım turunda banner Full Test'e kayıp maintenanceRunning'i düşürür (buton koşarken re-enable → regresyon).
    onProgress: (m: string) => emitPhaseRunning(runningLabel, m),
    verifyIntent: async (intentEn, opts): Promise<RealAppGateOutcome> => {
      if (!runtime.config) return { outcome: "cannot_run", reason: "error" };
      try {
        snapshotP ??= buildCodebaseSnapshot(st.project_root);
        authP ??= assessPhase16Verification(st.project_root).then((v) => v.authStatus === "configured");
        const [snapshot, authConfigured] = await Promise.all([snapshotP, authP]);
        const r = await verifyIntentAgainstApp(intentEn, {
          state: st,
          config: runtime.config,
          snapshot,
          authConfigured,
          slugPrefix: "verify",
          signal: opts?.signal ?? ac.signal,
        });
        return r.result;
      } catch (err) {
        log.warn("full-test", "işlevsel doğrulama seam istisna verdi — cannot_run(error)", { error: String(err) });
        return { outcome: "cannot_run", reason: "error" };
      }
    },
  };
}
const MAINTENANCE_RUNNING_LABEL = "🔧 Bakım Turu";

/**
 * TEST-ONLY seam (v15.8): runtime.state/config'i set eder + history root bağlar,
 * handleOpenProject'in boot/agent yan etkilerini ATLAYARAK. Yalnızca
 * pipeline-e2e integration testi `advanceToNextPhase(0)`'ı sürebilsin diye.
 * Production akışı bunu ÇAĞIRMAZ (IPC handler'ları handleOpenProject kullanır).
 */
export function __initRuntimeForTest(state: State, config: MyclConfig): void {
  runtime.state = state;
  runtime.config = config;
  runtime.controller = null;
  runtime.pendingPhaseScope = null;
  runtime.pendingErrorAnalysis = null;
  runtime.findingQueue = null;
  runtime.pendingDast = null;
  runtime.pendingFullTest = null;
  runtime.pendingMaintenance = null;
  runtime.pendingPlan = null;
  runtime.pendingPlanEdit = null;
  runtime.currentBatch = null;
  runtime.pendingAnswerReuse = null;
  setHistoryRoot(state.project_root);
  setAgentTraceRoot(state.project_root);
  setRecordContext({ phase: state.current_phase ?? 0 });
}

/**
 * TEST-ONLY seam (F1, 2026-06-04): handleAskqAnswer'ın error-analysis branch'ini
 * sürebilmek için runtime.pendingErrorAnalysis'i set/oku. Production akışı bunu
 * ÇAĞIRMAZ (failPhase üretir, handleAskqAnswer tüketir).
 */
export function __setPendingErrorAnalysisForTest(p: PendingErrorAnalysis | null): void {
  runtime.pendingErrorAnalysis = p;
}
export function __getPendingErrorAnalysisForTest(): PendingErrorAnalysis | null {
  return runtime.pendingErrorAnalysis;
}
export function __setFindingQueueForTest(q: FindingQueue | null): void {
  runtime.findingQueue = q;
}
export function __getFindingQueueForTest(): FindingQueue | null {
  return runtime.findingQueue;
}

/**
 * YZLLM 2026-07-03 (teker teker sor): kuyruktaki MEVCUT finding'i sor — emitBlockingFindingAskq ile mesaj+askq
 * emit et, per-finding sig (answer-memory izolasyonu) ile pendingErrorAnalysis kur. Auto modda emitBlockingFindingAskq
 * auto_selected_solution set eder + askq açmaz (dispatch'i çağıran yapar).
 */
function emitQueuedFinding(queue: FindingQueue): PendingErrorAnalysis {
  const finding = queue.findings[queue.index];
  const key = findingKey(finding, queue.index);
  const pending = emitBlockingFindingAskq(finding, {
    phase: queue.phase,
    sig: perFindingSig(queue.sig_base, key),
    acceptContinuePhase: queue.acceptContinuePhase,
    // Faz 13 GÜVENLİK kuyruğu: entegre opt-in — oto-cevap AÇIK + bu tur YAKINSIYOR (queue.converging → döngü koruması
    // TÜM bulgulara tutarlı) ise emin fix'i otomatik uygula (emitBlockingFindingAskq best-çözüm kapısı = güven). Diğer
    // kuyruklar eski davranış (kategori-bastırmalı). Mahkeme blocker fix: converging kontrolü finding[1+]'e de uygulanır.
    auto: findingQueueAutoApply(queue, {
      autoAnswerEnabled: isAutoAnswerEnabled(),
      autoAnswerSuggested: autoAnswerSuggested(),
    }),
  });
  pending.findings = queue.findings; // izlenebilirlik — kuyruk asıl doğruluk kaynağı (index/awaitingRerun)
  runtime.pendingErrorAnalysis = pending;
  return pending;
}

/**
 * ENTEGRE (foreign) opt-in "ajan eminse otomatik düzelt": bir güvenlik düzeltmesi OTOMATİK uygulanmadan önce, fix'in
 * EDD'den dokunacağı BELGELENMİŞ mevcut davranışı GÖSTER (onay DEĞİL — bilgilendirme; kullanıcı neyin değiştiğini görsün,
 * behavior-baseline zaten regresyon bayrağı taşır). Non-foreign / code_ref yok / belgelenmiş dokunulan yok → sessiz.
 */
async function emitSecurityFixImpact(pending: PendingErrorAnalysis): Promise<void> {
  const st = runtime.state;
  const cfg = runtime.config;
  if (!st || !cfg || st.origin !== "foreign") return;
  const file = pending.code_ref?.file;
  if (!file) return;
  // light: güvenlik-fix kuyruğu birçok bulguyu tek tek işler → her impact'te import-grafiği kurma (kaynak koruması).
  const msg = await describeTouchedForFiles(st, cfg, [file], { light: true }).catch(() => undefined);
  if (msg) emitChatMessage("system", msg);
}

/**
 * HİÇBİR ŞEY SORMA + FOREIGN GÖSTER katmanı (YZLLM 2026-07-09 "foreign'de göster+oto-uygula"): var olan yabancı kodu
 * DEĞİŞTİREN bir oto-fix (gate-autofix / failPhase-fix / debug-fix — hedef dosyaları önceden bilinmeyen yollar)
 * uygulanmadan önce "yabancı kod değişiyor" farkındalığını GÖRÜNÜR kılar (sormadan ama göstererek). Dosya-bilen yollar
 * (Faz 13 emin-fix / risk-fix) ayrıca describeTouchedForFiles ile dokunulan mevcut davranışı gösterir. Yalnız
 * foreign + hiçbir şey sorma modunda konuşur; aksi no-op (byte-aynı).
 */
function emitForeignAutoFixNotice(context: string): void {
  if (isNeverAsk() && runtime.state?.origin === "foreign") {
    emitChatMessage(
      "system",
      `🔐 Entegre mod (hiçbir şey sorma): ${context} — var olan yabancı kodda değişiklik SORULMADAN uygulanıyor; ` +
        "yapılan değişiklikler sohbette/diff'te görünür kalır.",
    );
  }
}

/**
 * YZLLM 2026-07-03: mevcut finding fix'lendikten SONRA kuyruğu ilerlet. Sonraki finding varsa onu sor (auto ise
 * dispatch et → intercept bir sonrakine ilerletir), yoksa kuyruğu temizle → çağıran gate'i BİR kez yeniden koşar
 * (final doğrulama). Faz 13 intercept'i (next===13 + awaitingRerun) bunu çağırır.
 */
async function advanceFindingQueue(): Promise<"asked" | "exhausted"> {
  const queue = runtime.findingQueue;
  if (!queue) return "exhausted";
  const decision = advanceDecision(queue);
  queue.index++;
  queue.awaitingRerun = false;
  if (decision === "exhausted") {
    runtime.findingQueue = null;
    return "exhausted";
  }
  const pending = emitQueuedFinding(queue);
  // Auto modda sonraki finding de otomatik çözülür (askq açılmadı) → dispatch et; concrete-solution dalı
  // awaitingRerun'ı tekrar set eder → intercept bir sonrakine ilerletir (tam otonom teker teker).
  if (pending.auto_selected_solution) {
    await emitSecurityFixImpact(pending); // entegre opt-in: uygulamadan önce dokunulan davranışı göster (foreign)
    await handleAskqAnswer(pending.id, pending.auto_selected_solution).catch((e: unknown) =>
      log.error("orchestrator", "finding-queue auto-solve routing failed", e),
    );
  } else if (autoAnswerSuggested()) {
    // GÜVENLİK AĞI (mahkeme, YZLLM 2026-07-03): oto-modda bu finding için çözüm ÜRETİLEMEDİ (solutions_tr boş →
    // emitBlockingFindingAskq GERÇEK askq açtı). finding[0] yolundakiyle SİMETRİK: headless'te askq'da asılı
    // kalma YOK → OTOMATİK "kabul et + devam" (bulgu rapora/audit'e yazıldı, YUTULMADI — KATI #4/frozen-goal).
    // HİÇBİR ŞEY SORMA (YZLLM 2026-07-09): foreign'de de accept-continue GÖRÜNÜR (aşağıda emitChatMessage) — "hiç sorma"
    // + çözülemeyen güvenlik bulgusu bastırılmadan kaydedilip devam edilir ("göster+devam"; kör-kabul değil, LOUD).
    emitChatMessage(
      "error",
      `🔴 Faz 13: bir güvenlik sorunu otomatik çözülemedi — bulgu yutulmadı; "kabul et + devam" ile ilerliyorum (elle düzeltme istenmez).`,
    );
    await handleAskqAnswer(pending.id, OPT_ACCEPT_CONTINUE).catch((e: unknown) =>
      log.error("orchestrator", "finding-queue auto-accept-continue failed", e),
    );
  }
  return "asked";
}

// v15.7 (2026-05-25): INTENT_TR_LABEL kaldırıldı (classifier confirm askq yok).
type AnyPhaseController =
  | Phase1Controller
  | Phase2Controller
  | Phase3Controller
  | Phase4Controller
  | Phase5Controller
  | Phase6Controller
  | Phase7Controller
  | Phase8Controller
  | Phase9Controller;
// activeController v15.1.1'de runtime.controller olarak taşındı.

/**
 * Faz controller'ı çalıştır + `runtime.controller`'ı GARANTİLİ temizle (try/finally).
 * KÖK FİX (kod-analiz 2026-06-07): `runtime.controller = pX; const r = await pX.run();
 * runtime.controller = null` deseni, `pX.run()` throw ederse (SDK timeout / ağ kopması)
 * null atamasını ATLIYOR → sistem bundan sonra her şeyi "faz zaten çalışıyor" diye reddedip
 * KALICI KİLİTLENİYORDU. finally throw'da da controller'ı bırakır. `runPhaseOnce` zaten
 * bu deseni içeriyordu; yeni faz siteleri de bu helper'ı kullanmalı (regresyonu önler).
 */
async function runController<T>(
  controller: AnyPhaseController,
  fn: () => Promise<T>,
  runningLabel?: string,
): Promise<T> {
  runtime.controller = controller;
  // YZLLM: "çalışırken ne yaptığını söylesin her zaman." Faz controller'ı çalıştığı SÜRECE
  // sticky banner (⏳ + ne yaptığı). try/finally ile zorunlu kapanış (takılı spinner yok).
  // askq'da fn() döner → finally → idle (bekleme ≠ çalışma). Sonraki turda tekrar açılır.
  // emitPhaseRunning/Idle = sticky banner + 30sn heartbeat (uzun işte "şu anki adım" bildirimi).
  if (runningLabel) emitPhaseRunning(runningLabel);
  try {
    return await fn();
  } finally {
    runtime.controller = null;
    if (runningLabel) emitPhaseIdle();
  }
}

let _shuttingDown = false;
/**
 * Tek temizlik noktası: TÜM çıkış yolları (SIGTERM/SIGINT/stdin-close/shutdown-IPC) bunu çağırır.
 * KÖK FİX (kod-analiz 2026-06-07): eskiden exit yolları doğrudan `process.exit(0)` idi →
 * `detached:true` dev-server (5173) + runtime HTTP listener + error-watcher arkada ZOMBİ kalıp
 * sonraki oturumda port çakıştırıyordu. Idempotent (çoklu sinyal güvenli); cleanup'lar fail-safe.
 */
function gracefulShutdown(reason: string): never {
  if (!_shuttingDown) {
    _shuttingDown = true;
    log.info("orchestrator", "graceful shutdown", { reason });
    try {
      if (runtime.state) stopActiveDevServer(runtime.state);
    } catch (e) {
      log.warn("orchestrator", "shutdown: dev-server stop failed", e);
    }
    try {
      stopRuntimeHttpServer();
    } catch (e) {
      log.warn("orchestrator", "shutdown: http server stop failed", e);
    }
    try {
      detachActiveWatcher();
    } catch (e) {
      log.warn("orchestrator", "shutdown: watcher detach failed", e);
    }
  }
  process.exit(0);
}

/**
 * Faz N başarısız olduğunda UI'ya gösterilen mesaj. Controller `lastFailReason`
 * field'ı doluysa kategori-bazlı deterministik mesaj (overloaded / rate_limit /
 * auth / generic). Yoksa kullanıcı talebi (2026-05-23) "yoğun olup olmadığını
 * bilmiyor mu?" — guess yapmak yerine açık fallback ver.
 */
interface FailReasonHolder {
  lastFailReason?: string;
  // YZLLM 2026-06-12: fail model+efor tırmanmasıyla düzelebilir mi? false → tırmanma (climb) BOŞA (örn. saf
  // AC-etiketleme/kapsama: kod doğru, model gücü çözmez). Tanımsız → eski davranış (tırmanabilir). Faz 8 set eder.
  lastFailEscalatable?: boolean;
  // YZLLM 2026-07-15 (faz-seviyesi döngü-kırıcı): bu fail'de test takımı YEŞİL mi (yalnız method/kalite-gate
  // blokladı — repro-first/AC/tech-debt gibi; testler kırmızı/bozuk DEĞİL)? Faz 8 set eder. Döngü-kırıcı never-ask
  // oto-kabul'ü YALNIZ true iken yapar (bozuk kodu sessizce "tamam" saymaz). Tanımsız → güvensiz (park).
  lastFailSuiteGreen?: boolean;
  // 4c (çift-inceleme dedup, YZLLM zaman-kaybı planı): gate-loop mahkemesi bu bulguyu ZATEN inceleyip escalate
  // ettiyse + outcome DEĞİŞMEDİYSE (fixRan=false) → failPhase aynı bulguyu YENİDEN incelemesin (redundant Sonnet
  // agentik pass + Bash repro). #1'in hükmü buraya taşınır; failPhase reuse eder. YALNIZ escalate taşınır
  // (fail-closed: autofix'e değil insana/rapora doğru; proceed→autofix→reOutcome durumunda outcome DEĞİŞİR →
  // taşınmaz, failPhase yeni post-autofix hatayı doğru şekilde YENİDEN inceler).
  priorGateRuling?: { action: MahkemeAction; summary: string };
}
function phaseFailMessage(phaseNum: number, controller?: FailReasonHolder): string {
  const reason = controller?.lastFailReason;
  if (reason) {
    if (/overloaded_error|"status":\s*529|\bOverloaded\b/i.test(reason)) {
      return `Faz ${phaseNum} tamamlanamadı: Anthropic API yoğun (5 deneme + ~67s backoff sonrası 529 Overloaded). Birkaç dakika bekleyip aynı mesajı tekrar gönder.`;
    }
    if (/rate_limit_error/i.test(reason)) {
      return `Faz ${phaseNum} tamamlanamadı: Anthropic API rate limit'i aşıldı. Bir süre bekleyip tekrar dene.`;
    }
    if (/authentication_error/i.test(reason)) {
      return `Faz ${phaseNum} tamamlanamadı: Anthropic API anahtarı geçersiz. Ayarlar → API Keys'i kontrol et.`;
    }
    if (/permission_error/i.test(reason)) {
      return `Faz ${phaseNum} tamamlanamadı: Anthropic API anahtarın bu modele erişim izni vermiyor.`;
    }
    return `Faz ${phaseNum} tamamlanamadı: ${reason.slice(0, 200)}`;
  }
  return `Faz ${phaseNum} tamamlanamadı (detay ~/.mycl/orchestrator.log).`;
}

/**
 * F1 (2026-06-04): Faz N başarısız olduğunda TEK nokta. Hata mesajını emit eder,
 * faz durumunu "error" yapar, sonra NON-BLOCKING LLM hata analizini tetikler
 * (orkestratör rolü; askq açar, OS bildirimi mevcut askq yolundan otomatik gider).
 * Asla throw ETMEZ — analiz patlasa bile faz-fail akışı bozulmaz (fail-closed:
 * analiz null dönerse askq açılmamıştır, branch hiç tetiklenmez). Çağıran kalıbı
 * korur: loop içinde `await failPhase(n, pX); return;`.
 */
// 2026-06-10 (YZLLM: "bu kadar kolay bişeyi çözemedi, node_modules silmeyi düşündü") — faz-fail oto-çözüm
// döngü-kıranı İMZA bazlı: aynı faz + aynı hata-imzası AUTO_SOLVE_MAX kez otomatik denenip ÇÖZÜLEMEDİYSE,
// bir daha aynı hatayı otomatik tamir etmeye çalışma (fix işe yaramıyor → kök neden başka) → kullanıcıya sor.
// Zaman PENCERESİ YOK: logda aynı hata saatlerce tekrarladı, 45-dk pencere sıfırlanınca döngü sürdü.
// FARKLI hata imzası → sayaç sıfır (yeni sorun meşru, otomatik denenir).
// Oto-cevap KAPALI: zaten otomatik düzeltmiyor (kullanıcıya sorar). Oto-cevap AÇIK (YZLLM: "durmasın, darboğazda
// devam etsin"): aynı hata-imzasında bile yüksek tavana kadar (snapshot güvenliğiyle) DENEMEYE devam; farklı bir
// hata çıkarsa imza sıfırlanır (ilerleme = sınırsız sürer). Yalnız AYNI hata bu tavanı aşarsa "gerçekten takıldı"
// deyip kullanıcıya bırakır (sonsuz aynı-fix döngüsü = sahte-yeşil/kaynak israfı backstop).
const AUTO_SOLVE_MAX = 6;
// YZLLM 2026-07-01 (FIX A): manuel modda (oto-cevap KAPALI) aynı hata bu kadar denemeden sonra ARTIK körü körüne
// aynı soruyu sorMAZ — loop-review + farklı seçenek (kabul-kalıcı / farklı-yaklaşım / dur). Manuel round-trip pahalı
// (kullanıcı her seferinde bekleyip cevaplıyor) → oto-taban 6'dan düşük. FIX B: priorSolutions sig-başına önceki
// kararları tutar → error-analysis "bunlar denendi, tekrarlama" olarak enjekte eder (aynı-soru döngüsü kırılır).
const MANUAL_LOOP_MAX = 3;
/**
 * KANIT TAŞIYAN FAZLAR (YZLLM 2026-07-28: "hedefe ilerlerken karşısına çıkan engellerin önemini bilmesi lazım…
 * sonucu çok kötü olacak bir şey varsa durur ve bana söylerdi").
 *
 * Bir engelin AĞIRLIĞI vardır: lint bulgusu geçilebilir, ama "yazılım gerçekten çalışıyor mu" sorusunu yanıtlayan
 * kapılar geçilemez. Bu fazların hepsi ÇALIŞIRLIK KANITI üretir: 8 = uygulama kodu + testleri yazıldı, 14 = birim,
 * 15 = entegrasyon, 16 = uçtan uca. Bunlardan biri KIRMIZI iken "kabul edip devam" demek, doğrulanmamış işi
 * "tamamlandı" diye damgalamaktır (sahte yeşil) — sonucu en kötü olan hata sınıfı.
 *
 * CANLI KANIT (cave, iterasyon 51 ve 52): Faz 16 E2E kırmızı → mahkeme "escalate" → kabul-devam → Faz 17 complete.
 * 51'de müfettiş hatayı BİZZAT yeniden üretmişti ("playwright test --list → TypeError + 0 tests in 0 files") ve
 * sistem yine de yürüdü. Artık bu fazlarda "escalate" (müfettiş çözemedi/kararsız) kabul-devam ETMEZ: akış gerçek
 * çözüm yoluna düşer (oto-fix → hata analizi → Faz 0); o da tükenirse iş kuyruğa yazılıp pipeline PARK eder
 * (advanceToNextPhase YOK → sahte "tamamlandı" yok, kullanıcı görünür şekilde bilgilendirilir).
 *
 * "suppress" (iki bağımsız değerlendirme KANITLA false-positive dedi) bu fazlarda da geçerli kalır — orada kanıt var.
 */
const PROOF_BEARING_PHASES: ReadonlySet<number> = new Set([8, 14, 15, 16]);
const autoSolveSig = new Map<number, { sig: string; count: number; priorSolutions: string[] }>();
// YZLLM 2026-07-09 (gate-timeout "atlama yok → çöz → orkestra → dürüst dur"): bir faz için timeout-divert deneme sayacı
// — sonsuz-döngü emniyeti. TIMEOUT_DIVERT_MAX aşılınca gerçek-çözüm/orkestra denemesi durur → dürüst görünür-dur. MODÜL-
// SEVİYE (Faz 0 re-run döngüsü boyunca yaşar — gateAutofixTried gibi local OLMAZ). Gerçek faz-tamamlanışta temizlenir.
const timeoutRetried = new Map<PhaseId, number>();
// Cevap-hatırlama Kademe 3 BACKSTOP (mahkeme YZLLM 2026-07-03): recall erken-return loop-guard'ı (autoSolveSig)
// atlar → onaylı cevap hatayı ÇÖZMÜYORSA aynı çözüm sessizce sonsuz tekrarlanabilirdi (frozen-goal ihlali). Aynı
// hata-imzası arka arkaya RECALL_AUTO_MAX kez oto-uygulandıysa sessiz tekrarı DURDUR → görünür dur + taze akışa
// dön (normal loop-guard/analiz devralır). Bellekte, sig-başına; taze karar (Hook B) sayacı sıfırlar.
const RECALL_AUTO_MAX = 3;
const recallAutoCount = new Map<string, number>();
// FAZ-SEVİYESİ DÖNGÜ-KIRICI (YZLLM 2026-07-15, cave 60-döngü): mevcut backstop'lar (recallAutoCount per-imza;
// _escalateAcceptChain her faz-tamamlanmasında reset) hata-İMZASI drift edince (tech-debt stderr tur-tur değişir)
// döngüyü kaçırıyor. Bu SAF faz-sayacı — imzadan/moddan bağımsız: bir faz PHASE_LOOP_MAX kez arka arkaya gate-fail
// ederse döngü var demektir → görünür kabul/park kararı (sessiz recall→Faz0 çevrimi yerine). Reset YALNIZ gerçek
// faz-tamamlanmasında (recordPhaseComplete / accept / yeni-proje). Ortam/timeout/abort fail'i buraya ulaşmadan return eder.
const PHASE_LOOP_MAX = 3;
const gateFailStreak = new Map<PhaseId, number>();

/** FIX B: kullanıcının/otonun bu hata-imzası için seçtiği çözümü kaydet → sonraki analizde "denendi, tekrarlama". */
function recordSolutionChoice(phase: PhaseId, sig: string, solution: string): void {
  const e = autoSolveSig.get(phase);
  const s = solution.trim();
  if (e && e.sig === sig && s && !e.priorSolutions.includes(s)) e.priorSolutions.push(s);
}

// Model yükseltme önerisi (YZLLM 2026-06-11): keşif yeni güçlü model bulunca OTOMATİK uygulamaz, SORAR.
// _pendingModelUpgrade: açık askq + önerilen model. _declinedModelUpgrades: bu oturumda "hayır" denenler (tekrar sorma).
let _pendingModelUpgrade: { askqId: string; model: string } | null = null;
const _declinedModelUpgrades = new Set<string>();

// YZLLM 2026-06-11: kullanıcı çalışan fazı başka faza yönlendirdi → abort tamamlanınca BU fazdan OTOMATİK devam
// (tekrar yazdırma yok). failPhase'in user-abort dalı tüketir.
let _resumePhaseAfterAbort: PhaseId | null = null;

/** Hata imzası: faz + lastFailReason'ın ilk ~160 char'ı (sayılar normalize → port/pid/ts gürültüsü eşleşmeyi bozmasın). */
function failSignature(n: PhaseId, ctrl?: FailReasonHolder): string {
  const raw = (ctrl?.lastFailReason ?? "")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return `${n}:${raw}`;
}

/**
 * #1 deliği (YZLLM 2026-06-11): pipeline-end doğrulama şeffaflığı. Bu iterasyonda hangi kalite gate'i (10-17)
 * GEÇTİ vs hangisi ATLANDI (araç yok / uygulanamaz) — atlanan gate "geçti" gibi görünmesin. Audit'ten okur.
 */
async function emitVerificationSummary(state: State): Promise<void> {
  // BOŞ-BUILD KORUMASI (2026-06-24, canlı kanıt): hiçbir deliverable üretilmediyse gate'ler yoklukta
  // sahte-geçer → "✅ Doğrulandı: Güvenlik/Birim/E2E/..." YALAN olur. Bunun yerine GÖRÜNÜR uyarı.
  if (!(await hasDeliverable(state.project_root))) {
    emitChatMessage(
      "system",
      "⛔ **Doğrulama: boş build** — hiçbir uygulama/kaynak dosyası üretilmedi. Gate'ler yoklukta koştu; bu koşu YEŞİL DEĞİL. (UI build/Faz 5 yanlış atlandıysa spec'i/proje tipini kontrol et.)",
    );
    return;
  }
  const GATE_DIMS: Record<number, string> = {
    10: "Lint", 11: "Sadeleştirme", 12: "Performans", 13: "Güvenlik",
    14: "Birim test", 15: "Entegrasyon", 16: "E2E", 17: "Sızma testi",
  };
  let audit: Awaited<ReturnType<typeof readAuditLogTail>>;
  try {
    audit = await readAuditLogTail(state.project_root, 500);
  } catch (e) {
    // Doğrulama özeti için audit okunamadı (sessiz-fallback denetimi): sessiz return → kullanıcı hangi
    // gate'lerin atlandığını/koştuğunu göremez. Görünür kıl.
    log.warn("orchestrator", "doğrulama özeti için audit okunamadı", { error: String(e) });
    emitChatMessage("system", "ℹ️ Doğrulama özeti üretilemedi (audit okunamadı) — hangi gate'lerin atlandığını elle kontrol et.");
    return;
  }
  const since = state.iteration_started_at ?? 0;
  const thisIter = audit.filter((e) => (e.ts ?? 0) >= since);
  const passed: string[] = [];
  const skipped: string[] = []; // araç yok/stub/bozuk → GERÇEK boşluk, sarı uyar
  const notApplicable: string[] = []; // stack bu boyuta genuinely sahip değil → nötr (YZLLM 2026-07-01)
  // Araç kurulumuyla OTO-ÇÖZÜLEBİLİR atlamalar (YZLLM 2026-07-24: "aracı eklemeye karar vermesi
  // gerekiyordu ve ekleyip çalıştırması gerekiyordu") — kullanıcıya "bilerek kabul et veya aracı ekle"
  // deyip DURMAK yerine karar verilir: kuyruğa "aracı kur + gate'i gerçekten koştur" işi açılır.
  const installable: Array<{ n: number; dim: string; detail: string }> = [];
  for (const [nStr, dim] of Object.entries(GATE_DIMS)) {
    const n = Number(nStr);
    const skip = thisIter.find((e) => e.event === `phase-${n}-skipped`);
    const done = thisIter.some((e) => e.event === `phase-${n}-complete`);
    // 2026-08-03 (mahkeme bulgusu): ana komut yoktu AMA stack bağımsız alt taramalar gerçekten koştuysa
    // bu boyut ÖLÇÜLDÜ — "DOĞRULANMADI" demek ve "aracı kur" işi açmak yanlış alarm olurdu (node
    // projelerinde `npm run perf` script'i yok; ölçümü bundle-budget + sayfa skoru yapıyor).
    const covered = thisIter.find((e) => e.event === `phase-${n}-covered-by-extras`);
    if (skip && covered) {
      passed.push(`${dim} (${String(covered.detail ?? "alt taramalar")})`);
    } else if (skip) {
      const reason = skip.detail ? String(skip.detail).split(" ")[0] : "";
      const label = `${dim}${reason ? ` (${reason})` : ""}`;
      // KESİN-N/A (ts-prune JS'te / profil null) → nötr; şüpheli/araç-eksik → sarı (false-green önleme).
      if (isNotApplicableSkip(skip.detail)) notApplicable.push(label);
      else {
        skipped.push(label);
        if (isToolInstallableSkip(skip.detail)) installable.push({ n, dim, detail: String(skip.detail ?? "") });
      }
    } else if (done) passed.push(dim);
  }
  // GERÇEK-APP DOĞRULAMA (mekanik faz değil → ayrı event'ler; YZLLM 2026-07-21): fix'in bildirilen bug'ı
  // gerçek çalışan uygulamada çözdüğü kanıtlandı mı? pass=doğrulandı, skipped=araç yok (sarı), fail=aşağıda ❌.
  const realappPass = thisIter.some((e) => e.event === "realapp-verify-pass");
  const realappSkip = thisIter.find((e) => e.event === "realapp-verify-skipped");
  const realappFail = thisIter.some((e) => e.event === "realapp-verify-fail");
  if (realappPass) passed.push("Gerçek uygulama (bildirilen sorun)");
  else if (realappSkip) {
    // not_applicable_* (YZLLM onayı 2026-07-24): sentezlenmiş kapı bu işe uygulanamadı (UI senaryosuna
    // çevrilemeyen iş — güvenlik/test-altyapı) → NÖTR ➖ (sarı "DOĞRULANMADI" korkutması yanlış olur).
    const d = realappSkip.detail ? String(realappSkip.detail) : "koşulamadı";
    if (d.startsWith("not_applicable")) notApplicable.push("Gerçek uygulama (arayüz senaryosuna çevrilemedi)");
    else skipped.push(`Gerçek uygulama (${d})`);
  }
  const lines = [`🔎 **Doğrulama özeti**`];
  if (passed.length) lines.push(`✅ Doğrulandı: ${passed.join(", ")}`);
  if (realappFail) {
    lines.push(
      `❌ **Gerçek uygulama doğrulaması BAŞARISIZ** — bildirilen sorun çalışan uygulamada hâlâ görülüyor; bu koşu YEŞİL DEĞİL (iş kuyruğa geri kondu).`,
    );
  }
  if (notApplicable.length) {
    // Nötr ton — uyarı DEĞİL. Stack bu boyuta sahip değil (ör. JS projesinde ts-prune) → "geçti sayılmaz" korkutması yanlış.
    lines.push(`➖ Uygulanamaz: ${notApplicable.join(", ")} — bu stack/proje türü için geçerli değil (eksiklik değil).`);
  }
  if (skipped.length) {
    lines.push(
      `⚠️ **DOĞRULANMADI (atlandı)**: ${skipped.join(", ")}`,
      `Bu boyutlar bu koşuda kontrol EDİLMEDİ (araç kurulu değil / stub / bozuk). "Geçti" anlamına gelmez.`,
    );
    // Araç-kurulabilir atlamalar → kuyruğa TEK-ATIŞ iş (YZLLM 2026-07-24: kararı kullanıcıya bırakma —
    // aracı ekle ve çalıştır). Dedup: aynı boyut için daha önce AÇILMIŞ (statüden bağımsız) verify-gap
    // işi varsa yeniden açılmaz — iş başarısız olsa da sonsuz açma döngüsü yok (özet dürüst kalır).
    const queuedDims: string[] = [];
    if (installable.length > 0) {
      try {
        for (const gap of installable) {
          const dedupKey = `Faz ${gap.n} (${gap.dim}) doğrulaması atlandı`;
          const cmd = /cmd="([^"]+)"/.exec(gap.detail)?.[1];
          // 2026-07-30: tekrar kontrolü artık kanonik anahtarla (metin şablonu değişse de kaymaz).
          // includeDone KORUNDU (eski davranış: bu boyut için daha önce AÇILMIŞ iş varsa — bitmiş olsa
          // bile — yenisi açılmaz; özet dürüst kalır, sonsuz açma döngüsü yok).
          const dec = await enqueueSystemFixTask(
            state.project_root,
            `${dedupKey} — neden: ${gap.detail || "araç yok"}. ` +
              `${cmd ? `Beklenen komut: ${cmd}. ` : ""}` +
              `Bu doğrulamanın gerçekten koşabilmesi için gerekli aracı/scripti projeye kur (bağımlılık + ` +
              `gerekli config + GERÇEK kontrol komutu; echo/stub YASAK) ve komutun gerçekten koşup anlamlı ` +
              `sonuç ürettiğini kanıtla.`,
            "verify-gap",
            { kind: "verify-gap", subject: String(gap.n), includeDone: true },
          );
          // Mahkeme düzeltmesi: zaten kuyrukta olan (refresh) boyut da "otomatik işleniyor" sayılır —
          // aksi halde özet "elle ekle" diyordu ama iş zaten kuyrukta işleniyordu.
          if (dec?.action === "create" || dec?.action === "refresh") queuedDims.push(gap.dim);
        }
      } catch (e) {
        // İş açma başarısız → görünür (sessiz fallback yok); özetin kendisi yine basılır.
        log.warn("orchestrator", "verify-gap işi kuyruğa eklenemedi", { error: String(e) });
        lines.push(`⚠️ Araç kurulum işi kuyruğa eklenemedi (${String(e).slice(0, 80)}) — aracı elle ekleyebilirsin.`);
      }
    }
    if (queuedDims.length > 0) {
      lines.push(`🔧 ${queuedDims.join(", ")} için "aracı kur + doğrulamayı koştur" işi kuyruğa eklendi — otomatik denenecek.`);
      if (skipped.length > queuedDims.length) lines.push(`Kalanlar için: bilerek kabul et veya aracı elle ekle.`);
    } else {
      lines.push(`Bilerek kabul et veya aracı ekle.`);
    }
  }
  emitChatMessage("system", lines.join("\n"));
}

// Merdiven KALDIRILDI (YZLLM 2026-06-16 "merdiven kullanmıcaz"): faz model+eforu artık iş-türüne göre SABİT
// (escalatedModelEffort) → "hangi model hangi işte iyi" merdiven-öğrenme raporu anlamını yitirdi → no-op
// (faz-complete kanca yeri korunur; ileride audit/telemetri için kullanılabilir).
async function recordRungOutcome(_n: PhaseId, _success: boolean): Promise<void> {}

// (_securityAutoResolveCount KALDIRILDI — mahkeme denetimi 2026-07-11: merdiven kaldırılınca MAX kontrolü de gitmişti;
//  sayaç artırılıyor/sıfırlanıyor ama HİÇBİR kararda okunmuyordu — zombi durum. TEK otorite: security-convergence.ts
//  bulgu-azalması kırıcısı, aşağıdaki ikili onun kalıcı durumudur.)
// (CASCADE-GUARD _iterationIsSecurityFix KALDIRILDI 2026-06-22 — Faz 17 otomatik pentest çıkarıldı;
//  cascade riski yoktu artık. Manuel 🛡️ buton kendi cascade-guard'ını taşımaz, kullanıcı-tetikli.)
// Yakınsama-kırıcı (YZLLM 2026-06-14: "MyCL'e yakınsama-kırıcı ekle"): güvenlik fix'leri bulguları AZALTMIYORSA
// sonsuz döngüye girme. Bu ikili İTERASYONDAN BAĞIMSIZ kalıcı; yalnız proje açılışında / Faz 13 çözülünce sıfırlanır.
let _securityFindingsPrev: number | null = null; // önceki güvenlik denemesindeki toplam bulgu sayısı
let _securityNoProgress = 0; // art arda "bulgu azalmadı" deneme sayısı (≥2 → yakınsamıyor; mantık security-convergence.ts)

/**
 * Faz tamamlandı → (YZLLM 2026-06-11) "yetersizliği NET anla": işi bir ÜST basamağa (önce efor+1, efor tepedeyse
 * model+1) KONTROL ettir. Yeterli → basamak kalır + rapora başarı. Yetersiz → rapora başarısızlık + domain basamağı
 * KONTROLCÜYE yükselir + faz o seviyede yeniden koşar ("rerun"). Oto-cevap kapalı / merdiven-dışı faz / tepe →
 * yalnız başarı kaydı (kontrol yok).
 */
// YZLLM 2026-06-13: ÜST-BASAMAK KONTROLÜ (verify-up) KALDIRILDI — "anlamsız + Faz 7
// yanlış-negatif loop'unun kaynağıydı". Faz tamamlanınca yalnız escalation başarı
// kaydı tutulur (merdiven öğrenmeye devam etsin); üst-rung yeniden-koşumu YOK.
async function recordPhaseComplete(n: PhaseId): Promise<void> {
  await recordRungOutcome(n, true);
  _autoAnswerChain = 0; // faz GERÇEKTEN tamamlandı → otonom-cevap döngü sayacı sıfır (ilerleme var; MAX yanlış-tetiklenmesin).
  _escalateAcceptChain = 0; // gerçek faz-tamamlanması = müfettiş O fazda çalıştı → escalate 'art arda' semantiği korunur
  _inspectorUnavailableChain = 0; // faz gerçekten bitti → müfettiş-erişim zinciri de sıfır (aynı semantik)
  // (kaskat ara-tamamlanma ÜRETMEZ → bu reset devre-kesiciyi defeat etmez; mahkeme onayladı).
  gateFailStreak.delete(n); // gerçek tamamlanma → faz-seviyesi döngü sayacı sıfır (ardışık-fail semantiği korunur).
}

/**
 * FAZ-SEVİYESİ DÖNGÜ-KIRICI oto-kabul (never-ask + testler YEŞİL): bir faz PHASE_LOOP_MAX kez arka arkaya gate-fail
 * etti ama test takımı yeşil (yalnız method/kalite-gate blokladı) → KULLANICI SEÇİMİ = otomatik kabul + ilerle.
 * Gate-fail'e neden olan tech-debt bulgularını (varsa) accepted-findings'e yaz → kapı bir daha işaretlemez (döngü
 * İMZADAN BAĞIMSIZ kalıcı kırılır) + `phase-N-complete` (detail `accepted_after_loop` → verdict PARTIAL, çıplak
 * PASS DEĞİL) + advance. GÖRÜNÜR (çağıran mesaj basar) — sessiz sahte-yeşil değil.
 */
async function autoAcceptPhaseAfterLoop(p: PhaseId): Promise<void> {
  if (!runtime.state) return;
  const findings = getLastTechDebtFindings(runtime.state.project_root);
  const seen = new Set<string>();
  for (const f of findings) {
    const key = acceptedFindingKey(f.file, f.category, f.excerpt);
    if (seen.has(key)) continue;
    seen.add(key);
    await appendAcceptedFinding(runtime.state.project_root, {
      ts: Date.now(),
      scope: "tech-debt",
      file: f.file,
      category: f.category,
      snippet: f.excerpt,
      reason: `Faz ${p} döngü-kırıcı: test yeşil, otomatik kabul (accepted_after_loop)`,
    }).catch((e) => log.warn("orchestrator", "loop-accept finding write fail", e));
  }
  gateFailStreak.delete(p);
  // MAHKEME CRITICAL fix: phase-complete detail'i TAM OLARAK "soft_complete_after_fail" olmalı — computeVerdict
  // (harness-verdict.ts:97) yalnız BU string'i soft-fail sayıp verdict'i PARTIAL yapar. Başka detail → PASS →
  // "tüm gate'ler yeşil" sahte-yeşili + modül-stok/prototip'e "temiz" sızıntısı. Bilgi (accepted_after_loop) AYRI
  // event'te (phase-loop-break-accept) — denetim izi kaybolmaz, ama verdict dürüstçe PARTIAL ("mükemmel değil").
  await appendAuditModule(runtime.state.project_root, {
    ts: Date.now(),
    phase: p,
    event: `phase-${p}-complete`,
    caller: "mycl-orchestrator",
    detail: "soft_complete_after_fail",
  }).catch((e) => log.warn("orchestrator", "loop-accept complete audit fail", e));
  await appendAuditModule(runtime.state.project_root, {
    ts: Date.now(),
    phase: p,
    event: "phase-loop-break-accept",
    caller: "mycl-orchestrator",
    detail: `accepted_after_loop suite_green findings=${seen.size}`,
  }).catch((e) => log.warn("orchestrator", "loop-accept info audit fail", e));
  await advanceToNextPhase(p);
}

/**
 * TIMEOUT/asılma divert'i için errCtx'i GERÇEK-çözüm bağlamıyla zenginleştir (YZLLM 2026-07-09 "atlama YOK → gerçek
 * çözüm → çok-açılı orkestra"): HANG çerçevesi (kör-fix YASAK, yeniden-üreterek teşhis et) + E2E'de (Faz 16) dev-server
 * GERÇEK-GÖZLEM talimatı (`npm run dev`'i Bash ile çalıştır — statik tahmin değil) + rekürans/E2E'de çok-açılı orkestra
 * hipotezleri (işe/projeye uygun 3 mercek). `ctrl.lastFailReason`'a
 * DOKUNMAZ (failSignature imzası kararlı kalsın). Fail-soft (her parça hata yutar → çağıran derin-çözüm gövdesiyle devam).
 */
async function enrichTimeoutContext(errCtx: ErrorContext, n: PhaseId, ctrl?: FailReasonHolder): Promise<void> {
  const st = runtime.state;
  const cfg = runtime.config;
  if (!st || !cfg) return;
  const parts: string[] = [errCtx.detail ?? ""];
  const e2eHint =
    n === 16
      ? " Bu bir E2E gate'i: asılmanın EN sık sebebi dev-server'ın boot ETMEMESİdir (Playwright webServer 120s bekleyip " +
        "node:events 5xx). GERÇEK sebebi görmek için `npm run dev`'i (veya projenin dev komutunu) Bash ile ÇALIŞTIR, boot " +
        "hatasını/port durumunu gözlemle — statik tahmin DEĞİL, gerçek gözlem."
      : "";
  parts.push(
    "\n\n[TIMEOUT/HANG] Bu gate hata VERMEDİ — ASILDI/timeout (çıkış kodu yok). Olası kök: (a) uygulama/test kodunda " +
      "sonsuz döngü/runaway, (b) dev-server boot edemiyor, (c) gerçekten yavaş. KÖR DÜZELTME YASAK (asılmayı çözmez + " +
      "sahte-yeşil riski). Asılan komutu Bash ile YENİDEN ÜRETEREK gerçek sebebi teşhis et. Çözüm ancak GERÇEK yeniden-" +
      "koşuda geçer." +
      e2eHint,
  );
  // Çok-açılı orkestra ("bulamazsa"): rekürans (aynı asılma tekrar) VEYA E2E → işe/projeye uygun 3 mercek hipotez üretir.
  const prev = autoSolveSig.get(n);
  const recurring = !!prev && prev.sig === failSignature(n, ctrl) && prev.count >= 1;
  if (recurring || n === 16) {
    const bugReport =
      `Gate Faz ${n} hung/timed out (no exit code). Suspected: infinite loop / async race / dev-server boot-fail. ` +
      `Investigate THIS project's code (Read/Grep/Bash) to find the real cause, work- and project-appropriately.`;
    const hyps = await runTimeoutMultiAngle(cfg, st.project_root, bugReport, parts.join("\n"));
    if (hyps.length) {
      // TAZE kök-neden hipotezleri → yalnız detail (bilgi bağlamı). errCtx.priorAttempts'e YAZMA (mahkeme major fix): o alan
      // "zaten UYGULANDI, gate HÂLÂ fail → TEKRAR ÖNERME" anlamında; taze hipotezleri oraya koymak analizi kendi hipotezini
      // araştırmaktan MEN ederdi (yanlış çerçeve). Detail nötr bağlam olarak analyzeAndAskError/Faz 0 D1 prompt'una girer.
      parts.push(`\n\n[ÇOK-AÇILI KÖK-NEDEN HİPOTEZLERİ (taze — araştırılacak, denenmiş DEĞİL)]\n${hyps.join("\n")}`);
      emitChatMessage("system", `🔬 ${hyps.length} kök-neden hipotezi (çok açılı orkestra) üretildi → gerçek-çözüme rehber.`);
    }
  }
  errCtx.detail = parts.join("");
}

/**
 * FROZEN-GOAL FIX (sessiz-stall kapatma, 2026-06-25): hata analizi HİÇ üretilemediğinde (analyzeAndAskError null)
 * sessizce DÜŞME — pass-or-escalate. Eski hata: null → runtime.pendingErrorAnalysis null → isPipelineParked()
 * false → reconcileAndDrainTasks task'ı sessizce 'dropped' yapıp pipeline'ı öldürüyordu (bayat 'Model çalışıyor'
 * banner, kullanıcıya tıklanacak hiçbir şey yok). Bu yardımcı: pendingErrorAnalysis'e sentinel yazar (park =
 * isPipelineParked true → drop YOK) + eyleme dönük askq açar (OPT_REANALYZE/OPT_QUEUE). Oto-modda kullanıcı
 * izlemiyor → park = sessiz-stall → OPT_QUEUE OTO-route (hata iş listesine + görünür dur; OPT_REANALYZE
 * oto-seçilmediği için reanalyze→null→reanalyze sonsuz döngüsü YOK). Tüm failPhase null-yolları bunu çağırır.
 */
async function escalateUnanalyzableError(n: PhaseId, autoResolve: boolean, sig?: string): Promise<void> {
  // Savunmacı guard (sentinel-routing finding-e): mevcut gerçek bir bekleme varsa EZME.
  // 3 çağrı sitesinin hepsi bugün null garantili, ama gelecek site için kapıyı kapat.
  if (runtime.pendingErrorAnalysis !== null) {
    log.warn(
      "orchestrator",
      "escalateUnanalyzableError çağrıldı ama pendingErrorAnalysis zaten dolu — ezme korunuyor",
      { existingId: runtime.pendingErrorAnalysis.id, requestedPhase: n },
    );
    return;
  }
  const fbId = `error_analysis_fallback_${randomUUID()}`;
  const fallbackOptions = [OPT_REANALYZE, OPT_QUEUE]; // tek tanım — pending + emitAskq aynı listeyi kullanır (drift olmasın)
  runtime.pendingErrorAnalysis = {
    id: fbId,
    phase: n,
    blocking: true,
    options: fallbackOptions,
    solutions_tr: [],
    // FIX B (mahkeme): fallback pending'e de sig taşı → sonraki tur PREVIOUS ATTEMPTS hafızası tutarlı kalır.
    sig,
  };
  emitChatMessage(
    "system",
    `⚠️ Faz ${n}: hata analizi üretilemedi — sessizce durmuyorum. Seçenek: tekrar analiz, ya da iş listesine kaydedip devam.`,
  );
  if (autoResolve) {
    // Oto-çözüm: askq UI'a basmadan doğrudan "kaydet + devam" route et. emitAskq'yi ATLA ki merkezî otonom-cevap
    // hook'u (onAutonomousAskq) AYNI id'yi ikinci kez cevaplamaya kalkmasın (çift-cevap yarışı + boşa LLM turu).
    await handleAskqAnswer(fbId, OPT_QUEUE).catch((e: unknown) =>
      log.error("orchestrator", "escalateUnanalyzableError auto-route (queue) failed", e),
    );
    return;
  }
  // Oto-cevap KAPALI: askq'yı göster. never-ask'ta merkezî hook (güvenli: yalnız REANALYZE/QUEUE) otonom cevaplar; mod-kapalıda kullanıcı.
  emitAskq({
    id: fbId,
    question: `Faz ${n}: hata analizi üretilemedi. Ne yapalım?`,
    options: fallbackOptions,
  });
}

// ── HİÇBİR ŞEY SORMA: kapsanmamış askq'yi orkestra ajanı/mahkeme OTONOM cevaplasın (YZLLM 2026-07-10) ──
// never-ask'ta emitAskq'ye ULAŞAN (kategori-guard'ıyla bypass EDİLMEMİŞ) bir askq asılı kalıyordu → hook (ipc.ts) yakalar →
// orkestra ajanı (respondAsOrchestrator, zengin bağlam) BİRİNCİL, mahkeme (inspectClarify, fail-closed) İKİNCİL, muhafazakâr
// varsayılan SON ÇARE. Yıkıcı-seçenek korumalı (id-denylist + option-stripping) + döngü emniyetli. Mod-kapalı → hook no-op.
const AUTO_ANSWER_MAX = 3;
let _autoAnswerChain = 0;
const _autoAnswerInFlight = new Set<string>();

/**
 * HİÇBİR ŞEY SORMA: asılı kalan bir askq'yi otonom cevapla. BİRİNCİL orkestra ajanı (respondAsOrchestrator — state+audit+
 * task-queue bağlamı görür), İKİNCİL mahkeme (inspectClarify — bağımsız yargıç, fail-closed), SON ÇARE muhafazakâr varsayılan
 * (ilk constructive). Yıkıcı seçenekler motora HİÇ gösterilmez (stripDestructiveOptions). Döngü emniyeti + uydurma-yasak
 * (matchAnswerToOption). LOUD (kullanıcı görüp düzeltebilir). skipCourt: ask_clarify'da mahkeme ZATEN koştu → tekrar çağırma.
 */
/**
 * Otonom cevap SEÇ (route'suz — hem askq-yolu hem ask_clarify-yolu kullanır): BİRİNCİL orkestra ajanı, İKİNCİL mahkeme,
 * SON ÇARE muhafazakâr varsayılan. Yıkıcı seçenekler motora HİÇ gösterilmez. null = hiç güvenli cevap yok (korunmalı).
 */
async function chooseAutonomousAnswer(a: {
  id?: string;
  question: string;
  options: string[];
  intent?: string;
  trajectory?: string;
  skipCourt?: boolean;
  /** Yüksek riskli (restart_consent): yalnız mahkeme; orkestra "hedefi ilerlet" biası + muhafazakâr-default DEVRE DIŞI. */
  courtFirst?: boolean;
}): Promise<string | null> {
  const cfg = runtime.config;
  const st = runtime.state;
  if (!cfg || !st) return null;
  const constructive = stripDestructiveOptions(a.options);
  if (constructive.length === 0) return null; // yalnız-yıkıcı → korunmalı
  const runCourt = async (): Promise<string | null> => {
    if (!cfg.features.inspector_enabled) return null;
    try {
      const ruling = await inspectClarify(cfg, {
        projectRoot: st.project_root,
        intent: a.intent ?? st.intent_summary ?? "",
        trajectory: a.trajectory ?? "otonom askq cevaplama (hiçbir şey sorma)",
        question: a.question,
        options: constructive,
      });
      if (!ruling.ask && ruling.answer) return matchAnswerToOption(ruling.answer, constructive);
    } catch (e) {
      log.warn("orchestrator", "otonom-cevap: mahkeme hata (yutuldu)", { error: String(e) });
    }
    return null;
  };
  // COURT-FIRST (restart_consent gibi yüksek-riskli / büyük karar): orkestra "hedefi ilerlet" biası TEHLİKELİ (tüm
  // pipeline'ı sessizce yeniden başlatabilir) → yalnız MAHKEME (tarafsız yargıç). Mahkeme kararsızsa muhafazakâr-default
  // DEĞİL → null (çağıran LOUD-hold, kararı kullanıcıya bırak). GUARDRAIL 1'in "ASLA otomatik" garantisini korur.
  if (a.courtFirst) return runCourt();
  // cevaplanmakta OLAN askq'yi bağlam bölümüne geçir (getActiveAskq top-of-stack yerine — eşzamanlı 2. askq'de yanlış-cevap kökü).
  // options = constructive (görev metniyle AYNI arındırılmış küme; ham a.options'taki yıkıcı seçenek bölümde gösterilip de
  // görevde olmayınca ajan onu seçerse matchAnswerToOption null döner → boşa tur — mahkeme minor).
  const activeAskq: ActiveAskqSnapshot | undefined = a.id
    ? { id: a.id, question: a.question, options: constructive }
    : undefined;
  let answer: string | null = null;
  // BİRİNCİL — orkestra ajanı (proje durumu + iş kuyruğu + geçmiş bağlamı).
  try {
    const prompt =
      "[OTONOM CEVAP — hiçbir şey sorma modu] Aktif bir soru cevapsız kaldı; proje durumunu, iş kuyruğunu ve geçmişi " +
      'değerlendirip EN DOĞRU seçeneği "answer_askq" aksiyonuyla ver (askq_answer alanına seçeneği BİREBİR yaz). ' +
      "Yıkıcı/geri-alınamaz olanı SEÇME; işi koruyan + hedefi ilerleten seçeneği tercih et.\n" +
      `Soru: "${a.question}"\nSeçenekler:\n${constructive.map((o, i) => `${i + 1}. ${o}`).join("\n")}`;
    const decision = await respondAsOrchestrator(cfg, st, prompt, { activeAskq });
    if (decision.action === "answer_askq" && decision.askq_answer) {
      answer = matchAnswerToOption(decision.askq_answer, constructive);
    }
  } catch (e) {
    log.warn("orchestrator", "otonom-cevap: orkestra ajanı hata (yutuldu → mahkeme)", { error: String(e) });
  }
  // İKİNCİL — mahkeme (bağımsız yargıç, fail-closed).
  if (!answer && !a.skipCourt) answer = await runCourt();
  // SON ÇARE — muhafazakâr varsayılan (ilk constructive).
  return answer ?? pickConservativeDefault(a.options);
}

/** Kapsanmamış bir askq'yi (emitAskq yolu) otonom cevapla + `handleAskqAnswer` ile route et. Döngü emniyetli + LOUD. */
async function autonomouslyAnswerAskq(a: {
  id: string;
  question: string;
  options: string[];
  intent?: string;
  trajectory?: string;
  skipCourt?: boolean;
  courtFirst?: boolean;
}): Promise<void> {
  try {
    if (shouldStopAutoAnswer(_autoAnswerChain, AUTO_ANSWER_MAX)) {
      emitChatMessage(
        "system",
        `⚠️ Hiçbir şey sorma: art arda ${_autoAnswerChain} soru otonom cevaplandı ama ilerleme yok — döngü emniyeti, ` +
          "otonom cevaplamayı durdurdum. Aktif soruyu sen yanıtlayabilirsin.",
      );
      return;
    }
    // TOCTOU FIX (mahkeme 2026-07-10): sayacı await'ten ÖNCE (senkron) artır → eşzamanlı 2. askq callback'i GÜNCEL
    // değeri görür. Eskiden artış await SONRASIYDI → iki farklı-id askq aynı (henüz-artmamış) sayacı okuyup MAX'ı
    // aşabiliyordu (döngü emniyeti sessizce zayıflıyordu). Rezerve; hold (pick=null) da runaway sinyali → geri alma yok.
    _autoAnswerChain++;
    const pick = await chooseAutonomousAnswer(a);
    if (!pick) {
      emitChatMessage(
        "system",
        a.courtFirst
          ? `⚠️ Hiçbir şey sorma: "${a.question.slice(0, 80)}" tüm pipeline'ı yeniden başlatan BÜYÜK bir karar — otomatik uygulamadım, senin onayını istiyorum.`
          : `⚠️ Hiçbir şey sorma: "${a.question.slice(0, 80)}" için güvenli cevap üretemedim/yalnız-yıkıcı — korunuyor.`,
      );
      return;
    }
    emitChatMessage(
      "system",
      `🤖 Hiçbir şey sorma: "${a.question.slice(0, 80)}" sorusunu ${a.courtFirst ? "mahkeme" : "orkestra ajanı"} **${pick}** ile otomatik cevapladı.`,
    );
    await handleAskqAnswer(a.id, pick).catch((e: unknown) =>
      log.error("orchestrator", "otonom-cevap handleAskqAnswer failed", e),
    );
  } finally {
    _autoAnswerInFlight.delete(a.id);
  }
}

/** ipc.ts emitAskq hook'u: never-ask'ta kapsanmamış (korunmamış) askq'yi otonom cevaplama motoruna yönlendir (mod-kapalı no-op). */
function onAutonomousAskq(s: ActiveAskqSnapshot): void {
  if (!isNeverAsk()) return; // mod-kapalı: byte-aynı parite
  // KULLANICI-ONLY korumalar (TEK KAYNAK isAutonomouslyAnswerableAskq): id-öneki (agent_decision_ cancel / dast_confirm_
  // DAST) VEYA protected bayrağı (forceUserPrompt düşük-güven onay). Bunlar never-ask'ta bile otonom cevaplanMAZ.
  if (!isAutonomouslyAnswerableAskq(s)) return;
  if (_autoAnswerInFlight.has(s.id)) return; // idempotent emit re-entrancy (aynı-id çift-ateş)
  _autoAnswerInFlight.add(s.id);
  const opts = s.options.map((o) => (typeof o === "string" ? o : o.label));
  // COURT-FIRST (restart_consent): büyük karar → yalnız mahkeme (orkestra bias'ı yok). skipCourt=false (mahkeme ŞART).
  const courtFirst = isCourtFirstAskqId(s.id);
  // setImmediate: emitAskq senkron + çoğu controller'ın await-döngüsünden çağrılır → LLM'i emit stack'inde çalıştırma.
  setImmediate(() => {
    void autonomouslyAnswerAskq({ id: s.id, question: s.question, options: opts, courtFirst });
  });
}
// emitAskq (ipc.ts) her askq'de bu hook'u çağırır; mod-kapalıyken onAutonomousAskq ilk satırda erken-return → byte-aynı.
setAutonomousAskqHook(onAutonomousAskq);

// (trySwitchSessionToZai + rerunPhaseAfterProviderSwitch KALDIRILDI — 2026-07-16, YZLLM: z.ai
// sağlayıcısı çıkarıldı. Fallback zinciri artık claude-CLI → claude-API'de biter; ikisi de
// tükendiyse GÖRÜNÜR mesaj + dürüst dur — sessiz sağlayıcı değişimi yok.)

/** YZLLM 2026-06-26: güncel faz kapsamını (needed_phases) frontend'e yolla — PhaseSidebar kapsam-dışı opsiyonelleri
 *  soluk göstersin. Scope değişen HER noktada + boot'ta çağrılır (tek doğruluk kaynağı runtime.state). */
function syncNeededPhases(): void {
  emitNeededPhases(runtime.state?.needed_phases ?? null);
}

// ── CEVAP-HATIRLAMA MERDİVENİ (YZLLM 2026-07-03) ─────────────────────────────────────────────────────
// Kademe 2 "aynı cevabı kullanayım mı?" onay askq'sı + Kademe 2/3 yeniden-uygulama. Aile-bağımsız: apply
// (kayıtlı cevabı uygula) ve fresh (taze soruya dön) closure'larını çağıran (failPhase / emit-site) taşır.

/**
 * Kademe 2: hafif onay askq'sı ("geçen sefer X demiştin, aynısını kullanayım mı?"). Oto-cevap AÇIKSA sessizce
 * TAZE soruya düşmez (merdivenin amacını bozar) → geçen seferki kararı (Evet) GÖRÜNÜR notla uygular.
 */
async function emitReuseConfirmAskq(args: {
  key: string;
  rec: AnswerMemoryRecord;
  intro: string;
  apply: () => Promise<void>;
  fresh: () => Promise<void>;
}): Promise<void> {
  const id = `answer_reuse_${randomUUID()}`;
  runtime.pendingAnswerReuse = {
    id,
    key: args.key,
    rec: args.rec,
    apply: args.apply,
    fresh: args.fresh,
  };
  emitChatMessage(
    "assistant",
    `${args.intro} Geçen sefer **${args.rec.answer}** demiştin. Aynı cevabı kullanayım mı?`,
  );
  const auto = autoAnswerPick([REUSE_YES, REUSE_NO], REUSE_YES);
  if (auto) {
    emitChatMessage(
      "system",
      `🤖 Oto-cevap açık — geçen seferki kararını (**${args.rec.answer}**) kullanıyorum.`,
    );
    await handleReuseConfirmAnswer(id, REUSE_YES);
    return;
  }
  emitAskq({
    id,
    question: "Aynı soru — geçen seferki cevabı kullanayım mı?",
    options: [REUSE_YES, REUSE_NO],
  });
}

/** Kademe 2 onay cevabını işle: Evet → onayla (kalıcı) + uygula; Hayır → taze soruya dön. */
async function handleReuseConfirmAnswer(id: string, sel: string): Promise<void> {
  const p = runtime.pendingAnswerReuse;
  if (!p || p.id !== id) return;
  runtime.pendingAnswerReuse = null;
  if (sel === REUSE_YES) {
    // Onayın KALICI yazıldığını doğrula: markReuseApproved disk hatasıyla başarısız olursa
    // reuseApproved=true diske geçmez → Kademe 3'e çıkamaz. O durumda kullanıcıya "otomatik
    // seçilecek" DEME (yanlış vaat + KATI #4 sessiz state uyumsuzluğu); dürüst mesaj ver.
    let approvedPersisted = true;
    if (runtime.state) {
      approvedPersisted = await markReuseApproved(runtime.state.project_root, p.key)
        .then(() => true)
        .catch((e) => {
          log.warn("orchestrator", "answer-memory markReuseApproved fail (non-fatal)", e);
          return false;
        });
    }
    emitChatMessage(
      "system",
      approvedPersisted
        ? `♻️ Aynı cevabı uyguluyorum: **${p.rec.answer}** — bundan sonra bu soru için otomatik seçilecek (sana söyleyerek).`
        : `♻️ Aynı cevabı uyguluyorum: **${p.rec.answer}** — ancak onay kalıcı kaydedilemedi; bu soru tekrar gelirse yeniden sorabilirim.`,
    );
    await p.apply();
  } else {
    emitChatMessage("system", "👍 Tamam, bu soruyu yeniden değerlendirelim.");
    await p.fresh();
  }
}

/**
 * Kademe 2/3: kayıtlı hata-analizi cevabını YENİDEN uygula. Sentetik pending kurup kanonik dispatch'i
 * (handleAskqAnswer) yeniden kullanır → kayıtlı metin doğrudan gönderilir (güncel seçenek listesine bakılmaz,
 * yeniden-ifadeye dayanıklı). fromRecall=true → handleAskqAnswer bu cevabı answer-memory'ye TEKRAR KAYDETMEZ.
 * DEĞİŞMEZ (mahkeme): Hook B YALNIZ answerKind="solution" kaydeder → buraya hep bir çözüm yönü gelir; sabit-etiket
 * (OPT_ACCEPT_CONTINUE/QUEUE/STOP_MANUAL) HİÇ ulaşmaz → blocking:false + acceptContinuePhase yokluğu güvenli
 * (çözüm yönü executeDispatchedIntent debug akışına gider; güvenlik-kabul dalı gerektirmez).
 */
/**
 * ANA KURAL SINIR ÇEVİRİSİ (YZLLM 2026-07-18: "main ajan ile iletişim tamamen İngilizce"): main'e
 * (Faz 0/8 promptları) gidecek TÜRKÇE kaynaklı metni (kullanıcının seçtiği/yazdığı çözüm, recall
 * kaydı) İngilizceye çevirir. Çeviri patlarsa ORİJİNAL metin + görünür not (sessiz fallback yok;
 * Faz 0'ın kendi bugReport tr-to-en ağı ikinci hat). Zaten İngilizce kısa metinde de zararsızdır
 * (translator EN→EN verbatim döner).
 */
async function toEnglishForMain(text: string): Promise<string> {
  const t = text.trim();
  if (!t || !runtime.config) return t;
  try {
    const r = await translate(runtime.config, t, "tr-to-en");
    return r.text;
  } catch (e) {
    log.warn("orchestrator", "main sınır çevirisi başarısız — orijinal iletildi", { error: String(e).slice(0, 120) });
    emitChatMessage("system", "🌐 Çevirmen erişilemedi — seçilen çözüm metni main ajana özgün haliyle iletildi (Faz 0 kendi çeviri ağıyla telafi eder).");
    return t;
  }
}

async function applyRecalledErrorAnswer(
  n: PhaseId,
  sig: string,
  rec: AnswerMemoryRecord,
): Promise<void> {
  const pid = `error_analysis_${randomUUID()}`;
  runtime.pendingErrorAnalysis = {
    id: pid,
    phase: n,
    blocking: false,
    sig,
    options: [rec.answer],
    solutions_tr: [rec.answer],
    // ANA KURAL: recall kaydı TR — main'e giden eşlenik burada çevrilir (gösterim TR kalır).
    solutions_en: [await toEnglishForMain(rec.answer)],
    fromRecall: true,
  };
  await handleAskqAnswer(pid, rec.answer);
}

// ── CEVAP-HATIRLAMA — Faz 3 KAPSAM ailesi (YZLLM 2026-07-03) ─────────────────────────────────────────
// Kararlı anahtar: önerilen-faz-seti (sıralı). Sabit-etiket cevaplar ("onayla"/"tüm fazlar") ama recall'da
// güncel `proposed` ile pending YENİDEN kurulur → gate-error'daki bağlam-kaybı sorunu YOK (mahkeme dersi).

/** Faz 3 kapsam sorusu kararlı anahtarı — aynı önerilen-faz-seti → aynı soru. */
function phaseScopeKey(proposed: number[]): string {
  return `phase-scope:${[...proposed].sort((a, b) => a - b).join(",")}`;
}

/** Kademe 1 / "Hayır" (fresh): normal faz-kapsam askq'sını emit et (pending kur + soru). */
function emitPhaseScopeAskq(proposed: number[]): void {
  const phaseList = proposed.map((p) => `Faz ${p}`).join(", ");
  const askqId = `phase_scope_${randomUUID()}`;
  runtime.pendingPhaseScope = { askqId, proposed };
  emitChatMessage(
    "assistant",
    `Bu iterasyon için önerilen fazlar: **${phaseList}**.\n\n` +
      `Brief'te gerekçesi yazılı. Onaylar mısın?`,
  );
  emitAskq({
    id: askqId,
    question: "Faz kapsamı nasıl olsun?",
    options: ["✅ Önerilen seti onayla", "⚙️ Tüm fazları çalıştır", "Vazgeç"],
    multi_select: false,
    allow_other: false,
  });
}

/** Kademe 2/3: kayıtlı kapsam cevabını YENİDEN uygula. Güncel `proposed` ile sentetik pending → kanonik dispatch
 *  (handleAskqAnswer). fromRecall=true → cevap dalı answer-memory'ye TEKRAR kaydetmez. */
async function applyRecalledPhaseScope(proposed: number[], rec: AnswerMemoryRecord): Promise<void> {
  const askqId = `phase_scope_${randomUUID()}`;
  runtime.pendingPhaseScope = { askqId, proposed, fromRecall: true };
  await handleAskqAnswer(askqId, rec.answer);
}

/**
 * CANLILIK GARANTİSİ (YZLLM 2026-07-18: "hiç bir zaman durmayacağını ve döngüye girmeyeceğini garanti
 * etmeliyiz"): otonom modda (oto-cevap/hiçbir-şey-sorma) bir terminal-dur noktası işi ASKIDA BIRAKMAZ.
 *  - Kuyruk işi aktifse: hiçbir şey yapmaz — reconcile işi pending+attempts'e döndürür, merdiven sahiplenir.
 *  - Kuyruk-DIŞI akışsa (doğrudan mesaj/Çalıştır): işi kuyruğa alır (attempts=1 + neden) → merdiven
 *    (farklı yaklaşım + tavan 3 + canlandırma) sahiplenir; drain reconcile'da kendiliğinden sürer.
 * Manuel modda dokunmaz (dur + rehber = kullanıcı sürer; bu donma değil, tasarım). Döngü garantisi
 * merdivenin tavanından gelir (tavanlı iş otomatik seçilmez → aynı iş sonsuz dönemez).
 */
async function ensureAutonomousContinuation(reason: string): Promise<void> {
  if (!autoAnswerSuggested()) return;
  if (!runtime.state) return;
  if (runtime.currentTaskId || runtime.currentBatch) {
    // Kuyruk işi: reconcile pending+attempts'e döndürecek (merdiven sahiplenir). SOMUT rehberlik
    // (mahkeme MEDIUM 2026-07-18): jenerik "tamamlanmadan durdu" notu bu nedeni EZMESİN → sonraki
    // returnTaskToPending bu nedeni kullansın (tek seferlik).
    _pendingStopReason = reason;
    return;
  }
  const text = _lastDevelopText?.trim();
  if (!text) return; // devam ettirilecek somut iş metni yok → genel emniyet ağı (bekçi) kalır
  const root = runtime.state.project_root;
  // MAHKEME HIGH (2026-07-18): intake dedup'undan geçmeyen doğrudan append, tekrar eden STOP'ta aynı
  // işi kuyruğa katlayabilirdi (tavan 3×N'e çıkar). Bekleyenlerle benzerlik kontrolü — varsa ekleme.
  const pendingNow = (await readTasks(root).catch(() => [])).filter((t) => taskStatus(t) === "pending");
  if (pendingNow.some((t) => textSimilarity(t.text, text) > 0.7)) {
    emitChatMessage("system", "🧭 Durmuyorum: bu iş zaten kuyrukta bekliyor — merdiven sahiplenecek (çift kayıt eklemedim).");
    _drainActive = true;
    return;
  }
  await appendTask(root, {
    id: randomUUID(),
    ts: Date.now(),
    text: text.slice(0, 300),
    status: "pending",
    source: "auto",
    attempts: 1,
    last_fail: reason.slice(0, 200),
  }).catch((e) => log.warn("orchestrator", "canlılık: iş kuyruğa alınamadı", e));
  await emitQueueChangedFor(root);
  emitChatMessage(
    "system",
    "🧭 Durmuyorum: yarım kalan iş kuyruğa alındı — daraltılmış/farklı yaklaşımla otomatik yeniden denenecek.",
  );
  _drainActive = true;
}

// Son terminal-dur nedeni (tek seferlik) — reconcile'ın jenerik orphan notu yerine SOMUT rehberlik
// last_fail'e taşınsın (mahkeme MEDIUM 2026-07-18: 'farklı yaklaşım' notu tam gerektiği anda eziliyordu).
let _pendingStopReason: string | null = null;

/**
 * LLM kesintisi devam kapanışı (YZLLM 2026-07-17 "5 dk'da bir denesin / reset saatinde devam etsin"):
 * kesilen fazı, erişim dönünce OTOMATİK yeniden koşar. Emniyetler: pipeline zaten koşuyorsa (kullanıcı
 * 'Çalıştır'a bastı) ya da faz manuel ilerletildiyse ÇİFT koşum yok — görünür not + atla.
 */
function makePhaseOutageResume(n: PhaseId): () => Promise<OutageResumeResult> {
  // MAHKEME CRITICAL (2026-07-23): meşgul/askq atlaması eskiden beklemeyi SESSİZCE sonlandırıyordu →
  // kuyruksuz faz-vuruş köşesinde (watchdog hasPending şartına takılır, kuyrukta iş yok) kalıcı durma.
  // Artık "skipped" dönülür → fire beklemeyi SESSİZCE yeniden kurar; mesaj yalnız İLK atlamada (spam yok,
  // şerit zaten "LLM erişimi bekleniyor" göstermeye devam eder — görünürlük orada).
  let skipNoticeShown = false;
  return async () => {
    if (_handlingUserMessage || _pipelineDepth > 0 || runtime.controller !== null || getActiveAskq() !== null) {
      if (!skipNoticeShown) {
        skipNoticeShown = true;
        emitChatMessage(
          "system",
          "ℹ️ Otomatik devam şimdilik atlandı — sistem meşgul (yeni mesaj/askq/faz sürüyor). Beklemeye devam ediyorum; meşguliyet çözülünce yeniden deneyeceğim.",
        );
      }
      return "skipped";
    }
    if (!runtime.state) {
      emitChatMessage("system", "ℹ️ Otomatik devam sonlandı — proje bu arada değişmiş.");
      return "resumed";
    }
    // KUYRUK YOLU (mahkeme CRITICAL 2026-07-18): kesinti bir kuyruk işini vurduysa reconcile işi çoktan
    // pending'e döndürmüştür (currentTaskId=null, drain kapalı) → fazı değil KUYRUĞU sürdür (iş, deneme
    // bağlamıyla baştan ele alınır; aynı ölü sağlayıcıya art arda faz koşup deneme yakılmaz).
    if (!runtime.currentTaskId && nextPendingTask(await readTasks(runtime.state.project_root).catch(() => []))) {
      emitChatMessage("system", "🔄 LLM erişimini yeniden deniyorum — açıldıysa kaldığım yerden devam edeceğim.");
      _drainActive = true;
      await reconcileAndDrainTasks();
      return "resumed";
    }
    if (runtime.state.current_phase !== n) {
      emitChatMessage("system", "ℹ️ Otomatik devam sonlandı — durum bu arada değişmiş (faz elle ilerletilmiş ya da proje değişmiş).");
      return "resumed";
    }
    if (n >= 1) {
      emitChatMessage("system", "🔄 LLM erişimini yeniden deniyorum — açıldıysa kaldığım yerden devam edeceğim.");
      await advanceToNextPhase((n - 1) as PhaseId); // kesilen fazı yeniden koş
    } else {
      emitChatMessage("system", "ℹ️ Faz 0 kesilmişti — devam için işi yeniden başlat ('Çalıştır' ya da mesaj).");
    }
    return "resumed";
  };
}

async function failPhase(
  n: PhaseId,
  ctrl?: FailReasonHolder,
  opts?: { forceFresh?: boolean },
): Promise<void> {
  // Kullanıcı çalışan fazı yönlendirmeyle durdurduysa bu bir HATA değil — analiz/oto-çözüm BAŞLATMA.
  // (YZLLM: "beni dinlemedi" — durdurma sonrası MyCL kendi analizine dalmasın, kullanıcının isteğine geçsin.)
  if (isUserInitiatedAbort()) {
    clearUserInitiatedAbort();
    emitChatMessage("system", `⏹ Faz ${n} durduruldu (sen yönlendirdin).`);
    // YZLLM 2026-06-11: kullanıcı hedef fazı zaten söyledi → OTOMATİK oradan devam (tekrar yazdırma yok).
    // setTimeout: önce bu (eski) advance-döngüsü tamamen kapansın, sonra yeni faz temiz başlasın.
    const resume = _resumePhaseAfterAbort;
    if (resume !== null) {
      _resumePhaseAfterAbort = null;
      setTimeout(() => {
        void handleRunPhase(resume, "advance").catch((e) =>
          log.error("orchestrator", "resume-after-abort failed", e),
        );
      }, 100);
    }
    return;
  }
  const message = phaseFailMessage(n, ctrl);
  emitChatMessage("error", message);
  emitPhaseChanged(n, n, "error");
  if (!runtime.state || !runtime.config) return;
  const errCtx: ErrorContext = { phase: n, message, detail: ctrl?.lastFailReason };
  // TIMEOUT-DIVERT bayrağı (mahkeme 2026-07-09 sahte-yeşil fix): bu failPhase turu bir gate-timeout divert'i mi. Öyleyse
  // aşağıdaki mahkeme-escalate→ACCEPT-CONTINUE (advanceToNextPhase) dalı ATLANIR — çünkü timeout'ta gate hiç yeniden
  // koşulmadan "geçti" saymak SAHTE-YEŞİL olur (mahkeme escalate deseni gate-fail için, timeout için değil). Bunun yerine
  // GERÇEK-çözüm (analyzeAndAskError + Faz 0 D1) devralır → fix → gate GERÇEKTEN yeniden koşulur.
  let timeoutDivertActive = false;
  // HESAP/ORTAM hatası (YZLLM 2026-06-11): kredi/bakiye yetersiz, fatura, auth/kota → PROJE hatası DEĞİL, model
  // zayıflığı DEĞİL. Her API çağrısı aynı hatayı verir → escalation (modeli pahalıya tırmandırma) + hata-analizi
  // (o da API çağrısı) ANLAMSIZ ve kısır döngü. DUR + net söyle; tırmanma/analiz/fix YAPMA.
  if (isApiAccountError(ctrl?.lastFailReason ?? "") || isApiAccountError(message)) {
    // YZLLM 2026-06-11: "API hata verince aboneliğe OTOMATİK geçmeli." Abonelik (claude CLI) varsa + şu an API'deysek
    // → tüm rolleri CLI'ye geçir (restart'sız) + kaldığı fazdan devam. Yoksa dur + net söyle.
    const onApi = (runtime.config.agent_backends?.main ?? "api") !== "cli";
    if (onApi && isClaudeAvailable()) {
      await persistAgentBackends({ orchestrator: "cli", translator: "cli", main: "cli" });
      runtime.config = null;
      await emitConfigStatus(); // reload + applyConfigDerivedSettings (restart'sız aktif)
      emitChatMessage(
        "system",
        "⚠️ Anthropic API krediniz/bakiyeniz yetersiz → **aboneliğe (Claude Code CLI) otomatik geçtim**, kaldığım " +
          "yerden devam ediyorum (API faturası kullanılmaz). Krediyi yükleyince Ayarlar'dan API'ye dönebilirsin.",
      );
      if (n >= 2) {
        await advanceToNextPhase((n - 1) as PhaseId); // aynı fazı CLI ile tekrar koş
      }
      return;
    }
    // Claude (abonelik + API) İKİSİ DE tükendi/limitli → dürüst dur + BEKLE-VE-DEVAM (YZLLM 2026-07-17,
    // canlı cave 2 saat donması: z.ai sökümü "dur"u getirmiş, otomatik devamı getirmemişti — regresyon).
    emitChatMessage(
      "system",
      "⛔ **Anthropic API krediniz/bakiyeniz yetersiz** ve çalışan abonelik (`claude`) da yok/limitli — bu " +
        "bir ortam sorunu, proje hatası DEĞİL. Otomatik tırmanma/analiz YAPMADIM — hepsi bir sağlayıcı " +
        "gerektirir, aynı hatayı verirdi. Beklemeden çözmek istersen **Plans & Billing'den kredi yükle** — " +
        "yüklersen ilk denemede kendiliğinden devam ederim.",
    );
    _drainActive = false; // MAHKEME CRITICAL: sıradaki işler aynı ölü sağlayıcıyla denemelerini yakmasın
    armLlmOutageWait("abonelik limitli + API kredisi yetersiz", makePhaseOutageResume(n));
    return; // STOP — escalation YOK, analiz YOK, fix YOK; devam zamanlayıcısı kuruldu.
  }
  // CLI ABONELİK LİMİTİ (YZLLM 2026-07-23 canlı log — "aboneliğin tekrar açılacağını unuttu"): faz hatası
  // "You've hit your session limit · resets 6:20am" imzasıyla gelince yukarıdaki isApiAccountError dalı
  // TETİKLENMİYORDU (o regex yalnız API kredi/yetki kalıpları) → akış mahkeme + hata-analizi + oto-cevap
  // döngüsüne sapıyordu (hepsi LLM ister → hepsi çöker → asılı askq) ve bekle-ve-devam YENİDEN KURULMUYORDU
  // → reset saati unutuluyordu. Emsal desen: handleUserMessage catch'i (yukarıda ~3489) aynı birleşimi kullanır.
  // MAHKEME (2026-07-23): detectCliRateLimit DEĞİL isCliUsageLimitError — lastFailReason'a Faz 5 projenin kendi
  // stderr'ini de taşır; çıplak "usage limit" imzası proje çıktısıyla karışırdı. Claude'a çapalı imza şart.
  if (isCliUsageLimitError(`${ctrl?.lastFailReason ?? ""}\n${message}`)) {
    emitChatMessage(
      "system",
      "⛔ **Claude aboneliği kullanım limitine takıldı** — bu bir ortam sorunu, proje hatası DEĞİL. Otomatik " +
        "tırmanma/analiz YAPMADIM — hepsi bir sağlayıcı gerektirir, aynı hatayı verirdi. Limit açılınca " +
        "kaldığım yerden OTOMATİK devam edeceğim.",
    );
    _drainActive = false; // sıradaki işler aynı limitli sağlayıcıyla denemelerini yakmasın
    armLlmOutageWait("abonelik kullanım limiti", makePhaseOutageResume(n));
    return; // STOP — escalation YOK, analiz YOK; devam zamanlayıcısı kuruldu (reset biliniyorsa o saate).
  }
  // GEÇİCİ API YÜKÜ (YZLLM 2026-06-17 canlı bulgu): "529 Overloaded" = Anthropic API aşırı-yük, GEÇİCİ. 5-deneme +
  // ~67s backoff sonrası bile sürüyorsa PROJE/KOD hatası DEĞİL → oto-çözüm/debug/tweak ANLAMSIZ. (Canlı kanıt:
  // 529 → tweak-modu → ajan ne yapacağını bilemeyip 9 dk cache/transcript dosyalarını kurcaladı, UI yazmadı.)
  // DUR + net rehber; kullanıcı birkaç dakika sonra "Çalıştır" ile aynı işi tekrar başlatır (auth/ortam ile aynı kalıp).
  if (/overloaded_error|"status":\s*529|\bOverloaded\b/i.test(`${ctrl?.lastFailReason ?? ""}\n${message}`)) {
    emitChatMessage(
      "system",
      "⏳ **Anthropic API şu an çok yoğun (529 Overloaded)** — 5 deneme + backoff'a rağmen geçmedi. Bu GEÇİCİ bir " +
        "yük (proje/kod hatası DEĞİL). Debug/düzeltme YAPMADIM — hepsi yine API gerektirir, aynı hatayı verirdi.",
    );
    // BEKLE-VE-DEVAM (YZLLM 2026-07-17): geçici yükte de donup kullanıcıyı bekleme — 5 dk'da bir dene.
    _drainActive = false; // MAHKEME CRITICAL: 529 sürerken kuyruk denemeleri hızla yakılmasın
    armLlmOutageWait("API 529 Overloaded", makePhaseOutageResume(n));
    return; // STOP — oto-çözüm/debug/tweak YOK (geçici API yükü); devam zamanlayıcısı kuruldu.
  }
  // GENEL ORTAM hatası (YZLLM 2026-06-11, E2BIG-döngüsü logu): E2BIG/port-dolu/komut-yok/spawn → PROJE hatası DEĞİL,
  // model zayıflığı DEĞİL. Debug/oto-çözüm döngüsü (proje kodunu kurcalar) ANLAMSIZ + ajan döngüye girer (logda
  // AC-marker'ı stub/yorumla geçmeye çalışıp sahte-yeşile kaydı). DUR + ortama-özel net rehber; tırmanma/analiz/fix YOK.
  {
    const envReason = `${ctrl?.lastFailReason ?? ""}\n${message}`;
    if (isEnvironmentError(envReason)) {
      // YZLLM 2026-07-09 ("hiçbir sorunu atlama; en doğru çözümü bul; bulamazsa orkestra farklı açılardan — işe/projeye
      // uygun"): SAF-timeout/asılma (errno'suz) + MOD AÇIK → kör-STOP yerine GERÇEK-çözüm akışına düş. decideTimeoutDivert:
      //   stop     = gerçek env (port/errno) / mod kapalı / manuel → mevcut STOP (BYTE-AYNI parite).
      //   divert   = gerçek çözüm (mahkeme reproduce-first + error-analysis + Faz 0 D1) + çok-açılı orkestra.
      //   escalate = TIMEOUT_DIVERT_MAX tükendi → dürüst görünür-dur/kuyruk (escalateUnanalyzableError; ATLAMA/sahte-yeşil DEĞİL).
      // autoAnswerSuggested() zaten hiçbir-şey-sorma'yı kapsar (decideAutoAnswer'da `if(neverAsk) return true`) → tek terim yeter.
      const modeOn = autoAnswerSuggested();
      const decision = decideTimeoutDivert({
        isTimeoutHangOnly: isTimeoutHangOnly(envReason),
        modeOn,
        divertCount: timeoutRetried.get(n) ?? 0,
      });
      if (decision === "stop") {
        emitChatMessage("system", `⛔ ${environmentErrorAdvice(envReason)}`);
        // CANLILIK (YZLLM 2026-07-18): otonom modda ortam hatasında da donma — iş kuyruğa girer;
        // yeniden denemede ajan ortam engelini FARKLI yoldan aşmayı dener (ör. farklı port/araç kurulumu).
        await ensureAutonomousContinuation(
          `ortam hatası: ${envReason.slice(0, 120)} — aynı yolu tekrarlama, engeli farklı yoldan aş (ör. farklı port/eksik aracı kur/komutu değiştir)`,
        );
        return; // STOP — proje-fix döngüsüne GİRME (mevcut davranış birebir; devam kuyruk merdiveninde).
      }
      if (decision === "escalate") {
        emitChatMessage(
          "system",
          `⛔ Faz ${n} gate'i ${TIMEOUT_DIVERT_MAX} kez teşhis+çözüm denememe rağmen asılmaya devam ediyor — otomatik ` +
            `çözemedim (kör düzeltme sahte-yeşil olurdu). Bulguyu iş listesine kaydedip GÖRÜNÜR duruyorum (atlamıyorum); ` +
            `asılan komutu elle incele.`,
        );
        await escalateUnanalyzableError(n, true, failSignature(n, ctrl));
        return;
      }
      // decision === "divert": mevcut STOP yerine GERÇEK-çözüm akışına düş (aşağıdaki derin-çözüm gövdesi).
      timeoutDivertActive = true; // mahkeme-escalate→accept-continue'yu ATLA (sahte-yeşil önleme) → gerçek-çözüm devralır.
      timeoutRetried.set(n, (timeoutRetried.get(n) ?? 0) + 1);
      emitChatMessage(
        "system",
        `🔎 Faz ${n} gate'i asıldı/timeout — kör düzeltme yerine GERÇEK sebebini teşhis ediyorum (yeniden-üretme + ` +
          `çok açılı kök-neden). Sorunu ATLAMIYORUM.`,
      );
      await enrichTimeoutContext(errCtx, n, ctrl);
      // return YOK → mahkeme reproduce-first + error-analysis + Faz 0 D1 devralır (errCtx zenginleştirildi).
    }
  }
  // qa-askq (Faz 1/2/9 niyet/hassasiyet/risk) KEŞİF ZAMAN BÜTÇESİ aşımı (zaman-kaybı planı YZLLM 2026-07-07): ajan
  // projede çok arama yaptı, sonuçlandıramadı → PROJE/KOD hatası DEĞİL. error-analysis/derin-çözüm ANLAMSIZ
  // (düzeltilecek kod yok) + boşa ~6×15dk yakar VEYA mahkeme "escalate"iyle BOŞ NİYET ilerletebilir. DUR + net rehber
  // (KATI #4 sessiz değil; DONMUŞ HEDEF #1 "geç YA DA escalate" → burada escalate=insana yönlendir).
  if ((n === 1 || n === 2 || n === 9) && /keşif.*zaman bütçesi/i.test(ctrl?.lastFailReason ?? "")) {
    emitChatMessage(
      "system",
      `⏱️ Faz ${n} keşfi zaman bütçesini aştı — ajan projede çok arama yaptı, sonuçlandıramadı. Proje çok büyükse ya ` +
        `da istek çok genişse **daha net/dar bir istekle 'Çalıştır'** ile tekrar dene. (Kod hatası değil; otomatik ` +
        `düzeltme/ilerletme YAPMADIM.)`,
    );
    // CANLILIK (YZLLM 2026-07-18): otonom modda burada donma — iş kuyruğa girer, yeniden denemede ajana
    // "keşfi DAR tut" bağlamı gider (merdiven tavanı 3 → sonsuz bütçe yakımı da yok).
    await ensureAutonomousContinuation(
      `Faz ${n} keşif zaman bütçesi aşıldı — keşfi DAR tut: en fazla birkaç hedefli arama yap, sonra mevcut proje haritası/bilgiyle KARAR ver (açık uçlu tarama yapma)`,
    );
    return; // STOP — deep-solve/mahkeme/advance YOK (boşa döngü + boş-niyet ilerletme önlenir).
  }
  // Merdiven KALDIRILDI (YZLLM 2026-06-16 "merdiven kullanmıcaz"): fail'de model yükseltme + aynı-fazı-tekrar YOK.
  // (Canlı kanıt: E2BIG yanlış-pozitifinde 3 tur boşa tırmandı.) Her faz iş-türüne uygun modelle TEK seferde çalışır
  // (escalatedModelEffort). Ortam/abort/API hataları yukarıda zaten return etti; geriye kalan gerçek proje/kod
  // hatası → doğrudan derin-çözüm (oto-çözüm) akışına düşülür (aşağıda, yalnız Oto-cevap açıkken).
  // Oto-çözüm YALNIZ "Oto-cevap" açıkken (YZLLM: "oto-cevap işaretliyse yapar onları"). Kapalıyken MyCL
  // otomatik kod değiştirmez — seçenekleri kullanıcıya sorar (otonomi = kullanıcı opt-in'i). Ek olarak
  // döngü-kıran: AYNI imza AUTO_SOLVE_MAX kez denendiyse yine sor (sahte-yeşil/sonsuz-döngü önleme).
  const otoCevap = autoAnswerSuggested();
  const sig = failSignature(n, ctrl);
  // FAZ-SEVİYESİ DÖNGÜ-KIRICI (YZLLM 2026-07-15, cave 60-döngü): saf faz-sayacı — imzadan/moddan bağımsız.
  // sig drift edince (tech-debt stderr tur-tur değişir) per-imza backstop'lar (recallAutoCount/_escalateAcceptChain)
  // döngüyü kaçırıyordu. forceFresh (recall re-entry) çift saymasın. Ortam/abort/API/qa fail'i yukarıda RETURN etti
  // (sayılmaz); timeout-divert return ETMEZ ama TIMEOUT_DIVERT_MAX=2 ile sınırlı → tek başına eşiğe (3) ULAŞAMAZ,
  // yalnız gerçek gate-fail'lerle birlikte katkı verir (haklı: asılıp+fail eden faz da döngüdür). Eşik aşılınca:
  // never-ask+testler-yeşil → oto-kabul (kullanıcı seçimi); never-ask+testler-kırmızı → dürüst park; manuel → görünür
  // kabul/dur seçenekleri (sessiz recall→Faz0 çevrimini ATLA).
  let looped = false;
  if (!opts?.forceFresh && runtime.state) {
    const streak = (gateFailStreak.get(n) ?? 0) + 1;
    gateFailStreak.set(n, streak);
    if (streak >= PHASE_LOOP_MAX) {
      looped = true;
      gateFailStreak.delete(n); // devre bir kez ateşlensin (kabul/park sonrası taze başlasın)
      await appendAuditModule(runtime.state.project_root, {
        ts: Date.now(),
        phase: n,
        event: "phase-loop-break",
        caller: "mycl-orchestrator",
        detail: `${streak} ardışık gate-fail; suiteGreen=${ctrl?.lastFailSuiteGreen ?? "?"} sig=${sig.slice(0, 80)}`,
      }).catch(() => {});
      const suiteGreen = ctrl?.lastFailSuiteGreen === true;
      if (otoCevap && suiteGreen) {
        // never-ask + testler YEŞİL (yalnız method/kalite-gate blokladı) → KULLANICI SEÇİMİ: oto-kabul + ilerle.
        // GÖRÜNÜR + PARTIAL (autoAcceptPhaseAfterLoop accepted-findings yazar + phase-complete + advance) — sessiz PASS DEĞİL.
        emitChatMessage(
          "system",
          `⚠️ Faz ${n} art arda ${streak} kez aynı kapıdan geçemedi ama test takımı YEŞİL — otomatik kabul edip ` +
            `ilerliyorum. Bu iş "mükemmel" sayılmaz (PARTIAL; denetim izi: phase-loop-break).`,
        );
        await autoAcceptPhaseAfterLoop(n);
        return;
      }
      if (otoCevap && !suiteGreen) {
        // never-ask AMA testler kırmızı/bozuk → oto-kabul ETME (bozuk kodu sessizce "tamam" saymak çıtayı düşürür).
        // İş listesine dürüstçe park + GÖRÜNÜR dur (KATI #4; DONMUŞ HEDEF — atlamıyoruz, sessizce geçmiyoruz).
        await appendTask(runtime.state.project_root, {
          id: randomUUID(),
          ts: Date.now(),
          text: `Faz ${n} art arda ${streak} kez geçemedi + testler yeşil değil (elle incele): ${(ctrl?.lastFailReason ?? "").slice(0, 200)}`,
          status: "pending",
          source: "manual",
        }).catch((e) => log.warn("orchestrator", "loop-break park task fail", e));
        emitChatMessage(
          "system",
          `⛔ Faz ${n} art arda ${streak} kez geçemedi VE test takımı yeşil değil (kod bozuk olabilir) — otomatik ` +
            `tekrarı durdurdum. Sessizce "tamam" saymıyorum (çıta düşmez); iş listesine yazdım, elle inceleyip devam et.`,
        );
        return;
      }
      // MANUEL mod → görünür kabul/dur: loopExhausted → error-analysis askq OPT_ACCEPT_PERMANENT+OPT_STOP_MANUAL sunar.
      // Sessiz recall→Faz0 çevrimini ATLA (aşağıdaki recall bloğu `!looped` ile atlanır).
      errCtx.loopExhausted = true;
      emitChatMessage(
        "system",
        `⚠️ Faz ${n} art arda ${streak} kez aynı kapıdan geçemedi — otomatik tekrarı durdurdum; "kalıcı kabul et / ` +
          `elle incele" seçeneklerini sunuyorum.`,
      );
    }
  }
  // ── CEVAP-HATIRLAMA MERDİVENİ (YZLLM 2026-07-03): MANUEL modda (oto-cevap kapalı) aynı hata-imzası yine
  // geldiyse kullanıcının önceki cevabını hatırla → Kademe 3 (onaylı) oto-uygula, yoksa Kademe 2 "aynısını
  // kullanayım mı?" onayı. Oto-cevap AÇIKKEN atlanır → mevcut auto-resolve/loop-guard (priorSolutions ile
  // farklı yaklaşım dener) sahiplenir; recall onu kısa devre yaptırıp aynı çözümü tekrarlatmamalı. forceFresh
  // (Kademe 2 "Hayır") → recall bir kez atlanır (sonsuz onay döngüsü olmaz). looped → recall ATLA (döngü kır).
  if (!otoCevap && !opts?.forceFresh && !looped && runtime.state) {
    const recalled = await recallAnswer(runtime.state.project_root, sig).catch(() => null);
    if (recalled) {
      const apply = () => applyRecalledErrorAnswer(n, sig, recalled);
      const fresh = () => failPhase(n, ctrl, { forceFresh: true });
      if (recalled.reuseApproved && !recalled.sensitive) {
        // Kademe 3 — onaylı + hassas değil → hiç sorma, oto-uygula + GÖRÜNÜR bildir (KATI#4; "bana söyleyerek devam et").
        // BACKSTOP (mahkeme): recall erken-return loop-guard'ı atlar → onaylı cevap hatayı ÇÖZMÜYORSA sessizce
        // sonsuz tekrarlanabilir. Aynı sig RECALL_AUTO_MAX kez oto-uygulandıysa DUR → görünür + taze akışa dön.
        const applied = recallAutoCount.get(sig) ?? 0;
        if (applied >= RECALL_AUTO_MAX) {
          recallAutoCount.delete(sig);
          emitChatMessage(
            "system",
            `⚠️ Onayladığın cevap (**${recalled.answer}**) Faz ${n} hatasını ${applied} otomatik denemede çözmedi — ` +
              `otomatik tekrarı durdurup yeniden değerlendiriyorum.`,
          );
          await appendAuditModule(runtime.state.project_root, {
            ts: Date.now(),
            phase: n,
            event: "answer-recall-exhausted",
            caller: "mycl-orchestrator",
            detail: recalled.answer.slice(0, 160),
          }).catch(() => {});
          await failPhase(n, ctrl, { forceFresh: true });
          return;
        }
        recallAutoCount.set(sig, applied + 1);
        emitChatMessage(
          "system",
          `♻️ Aynı hata yine oluştu (Faz ${n}) — önceki kararını uyguluyorum: **${recalled.answer}**`,
        );
        await appendAuditModule(runtime.state.project_root, {
          ts: Date.now(),
          phase: n,
          event: "answer-recall-auto",
          caller: "mycl-orchestrator",
          detail: recalled.answer.slice(0, 160),
        }).catch(() => {});
        await apply();
        return;
      }
      // Kademe 2 — kayıt var ama onaylı değil (VEYA onaylı-ama-hassas) → hafif "aynı cevabı kullanayım mı?" onayı.
      await appendAuditModule(runtime.state.project_root, {
        ts: Date.now(),
        phase: n,
        event: "answer-recall-offer",
        caller: "mycl-orchestrator",
        detail: recalled.answer.slice(0, 160),
      }).catch(() => {});
      await emitReuseConfirmAskq({
        key: sig,
        rec: recalled,
        intro: `Faz ${n}'de aynı hata yine oluştu.`,
        apply,
        fresh,
      });
      return;
    }
  }
  const prev = autoSolveSig.get(n);
  const sameSig = prev?.sig === sig;
  const priorCount = sameSig ? prev!.count : 0;
  const priorSolutions = sameSig ? prev!.priorSolutions : []; // FIX B: bu sig için önceki kararlar (aynı hataysa)
  // FIX A (YZLLM 2026-07-01): sayacı MOD-BAĞIMSIZ artır (manuel modda da). Eski set YALNIZ oto-çözüm dalındaydı
  // (satır ~899) → manuel modda priorCount hep 0 → loop-guard hiç tetiklenmez → sonsuz aynı-soru. Artık girişte
  // tek noktadan sayılır (aşağıdaki eski set kaldırıldı; çift-say yok). Farklı sig → priorCount 0'dan (reset).
  autoSolveSig.set(n, { sig, count: priorCount + 1, priorSolutions });
  // FIX B: önceki denemeleri analize taşı (aynı hataysa) → LLM aynı çözüme dönmesin.
  if (priorSolutions.length) errCtx.priorAttempts = priorSolutions;
  let autoResolve = otoCevap && priorCount < AUTO_SOLVE_MAX;
  // FIX A: exhausted manuel modda DA — MANUAL_LOOP_MAX denemeden sonra körü körüne aynı soruyu sorma; mevcut
  // exhausted yolu (rollback + mahkeme döngü-incelemesi) manuel modda da çalışır + farklı seçenek askq'sı gelir.
  const exhausted =
    (otoCevap && priorCount >= AUTO_SOLVE_MAX) || (!otoCevap && priorCount >= MANUAL_LOOP_MAX);
  // FIX A: manuel-loop tükendiyse askq eski çözümleri TEKRAR sunmasın (farklı seçenek seti).
  if (exhausted && !otoCevap) errCtx.loopExhausted = true;
  // ⚖️ MAHKEME (sorun-zamanı / problem-triggered, YZLLM tasarımı): otomatik fix dispatch'inden ÖNCE müfettiş bu
  // faz-hatasını BAĞLAYICI inceler — gerçek kod sorunu mu, false-positive/gereksiz mi. Merkezi yol KUTSAL →
  // force-pass YOK: suppress/escalate (fix gereksiz/riskli/false-positive) → otomatik fix YERİNE İNSANA yönlendir
  // (autoResolve=false; mevcut askq makinesi devralır). proceed → normal oto-çözüm. Flag KAPALIYSA atlanır
  // (davranış değişmez, sıfır risk). Yalnız oto-çözüm GERÇEKTEN denenecekken konuşur (gereksiz mahkeme yok).
  let mahkemeDiverted = false;
  if (autoResolve && runtime.config.features.inspector_enabled) {
    try {
      // 4c (çift-inceleme dedup): gate-loop bu bulguyu ZATEN escalate olarak inceleyip mechHolder'a taşıdıysa
      // (outcome DEĞİŞMEDİ) → yeniden inceleme (tam Sonnet agentik pass + Bash repro) REDUNDANT → #1'in hükmünü
      // reuse et. Aksi (proceed→reOutcome yeni hata / inceleme koşmadı) normal incele + dersi kaydet (reuse'da #1
      // zaten kaydetti → çift-kayıt yok). Reuse yalnız escalate → fail-closed (autofix'e değil insana/rapora doğru).
      let ruling: MahkemeRuling;
      if (ctrl?.priorGateRuling) {
        ruling = { convened: true, action: ctrl.priorGateRuling.action, summary: ctrl.priorGateRuling.summary };
        log.info("orchestrator", "4c: gate-loop mahkeme hükmü reuse edildi (çift-inceleme atlandı)", { phase: n, action: ruling.action });
      } else {
        const insp = await inspectGateFinding(runtime.config, {
          projectRoot: runtime.state.project_root,
          gateLabel: `Faz ${n}`,
          errors: ctrl?.lastFailReason ?? message,
        });
        ruling = mahkemeRuling(insp);
        // TECRÜBE-RECORD (Parça 2): mahkeme kararını derse çevir (sorun→kanıtlı-çözüm→ilke; best-effort).
        await recordMahkemeLesson({
          projectRoot: runtime.state.project_root,
          config: runtime.config,
          signature: `Faz ${n} ${(ctrl?.lastFailReason ?? message).slice(0, 100)}`,
          problem: ctrl?.lastFailReason ?? message,
          result: insp,
          ruling,
          ts: Date.now(),
        });
      }
      // ENGEL AĞIRLIĞI (YZLLM 2026-07-28): kanıt taşıyan fazda "escalate" (müfettiş çözemedi/kararsız) kabul-devam
      // ETMEZ — doğrulanmamış işi "tamamlandı" damgalamak en kötü sonuç. Gerçek çözüm yoluna düşülür (aşağıdaki
      // oto-fix/hata-analizi akışı); tükenirse iş kuyruğa yazılıp pipeline park eder (sahte yeşil yok).
      // "suppress" HARİÇ: orada iki bağımsız değerlendirme KANITLA false-positive demiştir.
      // DENETİM YAPILAMADI ≠ KUŞKULU BULGU (YZLLM kararı 2026-07-30, canlı cave: "değerlendirme üretilemedi"
      // 129 kez → hepsi "kabul-devam" ile geçti, hiçbir denetim olmadan). Müfettişe SAĞLAYICI yüzünden hiç
      // ulaşılamadıysa ortada bir hüküm YOKTUR; bunu "otomatik modda akış bloklanmadı" diye geçmek, kontrol
      // edilmemiş işi kontrol edilmiş göstermektir. Bu dal kanıt taşıyan faz dalıyla AYNI yola gider: gerçek
      // çözüm denenir. Art arda 3 kez ulaşılamazsa dürüstçe durur (aşağıdaki devre kesici).
      const providerEscalate = ruling.action === "escalate" && ruling.providerUnavailable === true;
      if (providerEscalate) {
        _inspectorUnavailableChain++;
        await appendAuditModule(runtime.state.project_root, {
          ts: Date.now(),
          phase: n,
          event: "mahkeme-escalate-refused-provider",
          caller: "mycl-orchestrator",
          detail: `müfettişe ulaşılamadı (${_inspectorUnavailableChain}. kez) — kabul-devam reddedildi, gerçek çözüme yönlendirildi`,
        }).catch(() => {});
        if (_inspectorUnavailableChain > INSPECTOR_UNAVAILABLE_MAX) {
          emitChatMessage(
            "system",
            `⛔ Müfettişe art arda ${_inspectorUnavailableChain} kez ulaşılamadı (sağlayıcı sınırı/kredi). Denetim ` +
              `yapılamadan devam etmiyorum — bu iş "tamamlandı" SAYILMADI. Erişim dönünce KALDIĞIM FAZDAN otomatik süreceğim.`,
          );
          _drainActive = false;
          armLlmOutageWait("müfettişe erişilemiyor", makePhaseOutageResume(n));
          return; // advance YOK → halt; ilerleme korunur (reconcile kesintide state'i sıfırlamaz)
        }
        emitChatMessage(
          "system",
          `⚠️ Faz ${n}: bağımsız denetim yapılamadı (müfettişe ulaşılamadı) — bunu "geçti" saymıyorum. Hatanın ` +
            `gerçek çözümünü deniyorum.`,
        );
        // proofGateEscalate ile aynı yola düş: aşağıdaki kabul-devam dalı ATLANIR, gerçek çözüm akışı sürer.
      } else if (ruling.action !== "escalate") {
        _inspectorUnavailableChain = 0; // müfettiş konuştu (agree/suppress/flag) → sağlayıcı zinciri kırıldı
      }
      const proofGateEscalate = ruling.action === "escalate" && PROOF_BEARING_PHASES.has(n);
      if (proofGateEscalate) {
        await appendAuditModule(runtime.state.project_root, {
          ts: Date.now(),
          phase: n,
          event: "mahkeme-escalate-refused-proof-gate",
          caller: "mycl-orchestrator",
          detail: `kanıt taşıyan faz — kabul-devam reddedildi, gerçek çözüme yönlendirildi: ${ruling.summary.slice(0, 300)}`,
        }).catch(() => {});
        emitChatMessage(
          "system",
          `⛔ Faz ${n} bu işin ÇALIŞTIĞINI kanıtlayan kapılardan biri ve kırmızı. Müfettiş kesin hüküm veremedi ` +
            `("escalate") — bunu kabul edip devam ETMİYORUM, çünkü doğrulanmamış işi "tamamlandı" saymak en kötü ` +
            `sonuç olurdu. Gerçek çözümü deniyorum; çözemezsem işi kuyruğa yazıp duracağım ve sana söyleyeceğim.` +
            `\n${ruling.summary}`,
          { modelRole: "inspector" },
        );
      }
      if (
        ruling.convened &&
        ruling.action !== "proceed" &&
        !timeoutDivertActive &&
        !proofGateEscalate &&
        !providerEscalate // denetim hiç yapılamadı → kabul-devam YOK (gerçek çözüme gider)
      ) {
        // TIMEOUT-DIVERT İSTİSNASI (mahkeme 2026-07-09 sahte-yeşil fix): timeout-divert'te bu accept-continue dalı
        // ATLANIR — gate hiç yeniden koşulmadan "escalate → advanceToNextPhase" ile geçmek SAHTE-YEŞİL olurdu (E2E
        // koşmadı). Timeout-divert'te mahkeme escalate/suppress dese bile GERÇEK-çözüm (analyzeAndAskError + Faz 0 D1)
        // devralır → fix → gate GERÇEKTEN yeniden koşulur (index.ts:5257 pass / reOutcome doğrulaması).
        // FROZEN-GOAL (escalate-stall fix, canlı Arcelik_BO 2026-06-22): bu noktada otoCevap ZATEN açık
        // (mahkeme yalnız autoResolve=otoCevap iken koşar). Oto-modda askq'da BLOKLAMAK = SESSİZ STALL
        // (kullanıcı izlemiyor → soru cevapsız asılı kalır; frozen-goal "asla sessizce tıkanma" ihlali —
        // canlı kanıt: Faz 10 false-positive/auth bulgusunda donma). Çözüm: LOUD ACCEPT-CONTINUE — bulgu
        // RAPORA/audit'e yazılır (YUTULMAZ), çalışan kod riske atılmaz (oto-fix YOK), faz kabul-devam eder
        // (insan sonra raporu inceler). Faz 13 güvenlik yolundaki kanıtlı desenin genel failPhase'e taşınması.
        mahkemeDiverted = true;
        // DÖNGÜ EMNİYETİ (YZLLM 2026-07-13, canlı sahte-tamamlanma): "escalate" = müfettiş ÇÖZEMEDİ/erişilemedi
        // (suppress'ten FARKLI — o kanıtlı false-positive). Art arda escalate-accept = SİSTEMATİK müfettiş-fail
        // (rate-limit/LLM-fail) → tüm pipeline'ı sahte-"done" yapmadan DÜRÜST DUR. suppress sayılmaz (yalnız escalate).
        if (ruling.action === "escalate") {
          _escalateAcceptChain++;
          if (_escalateAcceptChain > ESCALATE_ACCEPT_MAX) {
            await appendAuditModule(runtime.state.project_root, {
              ts: Date.now(),
              phase: n,
              event: "escalate-accept-circuit-break",
              caller: "mycl-orchestrator",
              detail: `art arda ${_escalateAcceptChain} faz müfettiş-fail escalate → sistematik erişim sorunu; sahte-tamamlanma önlendi (halt)`,
            }).catch(() => {});
            emitChatMessage(
              "system",
              `⛔ Müfettiş art arda ${_escalateAcceptChain} fazda değerlendirme üretemedi (sistematik erişim sorunu — sağlayıcı ` +
                `sınırı/anahtar olabilir). Pipeline'ı DURDURDUM: bu iş "tamamlandı" SAYILMADI (sahte-yeşil önlendi). ` +
                "İş kuyruğa geri dönecek; erişim düzelince kaldığı yerden OTOMATİK denenecek.",
            );
            // YZLLM 2026-07-18: drain'i kapat (aynı ölü sağlayıcıyla sıradaki işleri de yakmasın) +
            // bekle-ve-devam kur — erişim dönünce kuyruk kendiliğinden sürer (iş düşürülmez, pending'e döner).
            _drainActive = false;
            armLlmOutageWait("müfettiş sistematik erişim sorunu", makePhaseOutageResume(n));
            return; // advanceToNextPhase YOK → halt; görev done sayılmaz (reconcile pending'e döndürür)
          }
        }
        await appendAuditModule(runtime.state.project_root, {
          ts: Date.now(),
          phase: n,
          event: `mahkeme-${ruling.action}-accept-continue`,
          caller: "mycl-orchestrator",
          detail: ruling.summary.slice(0, 400),
        }).catch(() => {});
        // Sonnet müfettiş düzeltmesi: suppress (false-positive KANITLANDI) ile escalate (KUŞKULU/çözülmedi)
        // davranışı aynı (oto-modda kabul-devam, frozen-goal) AMA ANLAMI farklı → mesajı ayrıştır (kullanıcı
        // suppress'i "kanıtlı geçti", escalate'i "kuşkulu, sonra incele" olarak görsün; yanlış sinyal verme).
        emitChatMessage(
          "system",
          ruling.action === "suppress"
            ? `⚖️ Mahkeme (suppress): Faz ${n} bulgusu FALSE-POSITIVE kanıtlandı (iki bağımsız değerlendirme kanıtla ` +
                `hemfikir) — oto-fix yapılmadı, geçti sayıldı.\n${ruling.summary}`
            : `⚖️ Mahkeme (escalate): Faz ${n} bulgusu KUŞKULU/çözülmedi — otomatik modda akış bloklanmadı (sessiz ` +
                `tıkanma önleme), RAPORA yazıldı, çalışan kod riske atılmadı; sonra incele.\n${ruling.summary}`,
          { modelRole: "inspector" },
        );
        await advanceToNextPhase(n);
        return;
      }
    } catch (e) {
      log.warn("orchestrator", "mahkeme failPhase incelemesi hata (yutuldu → normal akış)", { error: String(e) });
      // SESSİZ FALLBACK YOK (CLAUDE.md #4): mahkeme erişilemezse sistem denetimsiz akışa düşüyordu, kullanıcı
      // bunu hiç görmüyordu → görünür kıl. Davranış (normal akış) korunur; yalnız bildirim eklenir.
      emitChatMessage("system", "⚖️ Mahkeme (faz hatası) erişilemedi — inceleme atlandı, normal otomatik akışa düşüldü (denetimsiz). Müfettişe ulaşılamıyorsa anahtar/bağlantıyı kontrol et.");
    }
  }
  // HİÇBİR ŞEY SORMA + FOREIGN GÖSTER (YZLLM 2026-07-09 "göster+oto"): otomatik çözüm (analyzeAndAskError autoResolve →
  // concrete-solution dispatch) var olan yabancı kodu değiştirebilir → uygulanmadan farkındalık göster. no-op if non-foreign.
  if (autoResolve) emitForeignAutoFixNotice("hata otomatik çözülüyor (kod düzeltmesi uygulanabilir)");
  if (!autoResolve && !mahkemeDiverted) {
    emitChatMessage(
      "system",
      !otoCevap
        ? "ℹ️ Oto-cevap kapalı — hatayı otomatik düzeltmiyorum; seçenekleri sana soruyorum (Oto-cevap'ı açarsan otomatik çözer)."
        : `ℹ️ Aynı hata ${AUTO_SOLVE_MAX} otomatik çözüm denemesine rağmen sürüyor — demek ki sorun değiştirdiğim yerde DEĞİL.`,
    );
  }
  // YZLLM 2026-06-10: "oto-cevap açıksa ve geri almaktan başka çare yoksa MyCL kendi geri alsın."
  // Tükenme = aynı hata MAX denemeye rağmen sürüyor → denemeler işe yaramadı, üstelik junk biriktirmiş olabilir.
  // Oto-cevap açıkken: dizinin EN TEMİZ snapshot'ına (ilk fix öncesi) otomatik GERİ DÖN, sonra seçenekleri sor.
  let mahkemeLoopSummary: string | null = null;
  if (exhausted) {
    const rb = takeRollback();
    if (rb) {
      const ok = await restoreSnapshot(rb, runtime.state.project_root);
      emitChatMessage(
        "system",
        ok
          ? `↩️ Otomatik düzeltmeler bu hatayı çözmedi — başarısız değişiklikleri **geri aldım** (${rb.method === "git" ? "git checkpoint" : "yedek"}; ilk denemeden önceki temiz hale).`
          : `⚠️ Geri alma denedim ama tam başarılı olamadı (${rb.method}). Değişiklikleri elle kontrol etmen gerekebilir.`,
      );
    } else {
      emitChatMessage("system", "Geri alınacak snapshot yok.");
    }
    // ⚖️ MAHKEME — DÖNGÜ SINIFI (frozen-goal kanonik örneği). Tükenme = aynı hata AUTO_SOLVE_MAX kez
    // düzelmedi → bu, orkestratörün YAPISAL kör-noktası: "yanlış yeri mi düzeltiyorum / olmayan sorunu mu
    // kovalıyorum"u kendi soramaz (Faz N↔0 döngüsünü göremedi). BAĞIMSIZ müfettiş (Sonnet, çapraz-aile)
    // döngüyü inceler (loop sinyali → tam tartışma). suppress (iki bilim insanı KANITLA hemfikir + düşük-risk)
    // → fantom döngü KIRILIR, kabul-devam (çalışan koda dönüldü + dokümante). proceed/escalate → kullanıcıya
    // sorulur AMA müfettişin bağımsız okuması ekli (zengin escalation; kör-nokta görünür). Flag kapalı → davranış değişmez.
    if (runtime.config.features.inspector_enabled) {
      try {
        const insp = await inspectGateFinding(runtime.config, {
          projectRoot: runtime.state.project_root,
          gateLabel: `Faz ${n}`,
          errors: ctrl?.lastFailReason ?? message,
          loop: { attempts: priorCount },
        });
        const ruling = mahkemeRuling(insp);
        // TECRÜBE-RECORD (Parça 2): döngü-mahkemesi kararını derse çevir (best-effort).
        await recordMahkemeLesson({
          projectRoot: runtime.state.project_root,
          config: runtime.config,
          signature: `Faz ${n} ${(ctrl?.lastFailReason ?? message).slice(0, 100)}`,
          problem: ctrl?.lastFailReason ?? message,
          result: insp,
          ruling,
          ts: Date.now(),
        });
        if (ruling.convened) {
          await appendAuditModule(runtime.state.project_root, {
            ts: Date.now(),
            phase: n,
            event: `mahkeme-döngü-${ruling.action}`,
            caller: "mycl-orchestrator",
            detail: ruling.summary.slice(0, 400),
          }).catch(() => {});
          if (ruling.action === "suppress" && !timeoutDivertActive) {
            // TIMEOUT-DIVERT İSTİSNASI (mahkeme minor 2026-07-09 — correct-by-construction): birinci mahkemedeki
            // (1292) sahte-yeşil guard'ının İKİZİ. Timeout-divert'te suppress→advanceToNextPhase de gate'i yeniden
            // koşmadan geçirir (sahte-yeşil). Bugün TIMEOUT_DIVERT_MAX(2)<AUTO_SOLVE_MAX(6) yüzünden bu dala
            // ULAŞILMAZ; yine de örtük-tesadüf yerine AÇIK invariant: timeout-divert → gerçek-çözüm (analyzeAndAskError).
            emitChatMessage(
              "system",
              `⚖️ Mahkeme (döngü → suppress): Faz ${n} hatası ${priorCount} denemeye rağmen sürüyordu çünkü ` +
                `GERÇEK bir kod sorunu DEĞİL (false-positive — iki bağımsız değerlendirme kanıtla hemfikir, ` +
                `düşük-risk). Çalışan koda geri dönüldü, bulgu rapora yazıldı, devam ediliyor.\n${ruling.summary}`,
              { modelRole: "inspector" },
            );
            await advanceToNextPhase(n);
            return;
          }
          mahkemeLoopSummary = ruling.summary;
        }
      } catch (e) {
        log.warn("orchestrator", "mahkeme döngü-incelemesi hata (yutuldu → normal akış)", { error: String(e) });
        emitChatMessage("system", "⚖️ Mahkeme (döngü incelemesi) erişilemedi — inceleme atlandı, normal akışa düşüldü (denetimsiz).");
      }
    }
  }
  if (mahkemeLoopSummary) {
    emitChatMessage(
      "system",
      `🕵️ Müfettişin bağımsız döngü okuması (kararına yardımcı; orkestratörün göremediği açı):\n${mahkemeLoopSummary}`,
      { modelRole: "inspector" },
    );
  }
  runtime.pendingErrorAnalysis = await analyzeAndAskError(runtime.state, runtime.config, errCtx, {
    autoResolve,
  }).catch(() => null);
  // FIX B: bu askq'nın hata-imzasını park kaydına taşı → kullanıcı cevap verince (handleAskqAnswer) seçimi bu sig'e kaydedilir.
  if (runtime.pendingErrorAnalysis) runtime.pendingErrorAnalysis.sig = sig;
  const pendingAuto = runtime.pendingErrorAnalysis;
  if (pendingAuto?.auto_selected_solution) {
    // FIX B kaydı BURADA YAPILMAZ (mahkeme HIGH 2026-07-18): aşağıdaki handleAskqAnswer aynı (phase,sig)
    // için EN çeviriyi kaydediyor; buradaki TR kayıt çift + dil-karışık priorSolutions üretiyordu.
    // Aynı routing'i (askq-cevap dalı) otomatik sür — soru kartı hiç açılmadı.
    const routed = await handleAskqAnswer(pendingAuto.id, pendingAuto.auto_selected_solution)
      .then(() => true)
      .catch((e: unknown) => {
        log.error("orchestrator", "auto-solve routing failed", e);
        return false;
      });
    // FIX #3 (frozen-goal): oto-route throw etti + yeni park açılmadı → sessiz drop olmasın → fallback escalate.
    if (!routed && !runtime.pendingErrorAnalysis) await escalateUnanalyzableError(n, autoResolve, sig);
  } else if (!pendingAuto) {
    // FIX #1 (frozen-goal EVRENSEL kök): hata analizi HİÇ üretilemedi (null) → eski davranış sessiz drop'tu →
    // artık pass-or-escalate (fallback askq + oto-modda OPT_QUEUE oto-route).
    await escalateUnanalyzableError(n, autoResolve, sig);
  }
}

/**
 * Config'ten TÜREYEN modül-singleton'ları uygula (YZLLM 2026-06-10: "kapatıp açmadan da aktif olsun").
 * Backend (api/cli) zaten runtime.config'ten okunur — ama sandbox politikası + cache TTL gibi singleton'lar
 * yalnız boot'ta set ediliyordu → ayar değişince restart gerekiyordu. Artık her config-yüklemede yenilenir.
 * Tek nokta: emitConfigStatus + open_project bunu çağırır → yeni singleton eklenince TEK yerde güncellenir.
 */
function applyConfigDerivedSettings(config: MyclConfig): void {
  setSandboxPolicy(config.claude_code_flags.agent_sandbox_policy ?? "enforce");
  setCacheTtl(config.claude_code_flags.cache_ttl);
  // Sohbet rozeti (YZLLM 2026-07-28): hangi cevabı hangi model verdi. Config'ten TÜRER → kullanıcı modeli
  // değiştirince rozet de anında doğru (bayat model adı gösterilmez). MAHKEME (2026-07-28): orkestratör rozeti
  // `selected_models.orchestrator ?? main` DEĞİL — ajanın GERÇEKTE kullandığı çözümleyici `orchestratorModelId`
  // (= model_tiers.strong; eski orchestrator/main override'ı kullanılmıyor). Yanlış model yazmak = yalan atıf.
  // inspector çapraz-aile sabiti (kullanıcı ayarına bağlı DEĞİL — inspector.ts tek kaynak).
  setChatModelIds({
    orchestrator: orchestratorModelId(config.selected_models),
    main: config.selected_models.main,
    translator: config.selected_models.translator,
    inspector: INSPECTOR_MODEL_DEFAULT,
  });
}

/**
 * Katalog DIŞI model ayarlarını GÖRÜNÜR yapar (YZLLM 2026-08-04, KATI #4).
 *
 * Eskiden bu modeller sessizce katalog varsayılanıyla değiştiriliyordu — kullanıcının `claude-opus-5`
 * ayarı hiç uygulanmıyor, hiçbir yerde de söylenmiyordu. Artık ayar aynen uygulanıyor; kullanıcı
 * MyCL'in o modeli tanımadığını bir kez görür (katalog bayatladıysa çözüm katalogu güncellemek).
 * `modelChoiceLineIfChanged` süzgeci sayesinde satır proje başına bir kez basılır, faz başına değil.
 */
function emitUnknownModelWarning(sel: SelectedModels): void {
  const unknown = auditConfiguredModels(sel);
  if (unknown.length === 0) return;
  const list = unknown.map((u) => `**${u.id}** (${u.role})`).join(", ");
  const line = `ℹ️ ${list} MyCL kataloğunda yok — ayarın olduğu gibi kullanılıyor, değiştirilmiyor. Model geçersizse çağrı görünür hatayla düşer.`;
  const once = modelChoiceLineIfChanged("unknown-model-audit", line);
  if (once) emitChatMessage("system", once);
}

/** Config'i yüklemeyi dener, durumu UI'a yollar. */
async function emitConfigStatus(): Promise<boolean> {
  try {
    runtime.config = await loadConfig();
    applyConfigDerivedSettings(runtime.config); // restart'sız aktif: singleton'ları her yüklemede tazele
    log.info("config", "loaded", {
      selected_models: runtime.config.selected_models,
    });
    emitUnknownModelWarning(runtime.config.selected_models);
    emit("config_status", { ready: true });
    return true;
  } catch (err) {
    if (err instanceof ApiKeyMissingError) {
      log.warn("config", "api keys missing");
      emit("config_status", { ready: false, reason: "api_keys_missing" });
    } else if (err instanceof ModelSelectionMissingError) {
      log.warn("config", "model selection missing");
      emit("config_status", { ready: false, reason: "model_selection_missing" });
    } else {
      log.error("config", "load failed", err);
      emit("config_status", {
        ready: false,
        reason: "load_failed",
        detail: String(err),
      });
    }
    return false;
  }
}

// Resume/redirect dalları KENDİ durum mesajını (state+action) bastığında true → jenerik özet BASTIRILIR
// (MAHKEME CRITICAL 2026-07-19: fire-and-forget resume state'i güncellemeden jenerik özet BAYAT okuyup
// ÇELİŞKİLİ mesaj basıyordu — "niyet bekliyorum" + "devam ediyorum"). Her açılış başında sıfırlanır.
let _openStatusHandledInline = false;

async function handleOpenProject(path: string, integrate = false): Promise<void> {
  await handleOpenProjectInner(path, integrate);
  // "HER ZAMAN durum özeti" (YZLLM 2026-07-19): tüm açılış/resume/kuyruk dallarından SONRA, kullanıcı
  // ne durumda olduğunu + ne yapması gerektiğini TEK bakışta görsün. Deterministik, fail-soft. Resume dalı
  // kendi durum+action mesajını bastıysa (inline) jenerik özet ATLA (çelişki/çift-durum önleme).
  if (!_openStatusHandledInline) {
    await emitOpenStatusSummary().catch((e) => log.warn("orchestrator", "açılış durum özeti başarısız", { error: String(e) }));
  }
}

/**
 * DETERMİNİSTİK açılış durum özeti — state + kuyruk + EDD anlık görüntüsünden "📍 Durum / Yapman gereken"
 * mesajı basar. Eski LLM boot-narrator'ın (runBootStatusCheck) yerini alır: o kuyrukta iş varken susuyordu
 * (her-zaman garantisi yoktu) + token yakıyordu + prompt-kırılgandı. ASLA throw etmez (caller yutar).
 */
/**
 * SAF-değil: açılış durum SNAPSHOT'unu (state + kuyruk + EDD) topla → composeOpenStatus girdisi. Boot'ta İKİ
 * yerde kullanılır: (1) faz-durumu emit'i (index.ts:2076 idle/aktif statü) ve (2) durum-özeti mesajı — İKİSİ AYNI
 * girdiden composeOpenStatus çağırır → mesaj ile faz-göstergesi ARASINDA drift imkansız. state yoksa null.
 */
async function gatherOpenStatusInput(): Promise<OpenStatusInput | null> {
  const st = runtime.state;
  if (!st) return null;
  const root = st.project_root;
  const tasks = await readTasks(root).catch(() => []);
  const running =
    tasks.find((t) => t.id === runtime.currentTaskId) ?? tasks.find((t) => t.status === "running") ?? null;
  const pendingCount = tasks.filter((t) => (t.status ?? "pending") === "pending" && (t.attempts ?? 0) < MAX_TASK_AUTO_RETRIES).length;
  // Otomatik denenmez (deneme hakkı dolmuş) ama kuyrukta GÖRÜNÜR bekleyen işler — özet "işim yok" DEMESİN
  // (YZLLM 2026-07-24 ekranı: 7 böyle iş varken "bekleyen bir işim yok" çelişkisi).
  const stalledCount = tasks.filter((t) => (t.status ?? "pending") === "pending" && (t.attempts ?? 0) >= MAX_TASK_AUTO_RETRIES).length;
  const isForeign = st.origin === "foreign";
  let eddDone = 0, eddTotal = 0, eddPending = 0;
  if (isForeign) {
    try {
      const e = summarizeProgress(await readEddProgress(root));
      eddDone = e.done; eddTotal = e.total; eddPending = e.pending;
    } catch { /* edd yoksa 0 kalır */ }
  }
  return {
    currentPhase: st.current_phase,
    intentEmpty: !st.intent_summary || st.intent_summary.trim() === "",
    isForeign,
    pendingDiagnostic: st.pending_diagnostic != null,
    pendingUiReview: st.pending_ui_review === true,
    runningTaskText: running?.text ?? null,
    pendingTaskCount: pendingCount,
    stalledTaskCount: stalledCount,
    eddDone, eddTotal, eddPending,
  };
}

async function emitOpenStatusSummary(): Promise<void> {
  const input = await gatherOpenStatusInput();
  if (!input) return;
  emitChatMessage("assistant", formatOpenStatus(composeOpenStatus(input)));
}

async function handleOpenProjectInner(path: string, integrate = false): Promise<void> {
  log.info("orchestrator", "open_project", { path, integrate });
  _openStatusHandledInline = false; // her açılışta taze; inline resume dalları set eder
  // Yeni proje → güvenlik yakınsama-kırıcı durumunu sıfırla (eski projenin sayacı taşınmasın).
  _securityFindingsPrev = null;
  _securityNoProgress = 0;
  // GÜVENLİK (mahkeme, YZLLM 2026-07-03): eski projenin bayat bulgu-kuyruğunu temizle — yoksa yeni projede
  // bir Faz 13 varışı intercept'e takılıp GERÇEK güvenlik gate'ini sessizce bypass edebilir (KATI #4).
  runtime.findingQueue = null;
  // Netleştirme-mahkemesi sayacı da sıfırlanmalı (Pillar A): yoksa eski projede CLARIFY_INSPECT_MAX'a
  // ulaşan sayaç yeni projeye TAŞINIR → yeni projenin ilk gerçek netleştirme sorusu sessizce bastırılır.
  _clarifyInspectChain = 0;
  _autoAnswerChain = 0; // otonom-cevap döngü sayacı da sıfır (yeni proje → eski sayaç taşınmasın).
  _escalateAcceptChain = 0; // escalate-kaskat devre-kesici sayacı da sıfır (yeni proje → eski sayaç taşınmasın).
  _inspectorUnavailableChain = 0;
  // Timeout-divert sayacı da sıfırlanmalı (mahkeme minor 2026-07-09): faz-numarasıyla anahtarlı → eski projede TIMEOUT_
  // DIVERT_MAX'a ulaşan sayaç yeni projeye TAŞINIR → yeni projenin İLK timeout'u yanlışça "tükendi" sayılıp erken escalate olur.
  timeoutRetried.clear();
  gateFailStreak.clear(); // faz-seviyesi döngü sayacı da sıfır (yeni proje → eski sayaç taşınmasın).
  _batchFailedIds.clear(); // ⚡ paralel küme tek-atış seti de sıfır (proje değişti; eski id'ler anlamsız).
  // MAHKEME HIGH (2026-07-16): bayat askq + kullanıcı-tetikli pending'ler proje-BAĞIMSIZ global durumda
  // yaşıyordu → proje A'nın plan/full-test/bakım onayı proje B'de yanlışlıkla cevaplanabilirdi
  // (answer_askq top-of-stack'i proje kontrolsüz yönlendirir; pendingPlan onayı AKTİF projenin kuyruğuna
  // yazar). Proje değişiminde HEPSİNİ temizle — eski projenin sorusu yeni projede yaşayamaz.
  clearActiveAskq();
  cancelLlmOutageWait(); // eski projenin bekle-ve-devam zamanlayıcısı yeni projede ateşlenemez
  _lastDevelopText = null; // MAHKEME CRITICAL (2026-07-18): eski projenin iş metni yeni projeye SIZAMAZ
  _pendingStopReason = null;
  runtime.pendingDast = null;
  runtime.pendingFullTest = null;
  runtime.pendingMaintenance = null;
  runtime.pendingPlan = null;
  runtime.pendingPlanEdit = null;
  runtime.currentBatch = null;
  // YZLLM 2026-07-01 (FIX C): model-satırı cache'i sıfırla → yeni projede ilk model-seçim satırı yine görünür.
  resetModelChoiceCache();
  // FIX D (mahkeme): tech-debt son-bulgu deposunu da temizle (proje-değişiminde eski bulgular accept'e sızmasın).
  resetLastTechDebtFindings(path);
  // Aktif controller varsa yeni proje açma — state ortasında değişim yasak.
  if (runtime.controller) {
    emitError("Bir faz çalışıyor — önce mevcut projeyi kapatın", {
      phase: runtime.state?.current_phase,
    });
    _openStatusHandledInline = true; // emitError durum+action'ı söyledi → jenerik özet basma
    return;
  }
  try {
    if (!runtime.config) {
      const ok = await emitConfigStatus();
      if (!ok) return;
    } else {
      // runtime.config zaten yüklenmiş (orchestrator process önceden boot
      // edilmiş, frontend Tauri reload / Vite HMR ile resetlenmiş olabilir).
      // Frontend configStatus "unknown" başlar — emit etmezsek "ready" state'e
      // geçmez ve `load_messages` boot effect'i tetiklenmez → history boş kalır.
      // Idempotent re-emit: backend loadConfig çağırmadan event yollanır.
      emit("config_status", { ready: true });
    }
    // Onboarding (yabancı projeyi entegre et — "Proje Aç"): klasörü loadOrInit'ten ÖNCE sınıflandır.
    // loadOrInit `.mycl/state.json` yazınca sınıf "mycl"e döner → foreign tespiti kaçardı (mahkeme Mercek-A/B/C).
    // classifyOpenedFolder fail-safe (erişim hatası → "empty", throw etmez) → her açılışı bozma riski yok.
    const folderClass = await classifyOpenedFolder(path);
    runtime.state = await loadOrInit(path);
    await log.rotateForProject(path);
    // Persistence root'u set et — sonraki emit'ler history.log'a yazılır.
    // Erken set: loadOrInit sonrası ilk emit'ler de kaydedilsin.
    setHistoryRoot(path);
    setAgentTraceRoot(path); // ajan-içi tam iz aynı projeye yazsın (kör nokta kalmasın)
    // v15.11 GÜVENLİK: config-türevi singleton'lar (sandbox politikası + cache TTL). Tek nokta:
    // applyConfigDerivedSettings (emitConfigStatus de çağırır → ayar değişince restart'sız tazelenir).
    if (runtime.config) applyConfigDerivedSettings(runtime.config);
    // YZLLM 2026-06-15: Açılışta mevcut proje teknik dökümanını "Proje Dökümanı"
    // butonuna push et (varsa). Yoksa sessiz — Faz 17 üretip sonra emit eder.
    // (Kullanım kılavuzu artık projenin İÇİNDE; MyCL'de Kılavuz butonu kaldırıldı.)
    void fsReadFile(pathJoin(path, ".mycl", "tech-doc.md"), "utf-8")
      .then((c) => {
        if (c.trim()) emitTechDoc(c);
      })
      .catch(() => {});
    // v15.6: NDJSON record metadata bağlamı (session/iter/phase) — her append
    // edilen satıra otomatik enjekte edilir, ilerde dataset için anchor alan.
    setRecordContext({
      session_id: runtime.state.session_id,
      iteration: runtime.state.iteration_count ?? 1,
      phase: runtime.state.current_phase,
    });
    // v15.6: SCHEMA.md asset'i projeye kopyala — kullanıcı / analizci
    // `.mycl/SCHEMA.md` ile dosya formatlarını görür. Her boot'ta overwrite
    // (MyCL güncellenirse şema doc'u taze kalır). Sessiz fail (asset eksikse
    // boot'u bloklamasın).
    void copySchemaDocToProject(path).catch((err: unknown) =>
      log.warn("orchestrator", "SCHEMA.md copy failed", err),
    );
    // OE denetimi (YZLLM onayı 2026-07-29): git olmayan projede YEREL git deposu başlat — checkpoint/
    // rollback, Faz 9 tech-debt taraması ve değişen-dosya sinyalleri git'siz projede de çalışsın (canlı
    // cave kanıtı: git yok → her iterasyon FULL güvenlik taraması → aynı 26 bulgu 42 kez). AWAIT bilinçli
    // (mahkeme bulgusu): arka planda bırakılırsa boot işi git init bitmeden git durumuna bakabilirdi.
    // Fail-soft (başaramazsa mevcut git'siz akış sürer, neden görünür); uzak sunucu YOK, global config'e
    // dokunulmaz. Zaten git'liyse sessiz no-op. Yabancı köken projeler BİLEREK dahil (mahkeme sorusu,
    // karar): OE-3'ün kanıtı ve amacı tam da yabancı köken git'siz bir projeydi (cave) — mesaj görünür,
    // .git tek klasör, kullanıcı isterse siler.
    try {
      const repoInit = await ensureLocalGitRepo(path);
      if (repoInit.status === "initialized") {
        emitChatMessage(
          "system",
          "📦 Bu proje git deposu değildi — değişiklik takibi, geri alma noktaları ve hedefli taramalar için MyCL yerel bir git deposu başlattı. Uzak sunucuya bağlanmaz; istersen `.git` klasörünü silebilirsin.",
        );
      } else if (repoInit.status === "failed") {
        emitChatMessage(
          "system",
          `ℹ️ Proje git deposu değil ve MyCL yerel depo başlatamadı (${repoInit.reason ?? "bilinmeyen"}). Sorun değil — yedekler ~/.mycl/backups üzerinden sürer; yalnız taramalar tüm projeyi tarar.`,
        );
      }
    } catch (err) {
      log.warn("orchestrator", "ensureLocalGitRepo failed", err);
    }

    // YZLLM 2026-06-16: iş-göstergesi (başlık) HER ZAMAN kullanıcının yazdığı KISA ORİJİNAL metin (kuyruk task.text) —
    // türetilmiş uzun intent_summary_raw / fix-dispatch prompt'u DEĞİL ("işi başlığa yazmıştık, şimdi görünmüyor").
    // Boot/resume'da aktif (currentTaskId) → running → bekleyen işin orijinal text'i; iş yoksa null (temiz).
    {
      const bootTasks = await readTasks(runtime.state.project_root).catch(() => []);
      const activeTask =
        bootTasks.find((t) => t.id === runtime.currentTaskId) ??
        bootTasks.find((t) => t.status === "running") ??
        nextPendingTask(bootTasks);
      emitIterationIntent(activeTask?.text ?? null);
    }
    // v15.7 (2026-05-24): İş kuyruğunu frontend'e yolla
    void emitInitialTaskQueue(path);
    // Runtime HTTP server hedef proje bilgisini güncelle — UI'dan gelen
    // POST /__mycl/runtime-error çağrıları bu projenin mycl_errors.db'sine yazar.
    setRuntimeHttpTarget({
      projectRoot: path,
      dbPath: `${path}/error_folder/mycl_errors.db`,
    });
    log.info("orchestrator", "project loaded", {
      session_id: runtime.state.session_id,
      current_phase: runtime.state.current_phase,
    });
    // AÇILIŞ DURUM TUTARSIZLIĞI FIX'i (YZLLM 2026-07-22): eskiden KOŞULSUZ "running" yayılıyordu → tamamlanmış Faz 17
    // idle projesi açılınca header/sidebar/şerit "çalışıyor" gösterip durum-mesajının "boşta"sıyla çelişiyordu (faz
    // durumu persist edilmez). Artık faz-durumu, mesajla AYNI kaynaktan (composeOpenStatus) üretilir → drift imkansız.
    // KONUM KRİTİK: bu emit, aşağıdaki D2_WAITING debug askq re-emit'inden ÖNCE kalmalı — phase_changed reducer'ı
    // pendingAskq'yı temizler (App.tsx), sonraya taşınırsa yeni askq silinir. Resume dalları SONRA kendi phase_changed'ini
    // yayıp override eder → yalnız idle yollar bu hesaplanmış statüyü nihai taşır. state okunamazsa "running" (defansif).
    {
      const _oi = await gatherOpenStatusInput();
      emitPhaseChanged(
        runtime.state.current_phase,
        runtime.state.current_phase,
        _oi ? composeOpenStatus(_oi).phaseStatus : "running",
      );
    }
    // Mahkeme H1 (boot yarışı): kapsam emit'ini buraya koy — runtime.state loadOrInit ile POPULATE edildikten SONRA
    // deterministik koşar. Eski tek emit (handleListPhases) ayrı IPC mesajı + open_project'in await penceresinde
    // yarışıp null/bayat okuyabiliyordu → yeniden açılan onaylı-kapsamlı projede PhaseSidebar dimming'i bayat kalırdı.
    syncNeededPhases();
    // Boot/welcome chat mesajları kaldırıldı (kullanıcı: "kuru kalabalık,
    // arrow'larla işaret ettim"; 2026-05-23). Sidebar faz badge'i + header
    // proje yolu + composer placeholder zaten yönlendirici. log.info("project
    // loaded", ...) developer-side persist; chat'e yazmaya gerek yok.

    // Phase 0 D2_WAITING restore: kullanıcı askq açıkken uygulamayı kapatıp
    // açtıysa frontend pendingAskq boş kalır → kullanıcı asılı. State'teki
    // pending_diagnostic'i askq olarak re-emit et.
    const pendingDiag = runtime.state.pending_diagnostic;
    if (pendingDiag?.phase === "D2_WAITING") {
      if (pendingDiag.auto_selected_label) {
        // 2026-06-09 (YZLLM): otomatik çözüm modunda boot'ta da sorma — kaldığı yerden uygula.
        emitChatMessage(
          "system",
          `🔍 **Önceki debug oturumu**\n\n${pendingDiag.rootCauseTR}\n\n🤖 Önerilen çözüm otomatik uygulanıyor: **${pendingDiag.auto_selected_label}**`,
          { persist: false },
        );
        void handleAskqAnswer(pendingDiag.askq_id, pendingDiag.auto_selected_label).catch(
          (e: unknown) => log.error("orchestrator", "boot auto-fix routing failed", e),
        );
      } else {
        // Eski state.json (auto_selected_label yok) → geriye uyumlu askq.
        const askqOptions = [
          ...pendingDiag.options.map((o) => o.label),
          "Vazgeç",
        ];
        emitChatMessage(
          "system",
          `🔍 **Önceki debug oturumu**\n\n${pendingDiag.rootCauseTR}\n\n(Bir çözüm seç veya Vazgeç.)`,
          { persist: false },
        );
        emit("askq", {
          id: pendingDiag.askq_id,
          question: "Hangi çözümü uygulayalım?",
          options: askqOptions,
          allow_other: false,
        });
      }
    }

    // Zombi dev server kontrolü: state'te kayıtlı pid varsa yaşıyor mu bak.
    // v15.8 (2026-05-28): Cross-platform check (POSIX kill -0; Windows
    // tasklist). Yaşıyorsa kullanıcı uyarılır; ölmüşse state'i temizle.
    if (runtime.state.dev_server_pid !== undefined) {
      const pid = runtime.state.dev_server_pid;
      const alive = await isProcessAlive(pid);
      if (alive) {
        // Chat'e uyarı mesajı kaldırıldı (kullanıcı 2026-05-23 boot temizlik
        // talebi). Log korunur — developer terminal'inden takip eder.
        log.warn("orchestrator", "zombie dev server detected", { pid });
      } else {
        // Pid ölmüş — state'i temizle ki bir sonraki açılışta gereksiz uyarı olmasın.
        runtime.state = { ...runtime.state, dev_server_pid: undefined };
        await saveState(runtime.state);
        log.info("orchestrator", "stale dev_server_pid cleared", { pid });
      }
    }

    // v15.6 (2026-05-24): Mid-Phase 1 detection. Phase 1 controller askq'sı
    // RAM'de tutulur — uygulama kapanırsa kayboluyor. Kullanıcı talebi:
    // "kapatıp açtığımda kaldığı yerden başlamıyor". Audit'ten orijinal
    // intent'i çıkar, Phase 1'i yeniden başlat. Kullanıcı 1-2 askq tekrar
    // görür ama kaybolan akış yerine yeniden başlatılmış akış var.
    //
    // v15.7 (2026-05-27): Boot bug fast-path kaldırıldı. Kullanıcı kuralı:
    // "orkestra ajanı her zaman llm e sorsun. kendi yanlış karar veriyor".
    // Boot resume'da regex'le karar veremeyiz; user sonraki mesajında ne
    // isterse orchestrator agent o turn'de karar verir.
    // YZLLM 2026-06-15 ("iş listesindekileri sıra sıra pipeline'dan geçirsin sistem"):
    // İŞ-LİSTESİ TEK SÜRÜCÜDÜR. Bekleyen iş varsa bağımsız boot-resume DEVREYE GİRMEZ
    // — yoksa boot-resume eski niyeti işler + kuyruk aynı işi TEKRAR işler (duplicate).
    // Bekleyen iş varken kuyruk (emitInitialTaskQueue→kickWorkQueue) işi Faz 1'den
    // sürücüler. "running" da say (orphan = yarıda kalmış iş-listesi işi; boot'ta
    // "pending"e geri alınır → yine kuyruk işler); boot-reconcile ile bu kontrol
    // arasındaki sıralama yarışına dayanıklı (her iki sırada da doğru karar).
    const _queueItems = await readTasks(runtime.state.project_root);
    const hasPendingQueueWork = _queueItems.some((it) => {
      const st = it.status ?? "pending";
      return st === "pending" || st === "running";
    });

    const interrupted = await detectInterruptedPhase1(runtime.state);
    if (interrupted && !hasPendingQueueWork) {
      emitChatMessage(
        "system",
        `📍 **Durum:** Niyet toplama yarıda kalmıştı — kaldığım yerden devam ediyorum (niyet: "${interrupted.intentText.slice(0, 100)}").\n**Yapman gereken:** Gelen soruları yanıtla; farklı bir hedef istersen yazman yeterli.`,
      );
      _openStatusHandledInline = true;
      void restartPhase1WithIntent(interrupted.intentText).catch((e) => {
        log.error("orchestrator", "boot-resume restartPhase1WithIntent failed", e);
        emitError("Önceki oturum sürdürülemedi", String(e));
      });
      return; // boot check skip — Phase 1 zaten başladı
    }
    // YZLLM 2026-06-13 "headless çalışmasın": bekleyen UI-tweak headless'i hedefliyorsa (önceki
    // deep-debug'ın enjekte ettiği sapma) ATLA — headless:false SABİT kuraldır (playwright-setup.ts:
    // "kullanıcı testi gözlemek istiyor"). Kuralı ihlal eden tweak'i uygulama; discard et ki boot kaldığı
    // yerden devam etsin ("engel yoksa ilerle"). substring yeter (regex değil).
    if (runtime.state.pending_ui_tweak && /headless/i.test(runtime.state.pending_ui_tweak)) {
      log.info("orchestrator", "boot: headless ui-tweak discarded (headless:false hard rule)", {
        tweak: runtime.state.pending_ui_tweak.slice(0, 80),
      });
      // Tweak atılıyor → onunla eşleşen gerçek-app doğrulama marker'ı da atılmalı (orphan marker sonraki koşuda patlamasın).
      runtime.state = { ...runtime.state, pending_ui_tweak: undefined, pending_realapp_verify: undefined, updated_at: Date.now() };
      await saveState(runtime.state);
      emitChatMessage(
        "system",
        "🖥️ Bekleyen \"Playwright headless\" tweak'i uygulanmadı — headless:false sabit kuralın (browser görünür kalır, testi gözleyebilirsin). Kaldığım yerden devam ediyorum.",
      );
    }
    // YZLLM (cave5): ENTEGRE (foreign) projede geçiş-dönemi Faz 6 parkını temizle. Skip eklenmeden ÖNCE
    // Faz 6'ya girmiş foreign-origin proje restart'ta pending_ui_review=true ile askıda kalır
    // (hasPendingQueueWork boot-resume'u atlar + queue-drain isPipelineParked'ta durur → SESSİZ STALL,
    // DONMUŞ HEDEF #1 ihlali). Foreign'de Faz 6 UI-incelemesi YOK: bu bayat parkı geçip ilerle. Yeni
    // projeler skip yoluyla bu parka hiç girmez → guard tek-shot (advanceToNextPhase pending_ui_review'i temizler).
    if (
      runtime.state.origin === "foreign" &&
      runtime.state.pending_ui_review &&
      runtime.state.current_phase === 6
    ) {
      emitChatMessage(
        "system",
        "📍 **Durum:** Faz 6 (UI İncelemesi) entegre modunda atlanıyor — Faz 7'den otomatik devam ediyorum.\n**Yapman gereken:** Bir şey yapmana gerek yok; yeni bir hedef için yazman yeterli.",
      );
      _openStatusHandledInline = true;
      void advanceToNextPhase(6 as PhaseId).catch((e) => {
        log.error("orchestrator", "boot integrate Faz6 unpark failed", e);
        emitError("Önceki oturum sürdürülemedi", String(e));
      });
      return; // boot check skip — pipeline Faz 7'den devam ediyor
    }
    // v15.7 (2026-05-26): Phase 2-9 boot-resume (production readiness madde 08).
    // Faz 1 dışı yarım kalmış faz varsa advanceToNextPhase(N-1) ile restart.
    // Phase 5 tweak mode hariç (pending_ui_tweak akışı zaten kendi handler'ı
    // ile devam eder; çift tetik olmasın).
    const interrupted29 = await detectInterruptedPhase2To9(runtime.state);
    // pending_ui_tweak → deferred UI akışı kendi handler'ında. pending_diagnostic → Faz 0 debug askq cevabı
    // bekleniyor (YZLLM 2026-06-12: Faz 8/9 resume genişledi → parked faz user-seçimi beklerken auto-resume
    // ETME, seçimi baypas etmesin). İkisi de yoksa kaldığı yerden otomatik devam.
    // YZLLM 2026-06-14 ("sessizlik var, dikkat et"): pending_ui_tweak YALNIZ Faz ≤9 (UI) akışını bekletir. GATE
    // fazlarında (10-16) pending_ui_tweak bir DÜZELTME PLANI tutuyorsa (deep-solution'dan, örn. Faz 13 vite fix)
    // boot'ta RESUME edilmeli — yoksa mid-pipeline gate'te açınca boot-check "sessiz geç" deyip PARKEDİYORDU
    // (kullanıcının gördüğü "öylece duruyor/sessizlik"). Faz ≤9'da eski davranış (deferred UI handler) korunur.
    const uiTweakHoldsResume = !!runtime.state.pending_ui_tweak && runtime.state.current_phase <= 9;
    // hasPendingQueueWork (yukarıda): bekleyen iş varsa boot-resume ATLA — iş-listesi sürer (duplicate önlenir).
    if (interrupted29 && !uiTweakHoldsResume && !runtime.state.pending_diagnostic && !hasPendingQueueWork) {
      // YZLLM 2026-07-03: resume gövdesi resumeInterruptedPhase'e ÇIKARILDI (kuyruk-güdümlü orphan resume ile
      // PAYLAŞIMLI). Bu (unbound) çağrı byte-eşdeğer: spec-yok→Faz 4 fallback + ensurePendingIterationDir +
      // advanceToNextPhase(phaseId-1) + aynı "📍 Faz N yarıda kalmıştı" mesajı helper içinde.
      _openStatusHandledInline = true; // resumeInterruptedPhase kendi durum mesajını basar → jenerik özet atla
      void resumeInterruptedPhase(interrupted29.phaseId).catch((e) => {
        log.error("orchestrator", "boot-resume advanceToNextPhase failed", e);
        emitError("Önceki oturum sürdürülemedi", String(e));
      });
      return; // boot check skip — phase zaten başladı
    }

    // v15.11: Mevcut (MyCL-dışı) projeyi ilk açışta dökümante et — features.md
    // yoksa + kod varsa arka planda (await'siz, open'ı bloklamaz) üretir.
    // İdempotent: sonraki açılışlarda no-op. Orkestratör/Faz 1-2 sonradan bu
    // belgelere bakıp grounded soru sorar (gereksiz "X var mı?" sormaz).
    //
    // boot-park FIX (YZLLM 2026-06-18 canlı remax_BO): first-open doc-gen YALNIZ GERÇEK ilk-açışta
    // (proje MyCL pipeline'ından geçmemiş) koşmalı. mid-pipeline projede re-open (frontend-disconnect
    // sonrası) → resume kuyruk-bekleyen-iş yüzünden ATLANIYOR + buradaki doc-gen guard'sız çalışıp
    // pipeline'ı PARK ediyordu. current_phase>1 / kuyrukta-iş / yarıda-kalmış-faz / bekleyen-tweak/diag
    // → mid-pipeline → ilk-açış işlerini ATLA (queue-drain veya resume kendi yolunda sürer).
    const midPipeline =
      (runtime.state.current_phase ?? 1) > 1 ||
      hasPendingQueueWork ||
      !!interrupted29 ||
      !!runtime.state.pending_ui_tweak ||
      !!runtime.state.pending_diagnostic;
    // Onboarding kararı (yabancı projeyi MyCL'e entegre et — "Proje Aç"). classify loadOrInit'ten ÖNCE yapıldı.
    // İlk-açışta yabancı projeyi origin="foreign" diye İŞARETLE (integrate olmasa bile) → vite-injector
    // non-destructive guard'ı bu projede devreye girer (kaynağı onaysız ezmez).
    if (folderClass === "foreign" && runtime.state.origin == null) {
      runtime.state.origin = "foreign";
      await saveState(runtime.state).catch((e: unknown) =>
        log.warn("orchestrator", "origin persist edilemedi", e),
      );
    }
    // ENTEGRE (foreign-origin) projede oto-cevap KATEGORİ-FARKINDA (YZLLM 2026-07-08, cave5 evrimi): bu bayrak artık
    // TAM-blok DEĞİL — decideAutoAnswer'da kategoriyle değerlendirilir → yalnız GÜVENLİ-AKIŞ kararları (onay/kavrama/
    // faz-kapsam) foreign'de oto; kod-değiştiren + kullanıcı-tercihi (mock vs gerçek DB) kararlar kullanıcıda kalır.
    // Non-foreign → parite (byte-aynı). UI'a bildir (checkbox entegre-modda ETKİLEŞİMLİ + "güvenli kararlarda oto").
    {
      const integrateSuppress = runtime.state.origin === "foreign";
      setIntegrateModeSuppression(integrateSuppress);
      emit("auto_answer_mode", { suppressed: integrateSuppress });
    }
    // integrate bayrağı (UI "Proje Aç") + foreign + henüz-BAŞARIYLA-onboard-edilmemiş → TAM onboarding.
    // İdempotency BAŞARI işaretine (.mycl/onboarded.json) bakar — eski onboarded_at DEĞİL. Apology/no-access
    // koşusu işaret BIRAKMAZ → re-open yeniden dener (cave5 fix: eski apology features.md → bu sefer (A)-sandbox-
    // fix ile gerçek okunur). origin="foreign" yukarıda senkron set+save edildi; runOnboarding state'e dokunmaz.
    const onboardedOk = await onboardingSucceeded(path);
    const wantOnboard =
      integrate && (folderClass === "foreign" || runtime.state.origin === "foreign") && !onboardedOk;

    if (integrate && !wantOnboard) {
      // "Proje Aç" tıklandı ama onboarding koşulları sağlanmadı → SESSİZ kalma (KATI #4): nedeni söyle.
      const why =
        folderClass === "empty"
          ? "Bu klasör boş — entegre edilecek mevcut kod yok. Yeni proje için '📁 Yeni Klasör Seç' kullan."
          : onboardedOk
            ? "Bu proje zaten başarıyla MyCL'e entegre edilmiş — doğrudan geliştirmeye devam edebilirsin."
            : "Bu klasör zaten bir MyCL projesi gibi görünüyor — normal açıldı.";
      emitChatMessage("system", `ℹ️ ${why}`);
    }

    if (wantOnboard && runtime.config) {
      // runOnboarding YALNIZ .mycl/ dosyaları yazar (state.json'a DOKUNMAZ → stale-ref yarışı yok) ve BAŞARI
      // işaretini (.mycl/onboarded.json) yalnız projeyi GERÇEKTEN okuyabildiyse bırakır → no-access koşu işaretsiz
      // kalır, re-open yeniden dener. Aşağıdaki arka-plan bootstrap+map ATLANIR (eş-zamanlı yazım yarışı). Bloklamaz.
      // GAP'leri iş kuyruğuna ekleyip otomatik işle (YZLLM: onay bekleme). kickQueue inject (circular import
      // önler): onboarding başarılıysa gap-task'ları kuyruğa atar + bunu çağırır → emit + drain başlar.
      void runOnboarding(runtime.state, runtime.config, {
        kickQueue: async () => {
          await emitQueueChangedFor(path);
          await kickWorkQueue();
        },
        // Okunamayan proje erişilebilir konuma kopyalandı → frontend kopyayı açsın (open_project_request).
        requestReopen: async (copyPath, integrate) => {
          emit("open_project_request", { path: copyPath, integrate });
        },
      }).catch((e: unknown) => log.warn("orchestrator", "onboarding başarısız (non-fatal)", e));
    } else if (wantOnboard && !runtime.config) {
      // KATI #4 (sessiz-skip yok — mahkeme Mercek-C): config yüklenemediyse onboarding başlamaz → GÖRÜNÜR.
      emitChatMessage("system", "ℹ️ Onboarding başlatılamadı — yapılandırma yüklenemedi.");
    } else if (runtime.config && runtime.state && !midPipeline) {
      void bootstrapLivingDocs(runtime.state, runtime.config)
        .then(async () => {
          // 2026-08-03 ("kılavuz HER ZAMAN güncel"): bootstrap yalnız dosya YOKSA üretir. Mevcut projede
          // kod bu arada değiştiyse kılavuz bayat kalıyordu → açılışta bayatlık kontrolü + otomatik tazeleme.
          if (runtime.state && runtime.config) {
            await refreshDocsIfStale(runtime.state, runtime.config, { origin: "open" });
          }
        })
        .catch((e: unknown) => log.warn("orchestrator", "living-docs bootstrap failed (non-fatal)", e));
    }

    // EDD RESUME (mahkeme blocker fix): foreign-origin projede EDD one-time onboarding'e HAPSOLMASIN. Fresh
    // onboarding HARİÇ (o kendi sonunda tetikler) — her açılışta pending EDD işi varsa maybeRunEdd DEVAM ettirir
    // (onboarding marker'dan BAĞIMSIZ, resumable, concurrency-guard'lı; tamamlandıysa no-op). Fire-and-forget, bloklamaz.
    // !midPipeline (mahkeme Major — kardeş bootstrapLivingDocs ile tutarlı): mid-pipeline re-open'da resume edilen ağır
    // codegen (kendi claude CLI'ı) ile EDD'nin kendi CLI'ı EŞZAMANLI koşmasın (feedback_resource_careful "eşzamanlı ağır yok").
    if (!wantOnboard && runtime.config && runtime.state?.origin === "foreign" && !midPipeline) {
      void maybeRunEdd(runtime.config, runtime.state);
    }

    // Proje haritasını ARKA PLANDA hesapla (open'ı bloklamaz) → orkestratör recall'ı merkezi modülleri görür.
    // Proje değişti → eski harita cache'i her durumda temizlenir. Onboarding zaten haritayı kalıcılaştırıyor →
    // onboarding yolunda tekrar hesaplama (yarış + gereksiz iş).
    clearProjectMapCache();
    if (!wantOnboard) {
      void getCachedProjectMap(runtime.state.project_root).catch((e: unknown) =>
        log.warn("orchestrator", "project-map onboarding failed (non-fatal)", e),
      );
    }

    // agent-skills AUTO-KURULUM (YZLLM 2026-06-09: "sadece önermesin, bağlasın"): yoksa pinli commit'ten
    // arka planda kur → cli-backend --plugin-dir ile codegen ajanlarına bağlar. Non-blocking, fail görünür.
    void ensureAgentSkills().catch((e: unknown) =>
      log.warn("orchestrator", "agent-skills kurulum hatası (non-fatal)", e),
    );

    // codebase-memory-mcp AUTO-KURULUM (YZLLM 2026-07-13): YALNIZ flag AÇIKKEN (opt-in dış bağımlılık) — yoksa pinli
    // versiyondan arka planda kur → cli-backend --mcp-config ile codegen ajanlarına bağlar (yapısal kod grafiği; grep
    // yerine ucuz sorgu). Non-blocking, fail görünür (KATI #4: kurulamazsa grep fallback).
    if (runtime.config?.features.codebase_memory_mcp) {
      void ensureCodebaseMemoryMcp().catch((e: unknown) =>
        log.warn("orchestrator", "codebase-memory-mcp kurulum hatası (non-fatal)", e),
      );
    }
    // cognee kalıcı hafıza AUTO-KURULUM (YZLLM 2026-07-13, Phase B): YALNIZ flag AÇIKKEN (opt-in AĞIR dış bağımlılık).
    // Kaynak-klon+uv sync (dakikalar) arka planda → cli-backend --mcp-config ile remember/recall/forget bağlar. LLM=MyCL
    // sağlayıcısı. Non-blocking, fail görünür (KATI #4: key/kurulum yoksa cognee devre dışı, MyCL mevcut hafızayla sürer).
    if (runtime.config?.features.cognee_memory && runtime.state?.project_root) {
      void ensureCognee(runtime.config, runtime.state.project_root).catch((e: unknown) =>
        log.warn("orchestrator", "cognee kurulum hatası (non-fatal)", e),
      );
    }

    // Model AUTO-KEŞİF (YZLLM 2026-06-11): LLM WEB'de Anthropic dökümanlarından güncel modelleri bulur → ASLA
    // OTOMATİK UYGULAMAZ (eski davranış kullanıcı ayarını eziyordu = "ondan sonra bozuldu"). Yalnız: yeni GÜÇLÜ
    // model config'tekinden farklıysa → "main + strong görevler için geçeyim mi?" diye SORAR. Kabul edilirse
    // config'e yazılır; reddedilirse bu oturumda tekrar sorulmaz. Kullanıcı ayarı tek doğruluk kaynağı.
    if (runtime.config) {
      const cfg = runtime.config;
      const root = runtime.state.project_root;
      void discoverModelsViaWeb(cfg, root)
        .then((models) => {
          if (models.length === 0) return; // keşif başarısız → kullanıcı ayarı/statik katalog geçerli
          const t = computeTiersFromModels(models);
          log.info("orchestrator", "model auto-keşif (web)", t);
          const currentStrong = cfg.selected_models.model_tiers?.strong ?? cfg.selected_models.main;
          // YZLLM 2026-06-13: oturum-içi (bellek) VE kalıcı (config) ret listesi → bir kez sor, "hayır"ı hatırla.
          const declinedPersisted = !!t.strong && (cfg.declined_model_upgrades?.includes(t.strong) ?? false);
          if (
            t.strong &&
            t.strong !== currentStrong &&
            !_declinedModelUpgrades.has(t.strong) &&
            !declinedPersisted
          ) {
            // HİÇBİR ŞEY SORMA (YZLLM 2026-07-09): model KALICI bir ayardır (kullanıcı kral — feedback_model_policy).
            // Sorma AMA otomatik de yükseltme (ayarını ezme) → mevcut ayarla devam + GÖRÜNÜR bilgi. Kullanıcı isterse
            // Ayarlar'dan geçer. ("Herşeye o karar versin" bile kalıcı kullanıcı tercihini/model politikasını ezmez.)
            if (isNeverAsk()) {
              emitChatMessage(
                "system",
                `🆕 Güncel güçlü model bulundu: **${t.strong}** (şu an: ${currentStrong}). Hiçbir şey sorma modunda model ayarını otomatik değiştirmem (kalıcı kullanıcı tercihi) — istersen Ayarlar'dan geçebilirsin.`,
              );
              return;
            }
            const askqId = randomUUID();
            _pendingModelUpgrade = { askqId, model: t.strong };
            emitChatMessage(
              "system",
              `🆕 Güncel güçlü model bulundu: **${t.strong}** (şu an: ${currentStrong}). Geçmek istersen soruyorum — ayarların korunur, ben otomatik değiştirmiyorum.`,
            );
            emitAskq({
              id: askqId,
              question: `Yeni güçlü model ${t.strong} çıkmış. Main ajan + strong (kalite açısından kritik) görevler için buna geçeyim mi?`,
              options: ["Evet, geç", "Hayır, kalsın"],
              allow_other: false,
            });
          }
        })
        .catch((e: unknown) =>
          log.warn("orchestrator", "model auto-keşif (web) başarısız (kullanıcı ayarı geçerli)", e),
        );
    }

    // v15.6 (2026-05-24): Boot durum özeti — kullanıcı talebi: "ilk açılışta
    // orkestra ajanı yarıda kalan bi iş varsa onu algılasın ve kullanıcıya
    // söylesin yapılması gerekeni". D2_WAITING zaten yukarıda askq emit etti
    // → skip. Programmatik gate: gerçekten bekleyen iş yoksa agent call YOK
    // (token tasarrufu). Background'da çalışır, attach'i bloklamaz.
    const skipBoot = pendingDiag?.phase === "D2_WAITING";
    if (!skipBoot && runtime.config && runtime.state) {
      const st = runtime.state;
      // Boot-check narrator'ı yalnız GERÇEK devam-eden/biten iş varken çalışır (greenfield temiz açılışı ATLA:
      // YZLLM 2026-06-17 "yarım kalan iş yoksa ilk mesajı yazmasın"). YZLLM 2026-07-06 ("iş kuyruğundan işi aldı,
      // ne istediğimiz kabak gibi ortada — MyCL akıllı olmalı"): kuyrukta bekleyen/koşan iş VARSA boot-check SUSAR —
      // kuyruk sürücüsü (emitInitialTaskQueue) "İş başlıyor / 🔄 Yeni iterasyon / 📍 kaldığım yerden devam"ı zaten
      // anlatır; boot-check kuyruğu bilmediği için `cp=1 + intent boş → "Niyet bekleniyor"` deyip kullanıcıdan İKİNCİ
      // kez niyet istiyordu. Karar saf shouldRunBootStatusCheck'e taşındı (resume-detection.ts, birim-test'li).
      // ESKİ LLM boot-narrator KALDIRILDI (2026-07-19): deterministik emitOpenStatusSummary (wrapper sonda)
      // her açılışta "Durum + Yapman gereken"i basar → kuyruk-varken-susma + token + prompt-kırılganlığı bitti.
      void st; void hasPendingQueueWork;
    }
  } catch (err) {
    log.error("orchestrator", "open_project failed", err);
    emitError("Proje açılamadı", String(err));
  }
}


/**
 * v15.6 (2026-05-24): Mid-Phase 1 tespiti — uygulama kapanırsa Phase 1
 * controller RAM'de tutulan askq state'i kaybeder. Detection criteria:
 *   - state.current_phase === 1
 *   - state.intent_summary undefined (Phase 1 tamamlanmadı)
 *   - Audit'te en son `iteration-N-start` event'i var (intent text içeriyor)
 *   - O start'tan SONRA `phase-1-complete` YOK
 * Match olursa orijinal intent text'i döner.
 */

async function detectInterruptedPhase1(
  state: State,
): Promise<{ intentText: string } | null> {
  if (state.current_phase !== 1) return null;
  if (state.intent_summary) return null;
  let audit;
  try {
    // v15.7 (2026-05-25): tail 300 — son iter-N-start aramak için yeterli;
    // full read büyük projede 5K+ token boşa.
    audit = await readAuditLogTail(state.project_root, 300);
  } catch (e) {
    log.warn("orchestrator", "boot-resume(Faz 1) audit okunamadı — resume tespiti atlandı", { error: String(e) });
    return null;
  }
  // En son iteration-N-start event'ini bul
  const iterStarts = audit.filter((e) => /^iteration-\d+-start$/.test(e.event));
  if (iterStarts.length === 0) return null;
  const latest = iterStarts[iterStarts.length - 1];
  if (!latest) return null;
  // detail format: "previous pipeline complete; new intent: <text>"
  const detail = latest.detail ?? "";
  const match = detail.match(/new intent:\s*(.+)$/);
  if (!match || !match[1]) return null;
  // Bu iterStart'tan sonra phase-1-complete oldu mu?
  const completed = audit.some(
    (e) => e.ts > latest.ts && e.event === "phase-1-complete",
  );
  if (completed) return null;
  return { intentText: match[1].trim() };
}

/**
 * v15.7 (2026-05-26): Generic phase resume detection (Faz 2-9).
 *
 * Production readiness madde 08: "Phase 1 dışı boot-resume yok" eksikliği.
 * state.current_phase 2-9 arasında + son audit'te `phase-N-complete` yoksa
 * yarıda kalmış demektir. Yeni iterasyon başlamamışsa (yani current_phase
 * tutarlı) → resume için sinyal döner.
 *
 * Phase 1 dışı: state stateful (intent_summary set, brief.md var, vs.) →
 * resume = controller'ı fresh restart. Controller kendi state'inden okur.
 * advanceToNextPhase(N-1) çağrısı PHASE_TRANSITIONS[N-1]=N → runPhaseOnce(N)
 * tetikler.
 */
async function detectInterruptedPhase2To9(
  state: State,
): Promise<{ phaseId: PhaseId } | null> {
  // Ucuz erken-çıkış — audit okumadan (saf modülde de aynı guard var, IO'dan kaçın). 2-17 (mekanik dahil).
  if (state.current_phase < 2 || state.current_phase > 17) return null;
  let audit;
  try {
    audit = await readAuditLogTail(state.project_root, 300);
  } catch (e) {
    log.warn("orchestrator", "boot-resume(Faz 2-9) audit okunamadı — resume tespiti atlandı", { error: String(e) });
    return null;
  }
  // Karar mantığı saf modülde (resume-detection.ts) — orchestrator vitest'te test edilebilir.
  return detectInterruptedPhase2To9Pure(state, audit);
}

/**
 * v15.6: Yarıda kalan Phase 1 oturumunu sıfırdan başlatır. State zaten
 * temizdi (intent_summary undefined); sadece Phase 1 controller'ı orijinal
 * intent text ile çalıştırıyoruz. develop_new_or_iter handler'ının Phase 1
 * blok'unun kopyası (state reset YAPMAZ — state zaten doğru).
 */
async function restartPhase1WithIntent(intentText: string): Promise<void> {
  if (!runtime.state || !runtime.config) return;
  const spec = getSpec(1);
  if (!spec) {
    log.error("orchestrator", "phase 1 spec missing on restart");
    return;
  }
  log.info("orchestrator", "restarting phase 1 after interruption", {
    intent_len: intentText.length,
  });
  emitPhaseChanged(runtime.state.current_phase, 1, "running");
  const p1 = new Phase1Controller({
    state: runtime.state,
    config: runtime.config,
    spec,
  });
  // Token çizelgesi (YZLLM 2026-06-17): Faz 1 advanceToNextPhase loop'u DIŞINDA çalışır → cost-bucket'ı
  // burada set et ki Faz 1 token+süresi de çizelgeye yazılsın (flush'u sonraki faz geçişinde loop yapar).
  beginPhaseCost(1, runtime.state.iteration_count ?? 1);
  const result = await runController(p1, () => p1.run(intentText), "Niyet toplanıyor");
  if (result === "complete") {
    await recordRungOutcome(1, true);
    emitChatMessage("system", "Faz 1 tamamlandı — niyet onaylandı.");
    const summary = p1.approvedSummary ?? runtime.state.intent_summary;
    runtime.state = {
      ...runtime.state,
      intent_summary: summary,
      intent_summary_raw: p1.approvedSummary ?? runtime.state.intent_summary_raw,
    };
    await saveState(runtime.state);
    // YZLLM 2026-06-16 ("iş metni hep kısa orijinal"): Faz 1 sonrası iterationIntent'i türetilmiş (uzun)
    // intent_summary ile EZMİYORUZ — kuyruk başında set edilen kullanıcı-orijinal kısa metin (next.text) kalır.
    await advanceToNextPhase(1);
  } else {
    await failPhase(1, p1);
  }
}

/**
 * v15.6 (2026-05-24): SCHEMA.md asset'ini projeye `.mycl/SCHEMA.md` olarak
 * kopyalar. Her boot'ta overwrite — kullanıcı manuel edit yapmamalı (kaybolur).
 * Kullanıcı talebi: "ilerde veriseti olarak kullanabileceğimiz bi yapıda
 * tutmak istiyorum" → şema dokümante edilsin.
 *
 * Asset path resolution: context-builder.ts ile aynı pattern — bundle ve dev
 * mode için __dirname-relative.
 */
async function copySchemaDocToProject(projectRoot: string): Promise<void> {
  const { promises: fs } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve, join } = await import("node:path");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // dist/index.js → ../../assets/mycl-schema.md (bundle + dev aynı)
  const assetPath = resolve(__dirname, "..", "..", "assets", "mycl-schema.md");
  const destPath = join(projectRoot, ".mycl", "SCHEMA.md");
  const content = await fs.readFile(assetPath, "utf-8");
  await fs.mkdir(dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, content, "utf-8");
}

/**
 * v15.7 (2026-05-24): İş kuyruğu — composer'a yazılan metin "İş Ekle" ile
 * `<project>/.mycl/task-queue.jsonl`'a NDJSON satırı olarak eklenir. Sonra
 * `task_queue_changed` emit ile frontend güncellenir.
 */
async function handleTaskQueueAdd({ text }: { text: string }): Promise<void> {
  if (!runtime.state) {
    emitError("Aktif proje yok", null);
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    emitError("İş eklenemedi: metin boş", null);
    return;
  }
  const task: TaskQueueItem = {
    id: randomUUID(),
    ts: Date.now(),
    text: trimmed,
    // Manuel "İş Ekle" (source=manual, görsel ayrım için). YZLLM 2026-06-15: artık
    // manuel işler de sıra sıra otomatik işlenir (kickWorkQueue) — iş-listesi
    // kendiliğinden boşalan sıralı kuyruktur.
    status: "pending",
    source: "manual",
  };
  try {
    await appendTask(runtime.state.project_root, task);
    const items = await readTasks(runtime.state.project_root);
    emit("task_queue_changed", { items });
    // Yeni iş eklendi → iş-listesi sürücüsünü ateşle (sistem boştaysa hemen işler).
    await kickWorkQueue();
  } catch (err) {
    log.warn("task-queue", "add failed", err);
    emitError("İş eklenemedi", String(err));
  }
}

async function handleTaskQueueRemove({ id }: { id: string }): Promise<void> {
  if (!runtime.state) {
    emitError("Aktif proje yok", null);
    return;
  }
  try {
    await removeTask(runtime.state.project_root, id);
    const items = await readTasks(runtime.state.project_root);
    emit("task_queue_changed", { items });
  } catch (err) {
    log.warn("task-queue", "remove failed", err);
    emitError("İş kuyruğundan silme başarısız", String(err));
  }
}

/**
 * Proje açılışında mevcut iş kuyruğunu frontend'e gönderir.
 *
 * BOOT UZLAŞTIRMA (YZLLM 2026-06-14, düşman-inceleme #3/#13): currentTaskId
 * yalnız bellektedir → restart/çökme sonrası "running" damgalı bir iş ORPHAN
 * kalır (gerçekte koşmuyor). nextPendingTask yalnız "pending" seçtiğinden bu
 * iş asla yeniden seçilmez + kuyruk dürüst yansımaz. Açılışta "running" işleri
 * "dropped"a çevir (görünür "tamamlanmadan durdu"; gerekirse kullanıcı yeniden
 * ekler). Yeni pencere = yeni süreç → in-memory _drainActive zaten false.
 *
 * YZLLM 2026-06-15 ("şu an iş listesindekileri sıra sıra pipeline'dan geçirsin"):
 * orphan uzlaştırmasından sonra bekleyen iş varsa iş-listesi sürücüsünü ateşle —
 * proje açılışında mevcut işler kendiliğinden sırayla işlenmeye başlar.
 */
/**
 * YZLLM 2026-07-03: bir YARIM-kalmış fazdan resume — boot-resume bloğu (unbound) + kuyruk-güdümlü orphan resume
 * (bound: taskId) bu PAYLAŞIMLI mantığı kullanır. Gövde eski boot-resume satır-içinden BYTE-EŞDEĞER çıkarıldı
 * (spec-yok→Faz 4 fallback + ensurePendingIterationDir + "📍 Faz N yarıda kalmıştı" mesajı + advanceToNextPhase(phaseId-1)).
 * taskId verilirse orphan işi bu resume'a bağlar → Faz 17'de onTaskMaybeComplete 'done' (veya deliverable yoksa 'dropped') damgalar + kalan pending'ler drain.
 */
async function resumeInterruptedPhase(
  phaseId: PhaseId,
  opts?: { taskId?: string; message?: string },
): Promise<void> {
  if (!runtime.state) return;
  if (opts?.taskId) {
    runtime.currentTaskId = opts.taskId;
    _drainTaskId = opts.taskId; // yeşil-son 'done' kurtarması
    _drainActive = true; // kalan pending'ler resume sonrası drain edilsin
  }
  let resolvedPhase = phaseId;
  // spec-gerektiren faza (>4: UI/DB/TDD/risk) resume ama iter-spec DOSYASI yoksa → Faz 4'ten (spec'i yeniden üret).
  if (resolvedPhase > 4) {
    const specPath = currentSpecPath(runtime.state);
    const specExists = await import("node:fs/promises").then((m) =>
      m.access(specPath).then(() => true).catch(() => false),
    );
    if (!specExists) {
      emitChatMessage(
        "system",
        `ℹ️ Faz ${resolvedPhase}'in spec'i bulunamadı (devs/ temizlenmiş olabilir) — spec'i yeniden üretmek için Faz 4'ten devam ediyorum.`,
      );
      resolvedPhase = 4 as PhaseId;
    }
  }
  // Faz 2/3/4 resume: boot Faz 1 girişini atladığı için devs/_pending/<ts>/ dizinini garantile (fail-soft).
  if (resolvedPhase <= 4 && runtime.state.iteration_started_at) {
    await ensurePendingIterationDir(
      runtime.state.project_root,
      runtime.state.iteration_started_at,
    ).catch((e: unknown) =>
      log.warn("orchestrator", "boot-resume ensurePendingIterationDir failed", e),
    );
  }
  emitChatMessage(
    "system",
    opts?.message ?? `📍 Faz ${resolvedPhase} yarıda kalmıştı — kaldığı yerden devam ediyorum.`,
  );
  await advanceToNextPhase((resolvedPhase - 1) as PhaseId);
}

async function emitInitialTaskQueue(projectRoot: string): Promise<void> {
  try {
    const items = await readTasks(projectRoot);
    // YZLLM 2026-07-03: YARIM iterasyon diskte "running" orphan bırakır. Eskiden körlemesine "pending"e alınıp
    // runDevelopIteration ile Faz 1'den koşuluyordu → current_phase yoksayılıyor → önceki sorular/kararlar TEKRAR
    // soruluyordu. Artık: iterasyon MID-FLIGHT ise (running orphan + iterasyon-kapsamlı interrupted-faz + intent dolu)
    // orphan'ı FLIP ETMEDEN kaldığı fazdan devam et. (Orphan running kaldığından hasPendingQueueWork invariant true →
    // boot-resume bloğu deterministik stand-down → bu tek-resumer; yarış yok.) Yeni iş (pending) → drain (Faz 1'den).
    const audit = await readAuditLogTail(projectRoot, 300).catch(() => []);
    const action = decideBootQueueAction(runtime.state ?? ({} as State), items, audit);
    if (action.kind === "resume" && runtime.state && runtime.state.project_root === projectRoot) {
      emit("task_queue_loaded", { items }); // orphan "running" kalır — FLIP ETME
      await resumeInterruptedPhase(action.phaseId, {
        taskId: action.taskId,
        message: `📍 Faz ${action.phaseId} yarıda kalmıştı — kaldığım yerden devam ediyorum (baştan sormuyorum).`,
      });
      return;
    }
    // "drain"/"none": mevcut davranış — orphan "running" işleri "pending"e geri al, kuyruğu Faz 1'den sür.
    const orphans = items.filter((it) => (it.status ?? "pending") === "running");
    for (const orphan of orphans) {
      await patchTask(projectRoot, orphan.id, { status: "pending" }).catch((e) =>
        log.warn("task-queue", "boot orphan reconcile failed", e),
      );
    }
    const fresh = orphans.length > 0 ? await readTasks(projectRoot) : items;
    if (orphans.length > 0) {
      log.info("orchestrator", "boot: orphan 'running' işler 'pending'e (yeniden-kuyruğa) alındı", {
        count: orphans.length,
      });
    }
    emit("task_queue_loaded", { items: fresh });
    // Bekleyen iş varsa iş-listesini sırayla işlemeye başla (kullanıcı mesaj
    // göndermeden — iş-listesi kendiliğinden boşalan sıralı kuyruktur).
    await kickWorkQueue();
  } catch (err) {
    // YZLLM 2026-07-06 (çapraz-aile mahkemesi bulgusu — sessiz-stall): kuyruk yükleme/sürme zinciri
    // (readTasks / decideBootQueueAction / kickWorkQueue) bozuk task-queue.jsonl ya da geçici I/O ile
    // patlarsa ESKİDEN yalnız log.warn'du → kullanıcı boş ekranla kalır, hiçbir watchdog kuyruğu yeniden
    // tetiklemez. Boot-check narrator'ı kuyruk-işi varken susturulduğundan (shouldRunBootStatusCheck) bu,
    // tek kalan görünür yolu da keserdi → KATI #4 (sessiz fallback yok) + DONMUŞ HEDEF #1 (asla sessiz-tıkanma)
    // ihlali. Artık GÖRÜNÜR hata ver — kullanıcı ne olduğunu görür + ne yapacağını bilir.
    log.warn("task-queue", "initial load failed", err);
    emitError("İş kuyruğu yüklenemedi — projeyi kapatıp yeniden açmayı dene.", String(err));
  }
}

async function handleSaveApiKeys(keys: Partial<ApiKeys>): Promise<void> {
  log.info("orchestrator", "save_api_keys", { keys }); // logger REDACT eder
  // MERGE-aware validasyon: kayıt PATCH'tir — boş alan mevcut key'i silmez.
  // Merge sonrası claude translator+main varsa geçerli; yoksa reddet.
  if (!keys || !(await hasUsableKeysAfterMerge(keys))) {
    emitError(
      "API anahtarları: en az çevirmen+ana anahtarları gerekli (kayıt boş bırakılamaz)",
      null,
    );
    return;
  }
  try {
    await persistApiKeys(keys);
    runtime.config = null;
    await emitConfigStatus();
  } catch (err) {
    log.error("orchestrator", "save_api_keys failed", err);
    emitError("API anahtarları kaydedilemedi", String(err));
  }
}

async function handleSaveSelectedModels(
  payload: SelectedModels & {
    effort?: string;
    backends?: Partial<AgentBackends>;
    design_workflow?: ClaudeCodeFlags["design_workflow"];
    agent_teams_optin?: boolean;
    multi_agent_selection?: boolean;
    cache_ttl?: ClaudeCodeFlags["cache_ttl"];
  },
): Promise<void> {
  log.info("orchestrator", "save_selected_models", payload);
  if (!payload || !payload.translator || !payload.main) {
    emitError("Ayarlar kaydedilemedi: çevirmen ve ana model gerekli", null);
    return;
  }
  try {
    // v15.13: tasarım flag'lerini (design_workflow/agent_teams_optin) modellerden ayır;
    // gerisi (translator/main/orchestrator/model_tiers) selected_models'e gider.
    const { effort, backends, design_workflow, agent_teams_optin, multi_agent_selection, cache_ttl, ...sel } =
      payload;
    await persistSelectedModels(sel as SelectedModels);
    // v15.8: Efor + v15.13: tasarım fan-out flag'leri — Modeller sekmesinde modellerle
    // birlikte kaydedilir. CLI backend aktifse efor `--effort` olarak kullanılır.
    const flagsPatch: Partial<ClaudeCodeFlags> = {};
    const validEfforts = ["low", "medium", "high", "xhigh", "max", "ultracode"];
    if (effort && validEfforts.includes(effort)) {
      flagsPatch.effort = effort as ClaudeCodeFlags["effort"];
    }
    if (design_workflow === "off" || design_workflow === "create-only" || design_workflow === "always") {
      flagsPatch.design_workflow = design_workflow;
    }
    if (typeof agent_teams_optin === "boolean") {
      flagsPatch.agent_teams_optin = agent_teams_optin;
    }
    if (typeof multi_agent_selection === "boolean") {
      flagsPatch.multi_agent_selection = multi_agent_selection;
    }
    if (cache_ttl === "5m" || cache_ttl === "1h") {
      flagsPatch.cache_ttl = cache_ttl;
    }
    if (Object.keys(flagsPatch).length > 0) {
      const { persistClaudeCodeFlags } = await import("./config.js");
      await persistClaudeCodeFlags(flagsPatch);
      // F2: CLI spawn env'i hemen güncelle (yeniden başlatmaya gerek kalmadan).
      if (flagsPatch.cache_ttl) setCacheTtl(flagsPatch.cache_ttl);
    }
    // v15.8: rol başına backend (API/Abonelik) — Modeller sekmesinde modellerle
    // birlikte kaydedilir. Geçerli değerler "api"|"cli"|"auto"; gerisi yok sayılır.
    // v15.12: "auto" = Auto Mode (CLI→API limitte, reset'te CLI'ye dön).
    if (backends) {
      const clean: Partial<AgentBackends> = {};
      for (const role of ["orchestrator", "translator", "main"] as const) {
        const v = backends[role];
        // Geçerli değerler yalnız api/cli/auto (z.ai 2026-07-16'da kaldırıldı; eski UI "zai" yollarsa düşer).
        if (v === "api" || v === "cli" || v === "auto") clean[role] = v;
      }
      if (Object.keys(clean).length > 0) {
        await persistAgentBackends(clean);
      }
    }
    runtime.config = null;
    const ok = await emitConfigStatus(); // runtime.config'i + singleton'ları YENİDEN yükler (restart'sız aktif)
    // Görünür onay (YZLLM 2026-06-10: "kapatıp açmadan da aktif olsun") — kullanıcı değişimin
    // anında geçerli olduğunu görür; bir sonraki iş/faz yeni backend+model+efor ile koşar.
    const fresh = runtime.config as MyclConfig | null;
    if (ok && fresh) {
      const b = fresh.agent_backends;
      const label = (v: string | undefined) =>
        v === "cli" ? "Abonelik" : v === "auto" ? "Auto" : "API";
      emitChatMessage(
        "system",
        `✅ Ayarlar uygulandı — yeniden başlatma GEREKMEZ. Bir sonraki iş şu ayarla koşar:\n` +
          `• Backend → main: ${label(b?.main)}, translator: ${label(b?.translator)}, orkestratör: ${label(b?.orchestrator)}\n` +
          `• Model → main: ${fresh.selected_models.main}` +
          `${flagsPatch.effort ? ` · efor: ${flagsPatch.effort}` : ""}`,
      );
      // Katalog DIŞI model seçildiyse GERÇEKTEN çağrılabilir mi dene (YZLLM 2026-08-04). Ayar ne olursa
      // olsun KAYDEDİLDİ (kullanıcı ayarı kral) — bu yalnız erken uyarı: model yanlış yazıldıysa kullanıcı
      // ilk faz düşene kadar beklemesin. Doğrulama kararı DEĞİŞTİRMEZ; model yükseltme askq'sindeki
      // "doğrulanmazsa geçme" davranışının tersi, çünkü orada öneren MyCL, burada seçen kullanıcı.
      const unknown = auditConfiguredModels(fresh.selected_models).slice(0, 2);
      for (const u of unknown) {
        const root = runtime.state?.project_root ?? process.cwd();
        const callable = await verifyModelCallable(fresh, u.id, root).catch(() => false);
        emitChatMessage(
          "system",
          callable
            ? `✅ **${u.id}** (${u.role}) MyCL kataloğunda yok ama çağrı denemesi başarılı — olduğu gibi kullanılacak.`
            : `⚠️ **${u.id}** (${u.role}) çağrılamadı (model adı yanlış olabilir). Ayarın DEĞİŞTİRİLMEDİ, olduğu gibi kaydedildi — bu modelle koşan fazlar görünür hatayla düşebilir.`,
        );
      }
    }
  } catch (err) {
    log.error("orchestrator", "save_selected_models failed", err);
    emitError("Ayarlar kaydedilemedi", String(err));
  }
}

// v15.7 (2026-05-25): Feature flags IPC handler.
async function handleSaveFeatures(
  features: Partial<import("./config.js").FeatureFlags>,
): Promise<void> {
  log.info("orchestrator", "save_features", features);
  try {
    await persistFeatures(features);
    // BUG FIX (2026-05-25): runtime.config'i null YAPMA — handleUserMessage
    // null check fail eder → "no active project" hatası. Yerinde reload.
    try {
      runtime.config = await loadConfig();
      applyConfigDerivedSettings(runtime.config); // restart'sız aktif (singleton'ları tazele)
    } catch (err) {
      log.warn("orchestrator", "config reload after save_features failed", err);
      // Eski config kalır; sonraki çağrı yine çalışır.
    }
    // Advisor (YZLLM 2026-07-11): toggle değiştiyse GÖRÜNÜR durum (KATI #4) — açtığı danışman gerçekten aktif mi,
    // değilse NEDEN atlanıyor (claude<2.1.98 / API modu). Sessiz değil.
    if ("advisor_enabled" in features && runtime.config) {
      const msg = advisorStatusMessage(runtime.config);
      if (msg) emitChatMessage("system", msg);
    }
    // Frontend'e güncel feature değerini de geri yolla (toggle confirm).
    try {
      const fresh = await readFeatures();
      emit("features_value", { features: fresh });
    } catch {
      emit("features_value", { features: { playwright_enabled: true } });
    }
  } catch (err) {
    log.error("orchestrator", "save_features failed", err);
    emitError("Özellikler kaydedilemedi", String(err));
  }
}

async function handleReadFeatures(): Promise<void> {
  try {
    const features = await readFeatures();
    emit("features_value", { features });
  } catch (err) {
    log.warn("orchestrator", "read_features failed", err);
    emit("features_value", { features: { playwright_enabled: true } });
  }
}

/**
 * Bağlam sadeleştirme doktoru (YZLLM 2026-07-11): enjekte edilen agent bağlamını ÖLÇER + "koddan türetilebilir/tekrar"
 * bölümler için kesim ÖNERİR (NON-DESTRUCTIVE — .mycl/context-trim-report.md + chat özeti; hiçbir dosya silinmez).
 */
async function handleRunContextTrimDoctor(): Promise<void> {
  if (!runtime.config || !runtime.state) {
    emitChatMessage("system", "🩺 Bağlam sadeleştirme: önce bir proje aç.");
    return;
  }
  emitChatMessage("system", "🩺 Bağlam analiz ediliyor (enjekte edilen prompt + yönergeler; kesim ÖNERİSİ, otomatik silme yok)…");
  try {
    const { summary } = await runContextTrimDoctor(runtime.config, runtime.state.project_root);
    emitChatMessage("system", summary);
  } catch (err) {
    log.error("orchestrator", "context-trim doctor failed", err);
    emitError("Bağlam sadeleştirme yapılamadı", String(err));
  }
}

async function handleListModels(
  which: "translator" | "main",
  force: boolean,
): Promise<void> {
  log.info("orchestrator", "list_models request", { which, force });
  try {
    // API key gerek — secrets'tan oku (config tam yüklenemese bile).
    let apiKey: string | undefined;
    if (runtime.config) {
      apiKey = runtime.config.api_keys[which];
    } else {
      const { loadConfig: lc } = await import("./config.js");
      try {
        const cfg = await lc();
        apiKey = cfg.api_keys[which];
      } catch {
        // Config load fail — secrets'i ayrı yoldan deneriz.
        // v15.8 (2026-05-30): Platform-aware path (paths.ts) — eski
        // `${HOME}/.mycl` hardcode'u Windows'ta yanlış olurdu.
        const { globalConfigFile } = await import("./paths.js");
        const secretsPath = globalConfigFile("secrets.json");
        const fs = await import("node:fs/promises");
        const raw = await fs.readFile(secretsPath, "utf-8");
        const parsed = JSON.parse(raw) as { api_keys?: { translator?: string; main?: string } };
        apiKey = parsed.api_keys?.[which];
      }
    }
    if (!apiKey) {
      // v15.14: NON-kritik — abonelik modunda API anahtarı yok → model dropdown'ı boş kalır;
      // kırmızı banner ile alarma sokma (yapılandırılmış modeller çalışmaya devam eder).
      log.warn("orchestrator", "list_models: api key yok (dropdown boş, non-fatal)", { which });
      // Terminal sinyal (kod-analiz 2026-06-07): frontend loading SADECE models_list event'iyle temizlenir;
      // emit etmezsek dropdown + ↻ butonu sonsuza dek "yükleniyor"da/disabled takılır. Boş liste → unstick.
      emit("models_list", { which, models: [], fetched_at: Date.now(), cached: false });
      return;
    }
    const result = await listModels(apiKey, force);
    emit("models_list", {
      which,
      models: result.models,
      fetched_at: result.fetched_at,
      cached: result.cached,
    });
  } catch (err) {
    // v15.14: NON-kritik — dropdown boş kalabilir; yapılandırılmış modeller çalışır. Kırmızı banner YOK
    // (timeout+retry zaten models.ts'te). Settings'ten "Modelleri Yenile" ile yeniden denenebilir.
    log.warn("orchestrator", "list_models failed (non-fatal, dropdown boş kalabilir)", err);
    // Terminal sinyal: başarısızlıkta da frontend loading'i temizle (stuck "yükleniyor" önle).
    emit("models_list", { which, models: [], fetched_at: Date.now(), cached: false });
  }
}

async function handleReadSelectedModels(): Promise<void> {
  try {
    const sel = await readSelectedModels();
    // v15.8 (2026-05-30): Efor da gönderilir — Settings Modeller sekmesindeki
    // efor seçici mevcut değeri göstersin.
    const flags = await readClaudeCodeFlags();
    // v15.8: rol-backend'leri (API/Abonelik) — Modeller sekmesindeki seçiciler
    // mevcut değeri göstersin (migration uygulanmış halde).
    const backends = await readAgentBackends();
    emit("selected_models", {
      selected: sel ?? null,
      effort: flags.effort ?? "max",
      backends,
      // v15.13: auto-model katmanları + tasarım fan-out flag'leri — Settings seçicileri için.
      model_tiers: sel?.model_tiers,
      design_workflow: flags.design_workflow ?? "off",
      agent_teams_optin: flags.agent_teams_optin ?? false,
      multi_agent_selection: flags.multi_agent_selection ?? false,
      cache_ttl: flags.cache_ttl ?? "5m",
    });
  } catch (err) {
    log.error("orchestrator", "read_selected_models failed", err);
    emitError("Seçili modeller okunamadı", String(err));
  }
}

/**
 * ▶ Çalıştır butonu gibi deterministic UI eylemleri için intent classifier
 * bypass — `text` zaten "projeyi çalıştır" niyetiyle gönderilmiş, command
 * handler stack tespiti + chain runner ile doğru komutu türetir. LLM çağrısı
 * yok, ~1-2sn + token tasarrufu.
 */
async function handleCommandDirect(
  text: string,
  intentKind: "run" | "test" | "build" | "install" | "lint",
  opts: { silent?: boolean } = {},
): Promise<void> {
  log.info("orchestrator", "command_direct", {
    text_len: text.length,
    intent_kind: intentKind,
    silent: opts.silent ?? false,
  });
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  // History persistence: user mesajını yaz (frontend setMainState ile UI'ya optimistic eklenmiştir).
  // silent=iç yönlendirme → kullanıcı bunu YAZMADI (sahte "role:user" mesajı geçmişe yazma).
  if (runtime.state.project_root && !opts.silent) {
    appendHistory(runtime.state.project_root, {
      ts: Date.now(),
      kind: "chat_message",
      data: { role: "user", text },
    }).catch((err) =>
      log.warn("orchestrator", "command_direct history fail", err),
    );
  }
  // YZLLM 2026-06-12: busy iken DÜŞÜRME (eski "komut bekletildi" + return = kayıp). command_direct
  // paralel-değil (shared pipeline'a dokunur) → kuyruğa al; faz/orkestratör boşa çıkınca sırayla işlenir.
  // submit() boşsa hemen çalıştırır (gövdeyi await eder), meşgulse sıraya alıp görünür bilgilendirir.
  await commandDirectQueue.submit({ text, intentKind, silent: opts.silent });
}

/**
 * command_direct'in ASIL gövdesi — kuyruk kilidi altında çalışır (tek seferde bir tane). history
 * kaydı + meşguliyet kontrolü handleCommandDirect/kuyruktadır; burada yalnız precondition + komut.
 */
async function runCommandDirectBody(
  text: string,
  intentKind: "run" | "test" | "build" | "install" | "lint",
): Promise<void> {
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  // Phase 0 D2_WAITING'de yeni komut başlatma — askq cevabı bekleniyor;
  // pipeline branch'lerine ayrılmasın.
  if (runtime.state.pending_diagnostic?.phase === "D2_WAITING") {
    emitChatMessage(
      "system",
      "🛑 Debug akışı askq cevabı bekliyor. Önce bir çözüm seç (veya Vazgeç).",
    );
    return;
  }
  // Inline intent — classifier'ın üretirdiği ile aynı şekil; reasoning kullanıcı
  // bilgilendirmesi için. v15.7 (2026-05-27): intent_kind UI'dan geliyor;
  // orchestrator metni regex'le yorumlamıyor.
  await handleCommandIntent(runtime.state, runtime.config, text, {
    kind: "command",
    reasoning: "direct button click (classifier bypass)",
    intent_kind: intentKind,
  });
}

// v15.7 (2026-05-27): classifyFixPlan + FixPlanKind kaldırıldı. Eski regex
// classifier semantic karar veriyordu (kullanıcı kuralı: "regex güvenilir
// değil"). Yerini D1 ana ajanın `plan_kind` tool field'ı aldı — plan'ı yazan
// agent kendisi sınıflandırır. Bkz [phase-0.ts](./phase-0.ts) FixPlanKind.

// Re-entrancy guard (kod-analiz 2026-06-07): app.ts `rl.on("line")` dispatch'i AWAIT etmiyordu →
// kullanıcı faz koşarken ikinci mesaj yazınca İKİ handleUserMessage aynı runtime.state/runtime.controller'ı
// eşzamanlı okuyup yazabiliyordu (faz-regresyonu/kilitlenme hissinin yapısal kaynaklarından). handleUserMessage
// tüm fazı await ettiğinden bayrak işlem boyunca tutulur; abort_phase AYRI handler olduğu için bloklanmaz
// (durdurma çalışmaya devam eder). Sessiz reddetme değil — görünür "işleniyor" mesajı.
let _handlingUserMessage = false;
// 2026-06-10 (YZLLM: "beni dinlemedi" — logda: faz çalışırken "Faz 10'dan devam et" dedi, MyCL iki kez
// "önce mevcut faza cevap ver" deyip reddetti). DOĞRU davranış: kullanıcının AÇIK yönlendirmesi çalışan
// fazı EZER → çalışanı durdur (abort), yeni isteği lock boşalınca işle. Reddetme YOK.
let _pendingRedirect: string | null = null;
let _userInitiatedAbort = false;

// YZLLM 2026-06-12: pipeline-derinlik sayacı. advanceToNextPhase fazlar arasında kısa süre controller=null
// bırakır (await appendCost gibi) + failPhase içinden ÖZYİNELEMELİ çağrılır → basit boolean drain'i fazlar
// arasına sızdırır. Sayaç: girişte ++, çıkışta (her return/break/throw) --; >0 ise pipeline koşuyor sayılır.
let _pipelineDepth = 0;

// Paralel-OLMAYAN işler (▶ Çalıştır/build/test/lint = command_direct) için FIFO kuyruk. Busy iken DÜŞÜRMEK
// yerine sıraya alır; faz/orkestratör/pipeline boşa çıkınca sırayla işler. Paralel-güvenli işler (quality
// audit, DAST, read-only sorgular) bu kuyruğa girmez — onlar zaten serbest koşar.
const commandDirectQueue = new SerialWorkQueue<{
  text: string;
  intentKind: "run" | "test" | "build" | "install" | "lint";
  /** İç yönlendirme (ör. foreign-run redirect) → kuyruğa alma/kuyruktan alma mesajlarını BASTIR (kullanıcı zaten
   *  net bir "çalıştırıyorum" mesajı gördü; "kuyruğa alındı — çalışan iş bitince" ONU YALANLAR). */
  silent?: boolean;
}>({
  isExternallyBusy: () =>
    runtime.controller !== null || _handlingUserMessage || _pipelineDepth > 0,
  exec: ({ text, intentKind }) => runCommandDirectBody(text, intentKind),
  onEnqueue: (item, position) => {
    if (item.silent) return;
    emitChatMessage(
      "system",
      `🧾 İş kuyruğa alındı (sıra ${position}) — çalışan iş bitince işlenecek.`,
    );
  },
  onResume: (item, remaining) => {
    if (item.silent) return;
    emitChatMessage(
      "system",
      `▶️ Kuyruktan alındı, işleniyor: "${item.text.slice(0, 40)}"${remaining > 0 ? ` (kalan ${remaining})` : ""}.`,
    );
  },
});

/** Çalışan fazı/işi kullanıcı yönlendirmesi nedeniyle durdurmak için (failPhase analizini atlatır). */
function isUserInitiatedAbort(): boolean {
  return _userInitiatedAbort;
}
function clearUserInitiatedAbort(): void {
  _userInitiatedAbort = false;
}

// SORU MODU oturum geçmişi (YZLLM 2026-06-19): orkestratör soru modunda turlar arası bağlamı
// KAYBEDİYORDU (her tur yalnız o anki soru geçiyordu → follow-up'a alakasız cevap). Çözüm: oturum-içi
// geçmiş tut → her tura ekle. Mod AÇILIP/KAPANINCA (set_question_mode) TEMİZLENİR → "kapatınca tamamen
// silinir". In-memory (per-window orkestratör süreci); süreç restart'ında da sıfırlanır (zaten silinmeli).
interface QmTurn {
  role: "user" | "assistant";
  text: string;
}
let questionModeHistory: QmTurn[] = [];
const QM_HISTORY_MAX_MSGS = 16; // son 8 soru-cevap (16 mesaj) — bağlam için yeter, prompt şişmesin
const QM_MSG_MAX_CHARS = 1500;

/** SAF-ish: oturum geçmişini prompt bağlam bloğuna çevir (boşsa ""). */
function formatQuestionModeHistory(): string {
  if (questionModeHistory.length === 0) return "";
  const lines = questionModeHistory.map(
    (t) => `${t.role === "user" ? "Kullanıcı" : "Sen"}: ${t.text.slice(0, QM_MSG_MAX_CHARS)}`,
  );
  return (
    `[Bu soru-modu oturumundaki ÖNCEKİ konuşma — bağlam için; follow-up sorulara (ör. "nereye yazdın?", ` +
    `"onu listele") BUNA göre cevap ver]\n${lines.join("\n")}\n---\n`
  );
}

/**
 * SORU MODU (YZLLM 2026-06-16): salt-okunur danışma. Kullanıcı bir İŞ değil, geçmiş
 * çalışmadan DERS/bilgi sorar; orkestratör-ajan `devs/` (iter-spec/page-spec) + `.mycl` +
 * kodu OKUYUP Türkçe cevaplar. Faz/iş/pipeline KESİNLİKLE tetiklenmez — executeAgentDecision
 * ÇAĞRILMAZ (LLM ne karar verirse versin yalnız message_to_user basılır). Çevirmen/main yok
 * (orkestratör zaten Türkçe). API/CLI/Auto pariteli (respondAsOrchestrator seam). Fail-soft.
 * v15.x (2026-06-19): oturum geçmişi (questionModeHistory) bağlam olarak eklenir + cevap geçmişe yazılır.
 */
async function handleAskQuestion(text: string): Promise<void> {
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  const q = text.trim();
  if (!q) return;
  try {
    emitPhaseRunning("🔎 Soru cevaplanıyor (salt okunur danışma)…");
    // Oturum geçmişini bağlam olarak ekle (follow-up'lar bağlansın) — yoksa düz soru.
    const historyBlock = formatQuestionModeHistory();
    const promptText = historyBlock ? `${historyBlock}Şimdiki soru: ${q}` : q;
    const decision = await respondAsOrchestrator(runtime.config, runtime.state, promptText, {
      questionMode: true,
    });
    const answer =
      decision.message_to_user?.trim() ||
      decision.reason?.trim() ||
      "Bu soruya verecek bir cevabım yok (ilgili veriyi bulamadım).";
    emitChatMessage("assistant", answer, { modelRole: "orchestrator" });
    // Oturum geçmişine yaz (ham soru + cevap) + cap (en yeniler kalır).
    questionModeHistory.push({ role: "user", text: q }, { role: "assistant", text: answer });
    if (questionModeHistory.length > QM_HISTORY_MAX_MSGS) {
      questionModeHistory = questionModeHistory.slice(-QM_HISTORY_MAX_MSGS);
    }
    // executeAgentDecision ÇAĞRILMAZ → faz/iş/pipeline kesinlikle tetiklenmez (salt-okunur Q&A).
  } catch (err) {
    log.warn("orchestrator", "soru modu cevabı başarısız", err);
    emitChatMessage("system", "⚠️ Soru cevaplanamadı (orkestratör hatası) — tekrar dener misin?");
  } finally {
    emitPhaseIdle();
  }
}

/**
 * YZLLM 2026-06-26 (req 4): Orkestra panelinin altındaki composer "iş" değil, işin NASIL yapılacağına dair KALICI
 * YÖNERGE verir (örn. "projelerde her zaman versiyonlama yapalım"). Orkestratör değerlendirir: itirazı varsa söyler
 * (kaydetmez), yoksa benimser → ~/.mycl/directives.md'ye ekler → sonraki TÜM orkestratör prompt'larına enjekte edilir
 * (context-builder) → çapraz-proje uygulanır. Salt-okunur değerlendirme (questionMode) → pipeline/faz TETİKLENMEZ.
 */
async function handleOrchestratorDirective(text: string): Promise<void> {
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  const d = text.trim();
  if (!d) return;
  // Mahkeme M2/M3: faz banner'ı/askq AKTİFSE göstergeye DOKUNMA — çalışan fazı sahte-IDLE göstermesin / parked
  // askq'nin "yanıtını bekliyorum" sessizliğini bozmasın. Boşken spinner feedback'i ver, doluyken sessiz değerlendir.
  const useBanner = !isPhaseIndicatorActive();
  // YZLLM 2026-06-27: yönerge konuşması ANA CHAT'E DEĞİL orkestratör paneline gider (emitDirectiveReply).
  // Önce kullanıcının yönergesini panele yankıla → panelde gerçek bir konuşma görünsün ("o konuştuklarımız").
  emitDirectiveReply("user", d);
  try {
    if (useBanner) emitPhaseRunning("🧭 Kalıcı yönerge değerlendiriliyor (orkestratör)…");
    const decision = await respondAsOrchestrator(runtime.config, runtime.state, buildDirectiveEvalPrompt(d), {
      questionMode: true, // salt-okunur değerlendirme → executeAgentDecision çağrılmaz, faz/iş tetiklenmez
    });
    // Mahkeme #4: KARAR işaretçisi message_to_user'da değil reason'da olabilir → ikisini birleştir (fail-closed korunur).
    const raw = [decision.message_to_user, decision.reason].filter(Boolean).join("\n").trim();
    const { verdict, message } = parseDirectiveVerdict(raw);
    if (verdict === "adopt") {
      const added = await appendUserDirective(d);
      emitDirectiveReply(
        "assistant",
        added
          ? `✅ Yönergeyi benimsedim${message ? ` — ${message}` : ""}\n\nBundan sonra tüm işlerde buna uyacağım (kalıcı kaydettim).`
          : `✅ Bu yönerge zaten kayıtlı${message ? ` — ${message}` : ""}\n\nUygulamaya devam ediyorum (tekrar eklemedim).`,
      );
    } else if (verdict === "object") {
      emitDirectiveReply(
        "assistant",
        `⚠️ Bu yönergeye itirazım var: ${message || "uygulanması sakıncalı."}\n\nBu yüzden kalıcı olarak kaydetmedim — yine de uygulamamı istersen söyle.`,
      );
    } else {
      // İşaretçi parse edilemedi → fail-closed: kaydetme, dürüst söyle (sessiz yanlış-kayıt YOK).
      emitDirectiveReply(
        "assistant",
        `Yönergeyi net bir karara bağlayamadım${message ? `:\n\n${message}` : ""}\n\nDaha açık yazarsan kalıcı yönerge olarak değerlendiririm (henüz kaydetmedim).`,
      );
    }
  } catch (err) {
    log.warn("orchestrator", "kalıcı yönerge değerlendirilemedi", err);
    emitDirectiveReply("system", "⚠️ Yönerge değerlendirilemedi (orkestratör hatası) — tekrar dener misin?");
  } finally {
    if (useBanner) emitPhaseIdle();
  }
}

async function handleUserMessage(text: string): Promise<void> {
  if (_handlingUserMessage) {
    // REDDETME (eski "beni dinlemedi" hatası): kullanıcı çalışan iş varken yeni bir şey yazdıysa,
    // bu açık bir yönlendirmedir → çalışanı DURDUR + bu mesajı sıraya al; lock boşalınca işlenir.
    _pendingRedirect = text;
    if (
      runtime.controller &&
      "abort" in runtime.controller &&
      typeof runtime.controller.abort === "function"
    ) {
      _userInitiatedAbort = true;
      runtime.controller.abort();
      emitChatMessage(
        "system",
        "⏹ Çalışan işi durduruyorum — sen yönlendirdin, isteğini işleyeceğim.",
      );
    } else {
      emitChatMessage("system", "⏳ Önceki mesaj işleniyor — biter bitmez bu isteğini işleyeceğim.");
    }
    return;
  }
  _handlingUserMessage = true;
  try {
    await handleUserMessageInner(text);
  } finally {
    _handlingUserMessage = false;
  }
  // Lock boşaldı — kullanıcı çalışan fazı durdurup yönlendirdiyse, o yönlendirmeyi ŞİMDİ işle.
  if (_pendingRedirect !== null) {
    const next = _pendingRedirect;
    _pendingRedirect = null;
    _userInitiatedAbort = false;
    await handleUserMessage(next);
  }
  // İş kuyruğu: bu turda bir kuyruk işi bittiyse/yarıda kaldıysa orphan uzlaştır +
  // bekleyen auto işleri seri işle (kilit boş → reconcile çalışır). Pipeline hâlâ
  // koşuyor/parklıysa reconcile guard'ı no-op → kendi finally'sinde tetiklenir.
  await reconcileAndDrainTasks();
  // Bu tur pipeline tetiklemediyse (sohbet/karar) sistem şimdi boşta — bekleyen command_direct varsa işle.
  // Pipeline tetiklediyse advanceToNextPhase senkron olarak _pipelineDepth'i artırmıştır → drain no-op,
  // pipeline bitince kendi finally'sinde boşaltılır.
  void commandDirectQueue.drain();
}
/**
 * 🗺️ Plan Modu mesaj işleyici (2026-07-16): metni (veya revizyon geri bildirimini) plana çevir,
 * sohbete yaz, korumalı onay askq'ı aç. Plan üretilemezse GÖRÜNÜR hata — hiçbir şey kuyruğa girmez
 * (sessiz tek-iş fallback'i YOK; plan modu açık bir moddur, KATI #4).
 */
async function handlePlanModeMessage(text: string, revisePrevious?: PlanProposal): Promise<void> {
  if (!runtime.state || !runtime.config) return;
  runtime.pendingPlanEdit = null; // revizyon geri bildirimi tüketildi (tek kullanımlık)
  emitPhaseRunning("🗺️ Plan hazırlanıyor", revisePrevious ? "revizyon" : "yeni plan");
  let plan: PlanProposal | null = null;
  try {
    plan = await generatePlan(
      runtime.config,
      runtime.state.project_root,
      text,
      revisePrevious ? { previous: revisePrevious, feedback: text } : undefined,
    );
  } finally {
    emitPhaseIdle();
  }
  if (!plan) {
    emitChatMessage(
      "error",
      "🗺️ Plan üretilemedi (planlayıcı hatası). Hedefi tekrar yaz; sorun sürerse plan modunu kapatıp normal akışı kullanabilirsin. Hiçbir iş kuyruğa eklenmedi.",
    );
    return;
  }
  const askqId = `plan_approve_${randomUUID()}`;
  runtime.pendingPlan = { askqId, plan };
  emitChatMessage("assistant", formatPlanTR(plan), { modelRole: "orchestrator" });
  await appendAuditModule(runtime.state.project_root, {
    ts: Date.now(),
    phase: runtime.state.current_phase,
    event: "plan-proposed",
    caller: "mycl-orchestrator",
    detail: `steps=${plan.steps.length}`,
  }).catch(() => {});
  emitAskq({
    id: askqId,
    question: "Plan bu — nasıl ilerleyelim?",
    options: ["✅ Planı onayla", "✏️ Düzenle", "Vazgeç"],
    allow_other: false,
    multi_select: false,
  });
}

async function handleUserMessageInner(text: string): Promise<void> {
  log.info("orchestrator", "user_message", { text_len: text.length });
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  // İzolasyon bayrağını temizle (YZLLM 2026-06-15): yeni kullanıcı turu kuyruk-işi DEĞİL
  // (orkestratör kararı konuşma geçmişini görmeli). runDevelopIteration kuyruk-işine girince
  // yeniden true yapar. Önceki kuyruk-işinden kalan bayat true'yu sızdırma.
  runtime.state = { ...runtime.state, iteration_isolated: false };
  // Yeni kullanıcı turu = yeni düzeltme-dizisi → eski rollback noktasını at (önceki turun bayat snapshot'ı
  // bu turun bir hatasında yanlışlıkla restore edilmesin). Tur içi snapshot'lar kendi rollback'ini arm eder.
  disarmRollback();
  // Bayat otomatik-faz-geçişi de iptal — kullanıcı yeni bir şey söylüyor, eski yönlendirme geçersiz.
  _resumePhaseAfterAbort = null;
  // GÜVENLİK (mahkeme, YZLLM 2026-07-03): yeni kullanıcı turu → yarım kalmış bulgu-kuyruğunu at. Yoksa terk
  // edilmiş bir kuyruk (awaitingRerun=true) sonraki iterasyonun Faz 13 varışında intercept'e takılıp GERÇEK
  // güvenlik gate'ini sessizce bypass edebilir (KATI #4). Fix-march'lar buradan GEÇMEZ (executeDispatchedIntent/
  // advanceToNextPhase iç yol) → aktif teker-teker akışı bozulmaz; yalnız kullanıcı-başlatan yeni tur temizler.
  runtime.findingQueue = null;
  // History persistence: user mesajını yaz. Frontend setMainState ile UI'a
  // ekledi ama backend echo etmiyordu → tarihte yer almıyordu. Açılışta
  // history_chunk'tan gelmediği için kaybolmuş gibi görünüyordu (kullanıcı
  // raporu 2026-05-20).
  if (runtime.state.project_root) {
    appendHistory(runtime.state.project_root, {
      ts: Date.now(),
      kind: "chat_message",
      data: { role: "user", text },
    }).catch((err) => log.warn("orchestrator", "user msg history fail", err));
  }
  // v15.7 (2026-05-26): Askq açıkken composer mesajına izin ver — bu mesaj
  // askq cevabı DEĞİL, genel bir cevap/eleştri/soru. Orkestratör ajan
  // anlamaya çalışır; aktif askq context'ine eklenir (context-builder).
  // Askq UI açık kalır; kullanıcı isterse askq'dan da cevap verebilir.
  // Kullanıcı kuralı: "Composer'dan bişeyler yazılırsa, o soru için değil,
  // daha genel kapsamda bi cevap ya da eleştri yapılıyor demektir."

  // 🗺️ PLAN MODU (2026-07-16): mod AÇIKKEN kullanıcı mesajı normal orkestratör kararına
  // GİTMEZ — planlayıcı çalışır, plan + korumalı onay askq'ı sunulur. Bekleyen plan
  // revizyonu varsa bu mesaj GERİ BİLDİRİMDİR (plan yeniden üretilir). Regex yok — bu bir
  // MOD kapısıdır (kullanıcının açtığı anahtar), niyet tahmini değil; KAPALIYKEN yol bayt-aynı.
  if (runtime.pendingPlanEdit) {
    await handlePlanModeMessage(text, runtime.pendingPlanEdit.plan);
    return;
  }
  if (isPlanMode()) {
    await handlePlanModeMessage(text);
    return;
  }

  // v15.7 (2026-05-27): Bug/probe regex fast-path kaldırıldı.
  // Kullanıcı kuralı: "orkestra ajanı her zaman llm e sorsun. kendi yanlış
  // karar veriyor". Ör. "anket oluşturma sayfasını test et" pattern olarak
  // probe match ediyordu ama kullanıcı niyeti farklı olabilir. Orkestratör
  // LLM her zaman karar verir; `debug_triage` action'ı agent'ın elinde,
  // gerçekten bug ise agent kendisi seçer.

  // v15.7 (2026-05-25): ORKESTRATOR AGENT TEK YOL. Classifier fallback
  // kaldırıldı (kullanıcı kararı: "Classifier kullanmasak ne olur? orkestra
  // ajanı zaten Classifier'ın yaptığı her şeyi en iyi şekilde yapmaz mı?").
  // Agent fail → kullanıcıya graceful chat mesajı + retry yolu. Single source
  // of truth prensibi: agent dosyalardan okuyor (state.json, audit, brief,
  // spec, memory), runtime-only intent state (pendingIntent) artık yok.
  // BEKLE-VE-DEVAM için yeniden çağrılabilir kapanış (YZLLM 2026-07-17): iki LLM kanalı da kapalıyken
  // bu tur kaybolmasın — erişim dönünce AYNI metinle yeniden denenir (aşağıdaki catch arm eder).
  const respondAndExecute = async (): Promise<void> => {
    // Kapanış sonradan (bekle-ve-devam zamanlayıcısından) da çağrılır → durumu O ANKİ haliyle doğrula.
    if (!runtime.config || !runtime.state) {
      emitChatMessage("system", "ℹ️ Otomatik devam atlandı — proje/yapılandırma bu arada değişmiş.");
      return;
    }
    const decision = await respondAsOrchestrator(
      runtime.config,
      runtime.state,
      text,
    );
    log.info("orchestrator", "agent decision", {
      action: decision.action,
      reason: decision.reason.slice(0, 100),
    });
    if (decision.action === "fallback_to_classifier") {
      // Eski sigorta — şimdi friendly chat. Agent kafası karışmış, açık soru iste.
      emitChatMessage(
        "system",
        "Anlayamadım, tekrar yazar mısın? Farklı bir cümle yapısı yardımcı olabilir.",
      );
      return;
    }
    await executeAgentDecision(decision, text);
  };
  try {
    await respondAndExecute();
  } catch (err) {
    log.warn("orchestrator", "agent failed", err);
    const msg = ((err as Error).message ?? "bilinmeyen hata").slice(0, 120);
    // v15.7 (2026-05-25): MAX_TOOL_TURNS hatası özel — agent karar verememiş,
    // genelde delegation ("sen yap") veya belirsiz cümle. Spesifik öneri ver.
    const isMaxTurns = /MAX_TOOL_TURNS|decide_action eksik/.test(msg);
    if (isMaxTurns) {
      emitChatMessage(
        "system",
        `🤖 Ajan karar veremedi (tool döngüsünde takıldı). İki seçenek:\n` +
          `• Cümleni daha net yaz (örn. "Faz 16'yı çalıştır" / "anketi browser'dan kontrol et")\n` +
          `• Sidebar'dan ilgili Faz'a tıkla → "✅ Çalıştır" seç (manuel tetik)\n\n` +
          `Sorun devam ederse Settings'ten daha güçlü model (Sonnet) seçebilirsin.`,
      );
    } else if (isApiAccountError(msg) || detectCliRateLimit(msg) !== null) {
      // İki kanal da kapalı sınıfı (kredi bitti / abonelik limiti) → tur KAYBOLMAZ: bekle-ve-devam
      // aynı mesajı erişim dönünce yeniden dener (YZLLM 2026-07-17, canlı cave 2 saat donması).
      // MAHKEME CRITICAL: gecikmeli koşum handleUserMessage'ın re-entrancy kilidinden GEÇMEZ →
      // meşguliyet/askq korumasını burada kur (makePhaseOutageResume'un ikizi); atlama GÖRÜNÜR.
      // MAHKEME CRITICAL (2026-07-23): meşgul atlaması "skipped" döner → bekleme sonlanmaz (sessiz yeniden
      // kurulur; mesaj yalnız ilk atlamada — makePhaseOutageResume ile aynı sözleşme).
      let skipNoticeShown = false;
      armLlmOutageWait(msg, async (): Promise<OutageResumeResult> => {
        if (_handlingUserMessage || _pipelineDepth > 0 || runtime.controller !== null || getActiveAskq() !== null) {
          if (!skipNoticeShown) {
            skipNoticeShown = true;
            emitChatMessage("system", "ℹ️ Otomatik devam şimdilik atlandı — sistem meşgul. Beklemeye devam ediyorum; istersen mesajını yeniden yaz.");
          }
          return "skipped";
        }
        emitChatMessage("system", "🔄 LLM erişimini yeniden deniyorum — açıldıysa mesajını kaldığım yerden yanıtlayacağım.");
        await respondAndExecute();
        return "resumed";
      });
    } else {
      emitChatMessage(
        "system",
        `🤖 Ajan şu an cevap veremedi (${msg}). Lütfen tekrar yaz; sorun devam ederse Settings'ten orkestratör model seçimini kontrol et.`,
      );
    }
  }
}

// v15.7 (2026-05-25): emitIntentConfirmAskq + intentToNaturalSentence
// KALDIRILDI — classifier path silindi, confirm askq artık açılmıyor.
// Agent her zaman doğrudan executeAgentDecision çağırıyor.

// Netleştirme-mahkemesi döngü-emniyeti (YZLLM 2026-06-22): müfettiş bir netleştirmeyi "ilerle" diye
// çözünce orkestratör yeniden karar verir; arka arkaya ÇÖZÜLEN ama ilerleme getirmeyen netleştirme
// sayısı bu kapağa varınca insana sorulur (müfettiş yargısı zaten kör-pick değil, ama kademeli emniyet).
// ask_clarify DIŞINDA bir aksiyon (gerçek ilerleme) çalışınca sıfırlanır.
const CLARIFY_INSPECT_MAX = 2;
let _clarifyInspectChain = 0;
// DÖNGÜ EMNİYETİ (YZLLM 2026-07-13, canlı cave-7ac855d7 SAHTE-TAMAMLANMA): müfettiş SİSTEMATİK "değerlendirme üretemedi"
// (rate-limit/LLM-fail) durumunda failPhase'deki "escalate → accept-continue" HER fazı (1-9) saniyelerde geçip pipeline'ı
// "done" yapıyordu — HİÇ kod/test/UI yazmadan (code-edit:0) → görev sahte-tamamlandı. Clarify devre-kesicisinin
// (CLARIFY_INSPECT_MAX) faz-hatası kardeşi: art arda escalate-accept say → MAX'ta DÜRÜST DUR (görevi done sayma).
const ESCALATE_ACCEPT_MAX = 3;
let _escalateAcceptChain = 0;
// 2026-07-30 (YZLLM kararı, canlı cave: "değerlendirme üretilemedi" 129 kez → hepsi kabul-devam ile geçti):
// SAĞLAYICI kaynaklı escalate (müfettişe hiç ulaşılamadı = denetim YAPILMADI) ile GERÇEK kuşkulu bulgu
// escalate'i ayrı sayılır. Sağlayıcı dalında kabul-devam HİÇ yok — akış gerçek çözüm yoluna gider; art arda
// 3 kez ulaşılamazsa dürüstçe durur ve erişim dönünce KALDIĞI FAZDAN sürer.
const INSPECTOR_UNAVAILABLE_MAX = 3;
let _inspectorUnavailableChain = 0;

/**
 * v15.5 — Orkestrator agent AgentDecision'ı executeDispatchedIntent'in
 * beklediği DispatchOutcome formatına map eder + uygun handler'ı çağırır.
 * Agent askq atlayarak DİREKT aksiyon almayı seçer (chat/ask_clarify/run_phase)
 * veya mevcut Phase 6 deferred/develop/debug pipeline'ına bağlanır.
 */
async function executeAgentDecision(
  decision: AgentDecision,
  text: string,
): Promise<void> {
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  // v15.15: Pre-hoc bağımsız kör-nokta merceği — consequential karar EXECUTE edilmeden ÖNCE, bu
  // kararı VERMEYEN ayrı bir ajan "neyi paranteze aldın?"ı yakalar; bulgular GÖRÜNÜR (sessiz değil)
  // ama kararı BLOKLAMAZ (fail-safe). Gate trivial/reversible'ı eler → friction yok. NOT: bu yol
  // _handlingUserMessage busy-guard altında; tek-ucuz-tur latency'si kabul (gate çoğu kararı atar).
  if (
    blindspotLensDecision({
      lensFlag: runtime.config.claude_code_flags.blindspot_lens ?? "consequential",
      isConsequential: decisionIsConsequential(decision),
      isReversible: false,
    }) === "run"
  ) {
    // Mercek fail-safe (kararı bloklamaz) → ama altta runReasoningTurn'ün hiç
    // settle ETMEME ihtimaline karşı SERT timeout: 60s'de bitmezse görünür not +
    // karar bloklanmadan sürer. (runBlindspotLens'in try/catch'i yalnız reject'i
    // yakalar; never-settling promise'i değil → _handlingUserMessage deadlock'u.)
    const LENS_HARD_TIMEOUT_MS = 60_000;
    const lens = await Promise.race<LensResult>([
      runBlindspotLens(
        runtime.config,
        runtime.state.project_root,
        "decision",
        `Action: ${decision.action}${
          decision.target_phase !== undefined ? ` (phase ${decision.target_phase})` : ""
        }\nReason: ${decision.reason}`,
      ),
      new Promise<LensResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              ran: true,
              clean: false,
              blindspots: [],
              error: "mercek zaman aşımı (60s) — karar bloklanmadan sürdü",
            }),
          LENS_HARD_TIMEOUT_MS,
        ),
      ),
    ]);
    if (!lens.clean) {
      const m = formatLensFindings(lens);
      if (m) emitChatMessage("system", m);
    }
  }
  // v15.7 (2026-05-27): policy-detector regex shadow check kaldırıldı.
  // Prompt-level HARD RULE'lar (orchestrator-system.md / phase-01-intent.md)
  // source of truth; regex shadow check yanlış pozitif riski + audit gürültüsü.
  // Kullanıcı kuralı: "regex güvenilir değil".
  // Netleştirme-mahkemesi döngü-emniyeti: ask_clarify DIŞINDA bir aksiyon = gerçek ilerleme → sayacı sıfırla.
  if (decision.action !== "ask_clarify") {
    _clarifyInspectChain = 0;
    _escalateAcceptChain = 0; // gerçek orkestratör aksiyonu (yeni iş/faz) → escalate-kaskat sayacı sıfır (per-iş devre-kesici).
    _inspectorUnavailableChain = 0;
  }
  switch (decision.action) {
    case "chat": {
      const msg = decision.message_to_user ?? decision.reason;
      emitChatMessage("assistant", msg, { modelRole: "orchestrator" });
      return;
    }
    case "ask_clarify": {
      // Doğru-karar/proaktif-risk (2026-06-04): clarify_options doluysa SOMUT
      // seçenekler (risk + gerçek alternatifler); yoksa jenerik Evet/Hayır/Vazgeç.
      // Cevap akışı: agent_clarify_ → handleAskqAnswer → "Vazgeç" sessiz kapanış,
      // diğer seçim handleUserMessage'e → ajan o yönle yeniden karar verir.
      const askqId = `agent_clarify_${randomUUID()}`;
      const rich = decision.clarify_options && decision.clarify_options.length > 0;
      const clarifyOptions = rich ? [...decision.clarify_options!, "Vazgeç"] : ["Evet", "Hayır", "Vazgeç"];
      const clarifyQuestion = decision.message_to_user ?? decision.reason;
      // ⚖️ MAHKEME (YZLLM 2026-06-22 "müfettişle konuşsun, mahkeme kurulsun"): orkestratör "emin değilim,
      // sorayım" derken müfettiş BAĞIMSIZ tartar — gerçek belirsizlik mi (tercih/zevk/geri-alınamaz/eksik-
      // bilgi → insana), yoksa gereksiz mi soruyor (cevap çıkarılabilir → ilerle). Oto-cevap açıkken
      // (kullanıcı izlemiyor) devreye girer: insana yalnız GERÇEK belirsizlikte gidilir, gereksiz kart
      // boşuna bekletmez. Kör auto-pick DEĞİL (müfettiş yargısı) + kademeli döngü-emniyeti → sonsuz-clarify yok.
      const cfg = runtime.config;
      if (autoAnswerSuggested() && cfg.features.inspector_enabled) {
        if (_clarifyInspectChain >= CLARIFY_INSPECT_MAX) {
          // never-ask'ta "sana soruyorum" YANILTICI (aşağıdaki isNeverAsk bloğu ilerletir/durdurur) → bastır (mahkeme minor).
          if (!isNeverAsk()) {
            emitChatMessage(
              "system",
              `⚖️ Mahkeme: arka arkaya ${_clarifyInspectChain} netleştirme çözüldü ama ilerleme yok → ` +
                `döngü emniyeti için sana soruyorum.`,
            );
          }
        } else {
          try {
            const ruling = await inspectClarify(cfg, {
              projectRoot: runtime.state.project_root,
              intent: text,
              trajectory: decision.reason,
              question: clarifyQuestion,
              options: clarifyOptions.filter((o) => o !== "Vazgeç"),
            });
            await appendAuditModule(runtime.state.project_root, {
              ts: Date.now(),
              phase: runtime.state.current_phase,
              event: `mahkeme-clarify-${ruling.ask ? "ask" : "proceed"}`,
              caller: "mycl-orchestrator",
              detail: ruling.summary.slice(0, 400),
            }).catch(() => {});
            if (!ruling.ask && ruling.answer) {
              _clarifyInspectChain++;
              const answer = ruling.answer;
              emitChatMessage(
                "system",
                `⚖️ Mahkeme: bu netleştirme gereksiz — müfettiş **"${answer}"** ile ilerlemeyi uygun gördü ` +
                  `(sana sormadan).\n${ruling.summary}`,
              );
              // Kilit-DIŞINA ertele: inline handleUserMessage busy-guard'a takılıp çalışan işi ABORT eder
              // → setImmediate ile lock boşalınca gerçek-cevap yoluyla birebir işle.
              setImmediate(() => {
                void handleUserMessage(answer);
              });
              return;
            }
            // never-ask'ta bu mesajı HİÇ basma: aşağıdaki isNeverAsk bloğu TEK "en makul seçenekle ilerliyorum" mesajını
            // basar (çift-mesaj önlenir; mahkeme minor). ruling.summary zaten audit'e yazıldı (yukarıda). Non-never-ask: sor.
            if (!isNeverAsk()) {
              emitChatMessage("system", `⚖️ Mahkeme: belirsizlik gerçek — sana soruyorum.\n${ruling.summary}`);
            }
          } catch (e) {
            log.warn("orchestrator", "mahkeme clarify-incelemesi hata (yutuldu → insana sor)", {
              error: String(e),
            });
            if (!isNeverAsk()) {
              emitChatMessage("system", "⚖️ Mahkeme (netleştirme) erişilemedi — güvenli tarafta kaldım, soruyu sana yönelttim (denetimsiz).");
            }
          }
        }
      }
      // HİÇBİR ŞEY SORMA (YZLLM 2026-07-09): mahkeme "gerçek belirsizlik — insana sor" dese/erişilemese bile insana GİTME
      // (kullanıcı yok) → en makul/ilk seçenekle ilerle (clarify prompt'ta conservative/güvenli-önce). GÖRÜNÜR (LOUD).
      // DÖNGÜ EMNİYETİ (mahkeme 2026-07-09): devre-kesici + ask=true dalları buraya RETURN'süz düşer; _clarifyInspectChain'i
      // BURADA say → ajan ısrarla aynı belirsizliği üretip autoPick çözemezse sonsuz setImmediate→handleUserMessage→
      // ask_clarify çevrimi OLMASIN. MAX aşılırsa autoPick YAPMA → LOUD dur (frozen-goal: geç YA DA escalate; görünür
      // duruş, sessiz-döngü değil). Gerçek ilerleme (ask_clarify DIŞI aksiyon) sayacı yukarıda sıfırlar (2868).
      if (isNeverAsk()) {
        _clarifyInspectChain++;
        if (_clarifyInspectChain > CLARIFY_INSPECT_MAX) {
          emitChatMessage(
            "system",
            `⚠️ Hiçbir şey sorma: art arda ${_clarifyInspectChain} netleştirme çözülemedi — döngü emniyeti için otomatik ilerletmeyi DURDURDUM. Farklı bir işle sayaç sıfırlanır.`,
          );
          return;
        }
        // KÖR-ilk-seçenek DEĞİL (YZLLM 2026-07-10): orkestra ajanı bağlam-farkında seçer. Mahkeme ZATEN üstte koştu
        // (autoAnswerSuggested + inspector_enabled) → skipCourt (çift-mahkeme yok).
        const pick = await chooseAutonomousAnswer({
          id: askqId,
          question: clarifyQuestion,
          options: clarifyOptions,
          intent: text,
          trajectory: decision.reason,
          skipCourt: true,
        });
        if (!pick) {
          // GÜVENLİ cevap YOK (tüm seçenekler yıkıcı → korunmalı / runtime yok). KÖR fallback YAPMA (mahkeme: eski
          // `?? fallback` yıkıcı "Sil ve devam et"i seçip çalıştırıyordu → "yalnız-yıkıcı → korunmalı" garantisi kırılmıştı).
          // Netleştirmeyi kullanıcıya YÜZEYE ÇIKAR (protected → hook otonom cevaplamaz, açık tutar) — güvenlik oto-değil, kuşkuda İNSAN.
          emitChatMessage(
            "system",
            `⚠️ Hiçbir şey sorma: "${clarifyQuestion.slice(0, 80)}" için güvenli otonom cevap üretemedim (yalnız-yıkıcı/belirsiz) — bu netleştirmeyi sana bırakıyorum.`,
          );
          emitAskq({
            id: askqId,
            question: clarifyQuestion,
            options: clarifyOptions,
            multi_select: false,
            allow_other: true,
            protected: true,
          });
          return;
        }
        emitChatMessage(
          "system",
          `🤖 Hiçbir şey sorma: netleştirme sorulmadı — orkestra ajanı "${pick}" ile ilerliyor.\n${clarifyQuestion}`,
        );
        setImmediate(() => {
          void handleUserMessage(pick);
        });
        return;
      }
      emitAskq({
        id: askqId,
        question: clarifyQuestion,
        options: clarifyOptions,
        multi_select: false,
        allow_other: true,
      });
      return;
    }
    case "run_phase": {
      if (decision.target_phase === undefined) {
        log.warn("orchestrator", "agent run_phase missing target_phase");
        return;
      }
      await emitPhaseRunAskq(decision.target_phase, true);
      return;
    }
    case "run_project": {
      // VAR OLAN/kurulu uygulamayı ÇALIŞTIR — dev-server başlat (▶ butonun deterministik yolu: handleCommandDirect →
      // runDevServer → launchWithProvision, deps kurulum/kurtarma/servis dahil). UI codegen (run_phase 5) DEĞİL →
      // state.current_phase değişmez + non-consequential (kör-nokta merceği bu istekte KOŞMAZ; "çalıştır=Faz5" karmaşası
      // biter). silent: sahte user-history + çelişkili "kuyruğa alındı" mesajını bastırır (redirectForeignRunToDevServer deseni).
      emitChatMessage("system", "▶️ Projeyi çalıştırıyorum…");
      await handleCommandDirect(text, "run", { silent: true });
      return;
    }
    case "run_maintenance": {
      // 🔧 Bakım Turu (2026-07-16): sohbet niyeti de BUTONLA AYNI onay askq'suna düşer —
      // bağımlılık YAZAN işlem onaysız başlayamaz (korumalı id; never-ask bile oto-onaylayamaz).
      await handleRunMaintenanceRequest();
      return;
    }
    case "approve_ui":
    case "revise_ui":
    case "resume_pipeline":
    case "develop_new_or_iter": {
      // Faz 6 BİLEŞİK MESAJ (YZLLM 2026-06-15): kullanıcı UI incelemesi (Faz 6 park) sırasında HEM
      // (belki) mevcut işi onaylayıp HEM yeni/farklı bir iş bildirebilir. Tek-action modeli ikisini
      // birden yapamıyordu → onay kaybolup mevcut iş Faz 6'da takılıyor, ayrıca yeni iş kuyruğa
      // giriyordu. Burada İKİSİNİ DE yap: yeni iş(ler)i kuyruğa ekle + onaya göre devam et / tekrar sor.
      if (
        runtime.state.current_phase === 6 &&
        runtime.state.pending_ui_review &&
        decision.phase6_approval
      ) {
        emitChatMessage("assistant", decision.reason, { modelRole: "orchestrator" });
        // Yeni iş(ler)i KUYRUĞA ekle (BAŞLATMA — mevcut UI işi park'ta; kuyruk-drain onu bekler).
        // Mesaj salt onaysa intake boş döner (yeni iş yok) — sorun değil.
        try {
          await intakeAndEnqueue(runtime.config, runtime.state.project_root, text);
        } catch (err) {
          log.warn("orchestrator", "faz6 bileşik intake hatası (non-fatal)", err);
        }
        if (decision.phase6_approval === "approve") {
          // NET onay → mevcut UI işini onayla + Faz 7. Kuyruğa eklenen yeni iş, bu iş bitince sırayla işlenir.
          await appendAuditModule(runtime.state.project_root, {
            ts: Date.now(),
            phase: 6,
            event: "phase-6-complete",
            caller: "user",
            detail: text.slice(0, 200),
          });
          runtime.state = { ...runtime.state, pending_ui_review: undefined, updated_at: Date.now() };
          await saveState(runtime.state);
          emitChatMessage(
            "system",
            "✅ Faz 6 onaylandı (bildirdiğin yeni iş varsa kuyruğa eklendi) — Faz 7'e geçiliyor.",
          );
          await advanceToNextPhase(6);
        } else {
          // reask: onay net değil → yeni iş kuyrukta, UI incelemesi kararını TEKRAR sor (iş park'ta kalır).
          // YZLLM 2026-06-17: "UI'yi onayla" derken UI tarayıcıda AÇIK olmalı. Bu reask yolu (controller DEĞİL)
          // dev-server'ı garantilemiyordu → boot-resume Faz 6'da / Faz 5 atlanmışsa dev-server yok → kullanıcı
          // neyi onaylayacağını göremiyordu. Sormadan ÖNCE dev-server ayakta mı bak, değilse başlat (controller ile aynı).
          // FROZEN-GOAL #11: ensureDevServerForReview dönüşü yok sayılıyordu → dev-server başlamasa bile
          // "UI'yi onayla" deniyordu (çalışmayan uygulamayı incele). ok'a göre mesajı ayır.
          const dev = await ensureDevServerForReview(runtime.state, runtime.config);
          emitChatMessage(
            "system",
            dev.ok
              ? "👀 Bildirdiklerin kuyruğa eklendi. Bu işin UI'sini onaylıyor musun → `tamam` (Faz 7'e geçeriz) · düzeltme istersen yaz · `iptal` ile durdur."
              : "⚠️ Bildirdiklerin kuyruğa eklendi AMA dev-server otomatik başlatılamadı — UI'yi inceleyemezsin. Terminalde `npm run dev` ile başlat, sonra `tamam`/`iptal` yaz (ya da düzeltme iste).",
          );
        }
        return;
      }
      // v15.6 (2026-05-24): Açık niyetler için askq KALDIRILDI. Kullanıcı
      // talebi: "bunu sormasına gerek yoktu". Bu aksiyonlar non-destructive
      // ve niyet zaten kullanıcı mesajında açık → ekstra "Devam edeyim mi?"
      // adımı sadece friction yaratıyor. Chat'e tek satır açıklama yazılır
      // ve direkt execute edilir. Phase 1 (develop_new_or_iter) zaten kendi
      // clarification askq'larını sorar.
      emitChatMessage("assistant", decision.reason, { modelRole: "orchestrator" });
      // Decision log (audit-like) — dedup şu an kapalı ama record persist.
      try {
        await appendAgentDecisionLog(runtime.state.project_root, {
          ts: Date.now(),
          user_text: text,
          topic_slug: decision.topic_slug ?? "uncategorized",
          action: decision.action,
          reason: decision.reason,
          confirmed: true,
        });
      } catch (err) {
        log.warn("orchestrator", "agent decision log fail (fast-path)", err);
      }
      // ÇOKLU AJAN SEÇİMİ (opt-in, varsayılan KAPALI): niyet ≥2 GERÇEKTEN bağımsız modüle bölünüyorsa
      // izole worktree'lerde PARALEL yazdır. Kullanıldıysa fresh seri pipeline'ı ÇALIŞTIRMA (üzerine yazmasın).
      // Flag kapalıysa bu blok hiç girmez → normal akış değişmez. Her hata → used:false → normal akışa düşer.
      if (runtime.config.claude_code_flags.multi_agent_selection) {
        const sel = await runMultiAgentSelection(runtime.config, runtime.state, text);
        if (sel.used) {
          emitChatMessage(
            "assistant",
            `🤖 Çoklu Ajan Seçimi: ${sel.modules?.length ?? 0} bağımsız modül PARALEL yazıldı ` +
              `(${(sel.modules ?? []).join(", ")}). Dosyalar: ${(sel.files ?? []).join(", ")}.`,
          );
          // (b) ANLAMSAL / business-logic review: birleşik çıktı bütün hâlinde tutarlı mı (bağımsız ajanlar
          // birbirini görmeden yazdı → mekanik kapıların göremediği semantik/gizli-kuplaj). Yüzeye çıkarır, bloklamaz.
          try {
            const review = await reviewMergedModules(runtime.config, runtime.state.project_root, sel.files ?? []);
            emitChatMessage("assistant", formatReview(review));
          } catch (e) {
            log.warn("orchestrator", "paralel anlamsal review hatası (non-blocking)", e);
          }
          // (a) TAM TİTİZLİK: paralel sonucu Faz 10-17 kalite pipeline'ından GEÇİR (codegen'den SONRA → ezmez,
          // sadece doğrular: sadeleştir/perf/entegrasyon/e2e/yük dahil) + pipeline-SONU tazeleme (living-docs/
          // proje-haritası/handoff) GERÇEK akıştan koşar. Bu yüzden burada return YOK / elde-tazeleme YOK.
          emitChatMessage("assistant", "Kalite fazları (10-17) paralel sonuç üstünde çalışıyor…");
          await advanceToNextPhase(9);
          return;
        }
        log.info("orchestrator", "Çoklu Ajan Seçimi kullanılmadı → seri develop", { reason: sel.reason });
      }
      await executeConfirmedAgentDecision(decision, text);
      return;
    }
    case "debug_triage": {
      // YZLLM 2026-06-14 ("evet/hayır çıkmasın, direk işe koyulsun her zaman"): debug_triage NON-DESTRUCTIVE
      // (yalnız hatayı araştırır) + niyet kullanıcı mesajında açık → "Devam edeyim mi?" ONAYI KALDIRILDI.
      // develop_new_or_iter ile aynı hızlı-yol: tek satır açıklama + DİREKT execute (Faz 0 başlar).
      emitChatMessage(
        "assistant",
        decision.message_to_user ? `${decision.reason}\n\n${decision.message_to_user}` : decision.reason,
      );
      try {
        await appendAgentDecisionLog(runtime.state.project_root, {
          ts: Date.now(),
          user_text: text,
          topic_slug: decision.topic_slug ?? "uncategorized",
          action: decision.action,
          reason: decision.reason,
          confirmed: true,
        });
      } catch (err) {
        log.warn("orchestrator", "agent decision log fail (debug_triage fast-path)", err);
      }
      await executeConfirmedAgentDecision(decision, text);
      return;
    }
    case "cancel_pipeline": {
      // YIKICI (iş kaybı riski) → onay KORUNUR (YZLLM: silme/yıkıcı onayı gerçek kullanıcı-seçimidir; "direk işe
      // koyul" KURAL'ı işe-başlamak içindir, işi YOK ETMEK için değil). HİÇBİR ŞEY SORMA modunda BİLE korunur —
      // pipeline/iş iptali geri-alınamaz; "yıkıcı/yüksek-risk koruma açık kalır" (kullanıcı AskUserQuestion'da onayladı).
      const chatMsg =
        decision.message_to_user
          ? `${decision.reason}\n\n${decision.message_to_user}`
          : decision.reason;
      emitChatMessage("assistant", chatMsg, { modelRole: "orchestrator" });
      const askqId = `agent_decision_${randomUUID()}`;
      runtime.pendingAgentDecision = { askqId, decision, text };
      emitAskq({
        id: askqId,
        question: "Devam edeyim mi?",
        options: ["✅ Evet", "❌ Hayır", "Vazgeç"],
        multi_select: false,
        allow_other: false,
      });
      return;
    }
    case "save_memory_proposal": {
      // v15.6: Agent 2. confirmation tetiklendi — hafıza kayıt önerisi.
      if (!decision.memory_proposal) {
        log.warn("orchestrator", "save_memory_proposal missing memory_proposal");
        return;
      }
      const proposal = decision.memory_proposal;
      const topicSlug = decision.topic_slug ?? "uncategorized";
      const summaryMsg =
        `${decision.reason}\n\n📝 **Özet**: ${proposal.summary}` +
        (proposal.affected_files?.length
          ? `\n📁 **Dosyalar**: ${proposal.affected_files.join(", ")}`
          : "") +
        (proposal.affected_db_tables?.length
          ? `\n🗄 **DB tabloları**: ${proposal.affected_db_tables.join(", ")}`
          : "") +
        (proposal.affected_algorithms?.length
          ? `\n⚙️ **Algoritmalar**: ${proposal.affected_algorithms.join(", ")}`
          : "") +
        (proposal.change_description
          ? `\n🔧 **Değişiklik**: ${proposal.change_description}`
          : "");
      emitChatMessage("assistant", summaryMsg, { modelRole: "orchestrator" });
      const askqId = `mem_propose_${randomUUID()}`;
      runtime.pendingMemoryProposal = {
        askqId,
        proposal,
        topic_slug: topicSlug,
        user_text: text,
        decision_action: decision.action,
      };
      // HİÇBİR ŞEY SORMA (YZLLM 2026-07-09): hafıza kapsamı düşük-riskli, geri-alınabilir tercih → güvenli varsayılan
      // "Projeye özel" otomatik seçilir (kararı MyCL verir; genel hafızayı kirletmez). Mevcut cevap-işleme yolu kullanılır.
      if (isNeverAsk()) {
        emitChatMessage("system", '🤖 Hiçbir şey sorma modu: hafıza kaydı "Projeye özel" olarak otomatik seçildi.');
        await handleAskqAnswer(askqId, "📁 Projeye özel").catch((e: unknown) =>
          log.error("orchestrator", "never-ask memory-proposal auto-route failed", e),
        );
        return;
      }
      emitAskq({
        id: askqId,
        question: "Hangi hafızaya kaydedeyim?",
        options: [
          "📁 Projeye özel",
          "🌐 Genel (başka projelerde de görünür)",
          "📁🌐 Her İkisi",
          "❌ Hayır",
        ],
        multi_select: false,
        allow_other: false,
      });
      return;
    }
    case "set_optional_phases": {
      // v15.7 (2026-05-26): Orkestra Faz 1 sonrası opsiyonel faz scope'unu
      // belirledi. state.needed_phases güncellenir (zorunlu fazlar + seçilen
      // opsiyoneller). Pipeline akışı bir sonraki advance'te bu scope'u kullanır.
      const optional = decision.optional_phases_to_run ?? [];
      const requiredPhases = [1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 17];
      const newScope = [...requiredPhases, ...optional].sort((a, b) => a - b);
      runtime.state = {
        ...runtime.state,
        needed_phases: newScope as PhaseId[],
        updated_at: Date.now(),
      };
      await saveState(runtime.state);
      syncNeededPhases(); // kapsam belirlendi → PhaseSidebar kapsam-dışı opsiyonelleri soluklaştırsın
      await appendAuditModule(runtime.state.project_root, {
        ts: Date.now(),
        phase: runtime.state.current_phase,
        event: "optional-phases-set",
        caller: "mycl-orchestrator",
        detail: `optional=[${optional.join(",")}] scope=[${newScope.join(",")}]`,
      });
      emitChatMessage("assistant", decision.reason, { modelRole: "orchestrator" });
      if (decision.message_to_user) {
        emitChatMessage("assistant", decision.message_to_user, { modelRole: "orchestrator" });
      }
      return;
    }
    case "answer_askq": {
      // v15.7 (2026-05-26): Kapı bekçisi — askq açıkken composer'dan mesaj
      // geldi, orkestratör mesajın askq'ya uygun cevap olduğuna karar verdi.
      // Programatik olarak handleAskqAnswer çağırılır; ana ajan askq cevabı
      // gelmiş gibi devam eder.
      const ans = decision.askq_answer ?? "";
      const active = getActiveAskq();
      if (!active) {
        log.warn("orchestrator", "answer_askq but no active askq", { ans });
        emitChatMessage(
          "assistant",
          `${decision.reason}\n\n(Aktif soru bulunamadığı için cevap iletilemedi.)`,
        );
        return;
      }
      if (decision.reason) {
        emitChatMessage("assistant", decision.reason, { modelRole: "orchestrator" });
      }
      log.info("orchestrator", "answer_askq forwarding", {
        askqId: active.id,
        ans: ans.slice(0, 80),
      });
      await handleAskqAnswer(active.id, ans);
      return;
    }
    case "verify_feature": {
      // v15.8 (2026-05-30): Spesifik özelliği gerçekten test et — ana ajan
      // hedefli E2E testi yazar + çalıştırır + dürüst rapor. target_feature
      // yoksa kullanıcı mesajına düş.
      const st = runtime.state;
      const cfg = runtime.config;
      if (!st || !cfg) return;
      const feature = decision.target_feature ?? text;
      if (decision.reason) emitChatMessage("assistant", decision.reason, { modelRole: "orchestrator" });
      try {
        const res = await verifyFeatureHandler(feature, { state: st, config: cfg });
        if (res.statePatch) {
          runtime.state = { ...st, ...res.statePatch, updated_at: Date.now() };
          await saveState(runtime.state);
        }
        // v15.8 (2026-05-30): Gerçek test başarısızlığında dead-end YOK —
        // kök neden araştırması için Faz 0 D1'e devret (kullanıcı kuralı:
        // "çözümsüz bırakmamalı"). statePatch zaten yukarıda persist edildi.
        if (res.followUp?.kind === "debug_triage") {
          await executeConfirmedAgentDecision(
            {
              action: "debug_triage",
              reason:
                "Üretilen test gerçek bir hata yakaladı; kök nedeni araştırıyorum.",
              topic_slug: "verify-feature-fail",
            },
            res.followUp.bugReport,
          );
        }
      } catch (err) {
        log.error("orchestrator", "verify_feature failed", err);
        emitChatMessage(
          "system",
          `❌ Özellik testi sırasında beklenmedik bir hata oldu: ${String(err).slice(0, 150)}`,
        );
      }
      return;
    }
    case "fallback_to_classifier":
      // handleUserMessage'da yakalanır — buraya gelmemeli ama defensive
      log.warn("orchestrator", "executeAgentDecision: unexpected fallback action");
      return;
  }
}

/**
 * v15.6: pendingAgentDecision askq Evet cevabı sonrası executeDispatchedIntent
 * çağırarak agent'ın kararını uygular. run_phase için emitPhaseRunAskq, diğer 6
 * action için fake DispatchOutcome mapping.
 */
async function executeConfirmedAgentDecision(
  decision: AgentDecision,
  text: string,
): Promise<void> {
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  if (decision.action === "run_phase" && decision.target_phase !== undefined) {
    await emitPhaseRunAskq(decision.target_phase, true);
    return;
  }
  if (
    decision.action === "approve_ui" ||
    decision.action === "revise_ui" ||
    decision.action === "cancel_pipeline" ||
    decision.action === "resume_pipeline" ||
    decision.action === "debug_triage" ||
    decision.action === "develop_new_or_iter"
  ) {
    const fakeOutcome: DispatchOutcome = {
      handled: false,
      action: decision.action,
      intent: {
        kind: decision.action === "develop_new_or_iter" ? "develop" : (decision.action as IntentKind),
        reasoning: `(orchestrator-agent) ${decision.reason}`,
      },
    };
    await executeDispatchedIntent(text, fakeOutcome);
    return;
  }
  log.warn("orchestrator", "executeConfirmedAgentDecision: unexpected action", {
    action: decision.action,
  });
}

/**
 * Onaylanmış intent'i dispatch eder ve eski handleUserMessage'ın post-dispatch
 * akışını çalıştırır (resume / debug / develop). Confirm askq Evet branch'inden
 * çağrılır.
 */
async function executeDispatchedIntent(
  text: string,
  outcome: DispatchOutcome,
  // Orkestratör derin-çözüm akışı zaten somut çözüm bulduysa debug_triage'a taşı →
  // Faz 0 sıfırdan araştırmaz, doğrular (handoff'ta çözüm kaybını önler).
  // user_selected (YZLLM 2026-07-03 "aynı şeyi 2 kere sordu"): kullanıcının error-analysis'te SEÇTİĞİ çözüm →
  // Faz 0 D2 tekrar SORMAZ, D1 bu yönü onurladıysa doğrudan uygular (çift-soru kesilir).
  // ANA KURAL: priorAnalysis YALNIZ İNGİLİZCE taşır (main'e gider — Faz 0 D1 promptuna gömülür).
  priorAnalysis?: { solutions: string[]; user_selected?: string },
): Promise<void> {
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  if (outcome.handled) {
    return; // router yan-eylemi yaptı (command/chat/placeholder)
  }

  // outcome.handled === false → caller (bu fonksiyon) Phase 1/resume/debug çalıştırır
  if (outcome.action === "resume_pipeline") {
    log.info("orchestrator", "user_message → resume pipeline (explicit)", {
      from: runtime.state.current_phase,
    });
    emitChatMessage(
      "system",
      `Akış Faz ${runtime.state.current_phase}'ten devam ediyor.`,
    );
    await advanceToNextPhase(
      (runtime.state.current_phase - 1) as PhaseId,
    );
    return;
  }

  // Phase 6 deferred mod dispatch'leri ---
  if (outcome.action === "approve_ui") {
    log.info("orchestrator", "phase 6 approve_ui", {
      current_phase: runtime.state.current_phase,
    });
    await appendAuditModule(runtime.state.project_root, {
      ts: Date.now(),
      phase: 6,
      event: "phase-6-complete",
      caller: "user",
      detail: text.slice(0, 200),
    });
    // UI incelemesi bitti → park bayrağını temizle (isPipelineParked artık false;
    // pipeline-end'de kuyruk işi normal "done" damgalanır).
    runtime.state = { ...runtime.state, pending_ui_review: undefined, updated_at: Date.now() };
    await saveState(runtime.state);
    emitChatMessage("system", "✅ Faz 6 onaylandı — Faz 7'e geçiliyor.");
    await advanceToNextPhase(6);
    return;
  }
  if (outcome.action === "revise_ui") {
    log.info("orchestrator", "phase 6 revise_ui", {
      current_phase: runtime.state.current_phase,
      text_len: text.length,
    });
    await appendAuditModule(runtime.state.project_root, {
      ts: Date.now(),
      phase: 6,
      event: "ui-tweak-request",
      caller: "user",
      detail: text.slice(0, 200),
    });
    // Faz 5 history'sini temizle — tweak mode fresh start. Eski tool_use
    // sonrası tool_result eksik kayıtları Anthropic API tarafından reddediliyor
    // ("messages.X: tool_use ids were found without tool_result blocks"). Phase
    // 0 D1'de uygulanan aynı düzeltme (2026-05-22 kullanıcı raporu).
    try {
      await clearHistory(runtime.state.project_root, 5);
    } catch (err) {
      log.warn("orchestrator", "phase-6 clearHistory failed (non-fatal)", err);
    }
    // state.pending_ui_tweak set + current_phase=4 → outer loop PHASE_TRANSITIONS[4]=6
    // → Phase 5 tweak mini-loop tetiklenir; bitince Phase 6 deferred tekrar.
    runtime.state = {
      ...runtime.state,
      pending_ui_tweak: text,
      pending_ui_review: undefined, // Faz 6 inceleme parkı bitti (tweak'e dönülüyor; Faz 6 tekrar deferred dönünce yeniden set edilir)
      current_phase: 4,
      updated_at: Date.now(),
    };
    await saveState(runtime.state);
    emitChatMessage(
      "system",
      `🔄 UI revize talebi: _"${text.slice(0, 100)}"_ — Faz 5 tweak mode'a dönülüyor...`,
    );
    await advanceToNextPhase(4);
    return;
  }
  if (outcome.action === "cancel_pipeline") {
    log.info("orchestrator", "pipeline cancelled");
    cancelLlmOutageWait(); // kullanıcı işi iptal etti → bekle-ve-devam zamanlayıcısı da iptal
    _lastDevelopText = null; // iptal edilen işin metni sonraki bir STOP'ta kuyruğa geri sızamaz
    _pendingStopReason = null;
    // v15.7 (2026-05-27): R4-01 — pending_* alanları temizle ki D2_WAITING /
    // pending_ui_tweak / pending_backend_fix orphan kalmasın. Aksi halde
    // sonraki user_message handleCommandDirect "askq cevabı bekliyor"
    // engeline takılır + kullanıcı askıda kalır.
    if (runtime.state) {
      const active = getActiveAskq();
      if (active) {
        clearActiveAskq(active.id);
        emitAskqResolved(active.id);
      }
      runtime.state = {
        ...runtime.state,
        pending_diagnostic: undefined,
        pending_ui_tweak: undefined,
        pending_ui_review: undefined,
        pending_backend_fix: undefined,
        pending_realapp_verify: undefined,
        updated_at: Date.now(),
      };
      await saveState(runtime.state);
      // İş kuyruğu: kullanıcı açıkça iptal etti → drain oturumunu KAPAT (sıradakine
      // geçme) + çalışan işi "dropped" işaretle (currentTaskId serbest; auto-retry yok).
      _drainActive = false;
      if (runtime.currentTaskId) {
        await patchTask(runtime.state.project_root, runtime.currentTaskId, {
          status: "dropped",
        });
        runtime.currentTaskId = null;
        await emitQueueChangedFor(runtime.state.project_root);
      }
      // ⚡ MAHKEME CRITICAL (2026-07-16): aktif paralel KÜME de iptali görmeli — yoksa küme işleri
      // orphan-yolunda sessizce "pending"e dönüp kullanıcı onaysız OTOMATİK yeniden başlıyordu
      // (iptal niyeti boşa düşer), park başka pending'e bağlıysa kuyruk KALICI kilitleniyordu.
      // Tek-iş simetrisi: işler "dropped" (otomatik seçilmez; UI'dan yeniden eklenebilir) + slot boş.
      if (runtime.currentBatch) {
        for (const tid of runtime.currentBatch.taskIds) {
          await patchTask(runtime.state.project_root, tid, { status: "dropped" });
        }
        runtime.currentBatch = null;
        await emitQueueChangedFor(runtime.state.project_root);
      }
    }
    emitChatMessage(
      "system",
      "⏹ Akış durduruldu. Yeni mesaj yazarsan devam edersin.",
    );
    return;
  }

  if (outcome.action === "debug_triage") {
    // Phase 0 Debug Triage — pipeline reset YOK, iteration_count artmaz,
    // current_phase değişmez. Standalone codegen-style faz; Claude araştırır,
    // fix uygular veya diagnostic rapor sunar.
    log.info("orchestrator", "user_message → debug triage", {
      current_phase: runtime.state.current_phase,
    });
    const spec = PHASE_SPECS[0];
    if (!spec) {
      emitError("Faz 0 kaydı bulunamadı", null);
      return;
    }
    if (!runtime.state || !runtime.config) {
      emitError("Faz 0 başlayamıyor: çalışma ortamı hazır değil", null);
      return;
    }
    const phase0 = new Phase0Controller({
      state: runtime.state,
      config: runtime.config,
      spec,
      bugReport: text,
      priorAnalysis,
    });
    // Token çizelgesi (YZLLM 2026-06-17): Faz 0 (Debug) loop DIŞINDA → cost-bucket'ı burada set et.
    beginPhaseCost(0, runtime.state.iteration_count ?? 1);
    runtime.controller = phase0 as unknown as AnyPhaseController;
    let result: "complete" | "fail" = "fail";
    try {
      result = await phase0.run(text);
    } finally {
      runtime.controller = null;
    }
    // statePatch (pending_diagnostic) varsa state'e merge + persist.
    if (runtime.state && Object.keys(phase0.statePatch).length > 0) {
      runtime.state = { ...runtime.state, ...phase0.statePatch, updated_at: Date.now() };
      await saveState(runtime.state);
    }
    log.info("orchestrator", "debug triage end", { result });
    // 2026-06-09 (YZLLM: "hata çözümünü sorma, kendin çöz"): D1'in önerdiği seçenek
    // sorulmadan otomatik uygulanır — askq cevabıyla aynı routing (handleAskqAnswer).
    const diag = runtime.state?.pending_diagnostic;
    if (result === "complete" && diag?.phase === "D2_WAITING" && diag.auto_selected_label) {
      await handleAskqAnswer(diag.askq_id, diag.auto_selected_label);
    } else if (result === "fail") {
      // FROZEN-GOAL #5: Faz 0 (debug) iş-kuyruğu DIŞINDA → reconcileAndDrainTasks orphan-drop tetiklenmez +
      // bazı fail yolları (abort/SDK-fail) hiç mesaj emit etmiyordu → kullanıcı SESSİZCE terk ediliyordu.
      // Pass-or-escalate: her fail'de görünür + eyleme dönük kapanış mesajı.
      emitChatMessage(
        "system",
        "⏹ Hata ayıklama tamamlanamadı. Sorunu farklı/daha açık bir cümleyle tekrar yazarsan yeniden denerim; ya da `Çalıştır` ile pipeline'a devam edebilirsin.",
      );
    }
    return;
  }

  // outcome.action === "develop_new_or_iter" → İŞ KUYRUĞU sürücüsü (YZLLM 2026-06-14
  // "her iş Faz 1'den başlar + çok-problem önceliklendirilmiş kuyruk"): ham talebi
  // böl+önceliklendir+kuyruğa ekle, sonra öncelik sırasıyla TEK TEK Faz 1'den işle.
  await driveWorkQueue(text);
}

/**
 * Tek bir develop iterasyonunu (Faz 1 → pipeline sonu) çalıştırır. İş-kuyruğu
 * sürücüsü (`startNextPendingTask`) her bekleyen iş için bunu çağırır. Pipeline
 * GERÇEKTEN biterse (Faz 17 / next===null) pipeline-end `onTaskMaybeComplete`'i
 * tetikler (done+tarih damgası + sıradaki iş); askq'da PARKEDERSE `currentTaskId`
 * set kalır → sürücü sıradaki işe geçmez; kullanıcı cevabıyla resume → pipeline-end
 * → sonraki iş otomatik başlar. Böylece interaktif park'larda kuyruk bozulmaz.
 */
// Kuyruk-dışı geliştirme akışının son iş metni — bir terminal-dur noktasında işi kuyruğa alıp
// (ensureAutonomousContinuation) devam ettirebilmek için (YZLLM 2026-07-18 canlılık garantisi).
let _lastDevelopText: string | null = null;

async function runDevelopIteration(
  text: string,
  opts?: {
    seedIntent?: string;
    startPhase?: PhaseId;
    /** KESİNTİDEN DÖNÜŞ (2026-07-30): iterasyon zaten sürüyordu, yalnız sağlayıcı beklendi → yeni iterasyon
     *  SAYILMAZ, durum sıfırlanmaz, kaldığı fazdan devam edilir. Bu bayrak olmadan wasPipelineCompleted
     *  (proje ömründe ilk Faz 17'den sonra HEP true) niyeti/spec'i her seferinde siliyordu. */
    resumePaused?: boolean;
  },
): Promise<void> {
  _lastDevelopText = text;
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  // İzolasyon (YZLLM 2026-06-15, canlı test #2): bu, iş-listesindeki TEK işi işleyen
  // iterasyon → tüm fazlar (1..9) konuşma geçmişini KATMASIN, yoksa orijinal çok-bug'lı
  // mesaj sızıp işleri birleştirir. Bayrak state üzerinden advanceToNextPhase'e taşınır.
  runtime.state = { ...runtime.state, iteration_isolated: true };
  if (opts?.resumePaused && opts.startPhase && opts.startPhase > 1) {
    // Duraklamış iterasyonu SÜRDÜR: state (niyet/spec/kapsam) olduğu gibi kalır, yalnız kesilen fazdan
    // devam edilir. Yeni iterasyon sayacı artmaz, audit'e iteration-start yazılmaz (bu AYNI iterasyon).
    setRecordContext({ iteration: runtime.state.iteration_count ?? 1, phase: opts.startPhase });
    await appendAuditModule(runtime.state.project_root, {
      ts: Date.now(),
      phase: opts.startPhase,
      event: "iteration-resumed",
      caller: "mycl-orchestrator",
      detail: `kesinti sonrası kaldığı fazdan devam (Faz ${opts.startPhase})`,
    }).catch(() => {});
    await advanceToNextPhase((opts.startPhase - 1) as PhaseId);
    return;
  }
  // wasPipelineCompleted ise yeni iterasyon (state reset), değilse fresh Phase 1.
  if (await wasPipelineCompleted(runtime.state.project_root)) {
    const prevIter = runtime.state.iteration_count ?? 1;
    const newIter = prevIter + 1;
    log.info("orchestrator", "new iteration starting", {
      prev: prevIter,
      new: newIter,
    });
    await appendAuditModule(runtime.state.project_root, {
      ts: Date.now(),
      phase: 1,
      event: `iteration-${newIter}-start`,
      caller: "user",
      detail: `previous pipeline complete; new intent: ${text.slice(0, 100)}`,
    });
    // Yeni iterasyon önceki dev server'ı bırakmamalı — pid'i undefined yapmak
    // process'i ÖLDÜRMEZ (orphan + port çakışması). Temiz kapat (kill+detach).
    stopActiveDevServer(runtime.state);
    // State reset — pipeline alanları sıfırlanır; kalıcı kimlik korunur.
    // v15.7 (2026-05-27): pending_backend_fix + pending_migrations +
    // pending_diagnostic da reset listesine alındı (R2-01 QC bulgusu) — yeni
    // alanlar eklenince listenin tutarlı genişlemesi gerekiyor.
    gateFailStreak.clear(); // MAHKEME fix: yeni iterasyon → önceki iterasyonun parklı faz-döngü sayaçları taşınmasın.
    runtime.state = {
      ...runtime.state,
      current_phase: 1,
      spec_approved: false,
      spec_hash: undefined,
      tdd_compliance_score: undefined,
      dev_server_pid: undefined,
      intent_summary: undefined,
      intent_summary_raw: undefined,
      // UI tweak state'i yeni iterasyon'a sızmamalı — Phase 6 onayı sonrası
      // zaten sıfırlanıyor ama force-complete veya yarım kalan pipeline'da
      // kalmış olabilir; defensive.
      pending_ui_tweak: undefined,
      pending_ui_review: undefined,
      ui_tweak_count: undefined,
      pending_backend_fix: undefined,
      pending_migrations: undefined,
      pending_diagnostic: undefined,
      // Gerçek-app doğrulama marker'ı iterasyon-spesifik — bayat marker yeni iterasyona sızmasın.
      pending_realapp_verify: undefined,
      // v15.6: needed_phases scope iterasyon-spesifiktir — yeni iterasyonda
      // Faz 3 LLM tekrar önerir, kullanıcı tekrar onaylar.
      needed_phases: undefined,
      needed_phases_proposed: undefined,
      iteration_count: newIter,
      // Escalation (YZLLM 2026-06-11): "yeni iterasyon baştan başlamasın; önceki tecrübeler önemli; yükseltme var
      // düşürme yok." → escalation_rung'ı SIFIRLAMA — önceki iterasyonun tırmandığı seviye TAŞINIR (monotonik:
      // yalnız yükselir). İlk-ever iterasyonda unset → escalatedModelEffort/failPhase `?? firstRung()` ile cheap·low.
      // (escalation_rung BİLEREK burada set EDİLMİYOR — mevcut değer korunur.)
      // Boot-resume scope sınırı — bu iterasyonun başlangıcı (audit tail'e bağlı
      // kalmadan detectInterruptedPhase2To9 doğru scope hesaplasın).
      iteration_started_at: Date.now(),
      updated_at: Date.now(),
    };
    await saveState(runtime.state);
    syncNeededPhases(); // yeni iterasyon → kapsam sıfırlandı (Faz 3 tekrar önerecek), vurgulama kalksın
    // v15.6: yeni iterasyon — NDJSON metadata bağlamı update.
    setRecordContext({ iteration: newIter, phase: 1 });
    emitChatMessage(
      "system",
      `🔄 Yeni iterasyon başlıyor (#${newIter}). Eski spec.md/kod referans olarak korunuyor; Claude Faz 1'de Read ile bakabilir.`,
    );
    emitPhaseChanged(runtime.state.current_phase, 1, "running");
  }

  // Güvenlik/pentest SİSTEM-İŞİ (YZLLM 2026-06-19): niyet bulgudan türetildiği için Faz 1 (niyet) + Faz 2
  // (hassasiyet) ATLA, seed'lenmiş intent_summary ile doğrudan startPhase'ten (genelde Faz 3) başla.
  if (opts?.seedIntent && opts.startPhase && opts.startPhase > 1) {
    // MAHKEME CRITICAL (2026-07-18, ANA KURAL): bu dal Faz 1'i (ve oradaki tr-to-en çeviri kapısını)
    // ATLAR; intent_summary buradan Faz 3+ MAIN promptlarına gömülür. Türkçe kaynaklı seedIntent
    // (güvenlik işi metni + kuyruk [YENİDEN ELE ALMA] bloğu) main'e gitmeden İngilizceye çevrilir
    // (toEnglishForMain fail-soft: çeviri patlarsa orijinal + görünür not). intent_summary_raw
    // kullanıcı-görünür ham metin olarak TR kalır.
    const seedEn = await toEnglishForMain(opts.seedIntent);
    const iterTs = runtime.state.iteration_started_at ?? Date.now();
    runtime.state = {
      ...runtime.state,
      intent_summary: seedEn,
      intent_summary_raw: opts.seedIntent,
      current_phase: opts.startPhase,
      iteration_started_at: iterTs,
      updated_at: Date.now(),
    };
    await saveState(runtime.state);
    await ensurePendingIterationDir(runtime.state.project_root, iterTs).catch((e) =>
      log.warn("devs", "_pending iterasyon dizini açılamadı (non-fatal)", e),
    );
    setRecordContext({ iteration: runtime.state.iteration_count ?? 1, phase: opts.startPhase });
    emitChatMessage(
      "system",
      `🛡️ Güvenlik sistem işi Faz ${opts.startPhase}'ten ele alınıyor (niyet bulgudan türetildi; Faz 1/2 atlandı).`,
    );
    await advanceToNextPhase((opts.startPhase - 1) as PhaseId);
    return;
  }

  // Phase 1 — yeni intent başlatma. current_phase 1 ya da intent_summary yok.
  const spec = getSpec(1);
  if (!spec) {
    log.error("orchestrator", "phase 1 spec missing");
    emitError("Faz 1 spec eksik", null);
    return;
  }
  log.info("orchestrator", "phase 1 start");
  // QC A-1 (borç): non-null assert yerine explicit guard. Pre-condition
  // handleUserMessage entry'sinde sağlanır ama defansif kontrol kod okunaklığı.
  if (!runtime.state || !runtime.config) {
    emitError("Faz 1 başlayamıyor: çalışma ortamı hazır değil", null);
    return;
  }

  // Faz 0 (devs/ yapısı, YZLLM 2026-06-16): iterasyon-başı temel — TEK-KAYNAK <ts> + _pending iskeleti.
  // iteration_started_at yeni-iter dalında (yukarıda) set edilir; ilk-ever iterasyonda set EDİLMEZ →
  // burada garantile (idempotent: zaten varsa KORUNUR, yeniden damgalanmaz). Sonra devs/_pending/<ts>/
  // iskeleti açılır (birim çözümü + split sonraki fazlarda). Fail-soft: klasör açılamazsa pipeline KIRILMAZ.
  let iterTs = runtime.state.iteration_started_at;
  if (!iterTs) {
    iterTs = Date.now();
    runtime.state.iteration_started_at = iterTs;
    await saveState(runtime.state);
  }
  await ensurePendingIterationDir(runtime.state.project_root, iterTs).catch((e) =>
    log.warn("devs", "_pending iterasyon dizini açılamadı (non-fatal)", e),
  );

  const p1 = new Phase1Controller({
    state: runtime.state,
    config: runtime.config,
    spec,
    // İzolasyon (YZLLM 2026-06-15): bu Faz 1 iş-listesindeki TEK işi işliyor →
    // konuşma geçmişini katma, öteki işi çekip birleştirme.
    isolatedIntent: true,
  });
  // Token çizelgesi (YZLLM 2026-06-17): Faz 1 loop DIŞINDA → cost-bucket'ı burada set et (flush sonraki geçişte).
  beginPhaseCost(1, runtime.state.iteration_count ?? 1);
  runtime.lastPhase1Intent = text; // iter=1 Faz 1'i pürüzsüz tekrar koşmak için (canlı niyet)
  const result = await runController(p1, () => p1.run(text), "Niyet toplanıyor");
  log.info("orchestrator", "phase 1 end", { result });
  if (result === "complete") {
    await recordRungOutcome(1, true);
    emitChatMessage("system", "Faz 1 tamamlandı — niyet onaylandı.");
    // Intent summary'yi state'e kaydet — Phase 4 input olarak okuyacak.
    // _raw alanı Phase 1 ham özetini saklar; Faz 2 enriched üretip
    // intent_summary'ı overwrite etse bile raw değişmez (recovery için).
    const summary = p1.approvedSummary ?? runtime.state.intent_summary;
    runtime.state = {
      ...runtime.state,
      intent_summary: summary,
      intent_summary_raw: p1.approvedSummary ?? runtime.state.intent_summary_raw,
    };
    // YZLLM 2026-06-16 ("iş metni hep kısa orijinal"): Faz 1 sonrası iterationIntent'i türetilmiş (uzun)
    // intent_summary ile EZMİYORUZ — kuyruk başında set edilen kullanıcı-orijinal kısa metin (next.text) kalır.
    // Sonraki faz: P1 → P2 (ardışık akış).
    await advanceToNextPhase(1);
  } else {
    await failPhase(1, p1);
  }
}

// ===== İş kuyruğu sürücüsü (YZLLM 2026-06-14) ==========================
// "her iş Faz 1'den başlar"; çok-problem mesajı bölünüp önceliklendirilir +
// kuyruğa eklenir; işler öncelik sırasıyla TEK TEK Faz 1'den koşar; biten iş
// tarih damgalanır + KİLİTLENİR (tekrar uygulanamaz). Faz 4 sonrasına geçen her
// iş (tek bile) kuyruğa girer.
//
// SAĞLAMLIK (düşman-inceleme 2026-06-14): görev yaşam-döngüsü TEK bir tamamlanma
// yoluna (pipeline-end) bağlı DEĞİL. Pipeline her türlü çıkışta (fail/abandon/
// vazgeç/abort) sonunda `advanceToNextPhase` finally'sinde derinlik 0'a iner →
// orada `reconcileAndDrainTasks` çalışır:
//   1) currentTaskId set ama pipeline PARKLI DEĞİL (aktif askq yok) → iş gerçekten
//      bitmeden durdu (terminal fail/abort) → "dropped" damgala, kilidi serbest
//      bırak (sonsuza "running" + kuyruk-kilidi YOK). Parklıysa (askq bekliyor)
//      DOKUNMA — kullanıcı cevabıyla resume olur.
//   2) Aktif drain oturumu varsa sıradaki bekleyen AUTO işi seri işle
//      (_handlingUserMessage yeniden alınır → kullanıcı mesajıyla yarış yok).
// Manuel "İş Ekle" işleri (source=manual) auto-drain'e GİRMEZ — eski "Uygula"
// davranışı korunur. Boot'ta orphan "running" işler "pending"e geri alınır.

/** Aktif drain oturumu (kullanıcı iş gönderdi → kuyruk boşalana dek). Boot/sohbet'te false. */
let _drainActive = false;
/** Bu drain oturumunun işlediği iş id'si. Senaryo (mahkeme-doğrulandı): işin runDevelopIteration'ı DÖNER,
 *  reconcile onu 'dropped' yapıp currentTaskId=null'lar (pipeline debug'a yönlendi, park değil); AMA pipeline
 *  sonra debug fazından ilerleyip YEŞİLE ulaşır (ayrı advanceToNextPhase koşusu — startNextPendingTask'tan
 *  GEÇMEZ, bu yüzden _drainTaskId İLK işin id'sini tutmaya devam eder). Green-end'de (onTaskMaybeComplete)
 *  currentTaskId null + _drainTaskId hâlâ 'dropped' → o iş 'done'a KURTARILIR (YZLLM 2026-07-02: "iş yeşil
 *  bitti ama 'Düştü' kaldı"). startNextPendingTask set eder (yeni iş → üzerine yaz), onTaskMaybeComplete temizler. */
let _drainTaskId: string | null = null;
/** reconcileAndDrainTasks re-entrancy kilidi (eşzamanlı drain imkânsız). */
let _draining = false;

/**
 * Pipeline kullanıcı cevabı bekliyor mu (interaktif park)? Parklıysa orphan-drop
 * YAPILMAZ (iş tamamlanmadı ama düşmedi de — kullanıcı bekleniyor).
 *
 * Yeniden-inceleme #1 (KRİTİK): Faz 6 (UI incelemesi) DEFERRED modda askq AÇMAZ —
 * sadece chat'e "UI'yi incele, tamam/iptal yaz" yazıp döner. Bu askq'sız parkı
 * `pending_ui_review` bayrağı işaretler (Faz 6 BAŞARIYLA deferred dönünce set edilir;
 * controller ÇÖKERSE set EDİLMEZ → orphan-drop devreye girer, Faz 7/8 ile simetrik).
 * Eski `current_phase===6` heuristiği Faz 6 throw'unu da "park" sanıp kuyruğu sonsuza
 * kilitliyordu (round-3 regresyonu) — bayrağa bağlamak bunu kökten çözer.
 */
function isPipelineParked(): boolean {
  return (
    getActiveAskq() !== null ||
    runtime.pendingErrorAnalysis !== null ||
    runtime.findingQueue !== null || // teker-teker bulgu kuyruğu aktif (fix-march ortası) → orphan-drop yok
    runtime.pendingPhaseScope !== null ||
    runtime.pendingMemoryProposal !== null ||
    runtime.pendingDast !== null ||
    runtime.pendingFullTest !== null ||
    runtime.pendingMaintenance !== null ||
    runtime.pendingPlan !== null ||
    runtime.pendingPlanEdit !== null ||
    Boolean(runtime.state?.pending_ui_tweak) ||
    Boolean(runtime.state?.pending_diagnostic) ||
    Boolean(runtime.state?.pending_ui_review) // Faz 6 deferred UI-incelemesi (askq'sız park)
  );
}

/** Kuyruğu frontend'e gönder (running/done/öncelik değişince UI tazelenir). */
async function emitQueueChangedFor(projectRoot: string): Promise<void> {
  try {
    const items = await readTasks(projectRoot);
    emit("task_queue_changed", { items });
  } catch (err) {
    log.warn("task-queue", "emit changed failed", err);
  }
}

/**
 * develop_new_or_iter girişi: ham talebi böl+önceliklendir+kuyruğa ekle (auto/
 * pending), drain oturumunu aç, sonra en yüksek öncelikli AUTO işi başlat (bu
 * çağrı handleUserMessage kilidi altında → ilk iş seri koşar). Kalan işler
 * pipeline bitince reconcileAndDrainTasks ile zincirlenir. Tek iş de kuyruğa
 * girer (Rule 3: Faz 4 sonrasına geçen her iş, tek bile).
 */
async function driveWorkQueue(rawText: string): Promise<void> {
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  const root = runtime.state.project_root;
  // Increment 3: çok-problem anlama + öneme göre sıralama → kuyruğa (auto/pending).
  const enqueued = await intakeAndEnqueue(runtime.config, root, rawText);
  await emitQueueChangedFor(root);
  if (enqueued.length === 0) return; // boş/yalnız-boşluk talep → iş yok
  _drainActive = true; // drain oturumu açık (yeni işler eklendi)
  // Yeniden-inceleme #4/#8: zaten çalışan/parkta bir kuyruk işi varsa (currentTaskId
  // set — örn. Faz 6'da inceleme bekleyen iş) YENİ işi BAŞLATMA, yalnız kuyruğa ekle.
  // currentTaskId'yi ezmek parkta bekleyen işi sessizce orphan ederdi. O iş bitince
  // reconcileAndDrainTasks bu yeni işleri öncelik sırasıyla çeker.
  if (runtime.currentTaskId) {
    emitChatMessage(
      "system",
      `📥 ${enqueued.length} iş kuyruğa eklendi (öncelikle) — çalışan iş bitince sırayla, her biri Faz 1'den işlenecek.`,
    );
    return;
  }
  if (enqueued.length > 1) {
    emitChatMessage(
      "system",
      `📥 ${enqueued.length} ayrı iş tespit edildi + öneme göre sıralandı — en yüksek öncelikten başlayıp sırayla, her biri Faz 1'den işlenecek.`,
    );
  }
  // İlk işi ŞİMDİ başlat (handleUserMessage kilidi altında → seri). Kalan zincir
  // pipeline-end → advanceToNextPhase finally → reconcileAndDrainTasks ile sürer.
  await startNextPendingTask();
}

/**
 * İş-listesindeki en yüksek öncelikli bekleyen işi "running" işaretleyip Faz
 * 1'den başlatır. Tamamlanma damgası (done) pipeline-end'de (`onTaskMaybeComplete`)
 * vurulur. Çağıran MUTLAKA _handlingUserMessage kilidini tutmalı (seri garanti).
 * Çalıştırdıysa true, bekleyen iş yoksa/canlı iş varsa false döner.
 *
 * YZLLM 2026-06-15 ("iş listesindekileri sıra sıra pipeline'dan geçirsin sistem;
 * böyle kullanılsın MyCL"): manuel/auto AYRIMI YOK — kaynağı ne olursa olsun
 * (İş Ekle ya da çok-problem intake) bekleyen HER iş sırayla işlenir.
 */
// ⚡ Paralel küme tek-atış emniyeti (2026-07-16): başarısız kümedeki işler bir daha KÜMEYE girmez
// (sıralı işlenir) → sonsuz yeniden-kümeleme döngüsü imkânsız. Proje değişince temizlenir.
const _batchFailedIds = new Set<string>();
// Görünür-atlama throttle'ı: aynı neden art arda spam olmasın (drain her iş sonunda yeniden dener).
let _lastBatchSkipNotice = "";
function batchSkipNotice(reason: string): void {
  log.info("orchestrator", "paralel küme atlandı → sıralı akış", { reason });
  if (reason === _lastBatchSkipNotice) return;
  _lastBatchSkipNotice = reason;
  emitChatMessage("system", `⚡ Paralel kümeleme bu tur uygulanmadı: ${reason}.`);
}

/**
 * ⚡ Kuyruktan paralel iş kümesi başlatmayı DENE (2026-07-16, "orta yol" — KULLANICI KARARI).
 * FAIL-CLOSED her kenarda: bayrak kapalı / <2 uygun iş / git yok / kirli ağaç / hakem bölemedi /
 * worker-birleştirme hatası → false (caller SIRALI devam eder; hiçbir iş kaybolmaz).
 * Başarıda: işler running, kod paralel worktree'lerde yazılıp birleştirilir, kalite fazları
 * (9→17, Faz 6 dahil) birleşik sonuçta TEK SEFER eksiksiz koşar (multi_agent_selection emsali).
 * Çağıran _handlingUserMessage kilidini tutmalı (startNextPendingTask sözleşmesi).
 */
async function tryStartTaskBatch(): Promise<boolean> {
  if (!runtime.state || !runtime.config) return false;
  if (runtime.config.features.parallel_task_batching !== true) return false;
  if (runtime.currentTaskId || runtime.currentBatch) return false;
  const root = runtime.state.project_root;
  const pending = (await readTasks(root).catch(() => [] as TaskQueueItem[]))
    // MAHKEME CRITICAL (2026-07-18): attempts tavanı SIRALI seçimle aynı — tavanlı iş kümeye de girmez
    // (aksi halde 'otomatik seçilmez' garantisi paralel yoldan deliniyordu, attempts sınırsız artıyordu).
    .filter((t) => taskStatus(t) === "pending" && !_batchFailedIds.has(t.id) && (t.attempts ?? 0) < MAX_TASK_AUTO_RETRIES)
    .sort(
      (a, b) =>
        (a.priority ?? Number.POSITIVE_INFINITY) - (b.priority ?? Number.POSITIVE_INFINITY) || a.ts - b.ts,
    )
    .slice(0, MAX_BATCH);
  if (pending.length < 2) return false;
  // Ön koşul: git + TEMİZ ağaç — worktree yalnız COMMIT'li kodu görür (risk-fix-parallel dersi).
  const gitOk =
    (await isGitRepo(root).catch(() => false)) && (await isWorkingTreeClean(root).catch(() => false));
  if (!gitOk) {
    // MAHKEME MEDIUM (görünürlük): bayrak AÇIKKEN kullanıcı neden paralel olmadığını görsün —
    // aynı neden tekrarlanırsa spam olmasın (throttle).
    batchSkipNotice("git deposu değil ya da kaydedilmemiş değişiklik var — işler sıralı işleniyor");
    return false;
  }
  // LLM hakem önerir, DETERMİNİSTİK kapı (shouldParallelize) karar verir — fail-closed.
  const candidates = await judgeBatch(runtime.config, pending, root).catch((e: unknown) => {
    log.warn("orchestrator", "küme hakemi hatası → sıralı akış", e);
    return null;
  });
  if (!candidates) {
    batchSkipNotice("bekleyen işler bağımsız/ayrık bulunamadı — işler sıralı işleniyor (güvenli taraf)");
    return false;
  }
  const now = Date.now();
  for (const c of candidates) {
    await patchTask(root, c.task.id, { status: "running", started_at: now });
  }
  await emitQueueChangedFor(root);
  emitChatMessage(
    "system",
    `⚡ ${candidates.length} bağımsız iş PARALEL çalışıyor (izole worktree'lerde): ` +
      candidates.map((c) => `_"${c.task.text.slice(0, 60)}"_`).join(", "),
  );
  await appendAuditModule(root, {
    ts: now,
    phase: runtime.state.current_phase,
    event: "task-batch-start",
    caller: "mycl-orchestrator",
    detail: `n=${candidates.length} ids=${candidates.map((c) => c.task.id.slice(0, 8)).join(",")}`,
  }).catch(() => {});
  _escalateAcceptChain = 0; // per-iş escalate bütçesi (startNextPendingTask sözleşmesiyle aynı)
  _inspectorUnavailableChain = 0;
  const outcome = await runParallelModules(
    root,
    candidatesToModules(candidates),
    { enabled: true },
    makeScopedCodegenWorker(runtime.config, runtime.state),
  );
  if (!outcome.parallel || !outcome.ok) {
    // Geri al: işler pending'e döner + tek-atış fail-set → SIRALI devam (hiçbir iş kaybolmaz).
    for (const c of candidates) {
      _batchFailedIds.add(c.task.id);
      await patchTask(root, c.task.id, { status: "pending" });
    }
    await emitQueueChangedFor(root);
    emitChatMessage(
      "system",
      `⚠️ Paralel deneme başarısız (${outcome.reason}) — işler kuyruğa geri kondu, SIRALI işlenecek (kayıp yok).`,
    );
    await appendAuditModule(root, {
      ts: Date.now(),
      phase: runtime.state.current_phase,
      event: "task-batch-fallback",
      caller: "mycl-orchestrator",
      detail: outcome.reason.slice(0, 180),
    }).catch(() => {});
    return false;
  }
  runtime.currentBatch = {
    taskIds: candidates.map((c) => c.task.id),
    filesByTask: outcome.integratedByModule ?? {},
  };
  // MAHKEME dürüstlük düzeltmesi (2026-07-16): birleşik koşu Faz 9'DAN başlar (advanceToNextPhase(8)
  // → 9 dahil: düşman gözlü risk incelemesi birleşik sonucu görür) + 10-17. Faz 6 (kullanıcı UI
  // incelemesi) bu birleşik koşuda YOKTUR — bunu GÖRÜNÜR söyle (sessiz atlama yok, KATI #4).
  emitChatMessage(
    "assistant",
    `⚡ Paralel küme birleştirildi (${outcome.reason}). Kalite fazları (9-17: risk incelemesi + mekanik kapılar + E2E) birleşik sonuç üstünde koşuyor. ` +
      `Not: bu birleşik koşuda Faz 6 UI incelemesi otomatik açılmaz — görsel incelemek istersen sonunda "▶ Çalıştır" veya 🧪 Full Test kullan.`,
  );
  // Anlamsal bütünlük review'ı (multi_agent_selection emsali) — bloklamaz.
  try {
    const review = await reviewMergedModules(runtime.config, root, outcome.integratedFiles ?? []);
    emitChatMessage("assistant", formatReview(review));
  } catch (e) {
    log.warn("orchestrator", "küme anlamsal review hatası (non-blocking)", e);
  }
  // Faz 9'dan itibaren (PHASE_TRANSITIONS[8]=9): risk incelemesi DAHİL — emsalden (multi_agent_selection
  // advanceToNextPhase(9) = yalnız 10-17) bilinçli GÜÇLENDİRME (mahkeme bulgusu: 9 atlanıyordu).
  await advanceToNextPhase(8);
  return true;
}

/**
 * YZLLM 2026-07-18 ("kuyrukta 'düştü' işaretleme seçeneğini kaldır. sorunları çözmeye çalışsın.
 * çözemiyorsa bakış açısını değiştirsin. kuralları çiğnemeden çözsün."): MyCL kendi başarısızlığında
 * işi ASLA düşürmez — pending'e döndürür (attempts+1 + neden), yeniden denemede ajana FARKLI yaklaşım
 * talimatı verilir. Tavan (MAX_TASK_AUTO_RETRIES) dolunca otomatik seçim durur ama iş kuyrukta GÖRÜNÜR
 * bekler (kaybolmaz; sonsuz döngü/token yakımı da yok). 'dropped' YALNIZ kullanıcı iptalinde kalır.
 */
async function returnTaskToPending(projectRoot: string, taskId: string, failNote: string): Promise<number> {
  const current = (await readTasks(projectRoot).catch(() => [])).find((t) => t.id === taskId);
  // LLM KESİNTİSİ BEKLENİYORKEN deneme SAYILMAZ (YZLLM 2026-07-23 canlı log): iki kanal da kapalıyken
  // başarısız olan koşum İŞİN suçu değil — uzun pencerede (7 güne dek) saatlik yoklamalar 3 denemeyi eritip
  // reset açıldığında devam edecek iş bırakmazdı. Erişim dönünce gerçek başarısızlıklar yine normal sayılır.
  if (isLlmOutageWaiting()) {
    const kept = current?.attempts ?? 0;
    await patchTask(projectRoot, taskId, {
      status: "pending",
      last_fail: failNote.slice(0, 200),
    });
    emitChatMessage(
      "system",
      `↩️ İş kuyruğa GERİ kondu — LLM erişimi kapalı olduğundan bu koşum DENEME SAYILMADI (deneme ${kept}/${MAX_TASK_AUTO_RETRIES} korundu); erişim açılınca kaldığı yerden denenecek.`,
    );
    return kept;
  }
  const attempts = (current?.attempts ?? 0) + 1;
  await patchTask(projectRoot, taskId, {
    status: "pending",
    attempts,
    last_fail: failNote.slice(0, 200),
  });
  emitChatMessage(
    "system",
    attempts < MAX_TASK_AUTO_RETRIES
      ? `↩️ İş tamamlanamadı — kuyruğa GERİ kondu (deneme ${attempts}/${MAX_TASK_AUTO_RETRIES}); bir sonraki denemede FARKLI yaklaşım kullanılacak. Neden: ${failNote.slice(0, 120)}`
      : `⏸️ İş ${attempts} denemede tamamlanamadı — kuyrukta bekliyor (düşürülmedi, otomatik tekrar da edilmeyecek). Yeni bir talimat verirsen o bilgiyle yeniden ele alırım. Son neden: ${failNote.slice(0, 120)}`,
  );
  return attempts;
}

async function startNextPendingTask(): Promise<boolean> {
  if (!runtime.state) return false;
  if (runtime.currentTaskId) return false; // #4: canlı/parkta işi EZME
  if (runtime.currentBatch) return false; // ⚡ aktif paralel küme varken yeni iş başlatma (2026-07-16)
  const root = runtime.state.project_root;
  const next = nextPendingTask(await readTasks(root));
  if (!next) {
    _drainActive = false; // bekleyen iş kalmadı → oturum bitti
    return false;
  }
  // Mahkeme düzeltmesi (2026-07-30): resume bilgisi TÜKETİLİR — iş başladıktan sonra kalırsa, ileride
  // başka bir nedenle kuyruğa dönen aynı iş bayat fazdan sürmeye çalışırdı. 0 = "resume yok" (decide >1 ister).
  await patchTask(root, next.id, {
    status: "running",
    started_at: Date.now(), // süre görünürlüğü (YZLLM 2026-07-13)
    ...(next.resume_phase !== undefined ? { resume_phase: 0, resume_iter_ts: 0 } : {}),
  });
  _escalateAcceptChain = 0; // per-iş escalate bütçesi (mahkeme major: kuyruk-drain 3226/1688 reset'inden GEÇMİYOR →
  // sayaç görevler-arası birikip sağlıklı sağlayıcıda 4. işi yanlış-halt ederdi; "occasional tolere" sözleşmesi ihlali).
  _inspectorUnavailableChain = 0;
  runtime.currentTaskId = next.id;
  _drainTaskId = next.id; // yeşil-son 'done' kurtarması için (mid-flow drop'a rağmen); yeni iş → üzerine yaz
  await emitQueueChangedFor(root);
  // YZLLM 2026-06-15: üst bar + "İş" kutusu o anki işi göstersin (iş başında set et;
  // eskiden yalnız Faz 1 sonunda doluyordu → işlenirken boş kalıyordu). Metin zaten TR.
  emitIterationIntent(next.text);
  const attempts = next.attempts ?? 0;
  emitChatMessage(
    "system",
    `▶️ İş başlıyor (öncelik ${next.priority ?? "—"}${attempts > 0 ? `, deneme ${attempts + 1}/${MAX_TASK_AUTO_RETRIES}` : ""}): _"${next.text.slice(0, 90)}"_`,
  );
  // BAKIŞ AÇISI DEĞİŞİMİ (YZLLM 2026-07-18): önceki deneme(ler) tamamlanamadıysa ajana nedeni + "aynı
  // yaklaşımı tekrarlama" talimatı ver — kurallar aynen geçerli (sahte yeşil yok, atlama yok).
  const retryContext =
    attempts > 0 || next.last_fail
      ? `\n\n[YENİDEN ELE ALMA${attempts > 0 ? ` — DENEME ${attempts + 1}/${MAX_TASK_AUTO_RETRIES}` : ""}] Bu iş daha önce tamamlanamadı/bekletildi. Son not: ${next.last_fail ?? "kaydedilmedi"}. AYNI yaklaşımı tekrarlama — sorunu FARKLI bir bakış açısıyla ele al (farklı kök neden hipotezi, farklı yöntem); kuralları çiğnemeden, sahte yeşile kaçmadan çöz.`
      : "";
  const taskPrompt = `${next.text}${retryContext}`;
  const start = decideIterationStart({
    task: next,
    stateIterationStartedAt: runtime.state?.iteration_started_at,
    stateHasIntent: Boolean(runtime.state?.intent_summary),
  });
  if (
    resumeWasStale({
      task: next,
      stateIterationStartedAt: runtime.state?.iteration_started_at,
      stateHasIntent: Boolean(runtime.state?.intent_summary),
    })
  ) {
    // SESSİZ FALLBACK YOK: "kaldığı yerden" sözü tutulamadıysa kullanıcı bunu bilsin.
    emitChatMessage(
      "system",
      "ℹ️ Bu işi kaldığı yerden sürdüremedim (iterasyon durumu bu arada değişmiş) — baştan ele alıyorum.",
    );
  }
  if (start.kind === "resume") {
    // KESİNTİDEN DÖNÜŞ (2026-07-30): niyet/spec korunmuş → Faz 1'den değil kaldığı fazdan devam.
    emitChatMessage("system", `🔄 Kaldığım yerden devam ediyorum (Faz ${start.startPhase}).`);
    await runDevelopIteration(taskPrompt, {
      startPhase: start.startPhase as PhaseId,
      resumePaused: true,
    });
  } else if (start.kind === "seeded") {
    // Güvenlik/pentest sistem-işi → niyet bulgudan türetildi → from_phase'ten (Faz 3) başla, Faz 1/2 atla.
    await runDevelopIteration(taskPrompt, {
      seedIntent: taskPrompt,
      startPhase: start.startPhase as PhaseId,
    });
  } else {
    await runDevelopIteration(taskPrompt);
  }
  return true;
}

/**
 * pipeline-end'de (Faz 17 / next===null) çağrılır: çalışan kuyruk işini "done" +
 * completed_at ile damgala (KİLİT — tekrar uygulanamaz). Sıradaki işe geçiş
 * BURADA değil, advanceToNextPhase finally → reconcileAndDrainTasks'te (seri).
 * currentTaskId yoksa no-op (kuyruk-dışı iterasyon, örn. resume).
 */
/**
 * ⚡ Pipeline-end'de paralel kümenin işlerini damgala (2026-07-16): iş-başına DOSYA KANITI
 * (entegre edilen dosyalar) + proje-seviyesi deliverable birlikte → done; yoksa dropped
 * (sahte-tamamlanma kilidi — onTaskMaybeComplete'in :4400 aynası). currentBatch temizlenir.
 */
async function onBatchMaybeComplete(projectRoot: string): Promise<void> {
  const batch = runtime.currentBatch;
  if (!batch) return;
  runtime.currentBatch = null;
  const projectOk = await hasDeliverable(projectRoot);
  let dropped = 0;
  for (const tid of batch.taskIds) {
    const files = batch.filesByTask[tid] ?? [];
    if (projectOk && files.length > 0) {
      await patchTask(projectRoot, tid, { status: "done", completed_at: Date.now() });
    } else {
      // YZLLM 2026-07-18: düşürme yok → pending + fail-set (yeniden KÜMElenmez; sıralı, farklı yaklaşımla denenir).
      _batchFailedIds.add(tid);
      await returnTaskToPending(projectRoot, tid, "paralel kümede dosya kanıtı üretilmedi");
      dropped++;
    }
  }
  await emitQueueChangedFor(projectRoot);
  if (dropped > 0) {
    emitChatMessage(
      "system",
      `⚠️ Paralel kümedeki ${dropped} iş dosya kanıtı üretmedi — kuyruğa geri kondu, SIRALI ve farklı yaklaşımla yeniden denenecek (sahte tamamlanma kilidi).`,
    );
  }
}

async function onTaskMaybeComplete(projectRoot: string): Promise<void> {
  let doneId = runtime.currentTaskId;
  // YZLLM 2026-07-02 ("iş yeşil bitti ama 'Düştü' kaldı"): işin ilk koşusu dönüp reconcile onu 'dropped'
  // yapmış (debug'a yönlendi, currentTaskId=null) olabilir; ama pipeline sonra debug fazından ilerleyip Faz 17
  // YEŞİLİNE ulaştıysa iş GERÇEKTEN tamamlanmıştır → o drain-işini 'dropped'→'done' KURTAR. Guard: yalnız status'ü
  // HÂLÂ 'dropped' olan drain-işi kurtarılır (çözülmüş/alakasız işe dokunulmaz; _drainTaskId yeni iş başlayınca üzerine yazılır).
  if (!doneId && _drainTaskId) {
    const rescue = (await readTasks(projectRoot).catch(() => [])).find((t) => t.id === _drainTaskId);
    // 2026-07-18: mid-flow kesilen iş artık 'pending'e döner (dropped değil) → yeşil-son kurtarması ikisini de kapsar.
    if (rescue && (rescue.status === "dropped" || rescue.status === "pending")) doneId = _drainTaskId;
  }
  runtime.currentTaskId = null;
  _drainTaskId = null;
  _lastDevelopText = null; // iş kapandı → metni bayatlamadan bırak (çapraz-iş devam enjeksiyonu olmasın)
  if (!doneId) return; // kuyruk-dışı iterasyon (resume/doğrudan develop) → no-op
  // SAHTE-TAMAMLANMA KİLİT KORUMASI (YZLLM 2026-07-14, güvenilirlik denetimi): deliverable YOKSA görevi 'done'
  // (KİLİTLİ, "tekrar uygulanamaz") DAMGALAMA. emitVerificationSummary aynı hasDeliverable sinyaliyle "boş build →
  // YEŞİL DEĞİL" uyarısını basıyor; task-queue makine-durumu o uyarıyla TUTARLI olmalı — yoksa kuyruk "Tamamlandı"
  // gösterir, retry edilmez, sıradaki iş başlar (sahte-tamamlanma; kullanıcının en büyük korkusu). Boş-build → 'dropped'
  // (UI'da "Yeniden Ekle" görünür → kullanıcı sorunu çözüp yeniden gönderebilir). Bkz MEMORY project_faz5_skip_false_green.
  // GERÇEK İŞ KANITI (YZLLM kararı 2026-07-30, canlı cave: altı standart iş ~70 saniyede "tamamlandı"
  // damgalandı, o dakikalarda TEK bir dosya yazma olayı yok). Eski tek ölçüt "proje klasörü boş mu"ydu →
  // mevcut projede hep doğru → süreç Faz 17'ye ulaşınca iş kilitleniyordu. Artık BU İTERASYONDA gerçekten
  // iş yapıldığına dair pozitif kanıt aranır; yoksa iş kuyrukta kalır (kaybolmaz, deneme merdiveni sürer).
  const deliverableExists = await hasDeliverable(projectRoot);
  let auditReadable = true;
  let iterEvents: { event?: string; detail?: string; ts?: number }[] = [];
  const since = runtime.state?.iteration_started_at ?? 0;
  // Mahkeme düzeltmesi (2026-07-30): pencere TAM olmalı. Uzun iterasyonlarda (cave'de 476 olaylı iterasyon
  // var) kuyruğun sonundan sabit sayıda okumak erken yazma kanıtını pencereden düşürüp işi haksız yere
  // kuyruğa döndürebilirdi. Geniş oku + en eski kayıt iterasyon başlangıcından ÖNCE mi diye bak; değilse
  // pencere eksik demektir → kanıt yok sayma, "kayıt okunamadı" dalına düş (görünür not + done).
  let windowComplete = since > 0;
  try {
    const tail = await readAuditLogTail(projectRoot, 4000);
    iterEvents = tail.filter((e) => (e.ts ?? 0) >= since);
    if (tail.length > 0 && (tail[0]?.ts ?? 0) > since) windowComplete = false;
  } catch (e) {
    auditReadable = false;
    log.warn("orchestrator", "tamamlanma kanıtı için audit okunamadı", { error: String(e) });
  }
  const completion = decideTaskCompletion({
    events: iterEvents,
    auditReadable,
    iterationWindowKnown: windowComplete,
    deliverableExists,
    writeEvents: WRITE_EVENTS,
  });
  if (completion.verdict === "requeue") {
    await returnTaskToPending(projectRoot, doneId, completion.reason);
    await appendAuditModule(projectRoot, {
      ts: Date.now(),
      phase: (runtime.state?.current_phase ?? 17) as PhaseId,
      event: "task-completion-refused",
      caller: "mycl-orchestrator",
      detail: completion.reason,
    }).catch(() => {});
    await emitQueueChangedFor(projectRoot);
    emitChatMessage("system", completion.userMessage);
    return;
  }
  if (completion.note) emitChatMessage("system", completion.note);
  await patchTask(projectRoot, doneId, { status: "done", completed_at: Date.now() });
  await emitQueueChangedFor(projectRoot);
}

/**
 * Bu iterasyonda Faz 6 (UI incelemesi) İNSAN tarafından incelendi mi? İnsan-incelemesi = varsayılan modda Faz 6
 * PARKEDİP kullanıcı onayı (phase-6-complete, skip YOK). Foreign integrate (phase-6-skipped-integrate) VEYA never-ask
 * (oto-geçiş) → insan İNCELEMEDİ → tam-develop gerçek-app sentezi devreye girer. Audit okunamazsa "incelendi" say
 * (kuşkuda sentez KURMA — eski davranışı koru). SAF-değil (audit okur); karar realapp-gate-signal SAF'ında.
 */
async function isPhase6HumanReviewedThisIter(state: State): Promise<boolean> {
  if (isNeverAsk()) return false; // never-ask → hiçbir insan UI'yi incelemedi
  try {
    // MAHKEME CRITICAL (2 müfettiş): readAuditLogTail(500) per-iterasyon check için YETERSİZ (audit.ts docstring
    // bunu yasaklar; phase-8 aynı sebeple 1500 kullanır). Faz 6 iterasyonun ERKEN safhası; pipeline-sonuna (Faz 7-17)
    // kadar 500'ü aşan event olursa erken phase-6-complete pencereden düşer → yanlış "incelenmedi" → greenfield-
    // varsayılan-modda sentez YANLIŞ tetiklenir (KATI #14 ihlali). TAM audit + eventsSince (harness-verdict deseni).
    const events = eventsSince(await readAuditLog(state.project_root), state.iteration_started_at ?? 0);
    const p6 = events.filter((e) => e.phase === 6);
    const skipped = p6.some((e) => e.event.startsWith("phase-6-skipped"));
    const completed = p6.some((e) => e.event === "phase-6-complete");
    return completed && !skipped;
  } catch {
    return true; // audit okunamadı → kuşkuda "incelendi" (sentez kurma; eski davranış)
  }
}

/**
 * İMPURE (mahkeme MEDIUM — sentez FP fix): proje GERÇEKTEN UI dosyaları içeriyor mu (view/component/framework).
 * project_type="unknown" iken tam-develop sentezi YALNIZ spec-regex'e güvenirse yanlış-sınıflı backend/library
 * (spec'te "html/dom" geçen HTML-parser) sentezlenip bloklanabilir. Bu SAF-değil FS sinyali regex belirsizliğini
 * keser: gerçek UI dosyası varsa (cave: views/*.ejs) sentezle, yoksa (backend) sentezleme. Sınırlı tarama.
 */
async function projectHasUiFiles(root: string): Promise<boolean> {
  const uiDirs = ["views", "components", "pages", "templates", "src/components", "src/pages", "src/app", "app/views", "src/views"];
  for (const d of uiDirs) {
    try {
      if ((await fsStat(pathJoin(root, d))).isDirectory()) return true;
    } catch {
      /* yok */
    }
  }
  const uiExts = new Set([".ejs", ".tsx", ".jsx", ".vue", ".svelte", ".hbs", ".pug", ".astro"]);
  for (const base of ["", "src", "app", "public"]) {
    try {
      const entries = await fsReaddir(pathJoin(root, base), { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        const dot = e.name.lastIndexOf(".");
        if (dot >= 0 && uiExts.has(e.name.slice(dot).toLowerCase())) return true;
      }
    } catch {
      /* yok */
    }
  }
  return false;
}

/**
 * GERÇEK-APP DOĞRULAMA KAPISI (YZLLM 2026-07-21) — pipeline sonunda, emitVerificationSummary/
 * onTaskMaybeComplete ÖNCESİNDE çağrılır. Canlı kök: cave /profile "boş sonuç" fix'i Faz 8'i
 * "complete score=100" damgaladı ama bug SÜRDÜ — çünkü yalnız BİRİM-suite yeşili doğrulandı, gerçek
 * çalışan uygulama hiç görülmedi. İKİ KAYNAK: (1) Faz 0 debug fix-routing (ui-only/backend-only)
 * pending_realapp_verify marker'ı bırakır; (2) TAM-DEVELOP SENTEZİ — canlı cave /wellcome kanıtı: bug'lar Faz 0
 * debug'a DEĞİL tam-develop'a (Faz 1-17) yönleniyor → marker kurulmuyor; Faz 6 foreign/never-ask'ta atlanıyor,
 * Faz 16 placeholder → UI hiç uçtan-uca doğrulanmadan "done" oluyor. Marker yoksa: UI + Faz 6 insan-incelemesi-yok
 * + niyet-var ise intent_summary'yi hedef alıp marker SENTEZLE (decideFullDevelopGate). Her iki kaynak da AYNI
 * kapıdan (Playwright E2E) geçip bildirilen bug'ın/niyetin gerçek app'te GERÇEKTEN karşılandığını doğrular.
 *   pass       → sessiz devam (onTaskMaybeComplete 'done' damgalar).
 *   fail       → done ENGELLENİR + returnTaskToPending (attempts+1 → farklı yaklaşımla oto-retry). audit -fail → PARTIAL.
 *   cannot_run → done ENGELLENİR + patchTask(pending, attempts:MAX) (oto-retry YOK; görünür bekler + "Tekrar Dene"). audit -skipped → PARTIAL.
 * KATI #14: marker yok + sentez tetiklenmiyor (Faz 6 insan-incelendi / non-UI / niyet-yok / Playwright kapalı) → SIFIR davranış değişikliği.
 *
 * KAPSAM (mahkeme BULGU 3 canlı çıktı → genişletildi): Greenfield varsayılan mod → Faz 6 insan-incelemesi yapılır
 * → sentez KOŞMAZ (regresyon yok). Faz 6 revise_ui → Faz 6'da parkeder (insan doğrular). Faz 9 risk-fix → kendi
 * controller döngüsü, pipeline-sonu next===null'a girmez (hâlâ kapsam-dışı — risk-fix'in repro senaryosu yok).
 */
async function runRealAppGateAtPipelineEnd(stateIn: State): Promise<void> {
  const cfg = runtime.config;
  if (!cfg) {
    if (stateIn.pending_realapp_verify) log.warn("realapp-gate", "config yok → gerçek-app doğrulama atlandı (no-op)");
    return;
  }
  const playwrightEnabled = cfg.features.playwright_enabled !== false;

  let marker = stateIn.pending_realapp_verify;
  let synthesized = false;
  if (!marker) {
    // TAM-DEVELOP SENTEZİ (YZLLM 2026-07-21, canlı cave /wellcome): bug'lar Faz 0 debug'a DEĞİL tam-develop'a
    // (Faz 1-17) yönleniyor → Faz 0 marker'ı kurulmuyor; Faz 6 foreign/never-ask'ta atlanıyor, Faz 16 placeholder
    // → UI hiç uçtan-uca doğrulanmadan "done" oluyor. Marker yoksa: UI + Faz 6 insan-incelemesi-yok + niyet-var ise
    // intent_summary'yi hedef alıp gerçek-app doğrulamasını SENTEZLE (aynı kapıdan geçir).
    const phase6HumanReviewed = await isPhase6HumanReviewedThisIter(stateIn).catch(() => true);
    const intentEn = (stateIn.intent_summary ?? "").trim();
    const hasUiFiles = await projectHasUiFiles(stateIn.project_root).catch(() => false);
    const dec = decideFullDevelopGate({
      hasPhase0Marker: false,
      projectType: stateIn.project_type,
      hasUiFiles, // project_type=unknown iken GERÇEK UI-dosyası sinyali (regex FP'sini keser)
      phase6HumanReviewed,
      hasIntent: intentEn.length > 0,
      playwrightEnabled,
    });
    if (!dec.run) {
      log.info("realapp-gate", `tam-develop sentezi koşmuyor: ${dec.reason}`);
      return; // marker yok + sentez de yok → no-op (eski davranış)
    }
    const built = buildRealAppVerifyMarker({
      fromErrorAnalysis: false,
      bugReportTr: intentEn, // fallback metin; asıl repro hedefi bug_intent_en'den okunur (çeviri atlanır)
      bugIntentEn: intentEn,
      rootCauseTr: intentEn,
      fixLabel: `tam-develop iterasyon ${stateIn.iteration_count ?? 1}`,
      checkpointRef: undefined, // checkpoint yok → changedFiles null → realAppGateDecision fail-open koşar
      iteration: stateIn.iteration_count ?? 1,
    });
    marker = built.pending_realapp_verify;
    synthesized = true;
    if (!marker) return; // teorik; buildRealAppVerifyMarker fromErrorAnalysis=false → daima döner
    emitChatMessage("system", "🔬 Bu iterasyonda UI insan tarafından incelenmedi (Faz 6 atlandı) — çalışan uygulamayı niyete karşı gerçek-app doğrulamasından geçiriyorum.");
  }

  // Marker'ı TÜKET (tek-uçuş) — sentezlenen marker state'te yoktu, yalnız Faz 0 marker'ını temizle+kaydet.
  let state: State = synthesized ? stateIn : { ...stateIn, pending_realapp_verify: undefined };
  runtime.state = state;
  if (!synthesized) await saveState(state);

  const curIter = state.iteration_count ?? 1;
  if (marker.created_iter !== curIter) {
    log.warn("realapp-gate", "bayat marker (farklı iterasyon) — atlandı", {
      created_iter: marker.created_iter,
      curIter,
    });
    return;
  }

  // Faz 0 marker'ında realAppGateDecision (değişen-dosya + tip kararı); sentezlenen markerda decideFullDevelopGate
  // ZATEN karar verdi (gerçek UI-dosyası + Faz 6 yok) → tekrar realAppGateDecision KOŞMA (unknown+regex-miss'te o
  // 'run:false' derdi ve sentezi çelişkiyle iptal ederdi). Fail-open uyumlu.
  if (!synthesized) {
    let changedFiles: string[] | null = null;
    if (marker.checkpoint_ref) {
      try {
        changedFiles = await getChangedFiles(state.project_root, marker.checkpoint_ref);
      } catch {
        changedFiles = null; // tespit edilemedi → realAppGateDecision fail-open (koş)
      }
    }
    // has_ui spec-sinyali YALNIZ burada (Faz 0 marker'ı) gerekli → no-op/sentez yollarında hesaplama (LOW: mahkeme).
    const hasUiSpecSignal = await shouldRunMechanical(state.project_root, "has_ui").catch(() => true);
    const decision = realAppGateDecision({
      isFixIteration: true, // Faz 0 fix dalı → bu iterasyonda doğrulanacak iş var
      projectType: state.project_type,
      hasUiSpecSignal,
      changedFiles,
      playwrightEnabled,
    });
    if (!decision.run) {
      log.info("realapp-gate", `gerçek-app doğrulama koşmuyor: ${decision.reason}`);
      return; // done normal (eski davranış)
    }
  }

  // Doğrulamayı koş — verify-feature.ts altyapısı (dev-server + Playwright + codegen + mock-guard).
  // MAHKEME HIGH (2 müfettiş): çağrı ÇIPLAK bırakılırsa (kardeş pipeline-end çağrılarının hepsi .catch'li) bir
  // istisna pipeline'ı çökertir + marker zaten tüketilmiş olduğundan doğrulama KALICI kaybolur + işin gerçek
  // nedeni jenerik "terminal hata"yla örtülür. İstisna → cannot_run("error"): done ENGELLENİR (sessiz done değil).
  let result: RealAppGateOutcome;
  let statePatch: Partial<State> | undefined;
  try {
    const r = await runRealAppBugGate(
      {
        bug_intent_tr: marker.bug_intent_tr,
        bug_intent_en: marker.bug_intent_en,
        root_cause_tr: marker.root_cause_tr,
        fix_label: marker.fix_label,
      },
      { state, config: cfg },
    );
    result = r.result;
    statePatch = r.statePatch;
  } catch (err) {
    log.error("realapp-gate", "gerçek-app doğrulama işi beklenmedik istisna verdi → cannot_run(error), done engellenir", err);
    result = { outcome: "cannot_run", reason: "error" };
    statePatch = undefined;
  }
  if (statePatch) {
    state = { ...state, ...statePatch };
    runtime.state = state;
    await saveState(state);
  }

  const nowTs = Date.now();
  if (result.outcome === "pass") {
    await appendAuditModule(state.project_root, {
      ts: nowTs,
      phase: 16 as PhaseId,
      event: "realapp-verify-pass",
      caller: "mycl-orchestrator",
      detail: marker.fix_label ?? marker.bug_intent_tr.slice(0, 80),
    });
    emitChatMessage(
      "system",
      // MAHKEME MEDIUM (kapsam-aşımı): sentezde "bug" tüm niyettir → tek senaryo geçmesi niyetin TAMAMINI kanıtlamaz;
      // Faz 0 marker'ında bildirilen tek bug'dır → güçlü iddia doğru. Mesaj kaynağa göre.
      synthesized
        ? "✅ Gerçek uygulama doğrulaması geçti — niyetin temel senaryosu çalışan uygulamada doğrulandı (birim değil, gerçek arayüz)."
        : "✅ Gerçek uygulama doğrulaması geçti — bildirilen sorun çalışan uygulamada gerçekten çözüldü.",
    );
    return; // done normal (onTaskMaybeComplete 'done' damgalar)
  }

  // UYGULANAMAZ (YZLLM onayı 2026-07-24, "UI değişmeyen işlerde kapıyı uygulanamaz say"): SENTEZLENMİŞ
  // kapıda (Faz 6 atlanınca niyetten türetilen — kullanıcının bildirdiği somut bug DEĞİL) ajan senaryo
  // DOSYASINI hiç üretemediyse (not_found = "bu niyetten çalışan arayüz senaryosu çıkaramadım" deklarasyonu),
  // bu iş arayüz senaryosuna çevrilemiyor demektir (örn. güvenlik bulgusu giderme, test altyapısı tamiri).
  // Canlı kanıt (cave): işler suite yeşili + Faz 8 100 iken bu köşede attempts=MAX'a damgalanıp tavana
  // oturuyordu. Bu köşe NÖTR uygulanamaz → done NORMAL; özet ➖ basar. MAHKEME HIGH daraltması: YALNIZ
  // not_found — codegen_failed (LLM üretim hattı), guard_tripped (mock/vacuous hile sinyali!), aborted
  // (kesinti/iptal) ve ortamsal engeller SERT kalır; Faz 0 GERÇEK bug marker'ı (synthesized=false) aynen.
  if (synthesized && result.outcome === "cannot_run" && result.reason === "not_found") {
    await appendAuditModule(state.project_root, {
      ts: nowTs,
      phase: 16 as PhaseId,
      event: "realapp-verify-skipped",
      caller: "mycl-orchestrator",
      detail: `not_applicable_${result.reason}`, // emitVerificationSummary bunu ➖ nötr sınıflar
    });
    emitChatMessage(
      "system",
      "➖ Gerçek uygulama doğrulaması bu işe uygulanamadı — iş, çalışan arayüzde tek bir kullanıcı senaryosuna çevrilemedi (örn. güvenlik/test altyapısı işi). İş test yeşiliyle tamamlandı; arayüzü değiştiren işlerde bu doğrulama aynen koşmaya devam ediyor.",
    );
    return; // done NORMAL işler (onTaskMaybeComplete 'done' damgalar) — tavana damgalama YOK.
  }

  // fail / cannot_run → done'ı ENGELLE: currentTaskId + _drainTaskId null → onTaskMaybeComplete no-op.
  const taskId = runtime.currentTaskId ?? _drainTaskId;
  runtime.currentTaskId = null;
  _drainTaskId = null;

  if (result.outcome === "fail") {
    await appendAuditModule(state.project_root, {
      ts: nowTs,
      phase: 16 as PhaseId,
      event: "realapp-verify-fail",
      caller: "mycl-orchestrator",
      detail: result.failSnippet.slice(0, 200),
    });
    emitChatMessage(
      "system",
      "❌ Gerçek uygulama doğrulaması BAŞARISIZ — bildirilen sorun çalışan uygulamada HÂLÂ görülüyor. İş 'Tamamlandı' DAMGALANMADI; kuyruğa geri kondu, bir sonraki denemede farklı bir yaklaşım kullanılacak.",
    );
    if (taskId) {
      await returnTaskToPending(
        state.project_root,
        taskId,
        `gerçek-app doğrulaması: sorun sürüyor — ${result.failSnippet.slice(0, 120)}`,
      );
      await emitQueueChangedFor(state.project_root);
    }
    return;
  }

  // cannot_run → dürüst "kanıtlayamadım" (ortamsal engel) → done ENGELLE + oto-retry YOK (3× boşa koşturma).
  const reasonTR: Record<typeof result.reason, string> = {
    no_dev_server: "dev server ayağa kalkmadı",
    no_playwright: "Playwright kurulamadı",
    codegen_failed: "doğrulama testi üretilemedi",
    guard_tripped: "üretilen test hileliydi (mock/boş) — doğrulama sayılmadı",
    aborted: "doğrulama kesinti/iptalle yarıda kaldı",
    not_found: "senaryo/sayfa bulunamadı",
    error: "doğrulama beklenmedik hata verdi",
  };
  const why = reasonTR[result.reason];
  await appendAuditModule(state.project_root, {
    ts: nowTs,
    phase: 16 as PhaseId,
    event: "realapp-verify-skipped",
    caller: "mycl-orchestrator",
    detail: result.reason,
  });
  emitChatMessage(
    "system",
    `⚠️ Gerçek uygulama doğrulaması KOŞULAMADI (${why}) — fix yalnız birim testleriyle doğrulandı, çalışan uygulamada KANITLANMADI. İş 'Tamamlandı' damgalanmadı; kuyrukta görünür bekliyor (otomatik denenmez; "Tekrar Dene" ile yeniden başlatabilirsin).`,
  );
  if (taskId) {
    await patchTask(state.project_root, taskId, {
      status: "pending",
      attempts: MAX_TASK_AUTO_RETRIES,
      last_fail: `gerçek-app doğrulaması koşulamadı: ${why}`,
    });
    await emitQueueChangedFor(state.project_root);
  }
}

/**
 * Pipeline TAM çözüldüğünde (advanceToNextPhase finally, derinlik 0) çağrılır.
 * (1) Orphan uzlaştırma: currentTaskId set ama park YOK → iş bitmeden durdu →
 *     "dropped" (sonsuza "running" + kuyruk-kilidi önlenir). (2) Drain oturumu
 *     açıksa sıradaki AUTO işi seri işle (_handlingUserMessage yeniden alınır).
 * Meşgulse (başka iş/kilit/redirect) no-op → bir sonraki boşalmada tekrar denenir.
 */
async function reconcileAndDrainTasks(): Promise<void> {
  // Ucuz guard'lar (await YOK) → hemen _draining al (#3: orphan-drop await'lerinden
  // ÖNCE kilitle ki iki reconcile interleave olmasın).
  if (_draining) return;
  if (_handlingUserMessage || runtime.controller !== null || _pipelineDepth > 0) return;
  if (_pendingRedirect !== null) return;
  if (!runtime.state) return;
  _draining = true;
  try {
    // Birleşik döngü: her turda (a) orphan uzlaştır (park değilse düşür, parktaysa dur),
    // (b) oturum açıksa sıradaki AUTO işi başlat. Bir iş Faz 1'de terminal hata verirse
    // (failPhase advance ETMEDEN döner) currentTaskId set kalır → bir SONRAKİ turda
    // orphan-drop yakalar (#2: drain-loop terminal-fail kuyruğu kilitlemez).
    while (_pendingRedirect === null && runtime.state) {
      const root = runtime.state.project_root;
      if (runtime.currentTaskId) {
        if (isPipelineParked()) break; // kullanıcı cevabı bekleniyor → dur
        // park DEĞİL → iş tamamlanmadan durdu (terminal fail/abort) → düşür, devam et.
        const id = runtime.currentTaskId;
        runtime.currentTaskId = null;
        // YZLLM 2026-07-18: düşürme YOK — pending + attempts (tavan dolunca otomatik seçilmez, görünür bekler).
        // Somut STOP nedeni varsa (ensureAutonomousContinuation bıraktı) onu taşı — jenerik not ezmesin.
        const stopReason = _pendingStopReason ?? "pipeline iş tamamlanmadan durdu (terminal hata/kesinti)";
        _pendingStopReason = null;
        await returnTaskToPending(root, id, stopReason);
        // KESİNTİ AYRIMI (YZLLM kararı 2026-07-30): sağlayıcı kapalı olduğu için duraklamışsak ortada
        // TERMİNAL HATA YOK — iterasyon durumunu (faz/niyet/spec) SİLMEK 23 kez spec'i baştan ürettirdi.
        // Kesintide durumu koru + işe "hangi fazda kaldı" yaz; erişim dönünce oradan sürer.
        const keep = shouldPreserveIterationState({
          outageWaiting: isLlmOutageWaiting(),
          currentPhase: runtime.state.current_phase,
          hasIntent: Boolean(runtime.state.intent_summary),
          iterationStartedAt: runtime.state.iteration_started_at,
        });
        if (keep.preserve) {
          await patchTask(root, id, {
            resume_phase: keep.resumePhase,
            resume_iter_ts: keep.resumeIterTs,
          }).catch((e) => log.warn("orchestrator", "resume bilgisi yazılamadı", e));
          log.info("orchestrator", "kesinti — iterasyon durumu korundu", { phase: keep.resumePhase });
          await emitQueueChangedFor(root);
          continue; // state reset + clarify temizliği ATLANIR (ilerleme korunur)
        }
        // YZLLM 2026-07-03 (mahkeme — kritik): düşen iş BAYAT iterasyon-state'i (current_phase/intent_summary/spec/
        // iteration_started_at) bırakıyordu → SONRAKİ kuyruk işi bunları devralıp (wasPipelineCompleted reset'i proje-
        // ömründe ilk tamamlamadan ÖNCE hiç koşmaz) yanlış resume + yanlış clarify-enjeksiyonu yapıyordu (kapat-aç'ta
        // task2, task1'in terk edilmiş işini task2 etiketiyle sessizce sürdürüyordu). Düşen işin state'ini TEMİZLE →
        // sonraki iş sıfırdan Faz 1. (Resume yolu bu drop'tan GEÇMEZ; yalnız terminal-fail düşen işlerde tetiklenir.)
        runtime.state = {
          ...runtime.state,
          current_phase: 1,
          intent_summary: undefined,
          intent_summary_raw: undefined,
          iteration_started_at: undefined,
          spec_approved: false,
          spec_hash: undefined,
          needed_phases: undefined,
          needed_phases_proposed: undefined,
          updated_at: Date.now(),
        };
        await saveState(runtime.state);
        clearClarifyLog(root); // yarım işin clarify Q&A'sı sonraki denemeye SIZMASIN
        await emitQueueChangedFor(root);
      }
      // ⚡ Aktif paralel küme (2026-07-16): birleşik pipeline parktaysa dur; park DEĞİLSE
      // tamamlanmadan durmuş (terminal fail) → işleri BİR KEZ pending'e döndür (tek-atış
      // fail-set → yeniden kümelenmez, sıralı işlenir; hiçbir iş kaybolmaz).
      if (runtime.currentBatch) {
        if (isPipelineParked()) break;
        const batch = runtime.currentBatch;
        runtime.currentBatch = null;
        for (const tid of batch.taskIds) {
          _batchFailedIds.add(tid);
          await patchTask(root, tid, { status: "pending" });
        }
        await emitQueueChangedFor(root);
        emitChatMessage(
          "system",
          "⚠️ Paralel küme tamamlanmadan durdu — işler kuyruğa geri kondu, SIRALI işlenecek (kayıp yok).",
        );
      }
      if (!_drainActive) break; // aktif drain oturumu yok → yalnız orphan uzlaştırıldı
      _handlingUserMessage = true; // seri garanti (kullanıcı mesajıyla yarış yok)
      let ran = false;
      try {
        // ⚡ Önce paralel küme dene (bayrak + ≥2 bağımsız iş + git temiz); olmuyorsa sıralı tek iş.
        ran = (await tryStartTaskBatch()) || (await startNextPendingTask());
      } finally {
        _handlingUserMessage = false;
      }
      if (!ran) break; // bekleyen AUTO iş yok (startNextPendingTask _drainActive=false yaptı)
      // ran=true → iş koştu; döngü başına dön: done(currentTaskId=null→sıradaki) /
      // park(currentTaskId set→break) / fail(currentTaskId set,park değil→drop+devam).
    }
  } finally {
    _draining = false;
  }
  // Bu sırada kullanıcı yönlendirmesi biriktiyse işle (öncelikli).
  if (_pendingRedirect !== null) {
    const r = _pendingRedirect;
    _pendingRedirect = null;
    _userInitiatedAbort = false;
    await handleUserMessage(r);
  }
}

/**
 * İş-listesi sürücüsünü "ateşle" (YZLLM 2026-06-15: "iş listesindekileri sıra sıra
 * pipeline'dan geçirsin sistem; böyle kullanılsın MyCL"). Bekleyen iş varsa drain
 * oturumunu aç + uzlaştırmayı tetikle (sistem boşalınca işler; meşgulse reconcile
 * no-op → sonra). İŞ EKLE ile yeni iş geldiğinde + proje açılışında bekleyen iş
 * varsa çağrılır → kullanıcı mesaj göndermeden iş-listesi kendiliğinden işlenir.
 */
async function kickWorkQueue(): Promise<void> {
  if (!runtime.state) return;
  const items = await readTasks(runtime.state.project_root);
  if (!nextPendingTask(items)) return; // bekleyen iş yok → tetikleme
  // MAHKEME (2026-07-23): yeni iş tetiği = "şimdi dene" iradesi (handleRunPhase emsali) → bekle-ve-devam
  // iptal. Yoksa bayat bekleme bayrağı (kesinti düzeldi ama zamanlayıcı ateşlenmedi penceresi)
  // returnTaskToPending'in deneme-muafiyetini yanlış açık tutar (gerçek hata da sayılmazdı). Kesinti
  // hâlâ sürüyorsa ilk faz hatası (failPhase usage-limit/kredi dalları) beklemeyi YENİDEN kurar.
  cancelLlmOutageWait();
  _drainActive = true;
  setImmediate(() => {
    void reconcileAndDrainTasks().catch((e: unknown) =>
      log.error("orchestrator", "iş-listesi sürücü tetikleme hatası", e),
    );
  });
}

/**
 * Sonraki faza geç. Eksik faz controller'ları için (Phase 4'e gidene kadar
 * 2-3 skip edilir) skip event'i yazılır. Phase 4'e ulaşınca controller başlatılır.
 */
/**
 * Spec.md içeriğine bakıp koşullu mechanical fazları (P17/P18) atla. Heuristic:
 *   - has_ui: spec'te "ui"|"frontend"|"görsel" geçiyorsa true.
 *   - has_nfr: spec'te "load"|"performance"|"throughput"|"latency" geçiyorsa true.
 *   - has_database: "database"|"db"|"prisma"|"sql" geçiyorsa true.
 *   - always: her zaman true.
 */
async function shouldRunMechanical(
  projectRoot: string,
  skip_unless: "has_ui" | "has_web_target" | "has_nfr" | "has_database" | "always" | undefined,
): Promise<boolean> {
  if (!skip_unless || skip_unless === "always") return true;
  let spec = "";
  try {
    // Faz 3 (devs/): codegen-okur per-iter spec (runtime.state modül-seviye). state yoksa kök fallback.
    spec = await fsReadFile(
      runtime.state ? currentSpecPath(runtime.state) : pathJoin(projectRoot, ".mycl", "spec.md"),
      "utf-8",
    );
  } catch (e) {
    // KUŞKUDA FULL (sessiz-fallback denetimi): spec okunamazsa skip-koşulunu DEĞERLENDİREMEYİZ → atlamak
    // (return false) gate'i sessizce no-op yapar (false-green). Güvenli taraf = gate'i KOŞ (return true) +
    // GÖRÜNÜR uyarı. (ENOENT bile olsa: spec yoksa atlamak değil, emniyetli koşmak.)
    const code = (e as { code?: string }).code;
    log.error("orchestrator", "shouldRunMechanical: spec okunamadı → gate emniyetli KOŞULUYOR (atlanmıyor)", { code, error: String(e) });
    emitChatMessage(
      "system",
      `⚠️ Faz atlama koşulu için spec okunamadı (${code ?? "hata"}) → gate atlanmıyor, emniyetli şekilde KOŞULUYOR (kuşkuda full).`,
    );
    return true;
  }
  // Regex sinyal mantığı TEK KAYNAK'ta (mechanical-skip-signal.ts) — SAF + birim-testli (gölge-test yok). Bkz o modül.
  return specSignalMatches(spec.toLowerCase(), skip_unless);
}

/**
 * v15.6 (2026-05-24): needed_phases scope check. Yalnızca opsiyonel fazlar
 * etkilenir — zorunlu fazlar her zaman çalışır. needed_phases undefined ise
 * eski davranış (tüm fazlar çalışır).
 */
function isPhaseSkippedByScope(state: State, phaseId: number): boolean {
  // YZLLM 2026-06-11 (#2 deliği): Faz 8 (TDD/testler) ARTIK ZORUNLU — atlanırsa hiç test yazılmaz → test-temelli
  // doğrulama (Faz 14) boşalır → kontrol delinir.
  // YZLLM 2026-06-15: Faz 6 (UI incelemesi) DE ARTIK ZORUNLU — "UI değişikliği gerekmese bile UI'yi görmem,
  // direksiyonu nereye kıracağımı seçmem gerekebilir; hiç atlanmamalı". Backend/mantık işinde bile Faz 6
  // koşar → kullanıcıya mevcut UI'yi gösterip incelemeyi devreder. Yalnız 5 (UI üretimi) ve 7 (DB) gerçekten
  // opsiyonel (UI değişikliği/DB yoksa boş üretim/şema yapma). Faz 6/8/9 + zorunlu mekanik gate'ler her zaman çalışır.
  if (phaseId !== 5 && phaseId !== 7) return false;
  if (!state.needed_phases || state.needed_phases.length === 0) return false;
  return !state.needed_phases.includes(phaseId);
}

export async function advanceToNextPhase(from: PhaseId): Promise<void> {
  // YZLLM 2026-06-12: pipeline-derinliğini say (özyinelemeli failPhase→advance çağrıları + fazlar arası
  // controller=null boşlukları için). En dış çıkışta (derinlik 0) sistem GERÇEKTEN boşa çıkar → bekleyen
  // command_direct kuyruğunu boşalt. try/finally → her return/break/throw'da sayaç düzgün iner (kalıcı
  // "pipeline koşuyor" yanlış-pozitifi yok).
  // round-5 #1: _pipelineDepth++ EN BAŞTA (senkron — handleUserMessage 1704-1705'in dayandığı "advance
  // çağrısı _pipelineDepth++'a kadar senkron" invariant'ı korunur; aşağıdaki saveState await'i guard'ı
  // boşa düşürmesin).
  _pipelineDepth++;
  // MAHKEME fix (reset-kapsam boşluğu): faz `from` ilerliyor (tamamlandı/kabul/mahkeme-suppress/autofix — TÜM advance
  // yolları buradan geçer) → faz-seviyesi döngü sayacını sıfırla. Kanonik tek-nokta: dağınık explicit reset'lerin
  // kaçırdığı yolları (ör. mahkeme-suppress advanceToNextPhase(n)) da kapsar → stale streak → erken-tetik YOK.
  gateFailStreak.delete(from);
  try {
    // Görsel taban terfisi (2026-07-16): Faz 6 GEÇİLDİ (onay veya never-ask oto-geçiş — tüm advance
    // yolları burası) → bu iterasyonun görüntüleri yeni taban olur; pending yoksa no-op. revise_ui
    // advance ETMEDİĞİ için eski taban korunur (doğru: onaylanmamış görünüm taban olmaz).
    if (from === 6 && runtime.state?.project_root) {
      await promoteVisualBaseline(runtime.state.project_root);
    }
    // Yeniden-inceleme round-4 #1/#3/#5 (YAPISAL): Faz 6 inceleme parkından İLERİ
    // herhangi bir faza geçişte park bayrağını TEMİZLE. approve_ui / run_phase /
    // resume_pipeline / restartPhase1WithIntent hepsi pipeline'ı buradan ilerletir →
    // tek nokta. Aksi halde bayat pending_ui_review → isPipelineParked yanlış-true →
    // sonraki faz fail'inde orphan-drop bloklanır → kuyruk kalıcı kilitlenir. (Faz 6'ya
    // YENİ giriş bayrağı dispatch'in SONUNDA set eder → bu giriş-temizliğiyle çakışmaz.)
    if (runtime.state?.pending_ui_review) {
      runtime.state = { ...runtime.state, pending_ui_review: undefined, updated_at: Date.now() };
      await saveState(runtime.state);
    }
    await advanceToNextPhaseInner(from);
  } finally {
    _pipelineDepth--;
    if (_pipelineDepth === 0) {
      void commandDirectQueue.drain();
      // İş kuyruğu (YZLLM 2026-06-14): pipeline TAM çözüldü → orphan iş uzlaştır +
      // bekleyen auto işleri seri işle. setImmediate ile dış kilit (handleUserMessage/
      // handleAskqAnswer) boşaldıktan SONRA koşar → reconcile guard'ı meşgulse no-op.
      setImmediate(() => {
        void reconcileAndDrainTasks().catch((e: unknown) =>
          log.error("orchestrator", "kuyruk uzlaştırma/drain hatası", e),
        );
      });
    }
  }
}

/**
 * Faz 9 risk-fix dispatch (YZLLM 2026-06-13). Risk incelemesi bir riski "fix" diye işaretleyince,
 * eskiden yalnız audit'e yazılıp ATILIYORDU (bulunan risk düzeltilmiyordu). Artık her "fix" kararını
 * ALANINA göre hedefli-düzeltme fazına yönlendirir: ui→Faz 5, db→Faz 7, code→Faz 8 (belirsiz→8).
 *
 * Akış: senkron mini-döngü — fazları DOĞRUDAN `new + runController` ile çalıştırır, lineer faz-haritasını
 * (PHASE_TRANSITIONS) HİÇ ilerletmez → current_phase 9'da KALIR → araya Faz 6 (UI inceleme) vb. GİRMEZ.
 * Tam olarak istenen "düzelt → Faz 9'a dön → sonraki risk" döngüsü. Singleton-controller kısıtı korunur
 * (her seferinde tek faz, seri). Her zaman çalışır (Oto-cevaptan bağımsız — YZLLM 2026-06-13 kararı).
 *
 * Doğrulama: EKSTRA tur YOK — her düzeltme fazı kendi içinde doğrular (Faz 8 = TDD, kendi testini yazıp
 * geçirir) + Faz 9 sonrası Faz 10-17 kapıları değişen dosyaları zaten tarar (kullanıcı kararı 2026-06-13).
 * Fail-soft: bir fix patlarsa GÖRÜNÜR not + risk açık bırakılır + sonraki riske geçilir (pipeline kırılmaz).
 */
async function dispatchRiskFixes(
  stateIn: State,
  cfg: MyclConfig,
  decisions: { risk: string; decision: string; detail?: string; fix_phase?: string }[],
): Promise<State> {
  let state = stateIn;
  const fixesAll = (decisions ?? []).filter(
    (d) => String(d.decision).trim().toLowerCase() === "fix",
  );
  if (fixesAll.length === 0) return state;

  // YABANCI-YAZMA ONAY KAPISI (YZLLM 2026-07-08): entegre (foreign) projede risk-fix'ler VAR OLAN kodu OTONOM
  // değiştiriyor (oto-cevaptan bağımsız + behavior-consent foreign'de erken-return → bugün onaysız). Bu kapı,
  // her fix'in EDD'den dokunacağı mevcut davranışı gösterip kullanıcı onayı ister → yalnız onaylananlar uygulanır.
  // MyCL projede no-op (kapı origin!=="foreign"da items'ı aynen döndürür) → byte-aynı.
  let fixes = fixesAll;
  if (state.origin === "foreign") {
    const items = fixesAll.map((f, i) => {
      const text = f.detail?.trim() || f.risk; // boş/whitespace detail → risk metnine düş (label/seed AYNI kaynak — mahkeme Major)
      return {
        key: String(i),
        label: text.slice(0, 160),
        seedFiles: seedFilesFromText(state.project_root, text, extractFilePaths),
      };
    });
    const approved = await runForeignWriteConsentGate(state, cfg, items, { source: "risk-fix" });
    const okKeys = new Set(approved.map((a) => a.key));
    fixes = fixesAll.filter((_, i) => okKeys.has(String(i)));
    await appendAuditModule(state.project_root, {
      ts: Date.now(),
      phase: 9,
      event: "foreign-write-consent",
      caller: "mycl-orchestrator",
      detail: `risk-fix onayı: ${fixes.length}/${fixesAll.length} uygulanacak`,
    }).catch(() => {});
    if (fixes.length === 0) return state; // hiçbiri onaylanmadı → yabancı kod korunuyor (kapı mesajı yazdı)
  }

  emitChatMessage(
    "system",
    `🔧 Faz 9 — ${fixes.length} risk "düzelt" işaretlendi; her birini ilgili fazda otomatik düzeltiyorum (UI→Faz 5, DB→Faz 7, kod→Faz 8).`,
  );

  // ZAMAN-KAYBI PLANI #6 (YZLLM 2026-07-07, "varsayılan açık, çakışmada mahkeme"): kod-fix'lerini (target 8) İZOLE
  // KOPYALARDA paralel dene. Başarılıysa o fix'leri seri döngüden çıkar (dosyalar ana ağaca zaten uygulandı);
  // başarısızsa (worker/mahkeme/konsolide-test) TAM seri (fail-closed). ui/db fix'leri her zaman seri.
  const routeOf = (f: { fix_phase?: string }) =>
    resolveRiskFixTarget(f.fix_phase, { skipUi: !!state.skip_ui_phases, noDb: state.has_database === false });
  let remainingFixes = fixes;
  if (cfg.features.parallel_risk_fixes !== false) {
    const codeFixes: CodeFix[] = fixes
      .filter((f) => routeOf(f).target === 8)
      .map((f) => ({ detail: (f.detail?.trim() || f.risk).slice(0, 2000), risk: f.risk }));
    if (codeFixes.length >= 2) {
      const par = await runParallelRiskFixes(state, cfg, codeFixes).catch((e) => {
        log.error("orchestrator", "runParallelRiskFixes hata", e);
        return { ok: false, reason: String(e).slice(0, 120), treeCorrupted: false };
      });
      if (par.ok) {
        emitChatMessage("system", `✅ ${codeFixes.length} kod düzeltmesi PARALEL uygulandı — ${par.reason}`);
        remainingFixes = fixes.filter((f) => routeOf(f).target !== 8); // kalan: yalnız ui/db (+ skip)
      } else if ("userRejected" in par && par.userRejected) {
        // B1.1 (foreign): kullanıcı GERÇEK-dosya onayını reddetti → SERİ fallback YAPMA (aksi halde aynı fix'ler seri
        // uygulanır = reddi baypas eder). Kod-fix'leri ATLA (uygulanmadan bırak); yalnız ui/db seri kalır.
        emitChatMessage("system", "⏭️ Kod risk düzeltmeleri uygulanmadı — kesin dosya onayını reddettin (var olan kod korunuyor).");
        remainingFixes = fixes.filter((f) => routeOf(f).target !== 8);
      } else if (par.treeCorrupted) {
        // KISMİ GERİ ALMA BAŞARISIZ (mahkeme bulgusu; KATI #4 "dur"): ana ağaçta doğrulanmamış içerik olabilir →
        // BOZUK taban üstüne otomatik seri düzeltme YAPMA. Kod risk düzeltmelerini seri döngüden ÇIKAR (açık bırak) + LOUD.
        emitChatMessage(
          "system",
          `⛔ Paralel düzeltme geri alınamadı — ana ağaçta ELLE KONTROL gereken dosyalar olabilir (${par.reason}). Kod risk ` +
            `düzeltmelerini otomatik SÜRDÜRMÜYORUM (bozuk taban üstüne yazmam). Dosyaları kontrol edip 'Çalıştır' ile devam et; ` +
            `Faz 13/14 kapıları da tarayacak.`,
        );
        remainingFixes = fixes.filter((f) => routeOf(f).target !== 8); // kod-fix'leri seri KOŞMA (bozuk taban üstüne yazma)
      } else {
        emitChatMessage(
          "system",
          `↩️ Paralel düzeltme uygulanmadı (${par.reason}) — tek tek (tam test-odaklı) yola düşüyorum.`,
        );
      }
    }
  }

  for (let i = 0; i < remainingFixes.length; i++) {
    const f = remainingFixes[i];
    const detail = (f.detail?.trim() || f.risk).slice(0, 2000);
    // Saf yönlendirme + kapsam koruması (test edilebilir helper'da).
    const route = resolveRiskFixTarget(f.fix_phase, {
      skipUi: !!state.skip_ui_phases,
      noDb: state.has_database === false,
    });
    if (route.assumedCode) {
      log.warn("orchestrator", "risk-fix: fix_phase yok/bilinmiyor → Faz 8 (code) varsayıldı", {
        fix_phase: f.fix_phase,
        risk: f.risk.slice(0, 80),
      });
    }
    if (route.target === null) {
      emitChatMessage(
        "system",
        route.skipReason === "no-ui"
          ? `⏭ Risk ${i + 1}/${remainingFixes.length} atlandı — UI riski ama proje UI içermiyor: ${detail.slice(0, 120)}`
          : `⏭ Risk ${i + 1}/${remainingFixes.length} atlandı — DB riski ama proje veritabanı kullanmıyor: ${detail.slice(0, 120)}`,
      );
      continue;
    }
    const target = route.target;

    const fixSpec = getSpec(target);
    if (!fixSpec) {
      log.warn("orchestrator", "risk-fix: spec bulunamadı", { target });
      continue;
    }
    const phaseName = target === 5 ? "Faz 5 (UI)" : target === 7 ? "Faz 7 (DB)" : "Faz 8 (kod)";
    emitChatMessage(
      "system",
      `🔧 Risk ${i + 1}/${remainingFixes.length} → ${phaseName} ile düzeltiliyor: ${detail.slice(0, 160)}`,
    );
    await appendAuditModule(state.project_root, {
      ts: Date.now(),
      phase: 9,
      event: "risk-fix-dispatch",
      caller: "mycl-orchestrator",
      detail: `${phaseName} <= ${detail.slice(0, 120)}`,
    }).catch(() => {});

    // Hedefli-fix alanını set et — faz controller'ı bunu okuyup tüm-yeniden-yazma yerine tek fix yapar.
    if (target === 5) state = { ...state, pending_ui_tweak: detail };
    else if (target === 7) state = { ...state, pending_db_fix: detail };
    else state = { ...state, pending_backend_fix: detail };
    runtime.state = state;

    try {
      const ctrl =
        target === 5
          ? new Phase5Controller({ state, config: cfg, spec: fixSpec })
          : target === 7
            ? new Phase7Controller({ state, config: cfg, spec: fixSpec })
            : new Phase8Controller({ state, config: cfg, spec: fixSpec });
      const r = await runController(ctrl, () => ctrl.run(), `Risk düzeltiliyor — ${phaseName}`);
      if (r === "complete") {
        state = { ...state, ...ctrl.statePatch };
        emitChatMessage("system", `✅ Risk ${i + 1}/${remainingFixes.length} düzeltildi (${phaseName}).`);
      } else {
        emitChatMessage(
          "system",
          `⚠️ Risk ${i + 1}/${remainingFixes.length} düzeltilemedi (${phaseName}) — açık bırakıldı, sonraki riske geçiyorum.`,
        );
      }
    } catch (err) {
      log.error("orchestrator", "risk-fix dispatch hata", err);
      emitChatMessage(
        "system",
        `⚠️ Risk ${i + 1}/${remainingFixes.length} düzeltme hata verdi — açık bırakıldı: ${String(err).slice(0, 120)}`,
      );
    } finally {
      // Tek-seferlik tüketim: set ettiğim alanı her halükarda temizle (controller atlasa/patlasa bile sızmasın).
      if (target === 5) state = { ...state, pending_ui_tweak: undefined };
      else if (target === 7) state = { ...state, pending_db_fix: undefined };
      else state = { ...state, pending_backend_fix: undefined };
      runtime.state = state;
      await saveState(state).catch((e) => log.warn("orchestrator", "risk-fix saveState fail", e));
    }
  }
  emitChatMessage(
    "system",
    `🔧 Faz 9 risk düzeltmeleri tamamlandı (${fixes.length} risk işlendi). Kalite kapıları (Faz 10+) değişiklikleri doğrulayacak.`,
  );
  return state;
}

async function advanceToNextPhaseInner(from: PhaseId): Promise<void> {
  if (!runtime.state || !runtime.config) return;
  // Narrowing — döngü içinde runtime.state assignments TS'in null-check'ini bozar.
  let state: State = runtime.state;
  // Müfettiş B1: cfg `let` — Faz 13 güvenlik döngüsünde config yeniden yüklenirse (runtime.config
  // YENİDEN yükler) bu referans TAZELENMELİ; aksi halde runGateAutofix(state, cfg) STALE Claude config'le çalışıp
  // tekrar account-error verir.
  let cfg: MyclConfig = runtime.config;
  let cur: PhaseId = from;
  // v15.9: değişen-kapsam bir kez hesaplanır (ilk mekanik fazda); scoped-touch
  // modunda scope'lanamayan sistem-gate'leri atlanır.
  let scopeComputed = false;
  // YZLLM 2026-06-10: auto-düzeltilebilir gate (lint) bu koşuda BİR kez kendi-içinde-düzeltme denedi mi?
  // (1 satırlık lint'i sonsuz düzeltmeye çalışıp döngüye girmesin — bir deneme, olmazsa eskale.)
  const gateAutofixTried = new Set<number>();

  // ARDIŞIK akış: N → N+1, atlamasız. Controller'ı olmayan fazlar skip stub
  // ile geçer (audit phase-N-skipped + phase-N-complete) ama state.current_phase
  // tüm fazları sırayla ziyaret eder. Bu kural deterministik.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // v15.8 (2026-05-31): Önceki fazın token kovasını yaz (LLM turn'ü olduysa).
    // Faz başlangıcında beginPhaseCost set edildi; burada flush + cost.jsonl.
    // YZLLM 2026-06-20 (canlı bulgu: "Token çizelgesinde Faz 9 sonrası yok"): MEKANİK fazlar (10-17)
    // claude-token ÜRETMEZ ama GERÇEK SÜRE alır (gate'ler/Sızma Testi) → kullanıcı tüm pipeline'ı görmeli.
    // LLM fazları (≤9): token varsa yaz. Mekanik fazlar (≥10): süreleriyle HER ZAMAN yaz (0-token olsa bile).
    const prevCost = takePhaseCost();
    if (prevCost && (prevCost.turns > 0 || prevCost.input_tokens > 0 || prevCost.phase >= 10)) {
      // F1: birincil model = en çok token üreten (model_usage'tan); yalnız TANIMLI
      // alanları kopyala (USD yoksa undefined → panel token-only; uydurma $ yok).
      const mu = prevCost.model_usage;
      const primaryModel = mu
        ? Object.entries(mu).sort(
            (a, b) =>
              b[1].input_tokens + b[1].output_tokens - (a[1].input_tokens + a[1].output_tokens),
          )[0]?.[0]
        : undefined;
      const costRec: CostRecord = {
        ts: Date.now(),
        phase: prevCost.phase as PhaseId,
        iteration: prevCost.iteration,
        // Faz süresi (ms): kova başlangıcından şimdiye, ANCAK faz-içi askq-bekleme
        // (kullanıcının soruya cevap verme süresi — MyCL çalışması değil) düşülür
        // (YZLLM 2026-06-17 token çizelgesi). Math.max(0, …): negatif olmasın (defansif).
        ...(prevCost.started_at
          ? { duration_ms: Math.max(0, Date.now() - prevCost.started_at - prevCost.askqWaitMs) }
          : {}),
        turns: prevCost.turns,
        input_tokens: prevCost.input_tokens,
        output_tokens: prevCost.output_tokens,
        cache_read_input_tokens: prevCost.cache_read_input_tokens,
        cache_creation_input_tokens: prevCost.cache_creation_input_tokens,
        ...(prevCost.total_cost_usd !== undefined
          ? { total_cost_usd: prevCost.total_cost_usd }
          : {}),
        ...(primaryModel ? { model: primaryModel } : {}),
        ...(mu ? { model_usage: mu } : {}),
      };
      await appendCost(state.project_root, costRec).catch((err) =>
        log.warn("orchestrator", "cost write failed (non-blocking)", err),
      );
      // Token-timeline: faz cost'unu frontend'e CANLI yolla (realtime timeline paneli).
      emit("cost_phase", costRec);
      // Öngörüyü güncelle (yeni faz verisi geldi → tam-pipeline tahmini tazelensin).
      void emitCostForecast(state.project_root);
    }

    const next = PHASE_TRANSITIONS[cur];
    if (next === null || next === undefined) {
      // v15.8 (2026-05-30): Akış sonu DÜRÜST özet — istenen vs gerçekte
      // doğrulanan. Yanlış "her şey tamam" hissini önler.
      await emitPipelineEndSummary(state);
      // v15.11: Yaşayan dökümantasyon + UI kılavuzu güncelle (projeye dokunuldu).
      // Non-blocking — fail görünür uyarı, pipeline'ı bloklamaz.
      // 2026-08-03: bayatlık kontrolünden geçer — kaynak değişmediyse LLM çağrısı YOK (ucuz).
      await refreshDocsIfStale(state, cfg, { origin: "pipeline-end" }).catch((e: unknown) =>
        log.warn("orchestrator", "living-docs update failed (non-fatal)", e),
      );
      // Faz 4 (devs/ yapısı, YZLLM 2026-06-16): iterasyon-sonu — _pending/<ts>/ artefaktlarını
      // resolver ile iş-birimi klasörlerine (pages/endpoints/tables/<key>/<ts>/) taşı/böl. Fail-soft.
      const devsOutcome = await finalizeDevsArtifacts(state).catch((e: unknown) => {
        log.warn("orchestrator", "devs finalize failed (non-fatal)", e);
        return null;
      });
      // Faz 4b: dokunulan birimler + iter-spec'ten kök GENEL spec (.mycl/spec.md) + per-birim
      // page-spec.md'yi tazele (orkestratör rolü, salt-okunur, CLI modu). Fail-soft.
      if (devsOutcome) {
        await refreshDevsSpecs(state, cfg, devsOutcome).catch((e: unknown) =>
          log.warn("orchestrator", "devs spec refresh failed (non-fatal)", e),
        );
      }
      // Prototip-cache (item 4): koşu YEŞİL (gate-fail yok) + stack biliniyorsa baseline
      // dosyalarını golden prototip olarak kaydet (bu stack'te sonraki proje hızlı başlasın).
      // Non-blocking — snapshotPrototype kendi içinde yeşil/stack kontrolü yapar + throw etmez.
      await snapshotPrototype(state);
      // Modül-stoğu (item 5): YEŞİL koşuda orkestratör-rol ajanı NET reuse-edilebilir
      // feature modüllerini çıkarıp ~/.mycl/modules/<token>/'a stoklar (agent-güdümlü,
      // emin değilse no-op — çöp yok). Non-blocking; kendi içinde yeşil/stack/CLI kontrolü.
      await extractStockedModules(state, cfg).catch((e: unknown) =>
        log.warn("orchestrator", "module extraction failed (non-fatal)", e),
      );
      // Faz-Katkı Mahkemesi (YZLLM 2026-06-22): her fazın bu koşuya katkı yüzdesini mahkeme değerlendirip
      // Türkçe rapor chat'e basar → kullanıcı gereksiz fazı görüp KENDİ budar. Flag-gated + fail-soft.
      await runPhaseContributionReport(state, cfg).catch((e: unknown) =>
        log.warn("orchestrator", "phase-contribution report failed (non-fatal)", e),
      );
      // Katman-Maliyet Raporu (YZLLM 2026-07-12): faz-katkı raporunun katman-düzeyi kardeşi — her doğrulama
      // katmanının {süre, token, ne-yakaladı} DETERMİNİSTİK (LLM yok) chat'e → kullanıcı pahalı/az-değerli katmanı
      // görüp KENDİ budar (oto-budama YOK). Flag-gated + fail-soft.
      await runLayerCostReport(state, cfg).catch((e: unknown) =>
        log.warn("orchestrator", "layer-cost report failed (non-fatal)", e),
      );
      // YZLLM 2026-06-14: app-içi kılavuzun ekran görüntüleri — .mycl/help-pages.json route'larının ss'leri
      // hedef-app public/docs/guide-shots/'a (dev server ayaktaysa; bayat-temizlikli). updateLivingDocs SONRASI,
      // PDF ÖNCESİ. Non-blocking, fail-soft (dev server kapalıysa görünür skip).
      await generateGuideShots(state).catch((e: unknown) =>
        log.warn("orchestrator", "guide-shots generation failed (non-fatal)", e),
      );
      // NOT (YZLLM 2026-06-19): PDF kullanım kılavuzu ÜRETİMİ KALDIRILDI — yalnız app-içi
      // kılavuz (yukarıdaki guide-shots + her sayfada "?" popup) yeterli.
      // v15.9: scoped kapsam + fix checkpoint ref tüketildi — temizle (sonraki
      // iterasyonda stale scope yanlış daraltma yapmasın).
      if (state.changed_scope || state.fix_checkpoint_ref) {
        state = { ...state, changed_scope: undefined, fix_checkpoint_ref: undefined };
        runtime.state = state;
        await saveState(state);
      }
      // GERÇEK-APP DOĞRULAMA KAPISI (YZLLM 2026-07-21): bir fix iterasyonu bug'ı çözdüğünü iddia ediyorsa
      // birim-yeşil ≠ app-yeşil — gerçek çalışan uygulamada bildirilen bug'ın çözüldüğünü Playwright E2E ile
      // doğrula. emitVerificationSummary ÖNCESİNDE: audit event'i (pass/fail/skipped) özet + hükme yansısın.
      // Marker yoksa/karar "koşma" → no-op (KATI #14). Fail/cannot_run done'ı engeller (task kuyruğa döner).
      try {
        await runRealAppGateAtPipelineEnd(state);
      } catch (err) {
        // FAIL-CLOSED (mahkeme HIGH, 2 müfettiş): gate gövdesindeki çıplak await'ler (saveState/appendAudit/
        // task-queue — AuditError/TaskQueueError atabilir) pipeline'ı çökertip marker'ı KALICI kaybettirebilirdi.
        // Kardeş pipeline-end çağrılarının hepsi .catch'li; bu da öyle olmalı AMA done'ı da ENGELLE (sessiz done
        // YASAK): audit realapp-verify-skipped(gate-error) → PARTIAL + task pending + görünür uyarı.
        log.error("orchestrator", "runRealAppGateAtPipelineEnd beklenmedik istisna — fail-closed, done engelleniyor", err);
        const gateErrTaskId = runtime.currentTaskId ?? _drainTaskId;
        runtime.currentTaskId = null;
        _drainTaskId = null;
        emitChatMessage(
          "system",
          "⚠️ Gerçek uygulama doğrulaması beklenmedik bir hatayla kesildi — iş 'Tamamlandı' damgalanmadı (dürüst kalış); \"Tekrar Dene\" ile yeniden başlatabilirsin.",
        );
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 16 as PhaseId,
          event: "realapp-verify-skipped",
          caller: "mycl-orchestrator",
          detail: "gate-error",
        }).catch(() => {});
        if (gateErrTaskId) {
          await patchTask(state.project_root, gateErrTaskId, {
            status: "pending",
            attempts: MAX_TASK_AUTO_RETRIES,
            last_fail: "gerçek-app doğrulama beklenmedik hata",
          }).catch(() => {});
          await emitQueueChangedFor(state.project_root).catch(() => {});
        }
      }
      state = runtime.state ?? state; // gate marker'ı tüketti + statePatch uygulamış olabilir → yerel state tazele
      // #1 deliği (YZLLM 2026-06-11): sessiz gate-atlama şeffaflığı. Pipeline bitince hangi kalite boyutunun
      // GERÇEKTEN doğrulandığını, hangisinin ATLANDIĞINI (araç yok / uygulanamaz) açıkça göster — atlanan gate
      // "geçti" gibi görünmesin. Kullanıcı neyin doğrulanmadığını bilerek kabul etsin.
      await emitVerificationSummary(state);
      // YZLLM 2026-06-14: İŞ KUYRUĞU — bu iterasyon bir kuyruk işiyse "done" +
      // tamamlanma-tarihi ile damgala (KİLİT: tekrar uygulanamaz) + kuyrukta
      // bekleyen iş varsa sıradakini başlat. currentTaskId yoksa no-op.
      await onTaskMaybeComplete(state.project_root);
      // ⚡ Paralel küme işlerini damgala (2026-07-16) — currentBatch yoksa no-op.
      await onBatchMaybeComplete(state.project_root);
      // v15.7 (2026-05-25) BUG FIX: Akış son fazda (örn. Faz 17) bittiğinde
      // son emitPhaseChanged hâlâ "running" idi → sidebar mavi (running)
      // kalıyordu. Loop break öncesi son fazı "complete" işaretle.
      emitPhaseChanged(cur, cur, "complete");
      break;
    }

    state = { ...state, current_phase: next };
    // v15.10 stack stale-detection fix: greenfield'de state OLUŞUMUNDA dizin boş
    // olduğu için detectStack "unknown" döner; codegen (Faz 5/8) manifest'i
    // yarattıktan sonra YENİDEN tespit edilmezse Faz 10-15 mekanik kalite-
    // gate'leri "profile_resolve_null" ile SESSİZCE atlanır (lint/test/güvenlik
    // hiç koşmaz). Stack "unknown"/eksikse her ilerlemede deterministik yeniden
    // tespit (ucuz + idempotent); çözülünce kalıcı. Mevcut projelerde (FIX/DEV)
    // zaten doğru tespit edilir → no-op.
    if (!state.stack || state.stack === "unknown") {
      const freshStack = detectStack(state.project_root);
      // String() — detectStack runtime'da "unknown" dönebilir; tip görünümü
      // dışlasa da güvenli karşılaştırma.
      if (String(freshStack) !== "unknown" && freshStack !== state.stack) {
        state = { ...state, stack: freshStack };
        emitChatMessage(
          "system",
          `🧭 Proje stack'i tespit edildi: **${freshStack}** — mekanik kalite gate'leri (lint/test/…) bu profile göre çalışacak.`,
        );
        log.info("orchestrator", "stack re-detected post-codegen", {
          stack: freshStack,
          phase: next,
        });
      }
    }
    runtime.state = state;
    await saveState(state);
    // v15.6: faz değişti — NDJSON metadata bağlamını da güncelle
    setRecordContext({ phase: next });
    emitPhaseChanged(cur, next, "running");
    log.info("orchestrator", "phase advance", { from: cur, to: next });

    // YZLLM (cave5): ENTEGRE (foreign-origin) projede Faz 6 (UI İncelemesi) ATLANIR. Gap-task'lar UI-yapımı
    // değil (test/güvenlik/parmak-izi vb.); mevcut projede manuel UI-inceleme park'ı uygun değil + dev-server
    // çoğu zaman yok (mevcut projenin kendi toolchain'i). Bu, "Faz 6 ASLA atlanmaz" katı kuralının BİLİNÇLİ
    // entegre-mod istisnasıdır (kullanıcı açıkça istedi). phase-6-complete audit'i KORUNUR (sonraki gate'ler bekler).
    if (next === 6 && state.origin === "foreign") {
      await appendAuditModule(state.project_root, {
        ts: Date.now(),
        phase: 6,
        event: "phase-6-skipped-integrate",
        caller: "mycl-orchestrator",
        detail: "origin=foreign → entegre modunda UI incelemesi atlanır",
      });
      await appendAuditModule(state.project_root, {
        ts: Date.now(),
        phase: 6,
        event: "phase-6-complete",
        caller: "mycl-orchestrator",
      });
      emitChatMessage(
        "system",
        "Faz 6 (UI İncelemesi) atlandı — entegre modunda yapılmaz (mevcut projede boşluk işleri UI yapımı değil; sürdürülüyor).",
      );
      log.info("orchestrator", "phase 6 skipped (integrate mode)", { origin: state.origin });
      cur = 6 as PhaseId;
      continue;
    }
    // v15.6 (2026-05-24): Faz kapsamı (needed_phases) — Faz 3 LLM önerisini
    // kullanıcı onayladıysa state.needed_phases set; opsiyonel fazlar
    // (5/6/7/8) kapsam dışında ise sessizce atlanır + audit event.
    if (isPhaseSkippedByScope(state, next)) {
      await appendAuditModule(state.project_root, {
        ts: Date.now(),
        phase: next,
        event: `phase-${next}-skipped-by-scope`,
        caller: "mycl-orchestrator",
        detail: `needed_phases=${state.needed_phases?.join(",") ?? ""}`,
      });
      await appendAuditModule(state.project_root, {
        ts: Date.now(),
        phase: next,
        event: `phase-${next}-complete`,
        caller: "mycl-orchestrator",
      });
      emitChatMessage("system", `Faz ${next} atlandı — bu iterasyonda gerekli değil.`);
      log.info("orchestrator", "phase skipped by scope", { phase: next });
      cur = next;
      continue;
    }

    const spec = getSpec(next);
    if (!spec) {
      // Controller yok — deterministik skip stub: skipped + complete audit.
      await appendAuditModule(state.project_root, {
        ts: Date.now(),
        phase: next,
        event: `phase-${next}-skipped`,
        caller: "mycl-orchestrator",
      });
      await appendAuditModule(state.project_root, {
        ts: Date.now(),
        phase: next,
        event: `phase-${next}-complete`,
        caller: "mycl-orchestrator",
      });
      log.info("orchestrator", "phase skipped (no controller)", { phase: next });
      cur = next;
      continue;
    }

    // Spec var — controller başlat. Token kovasını bu faz için aç (turn'ler
    // recordTokenUsage üzerinden buraya akar; bir sonraki loop başında flush).
    beginPhaseCost(next, state.iteration_count ?? 1);
    if (next === 2) {
      const p2 = new Phase2Controller({ state, config: cfg, spec });
      const r = await runController(p2, () => p2.run(), "Hassasiyet denetleniyor");
      log.info("orchestrator", "phase 2 end", { result: r });
      if (r === "complete") {
        state = { ...state, ...p2.statePatch };
        runtime.state = state;
        await saveState(state);
        emitChatMessage(
          "system",
          "Faz 2 tamamlandı — niyet 8 boyutta zenginleştirildi.",
        );
        await recordPhaseComplete(2);
        cur = 2;
        continue;
      } else if (r === "abandoned") {
        // Kullanıcı compliance check sonrası vazgeçti — kalıcı kayıt + state
        // reset (handleUserMessage'daki wasPipelineCompleted pattern'ine
        // paralel). iteration_count artırılmaz; sadece tamamlanan iterasyonlar
        // sayılır.
        const prevIter = state.iteration_count ?? 1;
        const reason = p2.abandonInput?.reason ?? "";
        const concerns = p2.abandonInput?.concerns ?? [];
        await appendAbandonedIntent(state.project_root, {
          ts: Date.now(),
          iteration: prevIter,
          phase: 2,
          intent: state.intent_summary ?? "",
          concerns,
          reason,
        });
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 2,
          event: `iteration-${prevIter}-abandoned`,
          caller: "user",
          detail: reason.slice(0, 200),
        });
        // Niyet vazgeçildi — varsa ayakta dev server'ı temiz kapat (orphan önle).
        stopActiveDevServer(state);
        // v15.7 (2026-05-27): R2-01 — pending_* alanları reset listesine
        // alındı. Phase 2 abandon → Phase 1'e döner ama eski iterasyon'dan
        // pending_ui_tweak/backend_fix/migrations/diagnostic sızabilir.
        state = {
          ...state,
          current_phase: 1,
          spec_approved: false,
          spec_hash: undefined,
          tdd_compliance_score: undefined,
          dev_server_pid: undefined,
          intent_summary: undefined,
          intent_summary_raw: undefined,
          pending_ui_tweak: undefined,
          ui_tweak_count: undefined,
          pending_backend_fix: undefined,
          pending_migrations: undefined,
          pending_diagnostic: undefined,
          pending_realapp_verify: undefined,
          needed_phases: undefined,
          needed_phases_proposed: undefined,
          updated_at: Date.now(),
        };
        runtime.state = state;
        await saveState(state);
        syncNeededPhases(); // kapsam sıfırlandı (niyet vazgeçildi) → vurgulama kalksın
        emitChatMessage(
          "system",
          "🛑 Niyet vazgeçildi. Faz 1'e dönüldü; yeni mesajla başlayabilirsin.",
        );
        emitPhaseChanged(2, 1, "complete");
        return;
      } else {
        await failPhase(2, p2);
        return;
      }
    }
    if (next === 3) {
      const p3 = new Phase3Controller({ state, config: cfg, spec });
      const r = await runController(p3, () => p3.run(), "Mühendislik brifingi hazırlanıyor");
      log.info("orchestrator", "phase 3 end", { result: r });
      if (r === "complete") {
        state = { ...state, ...p3.statePatch };
        runtime.state = state;
        await saveState(state);
        emitChatMessage("system", "Faz 3 tamamlandı — mühendislik brifi onaylandı.");
        // v15.6: LLM önerisi kullanıcıya doğrulatılır. needed_phases_proposed
        // brief.md'de zaten gösterildi (LLM pitch'inde de bahsedildi). Burada
        // explicit scope askq emit et — kullanıcı override edebilir veya
        // tüm fazları çalıştırabilir. Loop'tan çık; askq cevabı geldiğinde
        // handleAskqAnswer pendingPhaseScope branch'ı advanceToNextPhase(3)
        // tekrar çağırır.
        const proposed = state.needed_phases_proposed;
        if (proposed && proposed.length > 0) {
          const phaseList = proposed
            .map((p) => `Faz ${p}`)
            .join(", ");
          if (autoAnswerSuggested("safe-flow", { isApproval: true })) {
            // Oto-cevap (YZLLM 2026-06-15): faz-kapsam askq'si qa-askq dışı DOĞRUDAN emit →
            // autoAnswer'ı kaçırıyordu (47 dk takılma sebeplerinden biri). Açıksa "Önerilen
            // seti onayla"yı otomatik seç; askq'yi UI'a göstermeden fall-through ile devam et.
            // Kategori (YZLLM 2026-07-08): faz-kapsam = plan seçimi (kod yazmaz) → safe-flow (foreign'de de oto).
            // (manuel "Önerilen seti onayla" handler'ıyla birebir: needed_phases=proposed).
            emitChatMessage(
              "system",
              `🤖 Oto-cevap (otomatik onay): "✅ Önerilen seti onayla" — ${phaseList}`,
            );
            state = {
              ...state,
              needed_phases: proposed,
              needed_phases_proposed: undefined,
              updated_at: Date.now(),
            };
            runtime.state = state;
            await saveState(state);
            syncNeededPhases(); // kapsam onaylandı (oto-cevap) → kapsam-dışı opsiyoneller soluk
            // fall-through → recordPhaseComplete(3) + cur=3 + continue
          } else {
            // ── CEVAP-HATIRLAMA MERDİVENİ (Faz 3 kapsam, YZLLM 2026-07-03): aynı önerilen-faz-seti tekrar
            // gelirse önceki kararı hatırla → Kademe 3 (onaylı) oto-uygula, yoksa Kademe 2 "aynısını kullanayım
            // mı?" onayı, kayıt yoksa Kademe 1 normal soru. (Oto-cevap dalı yukarıda ayrı ele alındı.)
            const key = phaseScopeKey(proposed);
            const recalled = await recallAnswer(state.project_root, key).catch(() => null);
            if (recalled) {
              const apply = () => applyRecalledPhaseScope(proposed, recalled);
              const fresh = async () => emitPhaseScopeAskq(proposed);
              if (recalled.reuseApproved && !recalled.sensitive) {
                emitChatMessage(
                  "system",
                  `♻️ Faz 3 kapsam sorusu yine geldi — önceki kararını uyguluyorum: **${recalled.answer}**`,
                );
                await appendAuditModule(state.project_root, {
                  ts: Date.now(),
                  phase: 3,
                  event: "answer-recall-auto",
                  caller: "mycl-orchestrator",
                  detail: recalled.answer.slice(0, 160),
                }).catch(() => {});
                await apply();
                return;
              }
              await appendAuditModule(state.project_root, {
                ts: Date.now(),
                phase: 3,
                event: "answer-recall-offer",
                caller: "mycl-orchestrator",
                detail: recalled.answer.slice(0, 160),
              }).catch(() => {});
              await emitReuseConfirmAskq({
                key,
                rec: recalled,
                intro: "Faz 3 kapsam sorusu yine geldi.",
                apply,
                fresh,
              });
              return;
            }
            emitPhaseScopeAskq(proposed);
            return;
          }
        }
        await recordPhaseComplete(3);
        cur = 3;
        continue;
      } else {
        await failPhase(3, p3);
        return;
      }
    }
    if (next === 4) {
      const p4 = new Phase4Controller({ state, config: cfg, spec });
      const r = await runController(p4, () => p4.run(), "Spec yazılıyor");
      log.info("orchestrator", "phase 4 end", { result: r });
      if (r === "complete") {
        await recordPhaseComplete(4);
        state = { ...state, ...p4.statePatch };
        runtime.state = state;
        await saveState(state);
        emitChatMessage("system", "Faz 4 tamamlandı — spec onaylandı.");
        cur = 4;
        continue;
      } else {
        await failPhase(4, p4);
        return;
      }
    }
    if (next === 5) {
      // v15.0 Batch E: structured signal `state.skip_ui_phases` (Phase 2
      // classifier ile set edildi) öncelikli; fallback olarak spec heuristic
      // `has_ui`. Library/cli/api/ml/game → skip_ui_phases=true → kesin skip.
      //
      // v15.7 (2026-05-27): R3-02 — Phase 0 D2 ui-only routing pending_ui_tweak
      // set ediyor; bu kullanıcı UI tweak istiyor demek. has_ui check'i bypass
      // et, yoksa tweak skip edilir ve kullanıcı boş çıkar.
      // ÖNDEN-ÇÖZ + KUŞKUDA FULL (2026-06-24 sistemik fix): Faz 5'i (UI build) yanlış atlamak YIKICI —
      // uygulama HİÇ kurulmaz (canlı kanıt: 50+ UI-terimli vanilla-HTML spec'i naif has_ui regex'i kaçırdı →
      // app yok, sonra boş build sahte-geçti). Eski koşul (skip_ui_phases || !hasUi) kırılgan kelime-regex'ine
      // YIKICI yetki veriyordu (eşleşme yok → atla). DÜZELTME: atlama YALNIZ güvenilir YAPISAL sinyalle olur
      // (classifier'ın skip_ui_phases: library/cli/api/ml/game). Belirsizlikte (project_type=unknown veya
      // web/desktop/mobile → skip_ui_phases=false) KOŞ (fail-open; Faz 5 no-UI spec'te zaten az/no-op üretir,
      // atlamaktan güvenli). Regex artık SKIP kararı VERMEZ — yalnız POZİTİF override (specShowsUi): classifier
      // non-UI dese bile spec açıkça UI gösteriyorsa yine koş → iki yönlü classifier-hata koruması. OR→AND.
      const specShowsUi = await shouldRunMechanical(state.project_root, "has_ui"); // pozitif sinyal (regex eşleşmesi)
      const tweakRequested = !!state.pending_ui_tweak;
      if (!tweakRequested && state.skip_ui_phases && !specShowsUi) {
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 5,
          event: "phase-5-skipped",
          caller: "mycl-orchestrator",
          detail: `classifier_skip project_type=${state.project_type ?? "unknown"} (spec'te de UI işareti yok)`,
        });
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 5,
          event: "phase-5-complete",
          caller: "mycl-orchestrator",
        });
        emitChatMessage(
          "system",
          `Faz 5 atlandı — proje tipi UI gerektirmiyor (${state.project_type ?? "?"}) ve spec'te de UI işareti yok.`,
        );
        cur = 5;
        continue;
      }
      const p5 = new Phase5Controller({ state, config: cfg, spec });
      const r = await runController(p5, () => p5.run(), "UI yazılıyor");
      log.info("orchestrator", "phase 5 end", { result: r });
      if (r === "complete") {
        // Dev server pid statePatch'inden state'e taşı (zombi koruma için).
        state = { ...state, ...p5.statePatch };
        runtime.state = state;
        await saveState(state);
        emitChatMessage("system", "Faz 5 tamamlandı — UI hazır.");
        await recordPhaseComplete(5);
        cur = 5;
        continue;
      } else {
        await failPhase(5, p5);
        return;
      }
    }
    if (next === 6) {
      // YZLLM 2026-06-20 (samsung_BO canlı, KATI KURAL): Faz 6 YALNIZ structured classifier
      // (skip_ui_phases) ile atlanır. Eski `|| !hasUi` (spec-keyword heuristik) GÜVENİLMEZDİ —
      // Faz 5 UI kurmuşken (skip_ui_phases=false) Faz 6 atlanıyor, app açılmıyor + inceleme
      // sorulmuyordu. Artık UI'lı projede Faz 6 ASLA atlanmaz/oto-geçilmez → MUTLAKA kullanıcıdan
      // inceleme ister + uygulamayı açar (phase-6 ensureDevServerForReview).
      if (state.skip_ui_phases) {
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 6,
          event: "phase-6-skipped",
          caller: "mycl-orchestrator",
          detail: `classifier_skip project_type=${state.project_type ?? "unknown"}`,
        });
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 6,
          event: "phase-6-complete",
          caller: "mycl-orchestrator",
        });
        emitChatMessage(
          "system",
          `Faz 6 atlandı — proje tipi UI gerektirmiyor (${state.project_type ?? "?"}).`,
        );
        cur = 6;
        continue;
      }
      // Phase 6 DEFERRED mode : controller askq
      // açmaz, hemen "deferred" döner; current_phase Faz 6'ya GEÇİLİRKEN (yukarıda)
      // set+persist edilmiştir + outer loop STOP. User'ın bir sonraki composer
      // mesajı router'da Phase 6 context'inde işlenir (approve_ui/revise_ui/cancel).
      const p6 = new Phase6Controller({ state, config: cfg, spec });
      let r: "deferred";
      try {
        r = await runController(p6, () => p6.run(), "UI inceleniyor");
      } catch (e) {
        // Yeniden-inceleme #1/#9: Faz 6 controller ÇÖKTÜ (deferred-park DEĞİL —
        // restart/spawn/disk I/O throw'u). pending_ui_review'i SET ETME (kuyruk işi
        // bunu görmesin → orphan-drop devreye girer, Faz 7/8 ile simetrik). Görünür
        // hata + failPhase (sessiz kilit YOK; error-analysis askq'a düşer).
        emitError("Faz 6 UI incelemesi başlatılamadı", e);
        await failPhase(6, p6);
        return;
      }
      log.info("orchestrator", "phase 6 end", { result: r });
      // Phase 6 dev server'ı (boot-resume'da Faz 5 spawn atlandığı için ölü
      // olabilir) yeniden başlatmış olabilir → güncel dev_server_pid'i persist
      // et. Deferred yol normalde state kaydetmez; statePatch boşsa no-op.
      // pending_ui_review=true: BAŞARILI deferred park işareti (isPipelineParked okur;
      // kuyruk işi bu işaret sayesinde orphan-drop'tan korunur). approve/revise/cancel'da
      // temizlenir. void r — deferred dışı sonuç bu yola gelmez.
      void r;
      // HİÇBİR ŞEY SORMA (YZLLM 2026-07-09): Faz 6 UI görsel-incelemesi normalde kullanıcı kararı gerektirir (park).
      // "Mutlak hiçbir şey sorma"da park ETME → a11y/görsel rapor p6.run()'da YUKARIDA GÖSTERİLDİ (LOUD, göstererek),
      // otomatik onayla + Faz 7'e ilerle (advanceToNextPhase — approve_ui yoluyla birebir). KATI #9 istisnası: YALNIZ mod
      // AÇIKKEN; mod kapalı varsayılanda Faz 6 hep kullanıcıya kalır (park). pending_ui_review SET EDİLMEZ.
      if (isNeverAsk()) {
        state = { ...state, ...p6.statePatch };
        runtime.state = state;
        await saveState(state);
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 6,
          event: "phase-6-complete",
          caller: "mycl-orchestrator",
          detail: "never_ask_auto_review",
        });
        emitChatMessage(
          "system",
          "🤖 Hiçbir şey sorma modu: Faz 6 UI incelemesi otomatik onaylandı (yukarıdaki erişilebilirlik raporu görünür) — Faz 7'e geçiliyor.",
        );
        await advanceToNextPhase(6);
        return;
      }
      state = { ...state, ...p6.statePatch, pending_ui_review: true };
      runtime.state = state;
      await saveState(state);
      // r === "deferred" — Header'a "YANIT BEKLENİYOR" durumunu yansıt + frontend
      // running banner'ı kapansın (waiting → banner null reducer'da).
      emitPhaseChanged(6, 6, "waiting");
      return;
    }
    if (next === 7) {
      // KÖK FİX (kod-analiz 2026-06-07): structured `state.has_database` ÖNCELİKLİ —
      // true→KOŞ, false→SKIP, undefined→spec.md heuristic. Eskiden `structuredSkip ||
      // !hasDbHeuristic` (OR) yüzünden LLM "DB VAR" (has_database===true) dese bile spec.md
      // regex'e takılmazsa (Mongo/Redis/NoSQL/"kayıt saklama") Faz 7 atlanıp DB şeması hiç
      // üretilmiyordu (sessiz kapsam kaybı — structured sinyalin geçersiz kılınması).
      let skipDb: boolean;
      let skipReason: string;
      if (state.has_database === true) {
        skipDb = false;
        skipReason = "";
      } else if (state.has_database === false) {
        skipDb = true;
        skipReason = "classifier_skip has_database=false";
      } else {
        const hasDbHeuristic = await shouldRunMechanical(
          state.project_root,
          "has_database",
        );
        skipDb = !hasDbHeuristic;
        skipReason = "no_database_in_spec";
      }
      if (skipDb) {
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 7,
          event: "phase-7-skipped",
          caller: "mycl-orchestrator",
          detail: skipReason,
        });
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 7,
          event: "phase-7-complete",
          caller: "mycl-orchestrator",
        });
        emitChatMessage(
          "system",
          state.has_database === false
            ? "Faz 7 atlandı — proje veritabanı kullanmıyor."
            : "Faz 7 atlandı — spec'te veritabanı yok.",
        );
        cur = 7;
        continue;
      }
      const p7 = new Phase7Controller({ state, config: cfg, spec });
      const r = await runController(p7, () => p7.run(), "Veritabanı tasarlanıyor");
      log.info("orchestrator", "phase 7 end", { result: r });
      if (r === "complete") {
        emitChatMessage("system", "Faz 7 tamamlandı — DB tasarımı onaylandı.");
        await recordPhaseComplete(7);
        cur = 7;
        continue;
      } else {
        await failPhase(7, p7);
        return;
      }
    }
    if (next === 8) {
      // Davranış-onay kapısı: var olan davranışı değiştirmeden önce kullanıcıya tek tek sor
      // (Faz 8 codegen BAŞLAMADAN). "Dur" derse pipeline durur (kullanıcı spec'i gözden geçirecek).
      if (!(await runBehaviorConsentGate(state, cfg))) return;
      // EDD (foreign): mevcut-davranış haritasını Faz 8 codegen notuna kur (consent kapısından hemen sonra; MyCL
      // kökeninde no-op). Codegen var olan kodu bilerek değiştirir (kanıtlı boşluk kapatma). Best-effort — bloke etmez.
      await attachEddCodegenNote(state);
      emitChatMessage(
        "system",
        "Faz 8 başlıyor — TDD codegen. Bu biraz sürebilir.",
      );
      const p8 = new Phase8Controller({ state, config: cfg, spec });
      let r: Awaited<ReturnType<typeof p8.run>>;
      try {
        r = await runController(p8, () => p8.run(), "TDD uygulanıyor");
      } finally {
        // Davranış-onay + EDD notu Faz 8'e özgü — tüketildi; sonraki fazlara/diske SIZMASIN (mahkeme #2). Throw'da da
        // temizlensin diye finally (tekil-koşum yoluyla simetri). Sonraki spread `{...state,...statePatch}` bunu korur.
        state.pending_behavior_consent_note = undefined;
        state.behavior_consent_no_paths = undefined;
        state.pending_edd_context_note = undefined;
      }
      log.info("orchestrator", "phase 8 end", { result: r });
      if (r === "complete") {
        await recordPhaseComplete(8);
        state = { ...state, ...p8.statePatch };
        runtime.state = state;
        await saveState(state);
        emitChatMessage(
          "system",
          `Faz 8 tamamlandı — TDD compliance ${state.tdd_compliance_score ?? "?"}/100.`,
        );
        cur = 8;
        continue;
      } else {
        await failPhase(8, p8);
        return;
      }
    }
    if (next === 9) {
      const p9 = new Phase9Controller({ state, config: cfg, spec });
      const r = await runController(p9, () => p9.run(), "Risk inceleniyor");
      log.info("orchestrator", "phase 9 end", { result: r });
      if (r === "complete") {
        // YZLLM 2026-06-13: Faz 9 "fix" kararlarını ilgili faza (5/7/8) yönlendirip otomatik düzelt,
        // sonra Faz 9'a dön (mini-döngü; current_phase 9'da kalır, Faz 6 araya girmez). Düzeltmeler
        // state'i değiştirebilir (codegen sonuçları, dev-server pid) → dönen state'i kullan.
        state = await dispatchRiskFixes(state, cfg, p9.riskDecisions);
        runtime.state = state;
        await recordPhaseComplete(9);
        emitChatMessage("system", "Faz 9 tamamlandı — risk incelemesi onaylandı.");
        cur = 9;
        continue;
      } else {
        await failPhase(9, p9);
        return;
      }
    }
    // Mechanical fazlar — generic runner ile dispatch.
    if (spec.type === "mechanical" && spec.mechanical_config) {
      const ok = await shouldRunMechanical(
        state.project_root,
        spec.mechanical_config.skip_unless,
      );
      if (!ok) {
        log.info("orchestrator", "mechanical phase skipped (gate)", {
          phase: next,
          reason: spec.mechanical_config.skip_unless,
        });
        const skipEvent =
          spec.required_audits.find((e) => e.endsWith("-skipped")) ??
          `phase-${next}-skipped`;
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: next,
          event: skipEvent,
          caller: "mycl-orchestrator",
          detail: `skip_unless=${spec.mechanical_config.skip_unless}`,
        });
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: next,
          event: `phase-${next}-complete`,
          caller: "mycl-orchestrator",
        });
        emitChatMessage(
          "system",
          `⏭ Faz ${next} atlandı — bu proje için gerekli koşul sağlanmadı.`,
        );
        cur = next;
        continue;
      }
      // v15.9 SCOPED MEKANİK GATE — ilk mekanik fazda değişen kapsamı bir kez
      // hesapla (fix/development; greenfield ilk build değilse). Scope'lanabilir
      // gate'ler (lint/güvenlik) değişen dosyalara daralır; scope'lanamayan
      // sistem-gate'leri (11/12/15/17) bu hızlı koşuda atlanıp tam taramaya bırakılır.
      // YZLLM 2026-06-14 "HİÇBİR FAZ YA DA ALT SÜRECİ ATLANAMAZ": scoped-gate (değişen-dosya daraltma + sistem-faz
      // atlama) DEVRE DIŞI — her gate TÜM PROJEYİ tarar, hiçbir faz atlanmaz. Eksik-kapsam = false-green riski
      // ("sessizlik = false pozitif"). changed_scope hiç set edilmez → SCOPED_SKIP_PHASES (Faz 11/12/15/17) tetiklenmez.
      const SCOPED_GATES_DISABLED = true;
      if (SCOPED_GATES_DISABLED) {
        // Tam kapsam — persisted changed_scope'u TEMİZLE (eski scoped koşudan kalmışsa SCOPED_SKIP_PHASES tetiklenip
        // Faz 11/12'yi atlamaya devam ediyordu). Boş → hiçbir faz atlanmaz + gate'ler tüm projeyi tarar.
        if (state.changed_scope) {
          state = { ...state, changed_scope: undefined };
          runtime.state = state;
          await saveState(state);
        }
      } else if (!scopeComputed && shouldComputeScope(state)) {
        scopeComputed = true;
        try {
          // YZLLM 2026-06-12: iteration_started_at → git yoksa audit-tabanlı non-git scope (yalnız değişen dosyalar).
          const sc = await computeChangedScope(state.project_root, state.fix_checkpoint_ref, state.iteration_started_at);
          if (sc.available && sc.files.length > 0) {
            state = {
              ...state,
              changed_scope: { files: sc.files, since: sc.since, computed_at: Date.now() },
              fix_checkpoint_ref: undefined,
            };
            runtime.state = state;
            await saveState(state);
            emitChatMessage(
              "system",
              `🎯 Scoped kalite: değişen ${sc.files.length} dosya + bağımlıları taranıyor; sistem gate'leri (sadeleştirme/perf/entegrasyon/load) tam taramaya bırakıldı.`,
            );
          } else if (state.fix_checkpoint_ref) {
            state = { ...state, fix_checkpoint_ref: undefined };
            runtime.state = state;
          }
        } catch (err) {
          log.warn("orchestrator", "değişen kapsam hesaplanamadı (full mod)", err);
        }
      }
      // Scope'lanamayan sistem-gate'leri scoped-touch modunda atla (tam taramada koşar).
      if (
        state.changed_scope &&
        state.changed_scope.files.length > 0 &&
        SCOPED_SKIP_PHASES.has(next)
      ) {
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: next,
          event: `phase-${next}-skipped`,
          caller: "mycl-orchestrator",
          detail: "scoped_run: tüm-sistem gate, tam taramada koşar",
        });
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: next,
          event: `phase-${next}-complete`,
          caller: "mycl-orchestrator",
        });
        emitChatMessage(
          "system",
          `⏭ Faz ${next} (${phaseLabelTR(next, spec)}) bu scoped koşuda atlandı — tüm sistem taraması büyük taramada koşar.`,
        );
        cur = next;
        continue;
      }

      // v15.7 (2026-05-25): Faz 16 (E2E) için Playwright feature toggle.
      // Settings → Özellikler → "Playwright" kapalıysa fazı atla.
      if (next === 16 && runtime.config?.features.playwright_enabled === false) {
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 16,
          event: "phase-16-skipped",
          caller: "mycl-orchestrator",
          detail: "playwright_disabled (Settings → Özellikler)",
        });
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 16,
          event: "phase-16-complete",
          caller: "mycl-orchestrator",
        });
        emitChatMessage(
          "system",
          "⏭ Faz 16 atlandı — Playwright özelliği Settings'ten kapatılmış.",
        );
        cur = 16;
        continue;
      }

      // v15.7 (2026-05-27): Faz 16 öncesi Playwright pre-step.
      // Install + scaffold (config + smoke test) garantilenir. Pre-step
      // proceed=false dönerse mechanical runner'ı koşturmadan skip + ilerle.
      if (next === 16) {
        const pre = await ensurePlaywrightForPhase16(state);
        if (!pre.proceed) {
          await appendAuditModule(state.project_root, {
            ts: Date.now(),
            phase: 16,
            event: "phase-16-skipped",
            caller: "mycl-orchestrator",
            detail: `precheck_fail reason=${pre.reason}`,
          });
          await appendAuditModule(state.project_root, {
            ts: Date.now(),
            phase: 16,
            event: "phase-16-complete",
            caller: "mycl-orchestrator",
          });
          cur = 16;
          continue;
        }
      }

      const passEvent = spec.required_audits[0] ?? `phase-${next}-pass`;
      const failEvent = spec.required_audits[1];

      // Faz 17 = SIZMA TESTİ (2026-08-03 güncel): pentest artık OTOMATİK koşar (hızlı profil — yalnız
      // yüksek/kritik açıklar, ~1-2 dk). Tam kapsamlı tarama 🛡️ butonunda kalır. Koşamazsa (araç yok,
      // uygulama kapalı) "phase-17-skipped" yazılır → özet "DOĞRULANMADI" der, asla "geçti" demez.
      if (next === 17) {
        const { status: pentestStatus, partial } = await runPhase17Pentest(state, cfg);
        disarmRollback();
        // `partial` (bulgu>0 veya timeout) → "soft_complete_after_fail" → verdict PARTIAL (sahte yeşil yok).
        // Bulgu varsa partial=true döner → "soft_complete_after_fail" → hüküm KISMİ (sahte yeşil yok).
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 17,
          event: "phase-17-complete",
          caller: "mycl-orchestrator",
          ...(partial ? { detail: "soft_complete_after_fail" } : {}),
        });
        // Son faz → "sonraki faz" yeşil-sinyali gelmez (sidebar mavi kalıyordu). Temiz→yeşil, değilse→error.
        emitPhaseChanged(17, 17, pentestStatus);
        cur = 17;
        continue;
      }

      // YZLLM 2026-07-03 (teker teker sor) — İNTERCEPT: bir Faz 13 finding'i fix'lendi + pipeline gate'e geri yürüdü.
      // Bulgu-kuyruğu aktif + rerun-bekliyor ise TAM güvenlik gate'ini yeniden koşma; sıradaki finding'i sor.
      // Kuyruk bitince (exhausted) düş → gate BİR kez koşar (final doğrulama). SIKI guard: yalnız next===13 +
      // awaitingRerun → kuyruksuz/normal Faz 13 yeniden-koşması DOKUNULMAZ (regresyon koruması).
      if (
        next === 13 &&
        runtime.findingQueue?.phase === 13 &&
        runtime.findingQueue.awaitingRerun &&
        runtime.findingQueue.project_root === state.project_root // GÜVENLİK: bayat/çapraz-proje kuyruk gate'i bypass etmesin
      ) {
        const r = await advanceFindingQueue();
        if (r === "asked") return; // sonraki bulguya park — güvenlik gate'i yeniden koşulmaz
        // "exhausted" → kuyruk temizlendi → aşağı düş, gate bir kez koşsun (tüm fix'lerden sonra final doğrulama)
      }

      const runner = new MechanicalRunnerBase({
        tag: `phase-${next}`,
        displayLabel: phaseLabelTR(next, spec),
        phaseId: next,
        state,
        mechanical: spec.mechanical_config,
        pass_event: passEvent,
        fail_event: failEvent,
        // v15.9: scoped-touch modunda değişen dosyalara daralt (boş → tüm-proje).
        // YZLLM 2026-06-12: "yalnız değişen dosyaları denetle" → gate'ler her zaman scoped (non-git scope dahil).
        changedScope: state.changed_scope?.files,
      });
      // YZLLM: "çalışırken ne yaptığını söylesin." Mekanik faz (lint/test/build — yavaş olabilir)
      // çalıştığı sürece sticky banner. try/finally → takılı spinner yok.
      emitPhaseRunning(phaseLabelTR(next, spec));
      let outcome;
      try {
        outcome = await runner.run();
      } finally {
        emitPhaseIdle();
      }
      log.info("orchestrator", `phase ${next} mechanical end`, {
        outcome: outcome.kind,
      });
      if (outcome.kind === "pass" || outcome.kind === "skipped") {
        // Faz GEÇTİ → iyi ilerlemeyi KİLİTLE: rollback noktasını temizle ki sonraki bir hatanın geri-alması
        // bu başarılı fazı UNDO etmesin (YZLLM: "veri kaybına yol açmayanı tercih ederim").
        disarmRollback();
        // Timeout-divert sayacını temizle: faz GERÇEKTEN geçti → gelecek bir timeout taze sayımla başlasın (her advance'te
        // değil, yalnız gerçek tamamlanışta — sonsuz-döngü emniyeti bozulmaz).
        timeoutRetried.delete(next);
        _autoAnswerChain = 0; // mekanik faz GERÇEKTEN geçti → otonom-cevap döngü sayacı sıfır (ilerleme).
        // Skipped (örn. missing command) akışı kırmaz — phase-N-complete
        // yazılır ki ardışık akış devam etsin. Runner zaten skip event'i
        // (phase-N-skipped) + sade Türkçe mesaj yazmış olur.
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: next,
          event: `phase-${next}-complete`,
          caller: "mycl-orchestrator",
        });
        // pass/skip mesajını runner zaten yazdı (Türkçe). v15.8 (2026-05-30):
        // Faz 16 (E2E) geçtiyse "geçti" yeterli değil — gerçekten ne
        // doğrulandığını dürüstçe ekle (yer tutucu test / giriş yapılmadı).
        if (outcome.kind === "pass" && next === 16) {
          await emitPhase16HonestyNote(state);
        }
        cur = next;
        continue;
      }
      // Güvenlik-baseline Unit 2: Faz 13 (Güvenlik) BLOCKING — soft-complete YAZMA.
      // YZLLM kararı: güvenlik-gate-fail "TAMAMLANDI" demesin (MEDIUM dahil bloklar).
      // F1 analiz askq'ına yönlendir (Çöz / Kabul et devam / Tekrar analiz). security-fail
      // / csp-evaluator-fail / semgrep-*-fail event'lerini runner zaten yazdı → harness
      // bunları *-fail görür. Akış DURUR; "Kabul et, devam et" cevabı handleAskqAnswer'da
      // phase-13-complete (security_accepted_by_user) yazıp advanceToNextPhase(13) ile
      // sürdürür (takılma yok — kullanıcı override edebilir).
      if (next === 13) {
        emitPhaseChanged(13, 13, "error");
        // YZLLM 2026-06-11 ("Faz 11/13'teydim niye Faz 8'e döndü"): Faz 13 güvenlik bulgusunu ÖNCE FAZIN İÇİNDE
        // odaklı-minimal düzelt + Faz 13'ü YENİDEN doğrula (diğer mekanik gate'ler gibi). Çözülürse Faz 8'e/codegen'e
        // HİÇ dönmez (8→9→…→13 yeniden-koşma yok). Yalnız Oto-cevap açıkken + bir kez (gateAutofixTried).
        // HİÇBİR ŞEY SORMA (YZLLM 2026-07-09 "foreign'de göster+oto-uygula"): autoAnswerSuggested() foreign'de de true →
        // gate-autofix foreign'de AÇIK. runGateAutofix çağrısından önce/sonra foreign+never-ask'ta dokunulan davranış
        // GÖSTERİLİR (aşağıda emitForeignAutoFixNotice); mahkeme escalate/proceed korumaları aynen (fix riskliyse insansız
        // accept-continue LOUD).
        if (
          outcome.kind === "fail" &&
          autoAnswerSuggested() &&
          !gateAutofixTried.has(13) &&
          runtime.state &&
          runtime.config
        ) {
          gateAutofixTried.add(13);
          // ⚖️ MAHKEME (YZLLM 2026-06-22, "mahkeme EVRENSEL — küçükte olsa etkileri büyük"): Faz 13 güvenlik
          // = EN yüksek-risk alan; oto-düzeltmeden ÖNCE müfettiş BAĞLAYICI inceler (genel gate yolundaki kanıtlı
          // desen, Faz 13 terminaline uyarlandı). inspectGateFinding "Güvenlik" etiketinden highStakes=true türetir
          // → mahkemeRuling güvenlikte ASLA suppress etmez (sessiz-gömme=beter).
          //   proceed  = bulgu gerçek → oto-fix (müfettiş gerekçesi B5 ile fix'i besler).
          //   escalate = iki bilim insanı kuşkulu/false-positive → çalışan kodu "düzeltmeyle" BOZMA; oto-fix YOK,
          //              LOUD accept-continue (bulgu rapora yazılır, pipeline devam — frozen-goal: oto-modda insan
          //              BLOKLANMAZ). Flag KAPALI veya mahkeme hata → proceed (davranış aynen korunur, sıfır risk).
          let secMahkemeAction: MahkemeAction = "proceed";
          let secMahkemeGuidance: string | undefined;
          if (cfg.features.inspector_enabled) {
            try {
              const insp = await inspectGateFinding(cfg, {
                projectRoot: state.project_root,
                gateLabel: phaseLabelTR(13, spec),
                errors: outcome.stderr,
                highStakes: true, // YAPISAL: Faz 13 = güvenlik gate'i → kelime-regex'ine bağlı kalma
              });
              const ruling = mahkemeRuling(insp);
              if (ruling.convened) {
                // Güvenlik: suppress ASLA (savunmacı — highStakes regex'i kaçırsa bile) → escalate'e çevir.
                secMahkemeAction = ruling.action === "suppress" ? "escalate" : ruling.action;
                if (secMahkemeAction === "proceed") secMahkemeGuidance = ruling.summary;
                emitChatMessage("system", `⚖️ Mahkeme (Faz 13 güvenlik — ${secMahkemeAction}): ${ruling.summary}`);
                // TECRÜBE-RECORD (Parça 2): EFEKTİF aksiyonla (güvenlik-suppress→escalate=ders yok); proceed=gerçek-bulgu dersi.
                await recordMahkemeLesson({
                  projectRoot: state.project_root,
                  config: cfg,
                  signature: `${phaseLabelTR(13, spec)} ${outcome.stderr.slice(0, 100)}`,
                  problem: outcome.stderr,
                  result: insp,
                  ruling: { ...ruling, action: secMahkemeAction },
                  ts: Date.now(),
                });
              }
            } catch (e) {
              log.warn("orchestrator", "mahkeme Faz 13 incelemesi hata (yutuldu → proceed)", { error: String(e) });
              // EN KRİTİK bypass: güvenlik bulgusu mahkeme hatasında DENETİMSİZ geçiyor → mutlaka görünür.
              emitChatMessage("system", "⚖️ Mahkeme (Faz 13 GÜVENLİK incelemesi) erişilemedi — güvenlik bulgusu DENETİMSİZ geçti (proceed). En kritik bypass; raporu/bulguyu elle incele.");
            }
          }
          if (secMahkemeAction === "escalate") {
            // Müfettiş bulguyu kuşkulu/false-positive ilan etti → oto-fix YOK (çalışan kodu koru). LOUD accept-continue:
            // pipeline devam, bulgu rapora yazılır, insan bloklanmaz (Faz 13 oto-modda asla bloklamaz kuralı korunur).
            emitChatMessage(
              "system",
              "⚖️ Mahkeme: Faz 13 güvenlik bulgusu olası false-positive/kuşkulu — otomatik düzeltme YAPILMADI " +
                "(çalışan kod korundu), bulgu YUTULMADI rapora yazıldı; pipeline 'kabul et + devam' ile ilerliyor (incelemen raporda).",
            );
            const accId = `error_analysis_${randomUUID()}`;
            runtime.pendingErrorAnalysis = {
              id: accId,
              phase: 13,
              blocking: true,
              options: [OPT_ACCEPT_CONTINUE],
              solutions_tr: [],
              acceptContinuePhase: 13,
            };
            await handleAskqAnswer(accId, OPT_ACCEPT_CONTINUE).catch((e: unknown) =>
              log.error("orchestrator", "faz-13 mahkeme-escalate accept-continue failed", e),
            );
            return;
          }
          emitChatMessage(
            "system",
            "🔧 Faz 13 (Güvenlik) — bulguları fazın içinde düzeltiyorum + güvenliği yeniden doğruluyorum (Faz 8'e dönmeden).",
          );
          emitForeignAutoFixNotice("Faz 13 güvenlik düzeltmesi");
          const fixRan = await runGateAutofix(state, cfg, 13, phaseLabelTR(13, spec), outcome.stderr, secMahkemeGuidance);
          if (fixRan) {
            const reRunner = new MechanicalRunnerBase({
              tag: "phase-13",
              displayLabel: phaseLabelTR(13, spec),
              phaseId: 13,
              state,
              mechanical: spec.mechanical_config,
              pass_event: passEvent,
              fail_event: failEvent,
              // YZLLM 2026-06-12 "yalnız değişen dosyaları denetle" → re-verify de scoped (değişen dosyalar).
              changedScope: state.changed_scope?.files,
            });
            emitPhaseRunning(phaseLabelTR(13, spec));
            let reOutcome;
            try {
              reOutcome = await reRunner.run();
            } finally {
              emitPhaseIdle();
            }
            if (reOutcome.kind === "pass" || reOutcome.kind === "skipped") {
              disarmRollback();
              await appendAuditModule(state.project_root, {
                ts: Date.now(),
                phase: 13,
                event: "phase-13-complete",
                caller: "mycl-orchestrator",
                detail: "gate_autofix_resolved",
              });
              gateFailStreak.delete(13); // gate kendi içinde çözüldü (ilerleme) → döngü sayacı sıfır.
              emitChatMessage("system", "✅ Faz 13 kendi içinde düzeltildi — güvenlik geçti (Faz 8'e dönülmedi).");
              _securityFindingsPrev = null; // yakınsama-kırıcı sıfırla (güvenlik çözüldü)
              _securityNoProgress = 0;
              // Güvenlik düzeltmesi kodu değiştirdi → testleri bozmuş olabilir; regresyon guard (YZLLM 2026-06-12).
              const rg13 = await runRegressionGuard(state, cfg, 13);
              if (rg13.ran && rg13.pass === false) {
                outcome = { kind: "fail", rescans: 0, stderr: "regression-guard: security fix broke tests" };
                // continue ETME — aşağıdaki analiz/accept-continue regresyonu ele alsın.
              } else {
                cur = 13;
                continue;
              }
            } else {
              outcome = reOutcome; // hâlâ fail → güncel çıktıyla aşağıdaki analiz/accept-continue'a düş
            }
          }
        }
        let pending: PendingErrorAnalysis | null = null;
        // YZLLM 2026-06-14: "ASLA elle düzeltme önerme; güvenliği OTOMATİK düzelt." → Oto-cevap açıkken Faz 13 İNSANA
        // ASLA devretmez; çözülemezse OTOMATİK "kabul et + devam" (LOUD rapor — sessiz değil, bulgular yutulmaz).
        // Döngü-kırıcı TEK OTORİTE: security-convergence.ts bulgu-azalması (SAF + test'li; eski _securityAutoResolveCount
        // zombi sayacı mahkeme denetimi 2026-07-11'de kaldırıldı). Oto-cevap KAPALIYSA blocking-askq (insan kabul/yeniden-analiz).
        const auto = autoAnswerSuggested();
        // ENTEGRE (foreign) opt-in "ajan eminse otomatik düzelt" (YZLLM 2026-07-09): güvenlik-fix'i foreign'de de otomatik
        // uygula — AMA yalnız YAKINSARKEN (converging = bulgular azalıyor → döngü koruması) + EMİN'ken (analyzeAndAskError
        // best-çözüm seçebiliyorsa). Değilse KULLANICIYA sor (riski otomatik KABUL ETME — accept-continue foreign'de yok).
        const autoFixSec = isAutoAnswerEnabled();
        const secStep = stepSecurityConvergence(
          { prevFindings: _securityFindingsPrev, noProgress: _securityNoProgress },
          sumSecurityFindings(outcome.stderr),
        );
        _securityFindingsPrev = secStep.prevFindings;
        _securityNoProgress = secStep.noProgress;
        let secMaxedOut = false;
        if (auto && !secStep.converging) {
          // Merdiven KALDIRILDI (YZLLM 2026-06-16 "merdiven kullanmıcaz"): bulgular azalmıyorsa model yükseltme YOK →
          // doğrudan otomatik terminal (kabul + devam, LOUD — bulgular yutulmaz). Yakınsama-kırıcı (security-convergence)
          // korunur → sonsuz fix döngüsü yine önlenir; yalnız "daha güçlü modelle tekrar dene" basamağı kaldırıldı.
          secMaxedOut = true;
        }
        if (runtime.state && runtime.config && !secMaxedOut) {
          pending = await analyzeAndAskError(
            runtime.state,
            runtime.config,
            {
              phase: 13,
              message: "Faz 13 (Güvenlik) gate'i başarısız — otomatik düzeltiliyor.",
              detail: outcome.stderr,
              allowAcceptContinue: true,
              acceptContinuePhase: 13,
            },
            // autoResolve: non-foreign=auto (parite); entegre opt-in foreign=yalnız yakınsarken; HİÇBİR ŞEY SORMA foreign'de
            // auto=true → emin-fix oto-seçilir (göster+uygula: aşağıda if(auto) dalı foreign'de emitSecurityFixImpact gösterir).
            { autoResolve: autoFixSec && (auto || secStep.converging) },
          ).catch(() => null);
        }
        // (z.ai sağlayıcı-geçiş dalı 2026-07-16'da kaldırıldı — Claude tükendiyse dürüst failPermanent.)
        // YZLLM 2026-07-03 (teker teker sor): triage >1 DISTINCT güvenlik sorunu bulduysa bulgu-kuyruğu kur.
        // analyzeAndAskError ZATEN finding[0]'ı emit etti (auto: auto_selected_solution + oto-mesaj; manuel:
        // finding[0] askq'si). Kuyruk index=0'dan başlar; finding[0]'a per-finding sig ata. Aşağıdaki dispatch
        // (auto veya kullanıcı seçimi) concrete-solution dalında awaitingRerun set eder → intercept sonraki
        // finding'e ilerletir; kuyruk bitince gate BİR kez yeniden koşar (final doğrulama). 1 finding → kuyruk yok.
        if (pending?.findings && pending.findings.length > 1) {
          const sigBase = `phase-13`;
          runtime.findingQueue = {
            phase: 13,
            project_root: state.project_root,
            findings: pending.findings,
            index: 0,
            sig_base: sigBase,
            acceptContinuePhase: 13,
            awaitingRerun: false,
            anyFixed: false,
            // Mahkeme blocker fix: bu turun yakınsama kararını kuyruğa taşı → TÜM bulgular (finding[0] değil) aynı
            // döngü/riski-kabul korumasıyla otomatik uygulanır (emitQueuedFinding → findingQueueAutoApply).
            converging: secStep.converging,
          };
          pending.sig = perFindingSig(sigBase, findingKey(pending.findings[0], 0));
          emitChatMessage(
            "system",
            `🔎 Güvenlik taraması ${pending.findings.length} ayrı sorun buldu — her birini ayrı ayrı soracağım (bu 1.'si; çözünce sonrakine geçeceğim).`,
          );
        }
        // HİÇBİR ŞEY SORMA (YZLLM 2026-07-09 "foreign'de göster+oto-uygula"): auto=autoAnswerSuggested() foreign'de de true →
        // bu blok foreign'de de çalışır. Emin-fix dalında FOREIGN'de emitSecurityFixImpact ile dokunulan davranış GÖSTERİLİR
        // (kör değil). Çözülemeyen dalı zaten LOUD accept-continue (görünür kabul + devam — kullanıcı "hiç sorma" dedi).
        // Non-foreign davranış BİREBİR (emin-fix VEYA otomatik accept-continue).
        if (auto) {
          // ELLE DÜZELTME YOK (YZLLM 2026-06-14): otomatik fix varsa uygula; yoksa OTOMATİK "kabul et + devam" (LOUD).
          if (pending?.auto_selected_solution) {
            runtime.pendingErrorAnalysis = pending;
            // HİÇBİR ŞEY SORMA foreign: uygulamadan ÖNCE dokunulan mevcut davranışı GÖSTER (kullanıcı kararı "göster+oto").
            if (state.origin === "foreign") await emitSecurityFixImpact(pending);
            await handleAskqAnswer(pending.id, pending.auto_selected_solution).catch((e: unknown) =>
              log.error("orchestrator", "faz-13 auto-solve routing failed", e),
            );
          } else {
            emitChatMessage(
              "error",
              `🔴 Faz 13: güvenlik ${secMaxedOut ? "en güçlü basamakta da " : ""}otomatik çözülemedi — bulgular YUTULMADI, rapora yazıldı; pipeline OTOMATİK "kabul et + devam" ile ilerliyor (elle düzeltme İSTENMEZ).` +
                (outcome.stderr ? `\n\n${outcome.stderr.slice(0, 700)}` : ""),
            );
            const accId = pending?.id ?? `error_analysis_${randomUUID()}`;
            runtime.pendingErrorAnalysis = pending ?? {
              id: accId,
              phase: 13,
              blocking: true,
              options: [OPT_ACCEPT_CONTINUE],
              solutions_tr: [],
              acceptContinuePhase: 13,
            };
            await handleAskqAnswer(accId, OPT_ACCEPT_CONTINUE).catch((e: unknown) =>
              log.error("orchestrator", "faz-13 auto-accept-continue failed", e),
            );
          }
          return;
        }
        // ENTEGRE opt-in (foreign, auto=false): oto-cevap açık + EMİN (analyzeAndAskError best-çözüm seçti) + YAKINSIYOR
        // → güvenlik fix'ini OTOMATİK uygula + neye dokunduğunu GÖSTER (emitSecurityFixImpact). accept-continue YOK
        // (riski otomatik kabul etmez); emin değil/yakınsamıyorsa auto_selected boş → bu dal atlanır → aşağıdaki
        // blocking-askq'ya düşer (kullanıcı KABUL/yeniden-analiz seçer). Non-foreign yukarıdaki `if (auto)` dalıyla işlendi.
        if (autoFixSec && pending?.auto_selected_solution && secStep.converging) {
          runtime.pendingErrorAnalysis = pending;
          await emitSecurityFixImpact(pending);
          await handleAskqAnswer(pending.id, pending.auto_selected_solution).catch((e: unknown) =>
            log.error("orchestrator", "faz-13 entegre auto-solve routing failed", e),
          );
          return;
        }
        // Oto-cevap KAPALI → blocking askq (insan KABUL/yeniden-analiz seçer; "elle DÜZELT" değil).
        if (!pending) {
          const fallbackId = `error_analysis_${randomUUID()}`;
          const gateOptions = [OPT_ACCEPT_CONTINUE, OPT_REANALYZE]; // tek tanım — pending + emitAskq + protected aynı liste
          pending = {
            id: fallbackId,
            phase: 13,
            blocking: true,
            options: gateOptions,
            solutions_tr: [],
            acceptContinuePhase: 13,
          };
          emitChatMessage(
            "error",
            "🔒 Faz 13 (Güvenlik) gate'i başarısız — çözülmeden TAMAMLANDI sayılmaz. Detay yukarıda.",
          );
          emitAskq({
            id: fallbackId,
            question: "Faz 13 güvenlik gate'i başarısız. Nasıl ilerleyelim?",
            options: gateOptions,
            // Güvenlik override (Kabul et, devam et) → never-ask'ta bile KULLANICI-ONLY (hook otonom seçemez).
            protected: askqOffersAcceptOverride(gateOptions),
          });
        }
        runtime.pendingErrorAnalysis = pending;
        return;
      }
      // 2026-06-10 (YZLLM: "bitirdiğin bir faz olan Faz 8'e geri dönmen saçma; debug'dan sonra döneceği yeri yanlış
      // hesaplamış"): KÖK SORUN — gate (örn. Faz 10 lint) fail olunca düzeltme plan_kind'a göre SABİT erken faza
      // (backend→Faz 7/8) route edilip TAMAMLANMIŞ Faz 8 yeniden koşuyordu. Doğrusu: hata HANGİ fazda çıktıysa düzeltme
      // ORADA yapılıp ORASI yeniden doğrulanır — geri dönüş yok. Bu yüzden HER mekanik gate fail'inde (yalnız fix_cmd'li
      // lint değil) önce FAZIN İÇİNDE odaklı-minimal düzeltme + gate'i YENİDEN koş. Bir deneme (gateAutofixTried);
      // olmazsa investigate+solve. (Faz 13 güvenlik yukarıda kendi dalında döner — buraya düşmez.)
      // 4c: gate-loop mahkemesinin escalate hükmünü yakala → failPhase'e taşı (aynı bulguyu iki kez inceleme).
      let gateLoopEscalateRuling: { action: MahkemeAction; summary: string } | undefined;
      if (
        outcome.kind === "fail" &&
        spec.type === "mechanical" &&
        autoAnswerSuggested() && // Oto-cevap açıkken otomatik düzelt; kapalıyken aşağıdaki failPhase askq açar
        !gateAutofixTried.has(next)
      ) {
        gateAutofixTried.add(next);
        // ⚖️ MAHKEME (YZLLM 2026-06-21, "fix kararlarını da bilim adamları versin"): müfettiş gate-bulgusunu
        // BAĞLAYICI inceler — gerçek mi false-positive mi. Eski gözlem-modu DEĞİL; hüküm akışı değiştirir:
        //   suppress = tartışma sonrası orkestratör-teslim → false-positive KANITLANDI → fix UYGULANMAZ, faz geçer.
        //   escalate = kuşku/yüksek-risk → otomatik fix YOK → aşağıdaki failPhase insana götürür.
        //   proceed  = bulgu gerçek → normal autofix. Flag KAPALIYSA hep proceed = davranış değişmez (sıfır risk).
        let mahkemeAction: MahkemeAction = "proceed";
        let mahkemeGuidance: string | undefined; // B5: proceed'de müfettiş gerekçesi fix'i besler
        if (cfg.features.inspector_enabled) {
          try {
            const insp = await inspectGateFinding(cfg, {
              projectRoot: state.project_root,
              gateLabel: phaseLabelTR(next, spec),
              errors: outcome.stderr,
            });
            const ruling = mahkemeRuling(insp);
            // TECRÜBE-RECORD (Parça 2): bu gate-mahkemesi kararını da derse çevir.
            await recordMahkemeLesson({
              projectRoot: state.project_root,
              config: cfg,
              signature: `${phaseLabelTR(next, spec)} ${outcome.stderr.slice(0, 100)}`,
              problem: outcome.stderr,
              result: insp,
              ruling,
              ts: Date.now(),
            });
            if (ruling.convened) {
              mahkemeAction = ruling.action;
              if (ruling.action === "proceed") mahkemeGuidance = ruling.summary; // B5: gerekçe fix'e taşınır
              // 4c: escalate → autofix ATLANIR (fixRan=false) → outcome DEĞİŞMEZ → aynı bulgu failPhase'de yeniden
              // incelenmesin; hükmü mechHolder'a taşı (aşağıda). proceed'de outcome autofix'le değişir → taşınmaz.
              if (ruling.action === "escalate") gateLoopEscalateRuling = { action: "escalate", summary: ruling.summary };
              emitChatMessage("system", `⚖️ Mahkeme (${ruling.action}): ${ruling.summary}`);
            }
          } catch (e) {
            // Mahkeme hatası → güvenli varsayılan proceed (mevcut davranış korunur; mahkeme akışı BOZMAZ).
            log.warn("orchestrator", "mahkeme gate-incelemesi hata (yutuldu → proceed)", { error: String(e) });
            emitChatMessage(
              "system",
              "⚖️ Mahkeme (gate incelemesi) erişilemedi — bulgu denetlenemedi. Gate ATLANMIYOR: bulgu normal " +
                "oto-düzeltme yoluna gidiyor ve kapı yeniden koşacak.",
            );
          }
        }
        if (mahkemeAction === "suppress") {
          // False-positive KANITLANDI (iki bilim insanı kanıtla hemfikir) → çalışan kodu "düzeltme"; faz geçti say.
          disarmRollback();
          await appendAuditModule(state.project_root, {
            ts: Date.now(),
            phase: next,
            event: `phase-${next}-complete`,
            caller: "mycl-orchestrator",
            detail: "mahkeme_false_positive_suppressed",
          });
          emitChatMessage(
            "system",
            `✅ Faz ${next} — mahkeme bulguyu false-positive ilan etti (çalışan kod korundu); geçti sayıldı.`,
          );
          cur = next;
          continue;
        }
        // escalate → autofix ATLANIR (fixRan=false) → aşağıdaki failPhase insana götürür. proceed → normal autofix.
        let fixRan = false;
        if (mahkemeAction === "proceed") {
          emitChatMessage(
            "system",
            `🔧 Faz ${next} (${phaseLabelTR(next, spec)}) — bildirilen hataları fazın içinde düzeltiyorum (bu fazın işi; debug'a kaçmadan).`,
          );
          emitForeignAutoFixNotice(`Faz ${next} (${phaseLabelTR(next, spec)}) otomatik düzeltmesi`);
          fixRan = await runGateAutofix(state, cfg, next, phaseLabelTR(next, spec), outcome.stderr, mahkemeGuidance);
        }
        if (fixRan) {
          // Gate'i YENİDEN koş — gerçekten geçti mi DOĞRULA (autofix "geçti" demez).
          const reRunner = new MechanicalRunnerBase({
            tag: `phase-${next}`,
            displayLabel: phaseLabelTR(next, spec),
            phaseId: next,
            state,
            mechanical: spec.mechanical_config,
            pass_event: passEvent,
            fail_event: failEvent,
            changedScope: state.changed_scope?.files,
          });
          emitPhaseRunning(phaseLabelTR(next, spec));
          let reOutcome;
          try {
            reOutcome = await reRunner.run();
          } finally {
            emitPhaseIdle();
          }
          if (reOutcome.kind === "pass" || reOutcome.kind === "skipped") {
            disarmRollback(); // geçti → iyi düzeltmeyi kilitle (sonra geri-alınmasın)
            await appendAuditModule(state.project_root, {
              ts: Date.now(),
              phase: next,
              event: `phase-${next}-complete`,
              caller: "mycl-orchestrator",
              detail: "gate_autofix_resolved",
            });
            gateFailStreak.delete(next); // gate kendi içinde çözüldü (ilerleme) → döngü sayacı sıfır.
            emitChatMessage("system", `✅ Faz ${next} kendi içinde düzeltildi — geçti.`);
            // YZLLM 2026-06-12: Faz 8 SONRASI (≥9) bir gate düzeltmesi kodu değiştirdi → testleri bozmuş olabilir.
            // Regresyon guard: tüm testleri yeniden koş; kırmızıysa bu faz fail'e döner (sessiz bozulma engellenir).
            if (next >= 9) {
              const rg = await runRegressionGuard(state, cfg, next);
              if (rg.ran && rg.pass === false) {
                outcome = { kind: "fail", rescans: 0, stderr: "regression-guard: fix broke tests" };
                // continue ETME — aşağıdaki investigate+solve bu regresyonu ele alsın.
              } else {
                cur = next;
                continue;
              }
            } else {
              cur = next;
              continue;
            }
          } else {
            // Hâlâ fail → güncel çıktıyla aşağıdaki investigate+solve'a düş.
            outcome = reOutcome;
          }
        }
      }
      // Gerçek mekanik fail → güvenlik (Faz 13) gibi investigate+solve akışına gider: failPhase → gerçek stderr ile
      // analiz → en iyi çözümü otomatik uygula. Döngü-kıran (aynı hata 2× → kullanıcıya sor; non-blocking'de
      // "kuyruğa al, devam et" seçeneği var → takılma yok). MyCL'in KENDİ bozuk aracı zaten yukarıda skip edildi.
      const mechHolder: FailReasonHolder = {
        lastFailReason:
          `Faz ${next} (${phaseLabelTR(next, spec)}) başarısız.` +
          (outcome.stderr ? `\n\nThe actual error output (diagnose THIS):\n${outcome.stderr.slice(0, 1500)}` : ""),
        // 4c: gate-loop escalate hükmü varsa (outcome değişmedi) → failPhase reuse etsin, aynı bulguyu yeniden
        // Sonnet müfettişe göndermesin. Yoksa (proceed→reOutcome / inceleme koşmadı) failPhase normal inceler.
        ...(gateLoopEscalateRuling ? { priorGateRuling: gateLoopEscalateRuling } : {}),
      };
      await failPhase(next, mechHolder);
      return;
    }

    // Bilinmeyen tip — henüz controller yok.
    emitChatMessage(
      "system",
      `Faz ${next} henüz uygulanmadı — akış burada duruyor.`,
    );
    return;
  }
}

/**
 * Tüm 17 fazın özet bilgisini UI'a yollar — Aşamalar sayfası için.
 * Her giriş: id, type, name_tr, name_en, has_controller, required_audits,
 * config (askq/production/mechanical).
 */
/** Tam-pipeline (1..17) token+süre öngörüsünü cost.jsonl geçmişinden hesapla + frontend'e yolla.
 * Faz 0 (debug) pipeline-dışı. Cost değişiminde (faz-sonu + load_costs) çağrılır. Best-effort (fail → sessiz geç,
 * öngörü kritik değil). Naif avg×17 yerine per-faz medyan + eksik-faz genel-medyan (cost-forecast.ts). */
async function emitCostForecast(projectRoot: string): Promise<void> {
  try {
    const costs = await readCosts(projectRoot);
    const pipelineIds = Array.from({ length: 17 }, (_, i) => i + 1); // 1..17 (Faz 0 hariç)
    emit("cost_forecast", { forecast: predictPipelineCost(costs, pipelineIds) });
  } catch (e) {
    log.warn("orchestrator", "cost forecast emit failed (non-blocking)", e);
  }
}

function handleListPhases(): void {
  const phases: Array<Record<string, unknown>> = [];
  // v15.3 pipeline 17 faza indirildi (Faz 5/19/20 silindi, 6-18 → 5-17 renumber).
  // Loop 1..17; Faz 0 (Debug Triage) standalone — sidebar'da gösterilmez.
  for (let n = 1 as 1 | 2; n <= 17; n++) {
    const id = n as PhaseId;
    const spec = PHASE_SPECS[id];
    phases.push({
      id,
      type: spec?.type ?? "unknown",
      name_tr: t(`phase.${id}.name`, "tr"),
      name_en: t(`phase.${id}.name`, "en"),
      has_controller: spec !== undefined,
      model_role: spec?.model_role ?? null,
      allowed_tools: spec?.allowed_tools ?? null,
      denied_paths: spec?.denied_paths ?? null,
      required_audits: spec?.required_audits ?? [],
      askq_config: spec?.askq_config ?? null,
      production_config: spec?.production_config ?? null,
      mechanical_config: spec?.mechanical_config ?? null,
      next_phase: PHASE_TRANSITIONS[id],
    });
  }
  emit("phases_list", { phases });
  syncNeededPhases(); // boot/resume: mevcut kapsam varsa PhaseSidebar baştan doğru vurgulasın
  log.info("orchestrator", "phases listed", { count: phases.length });
}

/**
 * Güvenlik/pentest bulgularını İŞ KUYRUĞUNA "sistem işi" olarak yazar (YZLLM 2026-06-19): her bulgu
 * (templateId'ye göre TEKİLLEŞTİRİLMİŞ → per-URL sel yok) `source="security"` + `from_phase=3` ile
 * eklenir → auto-drain her birini Faz 3'ten yeni iterasyon başlatıp sona kadar götürür (öncelik:
 * kritik→düşük). Bulgu yoksa no-op. Döndürür: eklenen iş sayısı.
 */
async function enqueueSecurityFindings(
  projectRoot: string,
  summary: DastSummary | undefined,
  origin: string,
): Promise<number> {
  if (!summary || summary.findings.length === 0) return 0;
  const unique = dedupeFindingsByTemplate(summary.findings);
  // 2026-07-30: dedupeFindingsByTemplate yalnız BU taramanın içinde tekilleştiriyordu → aynı zafiyet her
  // taramada yeni iş açıyordu. Artık kuyruğa karşı da tekilleştirilir (açık iş varsa tazelenir).
  let created = 0;
  for (const f of unique) {
    const dec = await enqueueSystemFixTask(projectRoot, findingToTaskText(f), "security", {
      kind: "security-finding",
      subject: f.templateId,
      // Öncelik şiddetten (kritik → önce) — eski davranış AYNEN korunuyor.
      priority: severityToPriority(f.severity),
    });
    if (!dec || dec.action === "create") created++;
  }
  await emitQueueChangedFor(projectRoot);
  const more = summary.total > summary.findings.length ? ` (nuclei toplam ${summary.total} bulgu raporladı; örneklem tekilleştirildi)` : "";
  if (created === 0) {
    emitChatMessage(
      "system",
      `🛡️ ${origin}: ${unique.length} bulgu — hepsi zaten iş kuyruğunda (yeni iş açılmadı, mevcut işler tazelendi).`,
    );
    return 0;
  }
  emitChatMessage(
    "system",
    `🛡️ ${origin}: ${created} benzersiz güvenlik bulgusu iş kuyruğuna **sistem işi** olarak eklendi${more} — ` +
      `her biri Faz 3'ten yeni bir iterasyon başlatıp sona kadar gidecek (öncelik kritik→düşük). ` +
      `Otomatik işlenir; durdurmak istersen **Duraklat**.`,
  );
  await kickWorkQueue();
  return unique.length;
}

/**
 * Coarse güvenlik fix-işi kuyruğa (bağımlılık-audit / SAST gibi exit-kodlu, per-bulgu detayı
 * olmayan taramalar için). DAST'ın per-bulgu enqueue'sinden farklı: tek "şu sınıfı gider" işi.
 */
async function enqueueSecurityFixTask(
  projectRoot: string,
  text: string,
  subject: string,
): Promise<void> {
  await enqueueSystemFixTask(projectRoot, text, "security", { kind: "security-class", subject });
}

/**
 * Sistem kaynaklı coarse fix-işi kuyruğa (güvenlik / Full Test / bakım turu ortak makinesi,
 * 2026-07-16). Kaynak rozeti panelde görünür; iş Faz 3'ten normal pipeline iterasyonu olur.
 */
async function enqueueSystemFixTask(
  projectRoot: string,
  text: string,
  source: "security" | "full-test" | "maintenance" | "verify-gap",
  /** TEKRAR ANAHTARI (2026-07-30): aynı bulgu ikinci kez iş açmasın. Verilmezse eski davranış (hep açar) —
   *  ama tüm çağıranlar verir; parametre opsiyonel kalması yalnız geriye uyum içindir. */
  dedup?: { kind: SystemTaskKind; subject: string; includeDone?: boolean; priority?: number },
): Promise<DedupAction | null> {
  let decision: DedupAction | null = null;
  if (dedup) {
    const key = systemTaskKey({ source, kind: dedup.kind, subject: dedup.subject });
    const existing = await readTasks(projectRoot).catch(() => []);
    decision = decideSystemTask({
      key,
      text,
      existing,
      includeDone: dedup.includeDone,
      maxRetries: MAX_TASK_AUTO_RETRIES,
    });
    if (decision.action === "refresh") {
      // YENİ İŞ AÇMA: aynı bulgu için ikinci kayıt kuyruğu şişirir (canlı cave: aynı iş 4 kez).
      // Bunun yerine mevcut işi TAZE kanıtla güncelle; deneme hakkı dolmuşsa canlandır (bulgu hâlâ gerçek).
      const refreshId = decision.taskId;
      const cur = existing.find((t) => t.id === refreshId);
      const seen = (cur?.seen_count ?? 1) + 1;
      await patchTask(projectRoot, decision.taskId, {
        seen_count: seen,
        last_fail: `yeniden tespit edildi (${seen}. kez): ${text.slice(0, 160)}`,
        ...(decision.revive ? { attempts: 0 } : {}),
        // Mahkeme düzeltmesi: bulgu şiddeti arttıysa (ör. orta → kritik) öncelik de yükselsin —
        // eskiden yalnız ilk tespitteki öncelik kalıyordu.
        ...(dedup.priority !== undefined && dedup.priority < (cur?.priority ?? Number.POSITIVE_INFINITY)
          ? { priority: dedup.priority }
          : {}),
      });
      await emitQueueChangedFor(projectRoot);
      if (decision.revive) {
        emitChatMessage(
          "system",
          `🔁 Bu bulgu hâlâ duruyor (${seen}. tespit) — kuyruktaki iş yeniden denenebilir yapıldı: ${text.slice(0, 120)}`,
        );
        await kickWorkQueue();
      }
      return decision;
    }
    if (decision.action === "skip") {
      // done (yalnız includeDone) → zaten kapatılmış; dropped → kullanıcı iptal etmiş, sessizce diriltme yok.
      if (decision.why === "cancelled") {
        emitChatMessage(
          "system",
          `ℹ️ Aynı bulgu yeniden çıktı ama bu işi daha önce iptal etmiştin — yeniden açmıyorum: ${text.slice(0, 120)}`,
        );
      }
      return decision;
    }
  }
  const task: TaskQueueItem = {
    id: randomUUID(),
    ts: Date.now(),
    text,
    priority: dedup?.priority ?? 2, // sistem bulgusu → yüksek öncelik (DAST: bulgu şiddetinden)
    status: "pending",
    source,
    from_phase: 3,
    ...(decision ? { dedup_key: decision.key, seen_count: 1 } : {}),
  };
  await appendTask(projectRoot, task);
  await emitQueueChangedFor(projectRoot);
  await kickWorkQueue();
  return decision;
}

/**
 * Faz 17 (YZLLM 2026-06-19 → 2026-06-22): otomatik sızma testi KALDIRILDI — bu fonksiyon pentest
 * KOŞMAZ, yalnız no-op bilgi mesajı basıp "complete" döner. Gerçek DAST (katana+nuclei, canlı dev
 * server + AKTİF tarama) artık YALNIZ 🛡️ Güvenlik Taraması butonuyla MANUEL çalışır
 * (handleRunDastRequest) — makine yükünü kullanıcı kontrol eder.
 */
async function runPhase17Pentest(
  state: State,
  _config: MyclConfig,
): Promise<{ status: PhaseStatus; partial: boolean }> {
  // YZLLM kararı 2026-08-03 (urun amaci: "hicbir katmanda guvenlik acigi olmasin"): sizma testi OTOMATIK
  // kosar — ama HIZLI profille. 2026-06-22'de makine yuku nedeniyle kaldirilmisti; geriye kosulsuz
  // "phase-17-complete" yazan bir kabuk kalmisti ve dogrulama ozeti bunu "gecti" gosteriyordu (HICBIR tarama
  // yapilmadan sahte yesil). Artik: kosar; kosamazsa GORUNUR atlama yazar (asla "gecti" demez).
  // Tam kapsamli tarama 🛡️ Guvenlik Taramasi butonunda kalir (kullanici kontrollu, tum siddetler).
  const plat = process.platform;
  // ONDEN COZ (KATI #6): bu faz OTOMATIK kosuyor → icinde AGIR is baslatmaz.
  //  - Arac KURULUMU denemez (brew/go install dakikalar surebilir + surpriz kurulum). Arac yoksa gorunur
  //    atlama yazar; mevcut "araci kur + kapiyi gercekten kostur" isi zaten OTOMATIK acilir (missing_command).
  //  - Dev sunucu AYAGA KALDIRMAZ: Faz 5 sonrasi uygulama zaten ayakta olmali (KATI #8). Ayakta degilse bu
  //    fazin isi degil — gorunur atlama yazar (uygulamanin calismamasi kendi yolunda ele alinir).
  // Bu sayede kosamadigi durumda faz saniyeler icinde ve DURUSTCE gecer.
  const devAlive = state.dev_server_pid ? await isProcessAlive(state.dev_server_pid) : false;
  const decision = decidePhase17({
    platform: plat,
    devServerAlive: devAlive,
    nucleiInstalled: toolInstalled("nuclei"),
    katanaInstalled: toolInstalled("katana"),
  });
  if (!decision.run) {
    // DURUSTLUK: artik skip olayi YAZILIR → dogrulama ozeti bu boyutu "DOGRULANMADI" gosterir,
    // "installable_gap" ise mevcut mekanizma "araci kur + kapiyi kostur" isini otomatik acar.
    await appendAuditModule(state.project_root, {
      ts: Date.now(),
      phase: 17,
      event: "phase-17-skipped",
      caller: "mycl-orchestrator",
      detail: decision.auditDetail,
    }).catch(() => {});
    emitChatMessage("system", decision.userMsg);
    return { status: "complete", partial: false };
  }
  emitChatMessage(
    "system",
    "🔪 Faz 17 — sızma testi koşuyor (hızlı profil: yalnız yüksek ve kritik açıklar, ~1-2 dk). " +
      "Tam kapsamlı tarama için 🛡️ Güvenlik Taraması butonunu kullanabilirsin.",
  );
  setPentestActive(true);
  let res;
  try {
    res = await runDast(state, { profile: "fast" });
  } finally {
    setPentestActive(false);
  }
  if (!res.ok) {
    // Tarama KOSAMADI (timeout / hedef yok / arac hatasi) → "gecti" DEME: gorunur atlama.
    await appendAuditModule(state.project_root, {
      ts: Date.now(),
      phase: 17,
      event: "phase-17-skipped",
      caller: "mycl-orchestrator",
      detail: `scan_failed ${res.error ?? ""}`.trim(),
    }).catch(() => {});
    emitChatMessage("system", `⚠️ Sızma testi tamamlanamadı — bu boyut DOĞRULANMADI.\n${res.summary_tr}`);
    return { status: "complete", partial: false };
  }
  const found = res.summary?.findings.length ?? res.findings_count ?? 0;
  if (found > 0) {
    emitChatMessage("system", res.summary_tr);
    await enqueueSecurityFindings(state.project_root, res.summary, "Faz 17 (hızlı sızma testi)");
    // partial=true → "soft_complete_after_fail" → hukum KISMI (sahte yesil yok).
    return { status: "complete", partial: true };
  }
  emitChatMessage("system", "✅ Sızma testi (hızlı profil) temiz — yüksek ya da kritik açık bulunamadı.");
  return { status: "complete", partial: false };
}

/**
 * WP4 DAST: 🛡️ buton handler'ı. SADECE açıklama + onay askq'ı açar — taramayı
 * BAŞLATMAZ (runDast'a referans yok). Tarama yalnız handleAskqAnswer'ın pendingDast
 * branch'inde "Başlat" seçilince çalışır → onay-baypası imkânsız. emitAskq doğrudan
 * çağrılır (qa-askq/auto-answer yolundan GEÇMEZ → Oto-cevap bu onayı otomatikleyemez).
 */
async function handleRunDastRequest(): Promise<void> {
  if (!runtime.state) {
    emitChatMessage(
      "error",
      "Önce bir proje aç — güvenlik taraması için çalışan bir uygulama gerekli.",
    );
    return;
  }
  if (runtime.pendingDast) {
    emitChatMessage("system", "Zaten bir güvenlik taraması onayı bekleniyor.");
    return;
  }
  const askqId = `dast_confirm_${randomUUID()}`;
  runtime.pendingDast = { askqId };
  emitChatMessage(
    "assistant",
    "🛡️ **Güvenlik Taraması (DAST)**: çalışan uygulamana AKTİF güvenlik testleri " +
      "(nuclei) gönderir — gerçek istekler atıp davranışı zorlayarak açık arar. " +
      "**Tüm projeyi tarar**: önce uygulamayı gezip (katana ile) tüm sayfa/route'ları " +
      "bulur, her birini test eder — yalnız ana sayfayı değil. **Yalnız localhost/127.0.0.1** " +
      "hedeflenir; üretim veya uzak sunucuya ASLA çalışmaz. Gezme gerçek GET istekleri attığı " +
      "için durumu değiştiren bağlantılar tetiklenebilir — `logout`/`delete`/`purge` gibi açıkça " +
      "yıkıcı görünen yollar güvenlik için atlanır, ama özel, durumu değiştiren GET endpoint'lerin " +
      "olabilir. Aktif test + tüm uygulamayı gezme nedeniyle geçici yük / yan etki olabilir ve tarama " +
      "birkaç dakika sürebilir (geliştirme ortamında çalıştır). Onaylıyor musun?",
  );
  emitAskq({
    id: askqId,
    question: "Aktif güvenlik taraması (yalnız localhost) — emin misin?",
    options: [DAST_START_LABEL, "İptal"],
    allow_other: false,
    multi_select: false,
  });
}

/**
 * 🧪 Full Test buton handler'ı (2026-07-16) — DAST deseni: SADECE açıklama + onay askq'ı açar.
 * Koşum yalnız handleAskqAnswer'ın pendingFullTest dalında "Başlat" seçilince → onay baypası imkânsız.
 * emitAskq doğrudan (auto-answer yolundan geçmez; id auto-answer.ts'te korumalı).
 */
async function handleRunFullTestRequest(): Promise<void> {
  if (!runtime.state) {
    emitChatMessage("error", "Önce bir proje aç — Full Test için bir proje gerekli.");
    return;
  }
  // MAHKEME CRITICAL (2026-07-16): Faz 6 incelemesi PARKTAYKEN Full Test görsel çekimleri
  // `.mycl/visual-pending`'i EZİYORDU → onayda kullanıcının gördüğü değil Full Test'in çektiği
  // görüntüler taban oluyordu. Parktayken görünür engelle (önce incelemeyi bitir).
  if (runtime.state.pending_ui_review) {
    emitChatMessage(
      "system",
      "👀 Şu an Faz 6 UI incelemesi bekleniyor — önce incelemeyi bitir (onayla/değişiklik iste), sonra Full Test'i çalıştır.",
    );
    return;
  }
  if (runtime.pendingFullTest) {
    emitChatMessage("system", "Zaten bir Full Test onayı bekleniyor.");
    return;
  }
  // MAHKEME (2026-07-22, iptal eşzamanlılığı merceği): Full Test ve Bakım Turu AYNI `runtime.fullTestAbort` +
  // tek global banner slotunu paylaşır → ikisi aynı anda koşarsa iptal düğmesi sessizce işlevsiz kalır ve banner
  // "boşta" derken arka planda iş sürer. Karşılıklı dışlama kaynağında kurulur (korumadan önce engelle — KATI #6).
  if (runtime.fullTestAbort) {
    emitChatMessage("system", "Şu an bir Full Test / Bakım Turu çalışıyor — bitmesini bekle ya da 'İptal'e bas, sonra yenisini başlat.");
    return;
  }
  if (runtime.pendingMaintenance) {
    emitChatMessage("system", "Bir bakım turu onayı bekleniyor — önce onu yanıtla, sonra Full Test'i başlat.");
    return;
  }
  const askqId = `full_test_confirm_${randomUUID()}`;
  runtime.pendingFullTest = { askqId };
  emitChatMessage(
    "assistant",
    "🧪 **Full Test**: tüm proje baştan sona test edilir — birim testleri, entegrasyon, " +
      "Playwright ile uçtan uca (E2E), tüm sayfaların taranması (konsol hataları, kırık istekler, " +
      "boş sayfa) ve **işlevsel doğrulama** (her belgelenmiş özelliğin gerçekten çalıştığı, mock'suz E2E ile). " +
      "Uygulama gerekirse başlatılır. Uzun sürebilir; koşarken buton **'İptal'e** döner. Bulunan sorunlar iş " +
      "kuyruğuna düzeltme işi olarak eklenir. Başlatayım mı?",
  );
  emitAskq({
    id: askqId,
    question: "Tüm proje test edilsin mi?",
    options: [FULL_TEST_START_LABEL, "İptal"],
    allow_other: false,
    multi_select: false,
  });
}

/**
 * 🔧 Bakım Turu buton/sohbet handler'ı (2026-07-16) — DAST deseni: SADECE açıklama + onay askq'ı
 * açar (bağımlılık YAZAN bir işlem — onay şart; sohbetten gelen run_maintenance aksiyonu da buraya
 * düşer, onayı ASLA baypas edemez). Koşum yalnız handleAskqAnswer pendingMaintenance dalında.
 */
async function handleRunMaintenanceRequest(): Promise<void> {
  if (!runtime.state) {
    emitChatMessage("error", "Önce bir proje aç — bakım turu için bir proje gerekli.");
    return;
  }
  // MAHKEME CRITICAL (2026-07-16): Faz 6 parkındayken bakım turunun Full Test kuyruğu görsel
  // pending'i ezer (Full Test ile aynı gerekçe) — parktayken görünür engelle.
  if (runtime.state.pending_ui_review) {
    emitChatMessage(
      "system",
      "👀 Şu an Faz 6 UI incelemesi bekleniyor — önce incelemeyi bitir, sonra bakım turunu çalıştır.",
    );
    return;
  }
  if (runtime.pendingMaintenance) {
    emitChatMessage("system", "Zaten bir bakım turu onayı bekleniyor.");
    return;
  }
  // MAHKEME (2026-07-22, iptal eşzamanlılığı): Bakım Turu da Full Test ile aynı `fullTestAbort`/banner slotunu
  // paylaşır (bakım içinde Full Test koşar) → karşılıklı dışlama (Full Test handler ile simetrik).
  if (runtime.fullTestAbort) {
    emitChatMessage("system", "Şu an bir Full Test / Bakım Turu çalışıyor — bitmesini bekle ya da 'İptal'e bas, sonra yenisini başlat.");
    return;
  }
  if (runtime.pendingFullTest) {
    emitChatMessage("system", "Bir Full Test onayı bekleniyor — önce onu yanıtla, sonra bakım turunu başlat.");
    return;
  }
  const askqId = `maintenance_confirm_${randomUUID()}`;
  runtime.pendingMaintenance = { askqId };
  emitChatMessage(
    "assistant",
    "🔧 **Bakım Turu**: önce güncel olmayan bağımlılıklar raporlanır; güvenliyse (kaydedilmemiş " +
      "değişiklik yoksa) bağımlılıklar mevcut sürüm aralığı içinde **muhafazakârca** güncellenir " +
      "(büyük sürüm atlaması yapılmaz), ardından güvenlik taramaları koşar ve **her zaman Full Test** " +
      "ile biter (birim + entegrasyon + Playwright + rota taraması). Sorunlar iş kuyruğuna düzeltme " +
      "işi olarak eklenir; güncelleme öncesi duruma dönüş noktası raporda verilir. Başlatayım mı?",
  );
  emitAskq({
    id: askqId,
    question: "Bakım turu (bağımlılık güncelleme + tarama + Full Test) başlasın mı?",
    options: [MAINTENANCE_START_LABEL, "İptal"],
    allow_other: false,
    multi_select: false,
  });
}

export async function handleAskqAnswer(
  id: string,
  selected: string | string[],
): Promise<void> {
  // v15.7 (2026-05-26): Askq snapshot'ını temizle — composer akışı artık
  // "active askq" görmemeli (cevap geldi).
  clearActiveAskq(id);
  // v15.7 (2026-05-26): Frontend askq UI'sını clear et — orkestratör answer_askq
  // ile programatik cevap verdiyse askq kartı kullanıcı için artık aktif değil.
  emitAskqResolved(id);
  const selectedText = Array.isArray(selected) ? selected.join(", ") : selected;

  // ── DAVRANIŞ-ONAYI (YZLLM 2026-07-03): var olan davranışı değiştirmeden önce "değiştir/dokunma" cevabı.
  // Kendi id öneki (behavior_consent_*) → en başta işlenir; kapının bellekteki çözücüsünü tetikleyip sıralı
  // tek-tek döngüyü ilerletir. isConsentAskqId ise diğer dallara DÜŞMEZ (bilinmeyen/eski id de sessizce tüketilir).
  if (isConsentAskqId(id)) {
    resolveConsentAnswer(id, selectedText);
    return;
  }

  // ── YABANCI-YAZMA ONAYI (YZLLM 2026-07-08): entegre projede MyCL var olan kodu değiştirmeden önce onay. Kendi id
  // öneki (foreign_write_consent_*) → kapının bellekteki çözücüsünü tetikler; diğer dallara DÜŞMEZ.
  if (isForeignWriteConsentAskqId(id)) {
    resolveForeignWriteConsent(id, selectedText);
    return;
  }

  // ── CEVAP-HATIRLAMA — Kademe 2 onay cevabı (YZLLM 2026-07-03): "aynı cevabı kullanayım mı?" → Evet/Hayır.
  // Kendi id öneki (answer_reuse_*) → diğer dallarla çakışmaz; en başta işlenir (kayıtlı cevabı uygular / taze döner).
  if (runtime.pendingAnswerReuse && runtime.pendingAnswerReuse.id === id) {
    await handleReuseConfirmAnswer(id, selectedText);
    return;
  }

  // Model yükseltme önerisi cevabı (YZLLM 2026-06-11): "Evet" → main + strong tier config'e yazılır + reload;
  // "Hayır" → bu oturumda tekrar sorma. Ayarlar tek doğruluk kaynağı; kabul edince config'e işlenir.
  if (_pendingModelUpgrade && id === _pendingModelUpgrade.askqId) {
    const model = _pendingModelUpgrade.model;
    _pendingModelUpgrade = null;
    const yes = /evet|geç|yes/i.test(selectedText);
    if (yes && runtime.config) {
      // Fix 2 (YZLLM 2026-06-13): persist'ten ÖNCE modelin GERÇEKTEN çağrılabilir olduğunu doğrula —
      // keşif uydurma/var-olmayan id (örn. "claude-mythos-5") önerebilir; doğrulamadan ana model
      // yapmak tüm codegen'i kırardı. Doğrulanamazsa GEÇME (kullanıcı Ayarlar'dan elle seçebilir).
      const cfg = runtime.config;
      const root = runtime.state?.project_root ?? process.cwd();
      emitChatMessage("system", `⏳ **${model}** doğrulanıyor (gerçekten çağrılabilir mi)…`);
      const callable = await verifyModelCallable(cfg, model, root);
      if (!callable) {
        emitChatMessage(
          "system",
          `⚠️ **${model}** doğrulanamadı (çağrı başarısız / model bulunamadı) — güvenlik için GEÇMEDİM, mevcut modelin korunuyor. Gerçekten geçmek istersen Ayarlar → Modeller'den elle seçebilirsin.`,
        );
        return;
      }
      const sel = cfg.selected_models;
      await persistSelectedModels({
        ...sel,
        main: model,
        model_tiers: { ...(sel.model_tiers ?? {}), strong: model },
      } as SelectedModels);
      runtime.config = null;
      await emitConfigStatus(); // reload + applyConfigDerivedSettings (restart'sız aktif)
      emitChatMessage("system", `✅ Main ajan + strong görevler artık **${model}** kullanıyor — ayarların güncellendi.`);
    } else {
      // Fix 1 (YZLLM 2026-06-13): bellek-içi (oturum) + KALICI (config) → bir daha asla sorma.
      _declinedModelUpgrades.add(model);
      await persistDeclinedModelUpgrade(model).catch((e) =>
        log.warn("orchestrator", "declined model upgrade persist fail (non-fatal)", e),
      );
      emitChatMessage("system", `👍 Tamam, ${model}'e geçmedim; mevcut modelin korunuyor. (Bir daha sormam.)`);
    }
    return;
  }
  // History persistence: askq seçimi user mesajı olarak yazılır.
  if (runtime.state?.project_root) {
    appendHistory(runtime.state.project_root, {
      ts: Date.now(),
      kind: "chat_message",
      data: { role: "user", text: selectedText },
    }).catch((err) => log.warn("orchestrator", "askq ans history fail", err));
  }

  // v15.6 (2026-05-24): Faz 3 sonrası iterasyon scope onayı.
  // pendingPhaseScope set ise üç seçenek:
  //  - "✅ Önerilen seti onayla" → state.needed_phases = proposed, devam
  //  - "⚙️ Tüm fazları çalıştır" → state.needed_phases = undefined (skip yok)
  //  - "Vazgeç" → scope set EDİLMEZ, pipeline durur (kullanıcı reset edebilir)
  if (
    runtime.pendingPhaseScope &&
    runtime.pendingPhaseScope.askqId === id &&
    runtime.state
  ) {
    const sel = (Array.isArray(selected) ? selected[0] : selected) ?? "";
    const cached = runtime.pendingPhaseScope;
    runtime.pendingPhaseScope = null;
    if (sel === "Vazgeç") {
      emitChatMessage(
        "system",
        "🛑 Faz kapsamı reddedildi — akış duruyor. Özeti değiştirmek için yeni mesaj yaz.",
      );
      return;
    }
    // ── CEVAP-HATIRLAMA (Faz 3 kapsam kaydı, YZLLM 2026-07-03): onay/tüm-fazlar kararını önerilen-faz-seti
    // anahtarına KALICI yaz → aynı set tekrar gelince "aynı cevabı kullanayım mı?" merdiveni. Vazgeç yukarıda
    // return etti (kaydedilmez). fromRecall (yeniden-uygulama) reuseApproved'ı sıfırlamasın diye KAYDETMEZ.
    if (!cached.fromRecall) {
      await recordAnswer(runtime.state.project_root, {
        key: phaseScopeKey(cached.proposed),
        phase: 3,
        answer: sel,
        answerKind: "fixed",
        scope: "phase-scope",
        sensitive: false,
      }).catch((e) => log.warn("orchestrator", "answer-memory (phase-scope) record fail (non-fatal)", e));
    }
    let newNeededPhases: number[] | undefined;
    let label: string;
    if (sel === "⚙️ Tüm fazları çalıştır") {
      newNeededPhases = undefined;
      label = "tüm fazlar";
    } else {
      // Default: "✅ Önerilen seti onayla" + her şey diğer
      newNeededPhases = cached.proposed;
      label = cached.proposed.map((p) => `Faz ${p}`).join(", ");
    }
    runtime.state = {
      ...runtime.state,
      needed_phases: newNeededPhases,
      needed_phases_proposed: undefined,
      updated_at: Date.now(),
    };
    await saveState(runtime.state);
    syncNeededPhases(); // kapsam onaylandı → PhaseSidebar çalışacak fazları belirgin, diğerlerini soluk gösterir
    emitChatMessage("system", `Kapsam onaylandı: ${label}. Akış devam ediyor.`);
    await advanceToNextPhase(3);
    return;
  }

  // WP4 DAST (2026-06-04): aktif güvenlik-tarama onay cevabı. GÜVENLİK-KRİTİK —
  // KATI üçlü eşleşme (pendingDast set + askqId === id + selected === Başlat); branch'e
  // girer girmez pendingDast=null (çift-tık/re-entrancy kapanır). runDast TEK buradan
  // çağrılır → onay-baypası imkânsız. "İptal"/başka → sessiz no-op (chat'e not).
  if (runtime.pendingDast && runtime.pendingDast.askqId === id) {
    runtime.pendingDast = null; // tek-kullanımlık: çift-cevap re-tetikleyemez
    const sel = (Array.isArray(selected) ? selected[0] : selected) ?? "";
    if (sel !== DAST_START_LABEL) {
      emitChatMessage("system", "Güvenlik taraması iptal edildi.");
      return;
    }
    if (!runtime.state) {
      emitChatMessage("error", "Proje kapandı — güvenlik taraması yapılamadı.");
      return;
    }
    const st = runtime.state;
    // Sticky "çalışıyor" banner'ı (buton spinner bundan türetilir) — try/finally
    // ile ZORUNLU kapanış (takılı spinner yok).
    emitPhaseRunning(DAST_RUNNING_LABEL, "nuclei — yalnız localhost");
    try {
      await appendAuditModule(st.project_root, {
        ts: Date.now(),
        phase: st.current_phase,
        event: "dast-run-start",
        caller: "user",
      }).catch(() => {});
      // İş 3 (YZLLM "güvenlik aracı atlanamaz"): taramadan ÖNCE araçları garanti et — yoksa KUR.
      // Kurulamazsa ensureSecurityTools görünür hata verir; tarama eksik koşar ama sahte-yeşil yok.
      await ensureSecurityTools(["nuclei", "katana", "semgrep"]);
      // 🛡️ Full Security (YZLLM "huzur butonu"): STACK-BAĞIMSIZ bağımlılık-audit (profil 'security')
      // + SAST (semgrep güvenlik/OWASP/secret) + aktif DAST pentest (tüm yüzey + GÜNCEL CVE)
      // ÜÇÜ PARALEL → tek birleşik hüküm. Hepsi temizse yeşil; biri bile değilse kırmızı.
      setPentestActive(true); // pentest trafiği watcher'a hata sayılmasın (flood+ısınma önle)
      const [dep, sast, res] = await Promise.all([
        runDependencyAudit(st),
        runSemgrepScans(st),
        runDast(st, { updateTemplates: true }), // ANA: autologin AÇIK → korumalı route'lar taranır
      ]).finally(() => setPentestActive(false));
      // LOGIN modülünü autologin BYPASS'lamadan test et (YZLLM): ikinci pass anonim (mycl_no_autologin)
      // → gerçek login/auth akışı bir saldırgan gözüyle taranır. Ana taramadan SONRA (dev server'ı
      // aynı anda iki crawl ile boğma).
      setPentestActive(true);
      const loginRes = await runDast(st, { noAutologin: true }).finally(() => setPentestActive(false));
      const loginFindings = loginRes.findings_count ?? 0;
      const loginLine = !loginRes.ok
        ? `• Login (autologin'siz): ${loginRes.summary_tr.split("\n")[0]}`
        : loginFindings === 0
          ? "• Login modülü (autologin'siz / anonim): ✅ bulgu yok"
          : `• Login modülü (autologin'siz / anonim): ⚠️ ${loginFindings} bulgu — fix gerek`;
      const fullClean =
        res.ok &&
        (res.findings_count ?? 0) === 0 &&
        loginRes.ok &&
        loginFindings === 0 &&
        (dep.clean || !dep.ran) &&
        sast.clean;
      emitChatMessage(
        fullClean ? "system" : "error",
        `🛡️ **Full Security**\n${dependencyAuditLine(dep)}\n${sastLine(sast)}\n${res.summary_tr}\n${loginLine}`,
      );
      await appendAuditModule(st.project_root, {
        ts: Date.now(),
        phase: st.current_phase,
        event: res.ok ? "dast-run-complete" : "dast-run-failed",
        caller: "mycl-orchestrator",
        detail:
          res.findings_count !== undefined
            ? `findings=${res.findings_count}`
            : (res.error ?? ""),
      }).catch(() => {});
      // YZLLM 2026-06-19: bulgular → iş kuyruğuna sistem işi → her biri Faz 3'ten iterasyon.
      // emitPhaseIdle finally'de; enqueue kickWorkQueue'yu çağırır (drain guard'lı, çakışmaz).
      if (res.ok) await enqueueSecurityFindings(st.project_root, res.summary, "Güvenlik Taraması");
      // Login (autologin'siz) bulgularını da kuyruğa — dedupeFindingsByTemplate çift saymaz.
      if (loginRes.ok) await enqueueSecurityFindings(st.project_root, loginRes.summary, "Güvenlik (login, autologin'siz)");
      // Bağımlılık + SAST (exit-kodlu, per-bulgu yok) → coarse fix-işi kuyruğa (medium/high kalmasın).
      if (dep.ran && !dep.clean) {
        await enqueueSecurityFixTask(
          st.project_root,
          `Bağımlılık zafiyetlerini gider — \`${dep.tool}\` eşik üstü (yüksek+) zafiyet bildirdi. İlgili paketleri güvenli sürüme güncelle; tarama temiz geçsin.`,
          "dependency-audit",
        );
      }
      for (const label of sast.findings) {
        await enqueueSecurityFixTask(
          st.project_root,
          `SAST güvenlik bulgularını gider (semgrep ${label}). Bulguları Faz 13/audit'ten oku, kök nedeni düzelt; yeniden tara temiz olsun.`,
          `sast:${label}`,
        );
      }
      // 2026-08-03: tarama tek başına dosya değiştirmez (genelde "taze" döner, maliyeti ~0);
      // ama tarama sonrası düzeltmeler koştuysa kılavuz da tazelenir.
      if (runtime.state && runtime.config) {
        await refreshDocsIfStale(runtime.state, runtime.config, { origin: "dast" }).catch(() => {});
      }
    } catch (err) {
      emitChatMessage(
        "error",
        `Güvenlik taraması başarısız: ${String(err).slice(0, 200)}`,
      );
    } finally {
      emitPhaseIdle();
    }
    return;
  }

  // 🧪 Full Test onayı (2026-07-16) — DAST dalının ikizi: KATI üçlü eşleşme + girer girmez
  // pendingFullTest=null (çift-tık/re-entrancy kapanır). Koşum TEK buradan tetiklenir.
  if (runtime.pendingFullTest && runtime.pendingFullTest.askqId === id) {
    runtime.pendingFullTest = null;
    const sel = (Array.isArray(selected) ? selected[0] : selected) ?? "";
    if (sel !== FULL_TEST_START_LABEL) {
      emitChatMessage("system", "Full Test iptal edildi.");
      return;
    }
    if (!runtime.state) {
      emitChatMessage("error", "Proje kapandı — Full Test yapılamadı.");
      return;
    }
    const st = runtime.state;
    emitPhaseRunning(FULL_TEST_RUNNING_LABEL, "birim + entegrasyon + E2E + rota + işlevsel doğrulama");
    // İptal denetleyicisi — Full Test lock TUTMAZ (handleAskqAnswer yolu); cancel_full_test IPC concurrent
    // çalışıp bunu abort eder. Faz controller'ından AYRI (o Full Test'e erişmez).
    const ac = new AbortController();
    runtime.fullTestAbort = ac;
    try {
      await appendAuditModule(st.project_root, {
        ts: Date.now(),
        phase: st.current_phase,
        event: "full-test-run-start",
        caller: "user",
      }).catch(() => {});
      const report = await runFullTest(st, {
        ensureDevServer: async () => {
          if (!runtime.config) return { ok: false };
          const dev = await ensureDevServerForReview(st, runtime.config);
          return { ok: dev.ok, port: dev.port };
        },
        ensureE2E: () => ensurePlaywrightForPhase16(st),
        ...makeFunctionalVerifyDeps(st, ac, FULL_TEST_RUNNING_LABEL),
      });
      emitChatMessage(report.ok ? "system" : "error", formatFullTestReport(report));
      await appendAuditModule(st.project_root, {
        ts: Date.now(),
        phase: st.current_phase,
        event: report.ok ? "full-test-run-complete" : "full-test-run-failed",
        caller: "mycl-orchestrator",
        detail: report.sections.map((s) => `${s.id}=${s.status}`).join(" "),
      }).catch(() => {});
      // Düşen çekirdek bölümler → iş kuyruğuna görünür fix işi (DAST bulgu deseni).
      for (const t of fixTasksFromReport(report)) {
        await enqueueSystemFixTask(st.project_root, t.text, "full-test", {
          kind: "full-test-section",
          subject: t.id,
        });
      }
      // 2026-08-03: Full Test kod değiştirmiş olabilir (fix işleri) → kılavuz bayatsa tazele.
      // Bayat değilse LLM çağrısı YOK (ucuz kontrol).
      if (runtime.state && runtime.config) {
        await refreshDocsIfStale(runtime.state, runtime.config, { origin: "full-test" }).catch(() => {});
      }
    } catch (err) {
      emitChatMessage("error", `Full Test başarısız: ${String(err).slice(0, 200)}`);
    } finally {
      runtime.fullTestAbort = null;
      emitPhaseIdle();
    }
    return;
  }

  // 🗺️ Plan onayı (2026-07-16) — korumalı askq (never-ask'ta bile açık onay; kullanıcının şartı).
  // Onay → her adım kuyruğa (source:"plan", priority=sıra) + kalıcı iz + drain; Düzenle → sonraki
  // mesaj revizyon geri bildirimi; Vazgeç → hiçbir şey eklenmez.
  if (runtime.pendingPlan && runtime.pendingPlan.askqId === id) {
    const { plan } = runtime.pendingPlan;
    runtime.pendingPlan = null; // tek kullanımlık (çift-cevap re-tetikleyemez)
    const sel = (Array.isArray(selected) ? selected[0] : selected) ?? "";
    if (!runtime.state) {
      emitChatMessage("error", "Proje kapandı — plan uygulanamadı.");
      return;
    }
    const root = runtime.state.project_root;
    if (sel === "✏️ Düzenle") {
      runtime.pendingPlanEdit = { plan };
      emitChatMessage("system", "✏️ Düzeltme talebini yaz — planı geri bildirimine göre güncelleyeceğim.");
      return;
    }
    if (sel !== "✅ Planı onayla") {
      emitChatMessage("system", "🗺️ Plan iptal edildi — hiçbir iş kuyruğa eklenmedi.");
      await appendAuditModule(root, {
        ts: Date.now(),
        phase: runtime.state.current_phase,
        event: "plan-rejected",
        caller: "user",
      }).catch(() => {});
      return;
    }
    const now = Date.now();
    const sorted = [...plan.steps].sort((a, b) => a.priority - b.priority);
    for (let i = 0; i < sorted.length; i++) {
      const step = sorted[i]!;
      await appendTask(root, {
        id: randomUUID(),
        ts: now + i, // stabil FIFO (intake deseni)
        text: step.text,
        priority: step.priority,
        status: "pending",
        source: "plan",
      });
    }
    const planPath = await persistPlan(root, plan);
    await appendAuditModule(root, {
      ts: Date.now(),
      phase: runtime.state.current_phase,
      event: "plan-approved",
      caller: "user",
      detail: `steps=${sorted.length}${planPath ? ` path=${planPath}` : ""}`,
    }).catch(() => {});
    await emitQueueChangedFor(root);
    emitChatMessage(
      "system",
      `✅ Plan onaylandı — ${sorted.length} adım iş kuyruğuna eklendi, sırayla uygulanıyor.` +
        (planPath ? ` (kalıcı iz: \`${planPath.replace(root + "/", "")}\`)` : ""),
    );
    await kickWorkQueue();
    return;
  }

  // 🔧 Bakım Turu onayı (2026-07-16) — Full Test dalının ikizi. Bakım motoru bulguları
  // burada kuyruğa döker (audit/SAST/Full Test), rapor + Full Test raporu tek mesajda.
  if (runtime.pendingMaintenance && runtime.pendingMaintenance.askqId === id) {
    runtime.pendingMaintenance = null;
    const sel = (Array.isArray(selected) ? selected[0] : selected) ?? "";
    if (sel !== MAINTENANCE_START_LABEL) {
      emitChatMessage("system", "Bakım turu iptal edildi.");
      return;
    }
    if (!runtime.state) {
      emitChatMessage("error", "Proje kapandı — bakım turu yapılamadı.");
      return;
    }
    const st = runtime.state;
    emitPhaseRunning(MAINTENANCE_RUNNING_LABEL, "güncelle + tara + Full Test");
    // İptal denetleyicisi — bakımın Full Test alt-adımı (işlevsel doğrulama) da iptal edilebilir (Full Test ile aynı seam).
    const ac = new AbortController();
    runtime.fullTestAbort = ac;
    try {
      await appendAuditModule(st.project_root, {
        ts: Date.now(),
        phase: st.current_phase,
        event: "maintenance-run-start",
        caller: "user",
      }).catch(() => {});
      const report = await runMaintenance(st, {
        ensureDevServer: async () => {
          if (!runtime.config) return { ok: false };
          const dev = await ensureDevServerForReview(st, runtime.config);
          return { ok: dev.ok, port: dev.port };
        },
        ensureE2E: () => ensurePlaywrightForPhase16(st),
        ...makeFunctionalVerifyDeps(st, ac, MAINTENANCE_RUNNING_LABEL),
      });
      const ok = report.fullTest.ok && !report.auditRed && report.sastFindings.length === 0;
      emitChatMessage(
        ok ? "system" : "error",
        `${formatMaintenanceReport(report)}\n\n${formatFullTestReport(report.fullTest)}`,
      );
      await appendAuditModule(st.project_root, {
        ts: Date.now(),
        phase: st.current_phase,
        event: ok ? "maintenance-run-complete" : "maintenance-run-failed",
        caller: "mycl-orchestrator",
        detail: report.sections.map((s) => `${s.id}=${s.status}`).join(" ") + ` fulltest=${report.fullTest.ok}`,
      }).catch(() => {});
      // Bulgular → kuyruk (source:"maintenance"): audit kırmızı + SAST etiketleri + Full Test düşenleri.
      if (report.auditRed) {
        await enqueueSystemFixTask(
          st.project_root,
          "Bağımlılık zafiyetlerini gider — bakım turu güncellemesi sonrası audit hâlâ eşik üstü zafiyet bildiriyor. Paketleri güvenli sürüme taşı; tarama temiz geçsin.",
          "maintenance",
          { kind: "maintenance-audit", subject: "dependency-audit" },
        );
      }
      for (const label of report.sastFindings) {
        await enqueueSystemFixTask(
          st.project_root,
          `SAST güvenlik bulgularını gider (semgrep ${label}). Bulguları audit'ten oku, kök nedeni düzelt; yeniden tara temiz olsun.`,
          "maintenance",
          { kind: "maintenance-sast", subject: label },
        );
      }
      for (const t of fixTasksFromReport(report.fullTest)) {
        await enqueueSystemFixTask(st.project_root, `Bakım turu sonrası ${t.text}`, "maintenance", {
          kind: "full-test-section",
          subject: `maintenance:${t.id}`,
        });
      }
      // 2026-08-03: bakım turu bağımlılıkları günceller (kod GERÇEKTEN değişir) ama kılavuzu hiç
      // tazelemiyordu → "her zaman güncel" sözü buradan sızıyordu.
      if (runtime.state && runtime.config) {
        await refreshDocsIfStale(runtime.state, runtime.config, { origin: "maintenance" }).catch(() => {});
      }
    } catch (err) {
      emitChatMessage("error", `Bakım turu başarısız: ${String(err).slice(0, 200)}`);
    } finally {
      runtime.fullTestAbort = null;
      emitPhaseIdle();
    }
    return;
  }

  // F1 (2026-06-04): Faz-fail sonrası LLM hata analizi askq cevabı.
  // runtime.pendingErrorAnalysis ile eşleşir (id="error_analysis_..."). Bu branch
  // controller-fallback'tan ("no active controller", aşağıda) ÖNCE gelmeli: loop
  // seam'inde runtime.controller fail'den ÖNCE null'a set edilir → cevap geldiğinde
  // controller null; pending eşlemesi olmasaydı "no active controller" hatası düşerdi.
  // Seçenek etiketleri error-analysis.ts'ten import edilen sabitler (string drift yok).
  if (
    runtime.pendingErrorAnalysis &&
    runtime.pendingErrorAnalysis.id === id &&
    runtime.state &&
    runtime.config
  ) {
    const cached = runtime.pendingErrorAnalysis;
    runtime.pendingErrorAnalysis = null;
    const sel = (Array.isArray(selected) ? selected[0] : selected) ?? "";
    // YZLLM 2026-07-03 (teker teker sor): bir bulgu-kuyruğu aktifse cevabı KUYRUK-DUYARLI yönlendir — sabit-etiketler
    // YALNIZ BU finding'e uygulanır (fazı TAMAMLAMAZ); somut çözüm → fix dispatch + intercept sonraki finding'e geçirir.
    if (runtime.findingQueue && runtime.findingQueue.phase === cached.phase && runtime.state) {
      const queue = runtime.findingQueue;
      const curFinding = queue.findings[queue.index];
      if (sel === OPT_STOP_MANUAL) {
        // TÜM kuyruğu durdur (kullanıcı elle inceleyecek): kalan finding'leri iş listesine yaz, kuyruğu temizle, park.
        for (let i = queue.index; i < queue.findings.length; i++) {
          await appendTask(runtime.state.project_root, {
            id: randomUUID(),
            ts: Date.now(),
            text: `Faz ${cached.phase} güvenlik bulgusu (elle inceleme): ${queue.findings[i].summary_tr}`,
            status: "pending",
            source: "manual",
          }).catch((e) => log.warn("orchestrator", "finding-queue stop task append fail", e));
        }
        runtime.findingQueue = null;
        emitChatMessage(
          "system",
          "⏸️ Kalan güvenlik bulguları elle inceleme için parkta — hazır olunca iş listesinden devam et.",
        );
        return;
      }
      if (sel === OPT_REANALYZE) {
        emitChatMessage("system", "🔁 Bu bulguyu yeniden gösteriyorum.");
        emitQueuedFinding(queue); // aynı finding'i tekrar sor (index değişmez — kuyruğu bozma)
        return;
      }
      if (sel === OPT_ACCEPT_CONTINUE || sel === OPT_ACCEPT_PERMANENT || sel === OPT_QUEUE) {
        if (sel === OPT_QUEUE) {
          await appendTask(runtime.state.project_root, {
            id: randomUUID(),
            ts: Date.now(),
            text: `Faz ${cached.phase} güvenlik bulgusu (ertelendi): ${curFinding.summary_tr}`,
            status: "pending",
            source: "manual",
          }).catch((e) => log.warn("orchestrator", "finding-queue defer task fail", e));
        } else if (sel === OPT_ACCEPT_PERMANENT && curFinding.code_ref) {
          await appendAcceptedFinding(runtime.state.project_root, {
            ts: Date.now(),
            scope: "tech-debt",
            file: curFinding.code_ref.file,
            category: "security",
            snippet: curFinding.summary_tr,
            reason: `kullanıcı Faz ${cached.phase} teker-teker akışında kalıcı kabul etti`,
          }).catch((e) => log.warn("orchestrator", "finding-queue accept-permanent write fail", e));
        }
        emitChatMessage(
          "system",
          `⚠️ Bu güvenlik bulgusu ${sel === OPT_QUEUE ? "ertelendi" : "kabul edildi"} — sonraki soruna geçiyorum.`,
        );
        const r = await advanceFindingQueue();
        if (r === "asked") return; // sonraki finding soruldu (manuel: askq açık, bekliyor)
        // exhausted → kuyruk bitti
        if (queue.anyFixed) {
          emitChatMessage("system", "🔁 Tüm sorunlar ele alındı — güvenlik taramasını bir kez yeniden koşuyorum.");
          await advanceToNextPhase(12); // → Faz 13 gate final doğrulama (kuyruk null → normal koşar)
        } else {
          const p = (cached.acceptContinuePhase ?? cached.phase) as PhaseId;
          await appendAuditModule(runtime.state.project_root, {
            ts: Date.now(),
            phase: p,
            event: `phase-${p}-complete`,
            caller: "user",
            detail: "security_accepted_by_user",
          }).catch((e) => log.warn("orchestrator", "finding-queue accept audit fail", e));
          emitChatMessage("system", `⚠️ Tüm güvenlik bulguları kabul edildi — akış devam ediyor (Faz ${p}).`);
          await advanceToNextPhase(p);
        }
        return;
      }
      // Somut çözüm → BU finding'in fix'ini dispatch et; awaitingRerun+anyFixed set → intercept fix sonrası sonraki
      // finding'e ilerletir. Aşağıdaki concrete-solution dispatch yoluna DÜŞER (return YOK).
      queue.awaitingRerun = true;
      queue.anyFixed = true;
    }
    if (sel === OPT_REANALYZE) {
      const errCtx: ErrorContext = {
        phase: cached.phase,
        message: `Faz ${cached.phase} hatası için yeniden analiz istendi.`,
        detail: cached.solutions_tr.join("\n"),
      };
      runtime.pendingErrorAnalysis = await analyzeAndAskError(
        runtime.state,
        runtime.config,
        errCtx,
      ).catch(() => null);
      // FIX B (mahkeme): yeniden-analiz pending'ine de aynı sig'i taşı → seçilecek çözüm bu hata-imzasına kaydedilir.
      if (runtime.pendingErrorAnalysis) runtime.pendingErrorAnalysis.sig = cached.sig;
      // FIX #2 (frozen-goal): yeniden-analiz de HİÇ üretemedi (null) → eski davranış sessiz drop'tu → fallback
      // escalate. OPT_REANALYZE kullanıcının BİLİNÇLİ tıkı (yanıt-bağlamı) → autoResolve=false: PARK et (kullanıcı
      // OPT_QUEUE ile çıkar), oto-route YOK (reanalyze→null→reanalyze döngüsü + istemsiz task yazımı önlenir).
      if (!runtime.pendingErrorAnalysis) await escalateUnanalyzableError(cached.phase, false, cached.sig);
      return;
    }
    // ── CEVAP-HATIRLAMA (Kademe 1, YZLLM 2026-07-03; mahkeme-daraltıldı): kullanıcının seçtiği ÇÖZÜM YÖNÜNÜ
    // (answerKind="solution") hata-imzasına KALICI kaydet → aynı hata yine gelince "aynı cevabı kullanayım mı?"
    // merdiveni. YALNIZ "solution" — sabit-etiketler (OPT_QUEUE/STOP_MANUAL/ACCEPT_CONTINUE/ACCEPT_PERMANENT) KASITLA
    // hariç: bunlar kontrol/güvenlik eylemleri; sentetik pending ile yeniden-gönderilince bağlamı (acceptContinuePhase/
    // gerçek solutions_tr) kaybeder → yanlış dal/faz (mahkeme bulgusu). Güvenlik kabulü her seferinde yeniden onaylanır
    // (security oto-değil). OPT_REANALYZE terminal değil (yukarıda return etti). Oto-seçilen (LLM best_index) cevap ve
    // recall'dan gelen yeniden-uygulama (fromRecall) da KAYDEDİLMEZ. sensitive=blocking gate: solution cevabı blocking
    // (güvenlik) kapıda seçilse bile Kademe 3 sessiz-oto YOK, hep Kademe 2 onayı (blocking↔sensitive bağı: bugün tek
    // hassas sınıf blocking gate'ler — allowAcceptContinue hep blocking'e zorlanır).
    if (
      cached.sig &&
      !cached.fromRecall &&
      !cached.auto_selected_solution &&
      classifyAnswer(sel) === "solution" &&
      runtime.state
    ) {
      recallAutoCount.delete(cached.sig); // taze karar → Kademe 3 oto-uygulama backstop sayacını sıfırla
      await recordAnswer(runtime.state.project_root, {
        key: cached.sig,
        phase: cached.phase,
        answer: sel,
        answerKind: "solution",
        scope: "gate-error",
        sensitive: cached.blocking === true,
      }).catch((e) => log.warn("orchestrator", "answer-memory record fail (non-fatal)", e));
    }
    if (sel === OPT_QUEUE) {
      // sentinel-routing finding-f: appendTask throws → eski .catch sadece log yapıyordu
      // → task kuyrukta yok ama pendingErrorAnalysis=null → pipeline sessiz devam ediyordu
      // (frozen-goal ihlali). Artık I/O hatası görünür emitChatMessage ile yüzeye çıkar.
      // 2026-07-30 (canlı cave: aynı "—" işi 4 kez açıldı, hiçbiri çözülemedi): metin artık KANIT taşıyor
      // (faz + gerçek hata + audit işaretçisi + ne yapılacağı) ve aynı hata için ikinci iş AÇILMAZ.
      const deferredText = buildDeferredErrorTaskText({
        phase: cached.phase,
        failReason: cached.fail_detail,
        solutionTr: cached.solutions_tr[0],
        auditEvent: "error-analysis-no-provider",
        auditTs: Date.now(),
      });
      const deferKey = systemTaskKey({
        source: "manual",
        kind: "deferred-phase-error",
        subject: `${cached.phase}:${cached.sig ?? cached.fail_detail ?? ""}`,
      });
      const existingTasks = await readTasks(runtime.state.project_root).catch(() => []);
      const deferDecision = decideSystemTask({
        key: deferKey,
        text: deferredText,
        existing: existingTasks,
        maxRetries: MAX_TASK_AUTO_RETRIES,
      });
      if (deferDecision.action !== "create") {
        // Aynı faz hatası zaten kuyrukta — ikinci kayıt açmak yerine görünür kal.
        if (deferDecision.action === "refresh") {
          await patchTask(runtime.state.project_root, deferDecision.taskId, {
            seen_count: (existingTasks.find((t) => t.id === deferDecision.taskId)?.seen_count ?? 1) + 1,
            last_fail: `aynı faz hatası yeniden ertelendi: ${(cached.fail_detail ?? "").slice(0, 140)}`,
            ...(deferDecision.revive ? { attempts: 0 } : {}),
          }).catch(() => {});
          await emitQueueChangedFor(runtime.state.project_root).catch(() => {});
        }
        emitChatMessage(
          "system",
          "📋 Bu hata iş listesinde zaten var — yeni kayıt açmadım, mevcut işi güncelledim.",
        );
        return;
      }
      let appendOk = true;
      await appendTask(runtime.state.project_root, {
        id: randomUUID(),
        ts: Date.now(),
        text: deferredText,
        // Ertelenmiş hatırlatma → source=manual: auto-drain'e GİRMEZ (istemsiz
        // oto-çalıştırma yok; kullanıcı "Uygula" ile bilerek tetikler).
        status: "pending",
        source: "manual",
        dedup_key: deferKey,
        seen_count: 1,
      }).catch((e) => {
        appendOk = false;
        log.warn("orchestrator", "error-analysis task append fail", e);
        emitChatMessage(
          "error",
          `⚠️ Faz ${cached.phase}: hata iş listesine yazılamadı (disk/izin hatası). Lütfen el ile not al: ${cached.solutions_tr[0] ?? "—"}`,
        );
      });
      if (appendOk) {
        emitChatMessage(
          "system",
          "📋 Hata iş listesine kaydedildi — çözmeden devam edebilirsin.",
        );
      }
      return;
    }
    // Güvenlik-baseline Unit 2: "Kabul et, devam et" (blocking gate override). Kullanıcı
    // güvenlik bulgusunu bilerek kabul edip akışı sürdürür. phase-N-complete yazılır
    // ama detail "security_accepted_by_user" → soft_complete_after_fail DEĞİL (harness
    // bunu fail saymaz; ancak runner'ın yazdığı *-fail event'leri durduğu için verdict
    // yine PARTIAL = "tamamlandı ama güvenlik kabul edildi", asla çıplak PASS değil).
    if (sel === OPT_ACCEPT_CONTINUE && cached.acceptContinuePhase !== undefined) {
      const p = cached.acceptContinuePhase as PhaseId;
      await appendAuditModule(runtime.state.project_root, {
        ts: Date.now(),
        phase: p,
        event: `phase-${p}-complete`,
        caller: "user",
        detail: "security_accepted_by_user",
      }).catch((e) => log.warn("orchestrator", "accept-continue audit fail", e));
      emitChatMessage(
        "system",
        `⚠️ Faz ${p} güvenlik bulgusu kullanıcı tarafından kabul edildi — akış devam ediyor (bu iş "mükemmel" sayılmaz).`,
      );
      gateFailStreak.delete(p); // kabul = faz kapandı → döngü sayacı sıfır (sonraki iterasyon taze).
      await advanceToNextPhase(p);
      return;
    }
    // FIX D (YZLLM 2026-07-01: "kabul edilen bulgu bir daha sorulmasın"): KALICI kabul. Bu gate-fail'e neden olan
    // tech-debt bulgularını (dosya+kategori+snippet) `.mycl/accepted-findings.jsonl`'e yaz → sonraki iterasyonda
    // kapı ARTIK işaretlemez → aynı-soru döngüsü KALICI kırılır. GÖRÜNÜR + geri-alınabilir (satır sil = yeniden aktif).
    if (sel === OPT_ACCEPT_PERMANENT) {
      const p = (cached.acceptContinuePhase ?? cached.phase) as PhaseId;
      const findings = getLastTechDebtFindings(runtime.state.project_root);
      // Aynı anahtarı iki kez yazma (idempotent kabul).
      const writtenKeys = new Set<string>();
      const acceptedList: { file: string; category: string }[] = [];
      for (const f of findings) {
        const key = acceptedFindingKey(f.file, f.category, f.excerpt);
        if (writtenKeys.has(key)) continue;
        writtenKeys.add(key);
        await appendAcceptedFinding(runtime.state.project_root, {
          ts: Date.now(),
          scope: "tech-debt",
          file: f.file,
          category: f.category,
          snippet: f.excerpt,
          reason: `kullanıcı Faz ${cached.phase} döngüsünde kalıcı kabul etti`,
        }).catch((e) => log.warn("orchestrator", "accepted-finding write fail", e));
        acceptedList.push({ file: f.file, category: f.category });
      }
      const wrote = acceptedList.length;
      await appendAuditModule(runtime.state.project_root, {
        ts: Date.now(),
        phase: p,
        event: `phase-${p}-complete`,
        caller: "user",
        detail: `finding_accepted_permanently count=${wrote}`,
      }).catch((e) => log.warn("orchestrator", "accept-permanent audit fail", e));
      // KATI #4 (görünürlük) + mahkeme (bilinçli-onay): TAM OLARAK hangi bulguların kabul edildiğini DÖK — kullanıcı
      // "1 bulgu kabul ediyorum" sanırken sessizce fazlası gizlenmesin; istemediğini .jsonl'den silebilsin (geri-alınabilir).
      emitChatMessage(
        "system",
        wrote > 0
          ? `✅ ${wrote} bulgu KALICI kabul edildi — kapı (Faz 8 + Faz 9) bir daha işaretlemeyecek:\n` +
              acceptedList.map((a) => `  • ${a.file} — ${a.category}`).join("\n") +
              `\nGeri almak için: .mycl/accepted-findings.jsonl ilgili satırı sil.`
          : `✅ Bulgu kabul edildi — akış devam ediyor. (Kalıcı işaretlenebilir tech-debt bulgusu bulunamadı; ` +
              `sonraki iterasyonda aynı gate tekrar çıkarsa gerçek bir sorun olabilir.)`,
      );
      gateFailStreak.delete(p); // kalıcı kabul = faz kapandı → döngü sayacı sıfır.
      await advanceToNextPhase(p);
      return;
    }
    // FIX A: "Dur — elle inceleyeceğim". Döngü tükendi, kullanıcı bilerek park ediyor. Hata iş listesine yazılır
    // (kaybolmaz) + görünür dur; oto-route YOK (kullanıcı el ile inceleyecek). Sessiz-stall değil (frozen-goal).
    if (sel === OPT_STOP_MANUAL) {
      await appendTask(runtime.state.project_root, {
        id: randomUUID(),
        ts: Date.now(),
        text: `Faz ${cached.phase} hatası (kullanıcı elle inceleyecek): ${cached.solutions_tr[0] ?? "—"}`,
        status: "pending",
        source: "manual",
      }).catch((e) => {
        log.warn("orchestrator", "stop-manual task append fail", e);
        emitChatMessage(
          "error",
          `⚠️ Faz ${cached.phase}: hata iş listesine yazılamadı — lütfen el ile not al: ${cached.solutions_tr[0] ?? "—"}`,
        );
      });
      emitChatMessage(
        "system",
        `⏸️ Faz ${cached.phase} elle inceleme için parkta — aynı soru bir daha sorulmayacak. Hazır olunca iş listesinden devam et.`,
      );
      return;
    }
    // FIX B (YZLLM 2026-07-01): kullanıcının seçtiği çözümü bu hata-imzasına KAYDET → aynı hata tekrar fail
    // ederse error-analysis "bu denendi, tekrarlama" olarak görür (aynı-soru döngüsü kırılır, farklı yön önerilir).
    // ANA KURAL (YZLLM 2026-07-18): main'e giden HER metin İngilizce. Seçim TR etikettir (gösterim);
    // EN eşleniği indeks hizasından bulunur, yoksa (serbest TR cevap / eski format) sınırda çevrilir.
    const selIdx = cached.solutions_tr.indexOf(sel);
    const selEn =
      (selIdx >= 0 ? cached.solutions_en?.[selIdx] : undefined) ?? (await toEnglishForMain(sel));
    const solutionsEn =
      cached.solutions_en ?? (await Promise.all(cached.solutions_tr.map((s2) => toEnglishForMain(s2))));
    if (cached.sig) recordSolutionChoice(cached.phase, cached.sig, selEn);
    // Diğer her seçim ("Çöz" jeneriği veya somut bir çözüm metni) → mevcut debug
    // akışı (Faz 0 / debug_triage). Kullanıcıya TR gösterilir; main'e EN gider.
    emitChatMessage(
      "system",
      `🔧 Çözüm uygulanıyor: **${sel}** — debug akışı (Faz 0) başlatılıyor.`,
    );
    const bugReport =
      `Phase ${cached.phase} failed.\nChosen fix direction: ${selEn}` +
      (solutionsEn.length > 0 ? `\nProposed solutions:\n${solutionsEn.join("\n")}` : "");
    const fakeOutcome: DispatchOutcome = {
      handled: false,
      action: "debug_triage",
      intent: {
        kind: "debug",
        reasoning: "(error-analysis) kullanıcı çözüm seçti",
      },
    };
    // Orkestratörün ZATEN bulduğu çözümleri + kullanıcının SEÇTİĞİNİ yapılandırılmış taşı → Faz 0 D1
    // yeniden türetmez DOĞRULAR + D2 tekrar SORMAZ (çift-soru fix'i, YZLLM 2026-07-03).
    await executeDispatchedIntent(bugReport, fakeOutcome, {
      solutions: solutionsEn,
      user_selected: selEn,
    });
    return;
  }

  // v15.6 (2026-05-24): Agent ask_clarify askq cevabı. ask_clarify "fire-and-
  // forget" — orchestrator-side pending state tutmaz (sadece askq emit edilir).
  // Frontend kullanıcı yeni mesaj yazınca askq'yu "Vazgeç" ile auto-cancel
  // ediyor → buraya `agent_clarify_*` id geliyor → eskiden "no active
  // controller" hatası düşüyordu. Fix: "Vazgeç" → sessizce kapat; gerçek cevap
  // → yeni user_message gibi handle et (agent re-evaluate).
  if (id.startsWith("agent_clarify_")) {
    if (selectedText === "Vazgeç") return;
    await handleUserMessage(selectedText);
    return;
  }

  // v15.6: Memory save proposal askq — pendingMemoryProposal varsa user
  // "Projeye özel / Genel / Her İkisi / Hayır" cevabı işlenir.
  if (
    runtime.pendingMemoryProposal &&
    runtime.pendingMemoryProposal.askqId === id &&
    runtime.state &&
    runtime.config
  ) {
    const sel = (Array.isArray(selected) ? selected[0] : selected) ?? "";
    const cached = runtime.pendingMemoryProposal;
    runtime.pendingMemoryProposal = null;
    const baseEntry = {
      ts: Date.now(),
      topic_slug: cached.topic_slug,
      summary: cached.proposal.summary,
      user_text: cached.user_text,
      decision_action: cached.decision_action,
      affected_files: cached.proposal.affected_files,
      affected_db_tables: cached.proposal.affected_db_tables,
      affected_algorithms: cached.proposal.affected_algorithms,
      change_description: cached.proposal.change_description,
      confirmed_at: Date.now(),
    };
    // v15.7 (2026-05-26): General memory cross-project leak koruması.
    // scope yoksa default "stack-specific" (defansif — orkestratör belirtmediyse
    // ihtiyatlı davran). tech_stack state'ten alınır.
    const generalScope = cached.proposal.scope ?? "stack-specific";
    const generalExtras = generalScope === "universal"
      ? { scope: "universal" as const }
      : {
          scope: "stack-specific" as const,
          tech_stack: runtime.state.stack ?? "unknown",
        };
    try {
      if (sel === "📁 Projeye özel") {
        await appendProjectMemory(runtime.state.project_root, {
          ...baseEntry,
          type: "project",
        });
        emitChatMessage("system", `✅ Projeye özel hafızaya kaydedildi: \`${cached.topic_slug}\``);
      } else if (sel === "🌐 Genel (başka projelerde de görünür)") {
        // User talebi: "genel hafıza ile ilgili olan konu büyük ihtimalle
        // projeye de özeldir. aynı zamanda projeye özel de yazılsın."
        await appendGeneralMemory({ ...baseEntry, ...generalExtras, type: "general" });
        await appendProjectMemory(runtime.state.project_root, {
          ...baseEntry,
          type: "project",
        });
        emitChatMessage(
          "system",
          `✅ Genel (${generalScope}) + projeye özel hafızaya kaydedildi: \`${cached.topic_slug}\``,
        );
      } else if (sel === "📁🌐 Her İkisi") {
        await appendGeneralMemory({ ...baseEntry, ...generalExtras, type: "general" });
        await appendProjectMemory(runtime.state.project_root, {
          ...baseEntry,
          type: "project",
        });
        emitChatMessage(
          "system",
          `✅ Her iki hafızaya da kaydedildi (genel: ${generalScope}): \`${cached.topic_slug}\``,
        );
      } else {
        emitChatMessage("system", "Hafıza kaydı atlandı.");
      }
    } catch (err) {
      log.warn("orchestrator", "memory save failed", err);
      emitChatMessage("error", `Hafıza kaydı başarısız: ${String(err)}`);
    }
    return;
  }

  // v15.6: Agent decision confirmation askq — pendingAgentDecision varsa
  // kullanıcı "Evet" → executeConfirmedAgentDecision; "Hayır" → re-decide
  // (agent.respond() tekrar); "Vazgeç" → cancel.
  if (
    runtime.pendingAgentDecision &&
    runtime.pendingAgentDecision.askqId === id &&
    runtime.state &&
    runtime.config
  ) {
    const sel = (Array.isArray(selected) ? selected[0] : selected) ?? "";
    const cached = runtime.pendingAgentDecision;
    runtime.pendingAgentDecision = null;
    if (sel === "Vazgeç") {
      // Decision iptal — agent-decisions.jsonl'e confirmed=false kayıt
      try {
        await appendAgentDecisionLog(runtime.state.project_root, {
          ts: Date.now(),
          user_text: cached.text,
          topic_slug: cached.decision.topic_slug ?? "uncategorized",
          action: cached.decision.action,
          reason: cached.decision.reason,
          confirmed: false,
        });
      } catch (err) {
        log.warn("orchestrator", "agent decision log fail (cancel)", err);
      }
      emitChatMessage("system", "İptal edildi. Yeni bir mesaj yazabilirsin.");
      return;
    }
    if (sel === "✅ Evet") {
      // Confirmed agent decision → agent-decisions.jsonl'e kayıt (2. confirmation
      // detection input'u olarak)
      try {
        await appendAgentDecisionLog(runtime.state.project_root, {
          ts: Date.now(),
          user_text: cached.text,
          topic_slug: cached.decision.topic_slug ?? "uncategorized",
          action: cached.decision.action,
          reason: cached.decision.reason,
          confirmed: true,
        });
      } catch (err) {
        log.warn("orchestrator", "agent decision log fail (evet)", err);
      }
      await executeConfirmedAgentDecision(cached.decision, cached.text);
      return;
    }
    if (sel === "❌ Hayır") {
      // Agent'a "tekrar düşün" demek — fresh respond() çağrısı.
      emitChatMessage("system", "🔄 Tekrar düşünüyorum...");
      try {
        const newDecision = await respondAsOrchestrator(
          runtime.config,
          runtime.state,
          cached.text,
        );
        if (newDecision.action === "fallback_to_classifier") {
          emitChatMessage(
            "system",
            "Anlayamadım, daha net yazar mısın? Farklı bir cümle yapısı yardımcı olabilir.",
          );
          return;
        }
        await executeAgentDecision(newDecision, cached.text);
      } catch (err) {
        log.warn("orchestrator", "agent re-decide failed", err);
        const msg = ((err as Error).message ?? "bilinmeyen hata").slice(0, 120);
        emitChatMessage(
          "system",
          `🤖 Ajan yine cevap veremedi (${msg}). Lütfen mesajını farklı şekilde yazıp tekrar dene.`,
        );
      }
      return;
    }
    emitChatMessage("system", "Beklenmedik askq cevabı — iptal edildi.");
    return;
  }

  // v15.7 (2026-05-25): pendingIntent confirm askq akışı KALDIRILDI.
  // Classifier fallback yok artık → askq açılmıyor → bu branch dead.

  // Sidebar faz tıklama askq cevabı: runtime.pendingPhaseRun ile eşleşirse
  // tek deterministik mod (advance) — pipeline her zaman ilerlesin.
  // v15.7 (2026-05-28): "Sadece Çalıştır" askq'dan kaldırıldı. Kullanıcı
  // kuralı: "faz geçişlerini deterministik yapalım. mycl studio geçsin
  // sıradaki faza." only_run kod yolu programatik kalır (handleRunPhase
  // @deprecated branch), askq UI'da görünmez.
  if (runtime.pendingPhaseRun && runtime.pendingPhaseRun.askqId === id) {
    const sel = (Array.isArray(selected) ? selected[0] : selected) ?? "";
    const phaseId = runtime.pendingPhaseRun.phaseId;
    runtime.pendingPhaseRun = null;
    if (sel === "✅ Çalıştır" || sel === "Çalıştır") {
      await handleRunPhase(phaseId, "advance");
    } else if (sel === "Vazgeç") {
      emitChatMessage("system", "İptal edildi.");
    } else {
      // Backward-compat: eski metinli askq cevapları "Çalıştır ve İlerle"
      // de advance'a düşer; "Sadece Çalıştır" da defansif olarak advance
      // (kullanıcı kuralı: deterministik).
      log.info("orchestrator", "askq sel non-canonical, defaulting to advance", { sel });
      await handleRunPhase(phaseId, "advance");
    }
    return;
  }

  // v15.7 (2026-05-26): Phase 0 D2_WAITING askq cevap akışı — YENİ MİMARİ.
  // Eski: continueWithSelection → Phase 0 D3 codegen fix uygular.
  // Yeni: Phase 0 sadece teşhis. Kullanıcı plan seçince:
  //   - "Vazgeç" → debug iptal, pending_diagnostic clear
  //   - Plan seçimi → plan_summary'i state.pending_ui_tweak'e yaz +
  //     current_phase=4 + advanceToNextPhase(4) → Faz 5 (UI tweak mode)
  //     başlar, kalan opsiyonel pipeline (5-9) ve mechanical (10-17) akar.
  //
  // Bu, Phase 5 tweak mode pattern'ini reuse eder: zaten "küçük değişiklik
  // uygula, full rewrite yapma" davranışındadır — fix application için ideal.
  const pending = runtime.state?.pending_diagnostic;
  if (
    pending &&
    pending.phase === "D2_WAITING" &&
    pending.askq_id === id &&
    runtime.state &&
    runtime.config
  ) {
    if (selectedText === "Vazgeç") {
      await appendAuditModule(runtime.state.project_root, {
        ts: Date.now(),
        phase: 0,
        event: "debug-cancelled",
        caller: "user",
      });
      // Debug bir KESİNTİYDİ; iptal = "sorun yokmuş → kaldığım yerden DEVAM" (YZLLM: orkestratör takılıp
      // unutmamalı). debug_triage current_phase'i değiştirmedi → kaldığı faz hâlâ orada. Pipeline mid-flight
      // (Faz 1-9) ise resume; değilse (idle/tamamlanmış) sadece dur.
      const resumePhase = runtime.state.current_phase;
      runtime.state = {
        ...runtime.state,
        pending_diagnostic: undefined,
        updated_at: Date.now(),
      };
      await saveState(runtime.state);
      if (typeof resumePhase === "number" && resumePhase >= 1 && resumePhase <= 9) {
        emitChatMessage(
          "system",
          `🔄 Debug iptal edildi — Faz ${resumePhase}'ten kaldığım yerden devam ediyorum.`,
        );
        await advanceToNextPhase((resumePhase - 1) as PhaseId);
      } else {
        emitChatMessage("system", "🛑 Debug iptal edildi.");
      }
      return;
    }
    const selected = pending.options.find((o) => o.label === selectedText);
    if (!selected) {
      emitChatMessage("error", `Seçenek bulunamadı: ${selectedText}`);
      return;
    }
    // D5 dokunuş haritası (YZLLM: "hangi çözümü seçersem nerelere dokunur").
    // Seçilen çözümün dokunacağı dosyalar + DETERMİNİSTİK blast-radius. Routing'den
    // önce, kullanıcı uygulamadan ÖNCE görsün. Fail-safe (non-fatal).
    try {
      const touchMap = await buildTouchpointSummary(
        runtime.state.project_root,
        selected.planSummary,
      );
      if (touchMap) emitChatMessage("system", touchMap);
    } catch (err) {
      log.warn("orchestrator", "dokunuş haritası üretilemedi (non-fatal)", err);
    }
    // v15.7 (2026-05-27): Plan-aware routing. Eski regex classifier yerine
    // D1 ana ajanın `plan_kind` tool field'ı kullanılır. Defansif default:
    // eski state.json'da planKind yoksa "full-stack" → yeni iterasyon
    // (veri kaybı yok, sadece kapsamlı işlem).
    //   ui-only       → Phase 5 tweak
    //   backend-only  → Phase 8 fix mode (pending_backend_fix)
    //   full-stack    → develop_new_or_iter (Phase 1'den fresh)
    //   new-iteration → develop_new_or_iter (D1 sentinel)
    const planKindMissing = selected.planKind === undefined;
    const kind = selected.planKind ?? "full-stack";
    if (planKindMissing) {
      // Eski state.json'dan resume: D1 ajanı plan_kind set etmediği bir
      // dönemde kaydedilmiş. Kullanıcıya görünür uyarı + audit trail bırak ki
      // sürpriz scope eskalasyonu fark edilsin.
      log.warn("orchestrator", "planKind missing in option, defaulting to full-stack", {
        label: selected.label,
      });
      emitChatMessage(
        "system",
        "ℹ Eski oturum verisi: plan kapsamı belirsiz, güvenli yola düşüp yeni iterasyon olarak ele alıyorum.",
      );
    }
    // Otomatik seçim (auto_selected_label) audit'te dürüstçe orchestrator olarak görünür.
    const autoSelected = pending.auto_selected_label === selectedText;
    await appendAuditModule(runtime.state.project_root, {
      ts: Date.now(),
      phase: 0,
      event: "debug-fix-selected",
      caller: autoSelected ? "mycl-orchestrator" : "user",
      detail: `label="${selected.label}" kind=${kind}${planKindMissing ? " (defaulted)" : ""}${autoSelected ? " (auto)" : ""} plan_len=${selected.planSummary.length}`,
    });
    // #3: Faz 0'ın deterministik bağımlılık etki-alanını fix payload'ına ekle → Faz 8 codegen AI
    // blast-radius'u grep'siz görür (token + kaçırma). pending.affected Faz 0 D1'de hesaplandı.
    const fixPayload = `Fix request: ${selected.label}\n\nPlan:\n${selected.planSummary}${formatBlastRadius(pending.affected ?? [])}`;
    // v15.10: fix-güvenlik katmanı TÜM kod fix'lerine (backend + UI). Kod
    // değişiminden ÖNCE checkpoint al → regresyonda rollback hedefi + scoped-gate
    // (fix_checkpoint_ref shouldComputeScope'u tetikler; mekanik gate'ler yalnız
    // değişen dosyalara koşar). Kirli ağaçta atlanır (görünür uyarı), fix ilerler.
    // ui-only'de ilk kod değişimi Faz 5'te → checkpoint advance'ten ÖNCE alınmalı.
    let fixCheckpointRef: string | undefined;
    if (kind === "ui-only" || kind === "backend-only") {
      const cp = await createCheckpoint(runtime.state.project_root);
      if (cp.ok && cp.ref) {
        fixCheckpointRef = cp.ref;
        emitChatMessage(
          "system",
          "📌 Fix öncesi checkpoint alındı — regresyonda otomatik geri alınabilir; mekanik kalite gate'leri değişen dosyalara odaklanacak (scoped).",
        );
      } else {
        // Git yok/kirli → scoped-gate yok AMA yine de geri-alınabilir yedek al (.mycl/backups).
        await snapshotBeforeAutofix(runtime.state.project_root, Date.now());
      }
    }
    if (kind === "ui-only") {
      emitChatMessage(
        "system",
        `🔧 UI fix uygulanıyor: **${selected.label}**\n\nFaz 5 tweak modu başlatılıyor.`,
      );
      runtime.state = {
        ...runtime.state,
        pending_ui_tweak: fixPayload,
        fix_checkpoint_ref: fixCheckpointRef,
        // GERÇEK-APP DOĞRULAMA MARKER'ı (YZLLM 2026-07-21): pipeline sonunda bu fix'in gerçek çalışan uygulamada
        // bug'ı çözdüğünü doğrula (birim-yeşil ≠ app-yeşil). checkpoint marker'da taşınır (fix_checkpoint_ref
        // gate'ten ÖNCE tüketilir). Marker mantığı SAF buildRealAppVerifyMarker'da (test edilir): error-analysis
        // gate-fix → BOŞ (kurulmaz; sentetik repro hedefi + nested'de orijinal marker korunur), aksi → kullanıcı-şikayeti hedefli.
        ...buildRealAppVerifyMarker({
          fromErrorAnalysis: !!pending.from_error_analysis,
          bugReportTr: pending.bug_report_tr,
          rootCauseTr: pending.rootCauseTR,
          fixLabel: selected.label,
          checkpointRef: fixCheckpointRef,
          iteration: runtime.state.iteration_count ?? 1,
        }),
        pending_diagnostic: undefined,
        current_phase: 4 as PhaseId,
        updated_at: Date.now(),
      };
      await saveState(runtime.state);
      await advanceToNextPhase(4 as PhaseId);
    } else if (kind === "backend-only") {
      emitChatMessage(
        "system",
        `🔧 Backend fix uygulanıyor: **${selected.label}**\n\nFaz 8 (TDD) fix modunda başlatılıyor.`,
      );
      runtime.state = {
        ...runtime.state,
        pending_backend_fix: fixPayload,
        fix_checkpoint_ref: fixCheckpointRef,
        // GERÇEK-APP DOĞRULAMA MARKER'ı (YZLLM 2026-07-21): canlı vaka backend .ts fix'iydi ama UI'dan gözlendi
        // (buildCustomerSearchQuery → /profile boş) → backend-only fix de doğrulanmalı. SAF buildRealAppVerifyMarker
        // (test edilir): error-analysis gate-fix → BOŞ (bkz ui-only dalı — sentetik repro hedefi, gereksiz blok).
        ...buildRealAppVerifyMarker({
          fromErrorAnalysis: !!pending.from_error_analysis,
          bugReportTr: pending.bug_report_tr,
          rootCauseTr: pending.rootCauseTR,
          fixLabel: selected.label,
          checkpointRef: fixCheckpointRef,
          iteration: runtime.state.iteration_count ?? 1,
        }),
        pending_diagnostic: undefined,
        current_phase: 7 as PhaseId,
        updated_at: Date.now(),
      };
      await saveState(runtime.state);
      await advanceToNextPhase(7 as PhaseId);
    } else {
      // full-stack veya new-iteration — kapsamlı değişiklik, yeni iterasyon.
      // GUARDRAIL 2 (YZLLM 2026-06-10): bu MyCL'in KENDİ otomatik düzeltmesi — KULLANICI feature isteği DEĞİL.
      // Eskiden fixPayload "Fix request: ..." Faz 1'e gidip "Kullanıcı X istiyor" diye FABRİKLENİYORDU. Artık
      // intent açıkça işaretli: ajan bunu "uygulanan düzeltme" diye betimler, asla "kullanıcı istiyor" demez.
      emitChatMessage(
        "system",
        `🔧 Kapsamlı düzeltme (MyCL — pipeline hatasını gidermek için): **${selected.label}**\n\nYeni iterasyon olarak uygulanıyor.`,
      );
      runtime.state = {
        ...runtime.state,
        pending_diagnostic: undefined,
        updated_at: Date.now(),
      };
      await saveState(runtime.state);
      const autoFixIntent =
        `[MyCL AUTOMATED FIX — NOT a user feature request. Describe this as a fix being applied to resolve a ` +
        `failed pipeline phase; NEVER phrase it as "the user wants ...".]\n\n${fixPayload}`;
      await executeAgentDecision(
        {
          action: "develop_new_or_iter",
          reason: `MyCL kendi düzeltmesini kapsamlı (${kind}) olduğu için yeni iterasyon olarak uyguluyor (kullanıcı isteği değil).`,
          topic_slug: "debug-full-stack-fix",
        },
        autoFixIntent,
      );
    }
    return;
  }

  if (!runtime.controller) {
    emitError("Aktif denetleyici yok", { id });
    return;
  }
  // submitAskqAnswer'ı olan her controller cevabı kabul eder: qa (P1/P2/P9),
  // production (P3/P4/P7) ve v15.8'den beri codegen (P5/P8 doubt-driven eskalasyon).
  if ("submitAskqAnswer" in runtime.controller) {
    runtime.controller.submitAskqAnswer(id, selectedText);
  } else {
    emitError("Aktif faz soru yanıtı kabul etmiyor", { id });
  }
}

/**
 * Sidebar'dan bir faz tıklandığında çağrılır. 2-buton askq emit eder
 * (Çalıştır / Vazgeç). v15.7 (2026-05-28): Deterministik mod — eski
 * "Sadece Çalıştır" seçeneği kaldırıldı. Phase 0 reddedilir. Spec
 * bağımlılığı kontrolü `handleRunPhase` içinde.
 */
// v15.7 (2026-05-25): handleIntentDirect KALDIRILDI — sidebar intent
// button'ları zaten v15.7'de UI'dan silinmişti, frontend bu IPC'yi
// göndermiyor. Backend handler dead code'tu, temizlendi.

/**
 * v15.8 (2026-05-30): Sohbete yazılacak Türkçe faz etiketi ("Faz 16: E2E
 * Testler"). İç "phase-N" adı kullanıcıya sızmasın. i18n yoksa "Faz N" fallback.
 */
function phaseLabelTR(phaseId: number, spec: PhaseSpec): string {
  try {
    const nameTR = t(spec.name_i18n_key, "tr");
    if (nameTR) return `Faz ${phaseId}: ${nameTR}`;
  } catch {
    // i18n yüklenmediyse sade fallback
  }
  return `Faz ${phaseId}`;
}

/**
 * Foreign proje + Faz 5 (orkestratörün "çalıştır" niyeti eşlemesi) + `.mycl/spec.md` YOK = "var olan uygulamayı
 * ÇALIŞTIR" (UI codegen DEĞİL). Foreign proje EDD ile entegre olur, Faz 4 spec.md YAZMAZ → Faz 5 codegen'in ön
 * koşulu (spec) hiç yoktur → eskiden "önce Faz 4'ü tamamla" DEAD-END'i (hiçbir şey çalışmazdı — log teşhisi). Bunun
 * yerine dev-server başlatma yoluna (handleCommandDirect run — deps kurulum/kurtarma/servis dahil) SESSİZCE (silent:
 * çelişkili kuyruk mesajı yok) YÖNLENDİR. @returns true → yönlendirildi (çağıran RETURN etmeli). (YZLLM 2026-07-15)
 */
async function redirectForeignRunToDevServer(phaseId: number): Promise<boolean> {
  if (phaseId !== 5 || !runtime.state || runtime.state.origin !== "foreign") return false;
  const specMdPath = currentSpecPath(runtime.state);
  const hasSpec = await import("node:fs/promises").then((m) =>
    m.access(specMdPath).then(() => true).catch(() => false),
  );
  if (hasSpec) return false; // spec VAR → gerçek UI-build iterasyonu (redirect etme, normal Faz 5 codegen)
  emitChatMessage(
    "system",
    "▶️ Bu yabancı proje zaten kurulu (UI-kurma fazı gerekmez) — çalıştırıyorum…",
  );
  await handleCommandDirect("projeyi çalıştır", "run", { silent: true });
  return true;
}

async function emitPhaseRunAskq(phaseId: number, directRun = false): Promise<void> {
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  if (phaseId === 0) {
    emitChatMessage(
      "system",
      "🐛 Faz 0 (Hata Ayıklama) standalone'dur — tek başına 'çalıştır' ile başlamaz. " +
        "Yaşadığın hatayı/sorunu chat'e yaz; orkestratör otomatik olarak Debug Triage'ı başlatır.",
    );
    return;
  }
  if (runtime.controller) {
    // YZLLM 2026-06-11: "kullanıcı zaten Faz 11 yazdı, tekrar yazdırmanın anlamı yok." Kullanıcı hangi fazı
    // istediğini SÖYLEDİ → durunca OTOMATİK o fazdan devam et (yeniden yazdırma/yeniden bastırma YOK).
    if ("abort" in runtime.controller && typeof runtime.controller.abort === "function") {
      _userInitiatedAbort = true;
      _resumePhaseAfterAbort = phaseId as PhaseId;
      runtime.controller.abort();
    }
    emitChatMessage(
      "system",
      `⏹ Çalışan fazı durdurdum — durunca **Faz ${phaseId}'den otomatik devam edeceğim** (bir şey yazmana gerek yok).`,
    );
    return;
  }
  if (
    runtime.state.pending_diagnostic ||
    runtime.pendingPhaseRun
  ) {
    emitChatMessage(
      "system",
      "Bekleyen bir cevap var. Önce mevcut askq'yu sonuçlandır.",
    );
    return;
  }
  const spec = PHASE_SPECS[phaseId as PhaseId];
  if (!spec) {
    emitError(`Faz ${phaseId} spec yok`, null);
    return;
  }
  // Faz TR etiketi i18n'den (ortak yardımcı)
  const label = phaseLabelTR(phaseId, spec);
  if (directRun) {
    // Foreign proje "çalıştır" niyeti Faz 5 (UI codegen) diye eşlendiyse ama app zaten kurulu → dev-server'a yönlendir
    // (yanıltıcı "🚀 Faz 5 çalıştırılıyor" mesajını da ATLA — hiç UI kurmuyoruz). Log teşhisli fix.
    if (await redirectForeignRunToDevServer(phaseId)) return;
    // Agent ZATEN run_phase kararı verdi (kullanıcı "çalıştır" dedi) = AÇIK NİYET →
    // gereksiz onay askq'sı YOK (kardeş aksiyonlar approve_ui/resume_pipeline ile
    // tutarlı; v15.6 "açık niyete askq sorma" prensibi — YZLLM 2026-06-13: "zaten
    // çalıştır dedin ama gereksiz bi soru sordu"). Controller/pending/Faz-0 kontrolleri
    // yukarıda zaten yapıldı → güvenle doğrudan çalıştır.
    emitChatMessage("system", `🚀 **${label}** çalıştırılıyor.`);
    await handleRunPhase(phaseId as PhaseId, "advance");
    return;
  }
  const askqId = `phase-run-${randomUUID()}`;
  runtime.pendingPhaseRun = { askqId, phaseId: phaseId as PhaseId };
  emitChatMessage("system", `🚀 **${label}** — Ne yapayım?`);
  emitAskq({
    id: askqId,
    question: `**${label}** çalıştırılsın mı?`,
    // v15.7 (2026-05-28): Tek deterministik mod. Eski "Sadece Çalıştır" /
    // "Çalıştır ve İlerle" ayrımı askq'dan kaldırıldı (kullanıcı kuralı:
    // "faz geçişlerini deterministik yapalım"). Faz tamamlanınca pipeline
    // otomatik ilerler.
    options: ["✅ Çalıştır", "Vazgeç"],
    multi_select: false,
    allow_other: false,
  });
}

/**
 * Faz çalıştırma — askq cevabı sonrası çağrılır.
 *
 * v15.7 (2026-05-28): "only_run" mode askq UI'dan kaldırıldı (deterministik
 * geçiş kuralı). Kod yolu kalır — programatik testler veya gelecekte spesifik
 * features için. Sidebar tıklama akışı her zaman "advance" gelir.
 *
 * Mode'lar:
 * - "advance": state.current_phase = id, advanceToNextPhase ile pipeline ileri gider (tek geçerli mod kullanıcı akışında)
 * - "only_run" (DEPRECATED, programatik): controller bir kez çalışır, state.current_phase değişmez
 */
async function handleRunPhase(
  phaseId: PhaseId,
  mode: "only_run" | "advance",
): Promise<void> {
  // MAHKEME HIGH (2026-07-17): kullanıcı elle devam ediyor → bekle-ve-devam zamanlayıcısı iptal
  // (aksi halde reset saatinde insan + zamanlayıcı AYNI fazı iki kez koşturabilirdi).
  cancelLlmOutageWait();
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  const spec = PHASE_SPECS[phaseId];
  if (!spec) {
    emitError(`Faz ${phaseId} spec yok`, null);
    return;
  }

  // Foreign proje "çalıştır" → Faz 5 codegen değil, var olan app'i çalıştır (askq/sidebar yolu; directRun yolu
  // emitPhaseRunAskq'ta zaten yakalandı). Yönlendirdiyse burada bitir.
  if (await redirectForeignRunToDevServer(phaseId)) return;

  // Spec dependency kontrolü — defansif
  if ([4, 5, 6, 7, 9, 10].includes(phaseId)) {
    const specMdPath = currentSpecPath(runtime.state);
    try {
      await import("node:fs/promises").then((m) => m.access(specMdPath));
    } catch {
      emitChatMessage(
        "system",
        `⚠ **Faz ${phaseId}** için \`.mycl/spec.md\` (Faz 4 çıktısı) gerekli. Önce Faz 4'ü tamamla.`,
      );
      return;
    }
  }

  if (mode === "advance") {
    emitChatMessage(
      "system",
      `🚀 **Faz ${phaseId}** başlatılıyor — akış ilerleyecek.`,
    );
    // v15.7 (2026-05-26): Kullanıcı tıkladığı faz scope dışındaysa scope'a
    // ekle. Aksi takdirde isPhaseSkippedByScope true döner ve faz otomatik
    // atlanır — kullanıcı niyetine aykırı. Önceki zorunlu faz kontrolü
    // yapılmaz: kullanıcı zaten advanceToNextPhase(phaseId-1) ile bu noktadan
    // başlatıyor; daha öncekilere bakılmaz.
    if (
      runtime.state.needed_phases &&
      !runtime.state.needed_phases.includes(phaseId)
    ) {
      const updatedScope = [...runtime.state.needed_phases, phaseId].sort(
        (a, b) => a - b,
      );
      runtime.state = {
        ...runtime.state,
        needed_phases: updatedScope,
        updated_at: Date.now(),
      };
      await saveState(runtime.state);
      syncNeededPhases(); // kullanıcı faz ekledi → kapsam vurgusu güncellensin
      log.info("orchestrator", "user-clicked phase added to scope", {
        phaseId,
        scope: updatedScope,
      });
    }
    // v15.7 (2026-05-25) BUG FIX: Phase 0 standalone — PHASE_TRANSITIONS[0]=null.
    // phaseId=1 için prevPhase=0 → advanceToNextPhase(0) loop break ederdi.
    // Faz 1'i ayrı handle et: state'i 1'e koy, advanceToNextPhase'i 0'dan
    // çağırmak yerine "Faz 1 zaten current_phase, advance Faz 1'den başlayıp
    // tek tek ilerlesin" demek için phaseId=1 → prevPhase=null, manuel başlat.
    if (phaseId === 1) {
      // Faz 1 inline — restartPhase1WithIntent helper'ı zaten benzer iş yapıyor
      // ama intent_summary boş olabilir (yeni iter). Spec'ten intent_summary
      // yoksa kullanıcıdan beklenir — Phase 1 controller bunu yönetir.
      const intentForResume =
        runtime.state.intent_summary ?? "(devam: niyet tekrar açıklanacak)";
      runtime.state = {
        ...runtime.state,
        current_phase: 1,
        updated_at: Date.now(),
      };
      await saveState(runtime.state);
      await restartPhase1WithIntent(intentForResume);
      return;
    }
    // state.current_phase = phaseId - 1 → advanceToNextPhase ardışık olarak
    // phaseId'ye yükseltir ve çalıştırır. Pipeline N → N+1 → ... ilerler.
    const prevPhase = (phaseId - 1) as PhaseId;
    runtime.state = {
      ...runtime.state,
      current_phase: prevPhase,
      updated_at: Date.now(),
    };
    await saveState(runtime.state);
    await advanceToNextPhase(prevPhase);
    return;
  }

  // only_run: controller'ı doğrudan instantiate et + run. statePatch
  // discard edilir — sadece audit + chat output korunur.
  // v15.7 (2026-05-25): current_phase'i tıklanan faza güncelle — kullanıcı
  // talebi: "tıkladığım faz current faz olsun". emitPhaseChanged ile UI
  // header'ı + sidebar vurgusu yenilenir.
  const prevPhase = runtime.state.current_phase;
  runtime.state = {
    ...runtime.state,
    current_phase: phaseId,
    updated_at: Date.now(),
  };
  await saveState(runtime.state);
  setRecordContext({ phase: phaseId });
  emitPhaseChanged(prevPhase, phaseId, "running");
  emitChatMessage(
    "system",
    `🚀 **Faz ${phaseId}** tek seferlik çalıştırılıyor...`,
  );

  try {
    const result = await runPhaseOnce(phaseId, spec);
    if (result === "deferred") {
      // FROZEN-GOAL #10: Faz 6 'deferred' (UI inceleme PARKI) bir BAŞARI yolu — fail DEĞİL. Eski kod isSuccess=false
      // sayıp "❌ başarısız" yazıyor + pending_ui_review set ETMİYORDU → iş reconcile'da SESSİZCE orphan-drop oluyordu.
      // Normal advance yoluyla aynı: park bayrağı + 'waiting' statüsü (Phase6 inceleme istemini zaten yazdı).
      // HİÇBİR ŞEY SORMA (YZLLM 2026-07-09): tek-seferlik faz-run yolu da park ETMESİN → otomatik onayla + ilerle
      // (normal pipeline Faz 6 yoluyla simetrik; a11y raporu controller'da gösterildi). Mod kapalı → eski park davranışı.
      if (isNeverAsk()) {
        await appendAuditModule(runtime.state.project_root, {
          ts: Date.now(),
          phase: phaseId,
          event: "phase-6-complete",
          caller: "mycl-orchestrator",
          detail: "never_ask_auto_review",
        });
        emitChatMessage(
          "system",
          "🤖 Hiçbir şey sorma modu: Faz 6 UI incelemesi otomatik onaylandı — sonraki faza geçiliyor.",
        );
        await advanceToNextPhase(phaseId);
        return;
      }
      runtime.state = { ...runtime.state, pending_ui_review: true, updated_at: Date.now() };
      await saveState(runtime.state);
      emitPhaseChanged(phaseId, phaseId, "waiting");
      return;
    }
    if (result === "consent-stopped") {
      // Davranış-onay devre kesici: kullanıcı "Dur, spec'i gözden geçireceğim" dedi (mahkeme #1).
      // Kapı zaten "⏸️ Durdum" mesajını verdi → başarı/hata afişi YAZMA, yalnız 'waiting' park statüsü.
      emitPhaseChanged(phaseId, phaseId, "waiting");
      return;
    }
    // v15.7 (2026-05-27): result mapping düzeltildi. LLM controller'lar
    // "complete"/"fail"; mechanical "pass"/"fail"/"skipped". Önceden sadece
    // "complete" başarı sayılıyordu → mechanical pass "error" statüsüne
    // düşüyor, header "HATA" gösteriyordu (chat ⚠ pass).
    const isSuccess = result === "complete" || result === "pass" || result === "skipped";
    const icon = result === "skipped" ? "⏭" : isSuccess ? "✅" : "❌";
    // v15.8 (2026-05-30): İngilizce sonuç jetonu yerine sade Türkçe.
    const sonucTR =
      result === "skipped"
        ? "atlandı"
        : isSuccess
          ? "geçti"
          : "başarısız";
    emitChatMessage(
      "system",
      `${icon} **${phaseLabelTR(phaseId, spec)}** — ${sonucTR}.`,
    );
    emitPhaseChanged(phaseId, phaseId, isSuccess ? "complete" : "error");
  } catch (err) {
    log.error("orchestrator", "only-run failed", err);
    emitError(`Faz ${phaseId} tek koşumu başarısız`, String(err));
    emitPhaseChanged(phaseId, phaseId, "error");
  }
}

/**
 * Tek-shot faz çalıştırma — controller spawn, statePatch ignore.
 * Tüm phase controller'ları aynı (state, config, spec) constructor +
 * .run() döndürür.
 */
async function runPhaseOnce(
  phaseId: PhaseId,
  spec: PhaseSpec,
): Promise<string> {
  if (!runtime.state || !runtime.config) return "fail";
  const state = runtime.state;
  const cfg = runtime.config;

  // YZLLM (cave5): ENTEGRE (foreign-origin) projede Faz 6 (UI İncelemesi) tek-shot/resume yolunda da ATLANIR
  // — advanceToNextPhaseInner'daki skip ile aynı kural. Mevcut projede UI-inceleme parkı uygun değil; manuel
  // "Çalıştır" veya deferred-park resume bu noktaya düşse bile incelemeyi koşmadan geç. phase-6-complete KORUNUR.
  if (phaseId === 6 && state.origin === "foreign") {
    await appendAuditModule(state.project_root, {
      ts: Date.now(),
      phase: 6,
      event: "phase-6-skipped-integrate",
      caller: "mycl-orchestrator",
      detail: "origin=foreign → entegre modunda UI incelemesi atlanır (runPhaseOnce)",
    });
    await appendAuditModule(state.project_root, {
      ts: Date.now(),
      phase: 6,
      event: "phase-6-complete",
      caller: "mycl-orchestrator",
    });
    emitChatMessage(
      "system",
      "Faz 6 (UI İncelemesi) atlandı — entegre modunda yapılmaz (mevcut projede boşluk işleri UI yapımı değil).",
    );
    log.info("orchestrator", "phase 6 skipped (integrate mode, runPhaseOnce)", { origin: state.origin });
    return "skipped";
  }

  // v15.7 (2026-05-26): Production readiness madde 15 — Tool risk taxonomy.
  // Phase başlamadan önce ajanın risk_level'ini audit'e yaz. High-risk
  // ajanlar (Write/Edit/Bash erişimi olan codegen fazları) görünür sinyal
  // bırakır. Şu an hard-block YOK — sadece izlenebilirlik.
  try {
    const variant: "tweak" | undefined =
      phaseId === 5 && state.pending_ui_tweak ? "tweak" : undefined;
    const agentId = phaseIdToAgentId(phaseId, variant);
    if (agentId) {
      const acl = getAgentACL(agentId);
      if (acl) {
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: phaseId,
          event: "risk-check",
          caller: "mycl-orchestrator",
          detail: `agent=${agentId} risk=${acl.risk_level} tools=[${acl.allowed_tools.join(",")}]`,
        });
      }
    }
  } catch (err) {
    log.warn("orchestrator", "risk-check audit failed (non-blocking)", err);
  }

  // Her controller için aynı pattern: new Class(state, config, spec).run()
  let result: string;
  switch (phaseId) {
    case 1: {
      const p = new Phase1Controller({ state, config: cfg, spec });
      runtime.controller = p;
      try {
        // Phase 1 user_intent_tr alır — only_run modunda mevcut state.intent_summary
        // fallback. Yoksa generic prompt.
        const intent = state.intent_summary ?? "(devam — kullanıcı niyetini tekrar değerlendir)";
        const r = await p.run(intent);
        result = String(r);
      } finally {
        runtime.controller = null;
      }
      break;
    }
    case 2: {
      const p = new Phase2Controller({ state, config: cfg, spec });
      runtime.controller = p;
      try {
        result = String(await p.run());
      } finally {
        runtime.controller = null;
      }
      break;
    }
    case 3: {
      const p = new Phase3Controller({ state, config: cfg, spec });
      runtime.controller = p;
      try {
        result = String(await p.run());
      } finally {
        runtime.controller = null;
      }
      break;
    }
    case 4: {
      const p = new Phase4Controller({ state, config: cfg, spec });
      runtime.controller = p;
      try {
        result = String(await p.run());
      } finally {
        runtime.controller = null;
      }
      break;
    }
    case 5: {
      const p = new Phase5Controller({ state, config: cfg, spec });
      runtime.controller = p;
      try {
        result = String(await p.run());
      } finally {
        runtime.controller = null;
      }
      break;
    }
    case 6: {
      const p = new Phase6Controller({ state, config: cfg, spec });
      runtime.controller = p;
      try {
        result = String(await p.run());
      } finally {
        runtime.controller = null;
      }
      break;
    }
    case 7: {
      const p = new Phase7Controller({ state, config: cfg, spec });
      runtime.controller = p;
      try {
        result = String(await p.run());
      } finally {
        runtime.controller = null;
      }
      break;
    }
    case 8: {
      // Davranış-onay kapısı (sidebar tek-koş yolu da onay bağlamını korur — mahkeme #5).
      // Devre kesicide "Dur" → "skipped" (başarı afişi) YANLIŞ olurdu (mahkeme #1); ayrı jeton.
      if (!(await runBehaviorConsentGate(state, cfg))) {
        result = "consent-stopped";
        break;
      }
      // EDD (foreign): mevcut-davranış haritasını codegen notuna kur (tek-koş yolu da bağlamı korur; MyCL'de no-op).
      await attachEddCodegenNote(state);
      const p = new Phase8Controller({ state, config: cfg, spec });
      runtime.controller = p;
      try {
        result = String(await p.run());
      } finally {
        runtime.controller = null;
        // Onay + EDD notu Faz 8'e özgü — tüketildi; sızmasın (mahkeme #2). Throw'da da temizlensin diye finally.
        state.pending_behavior_consent_note = undefined;
        state.behavior_consent_no_paths = undefined;
        state.pending_edd_context_note = undefined;
      }
      break;
    }
    case 9: {
      const p = new Phase9Controller({ state, config: cfg, spec });
      runtime.controller = p;
      try {
        result = String(await p.run());
      } finally {
        runtime.controller = null;
      }
      break;
    }
    default:
      // v15.7 (2026-05-25): Mechanical phase'ler (10-17) için MechanicalRunnerBase.
      // Önceden "no-controller-for-phase-N" hatası dönüyordu.
      if (spec.type === "mechanical" && spec.mechanical_config) {
        // v15.7 (2026-05-27): Faz 16 only-run akışında da Playwright pre-step.
        // Advance loop'taki pre-step burada da koşmalı — "Sadece Çalıştır"
        // butonu farklı code path kullanıyor. proceed=false ise skip event
        // yazılıp mechanical runner çağrılmaz.
        if (phaseId === 16) {
          const pre = await ensurePlaywrightForPhase16(state);
          if (!pre.proceed) {
            await appendAuditModule(state.project_root, {
              ts: Date.now(),
              phase: 16,
              event: "phase-16-skipped",
              caller: "mycl-orchestrator",
              detail: `precheck_fail reason=${pre.reason}`,
            });
            result = "skipped";
            break;
          }
        }
        const passEvent = spec.required_audits[0] ?? `phase-${phaseId}-pass`;
        const failEvent = spec.required_audits[1];
        const runner = new MechanicalRunnerBase({
          tag: `phase-${phaseId}`,
          displayLabel: phaseLabelTR(phaseId, spec),
          phaseId,
          state,
          mechanical: spec.mechanical_config,
          pass_event: passEvent,
          fail_event: failEvent,
          // v15.9: scoped kapsam set ise değişen dosyalara daralt.
          changedScope: state.changed_scope?.files,
        });
        try {
          const outcome = await runner.run();
          result = outcome.kind; // "pass" | "fail" | "skipped"
        } catch (err) {
          log.error("phase-only-run", `mechanical ${phaseId} failed`, err);
          result = "fail";
        }
      } else {
        result = `no-controller-for-phase-${phaseId}`;
      }
  }
  return result;
}

/**
 * v15.7 (2026-05-27): Faz 16 öncesi Playwright pre-step.
 * Hem advanceToNextPhase loop'unda hem only-run akışında çağrılır.
 *
 * Sıra:
 *   1. Package install (`ensurePlaywrightInstalled`)
 *   2. Scaffold check + otomatik init (`ensurePlaywrightScaffold`)
 *
 * `{ proceed: false, reason }` döndüğünde caller mechanical runner'ı
 * çalıştırmadan skip event yazıp ilerlemeli.
 */
type Phase16Precheck =
  | { proceed: true }
  | {
      proceed: false;
      reason: "install_failed" | "scaffold_failed" | "unsupported";
    };

async function ensurePlaywrightForPhase16(
  state: State,
): Promise<Phase16Precheck> {
  if (!state.stack?.startsWith("node-")) {
    log.info("orchestrator", "phase-16 playwright pre-step skipped (non-node stack)", {
      stack: state.stack,
    });
    return { proceed: true };
  }
  emitChatMessage(
    "system",
    "🧪 Playwright kontrol ediliyor (gerekirse kurulum yapılacak)...",
  );
  const ensureRes = await ensurePlaywrightInstalled(
    state.project_root,
    state.stack,
  );
  await appendAuditModule(state.project_root, {
    ts: Date.now(),
    phase: 16,
    event: ensureRes.ok
      ? `playwright-${ensureRes.action}`
      : `playwright-install-failed`,
    caller: "mycl-orchestrator",
    detail:
      ensureRes.message +
      (ensureRes.error ? ` :: ${ensureRes.error.slice(0, 200)}` : ""),
  });
  if (ensureRes.action === "installed") {
    emitChatMessage("system", `✅ ${ensureRes.message}`);
  } else if (ensureRes.action === "already") {
    // Sessizlik düzelt — kullanıcı kontrol sonucunu görsün
    emitChatMessage("system", "✅ Playwright zaten kurulu, kontrol tamam.");
  } else if (ensureRes.action === "failed") {
    emitChatMessage(
      "system",
      `❌ ${ensureRes.message} — Faz 16 muhtemelen başarısız olacak.`,
    );
    return { proceed: false, reason: "install_failed" };
  } else if (ensureRes.action === "unsupported") {
    // FROZEN-GOAL #14: 'unsupported' sessizce skip ediyordu — kullanıcı E2E'nin neden atlandığını görmüyordu.
    // Tek kaynak (her iki caller'ı kapsar): görünür bilgi mesajı (akışı engellemez).
    emitChatMessage("system", "⏭ Faz 16 (E2E) atlandı — bu stack için Playwright/E2E desteklenmiyor (bilgi; akış sürer).");
    return { proceed: false, reason: "unsupported" };
  }

  // Scaffold check + auto-init
  let defaultPort = 5173;
  let devCommand: string | null = null;
  try {
    const profile = await loadProfile(state.stack);
    if (profile?.default_port) defaultPort = profile.default_port;
    // Önden-doğru: dev komutu playwright webServer bloğuna girer → Faz 16 E2E
    // server'ı otomatik başlatır (sarı kalmasın).
    devCommand = profile?.commands?.dev ?? null;
  } catch (err) {
    log.warn("orchestrator", "profile load for default_port failed", err);
  }
  const scaffoldRes = await ensurePlaywrightScaffold(
    state.project_root,
    defaultPort,
    devCommand,
  );
  await appendAuditModule(state.project_root, {
    ts: Date.now(),
    phase: 16,
    event: scaffoldRes.ok
      ? `playwright-scaffold-${scaffoldRes.action}`
      : `playwright-scaffold-failed`,
    caller: "mycl-orchestrator",
    detail:
      scaffoldRes.message +
      (scaffoldRes.error ? ` :: ${scaffoldRes.error.slice(0, 200)}` : ""),
  });
  if (scaffoldRes.action === "scaffolded") {
    emitChatMessage("system", `✅ ${scaffoldRes.message}`);
  } else if (scaffoldRes.action === "failed") {
    emitChatMessage(
      "system",
      `❌ ${scaffoldRes.message}${scaffoldRes.error ? ` (${scaffoldRes.error.slice(0, 120)})` : ""}`,
    );
    return { proceed: false, reason: "scaffold_failed" };
  }
  // "already" → silent (chat'i kirletme)

  // v15.8 (2026-05-28): Auth template — .mycl/auth.json placeholder yaz.
  // Smoke test login flow için credentials okuma yeri. Yoksa template + chat
  // hint kullanıcıyı yönlendirir; varsa dokunulmaz.
  const authRes = await ensureAuthTemplate(state.project_root);
  await appendAuditModule(state.project_root, {
    ts: Date.now(),
    phase: 16,
    event: authRes.ok ? `auth-template-${authRes.action}` : "auth-template-failed",
    caller: "mycl-orchestrator",
    detail: authRes.message + (authRes.error ? ` :: ${authRes.error.slice(0, 200)}` : ""),
  });
  if (authRes.action === "written") {
    emitChatMessage("system", authRes.message);
  }
  // "exists" → silent; "failed" → non-blocking (smoke yine çalışsın)

  return { proceed: true };
}

/**
 * v15.8 (2026-05-30): Faz 16 (E2E) geçtikten sonra DÜRÜST not. "geçti" tek
 * başına yanıltıcı — MyCL yalnızca çıkış kodu sıfır mı bakıyor. Gerçekte ne
 * doğrulandığını söyle: yer tutucu duman testi mi, giriş yapıldı mı.
 * Fail-safe: hata olursa sessiz (not eklemez, akışı bozmaz).
 */
async function emitPhase16HonestyNote(state: State): Promise<void> {
  try {
    const v = await assessPhase16Verification(state.project_root);
    const notes: string[] = [];
    if (v.smokeKind === "placeholder") {
      notes.push(
        "Çalışan test MyCL'in oluşturduğu **genel bir sayfa açılış kontrolü** — senin özel isteğini (örneğin belirli bir özelliğin gerçekten çalışması) test etmez.",
      );
    }
    if (v.authStatus === "placeholder") {
      notes.push(
        "Giriş yapılmadı (giriş bilgisi hâlâ yer tutucu); yalnızca giriş öncesi sayfa görüldü. Gerçek giriş için `.mycl/auth.json`'daki kullanıcı adı ve şifreyi doldur.",
      );
    }
    if (notes.length > 0) {
      emitChatMessage("system", "ℹ️ Dürüst not: " + notes.join(" "));
    }
  } catch (err) {
    log.warn("orchestrator", "phase-16 honesty note failed", err);
  }
}

/**
 * v15.8 (2026-05-30): Akış sonu dürüst özet. İstenen niyet ile gerçekte ne
 * doğrulandığını karşılaştırır; her şey gerçek doğrulanmadıysa açıkça söyler
 * (yanlış "tamamlandı" hissi verme). Fail-safe.
 */
async function emitPipelineEndSummary(state: State): Promise<void> {
  try {
    const intent = (state.intent_summary ?? "").trim();
    const v16 = await assessPhase16Verification(state.project_root);
    // DÜRÜST hüküm (YZLLM'in #1 endişesi: "sessizce TAMAMLANDI deme"). Mekanik
    // gate'ler (Faz 10-17) SOFT — patlasa bile orkestratör `phase-N-complete`
    // (soft_complete_after_fail) yazıp devam eder. computeVerdict audit'ten
    // gerçeği çıkarır: gate-fail veya güvenlik-skip varsa hüküm PASS değildir.
    let verdict: HarnessVerdict | null = null;
    try {
      // SARI-GATE KÖK FIX (YZLLM 2026-06-20, canlı remax_BO iter#2 bulgusu): verdict YALNIZ BU İTERASYONUN
      // olaylarına baksın. audit.jsonl append-only + tüm iterasyonları tutar → eski computeVerdict TÜM log'u
      // okuyup ÖNCEKİ iterasyonun gate-fail'lerini (örn. iter#1'de sarı kalan Faz 11/12/16) BU iterasyona
      // taşıyordu → gate gerçekte temiz geçse bile "yine sarı"/PARTIAL. iteration_started_at'tan itibaren süz
      // (genuine bu-iterasyon fail'i pencere içinde kalır → doğru sarı). İlk-ever (set yok) → tümü (geriye-uyumlu).
      const allEvents = await readAuditLog(state.project_root);
      // BOŞ-BUILD KORUMASI (2026-06-24): deliverable üretilmediyse (Faz 5 yanlış atlandı vb.) hüküm FAIL —
      // gate'ler yoklukta sahte-geçip "yeşil" demesin.
      const deliverableExists = await hasDeliverable(state.project_root);
      verdict = computeVerdict(eventsSince(allEvents, state.iteration_started_at ?? 0), { deliverableExists });
    } catch (err) {
      // Pipeline-sonu hüküm (sessiz-fallback denetimi): audit okunamazsa verdict null kalır → özet hükümsüz.
      // log.warn→log.error + GÖRÜNÜR (kullanıcı gate sonuçlarını elle kontrol etsin).
      log.error("orchestrator", "pipeline-sonu hüküm (verdict) hesaplanamadı (audit okunamadı)", err);
      emitChatMessage("system", "⚠️ Pipeline sonu hükmü hesaplanamadı (audit okunamadı) — gate sonuçlarını elle kontrol et.");
    }
    // Token okuma kendi içinde fail-safe — okunamazsa boş döküm (özet yine çıkar).
    let costs: Awaited<ReturnType<typeof readCosts>> = [];
    try {
      costs = await readCosts(state.project_root);
    } catch (err) {
      log.warn("orchestrator", "cost summary failed (non-blocking)", err);
    }
    emitChatMessage(
      "system",
      buildPipelineEndLines({ intent, v16, verdict, costs }).join("\n"),
    );
    // Frontend'e yapılandırılmış hüküm — sidebar başarısız gate'lere ⚠️ bassın,
    // header kısmî/başarısız çipi göstersin (ordinal ✅ "sessiz yeşil" yalanını düzeltir).
    if (verdict) {
      emit("pipeline_end", {
        verdict: verdict.verdict,
        gateFailures: verdict.gateFailures.map((g) => g.phase),
        securitySkipped: verdict.securitySkipped,
        realAppSkipped: verdict.realAppSkipped,
      });
    } else {
      // FROZEN-GOAL #16: verdict hesaplanamadı (audit okunamadı; üstte görünür uyarı verildi) → pipeline_end
      // emit EDİLMEZSE frontend pipelineVerdict null kalır → sidebar chip yok → SESSİZ FALSE-GREEN izlenimi.
      // Bilinen non-green değerle (PARTIAL) emit et: chip "tam doğrulanmadı" göstersin.
      emit("pipeline_end", { verdict: "PARTIAL", gateFailures: [], securitySkipped: [] });
    }
  } catch (err) {
    // FROZEN-GOAL #15: özet üretimi patlarsa eski kod yalnız log.warn yapıyordu → kullanıcı pipeline'ın
    // hükümsüz bittiğini hiç görmüyordu (sessiz). Görünür kıl.
    log.error("orchestrator", "pipeline end summary failed", err);
    emitChatMessage("system", "⚠️ Pipeline sonu özeti üretilemedi — gate sonuçlarını elle kontrol et.");
  }
}

// v15.1.4: dispatch switch IpcRouter sınıfına taşındı. Handler'lar register
// edilir; ipc-router.ts kind→handler map + dispatch logic'i sağlar. Index.ts
// burada sadece register call'ları + handler tanımları (runtime closure).
const ipcRouter = new IpcRouter();
ipcRouter.register("ping", (data: unknown) =>
  emit("pong", { ts: Date.now(), echo: data ?? null }),
);
ipcRouter.register("open_project", async (data: unknown) => {
  const d = data as { path?: string; integrate?: boolean } | undefined;
  // Proje değişiyor → önceki projeye ait bekleyen command_direct'ler bayat → at.
  commandDirectQueue.clear();
  await handleOpenProject(String(d?.path ?? ""), d?.integrate === true);
});
ipcRouter.register("user_message", async (data: unknown) => {
  const d = data as { text?: string } | undefined;
  await handleUserMessage(String(d?.text ?? ""));
});
// YZLLM 2026-06-16: SORU modu — composer toggle açıkken mesaj BU yoldan gelir (user_message DEĞİL) →
// salt-okunur danışma, pipeline'a hiç girmez (ayrı handler; user_message akışı değişmez, regresyon yok).
ipcRouter.register("ask_question", async (data: unknown) => {
  const d = data as { text?: string } | undefined;
  await handleAskQuestion(String(d?.text ?? ""));
});
// YZLLM 2026-06-26 (req 4): Orkestra paneli composer'ı → KALICI YÖNERGE (görev değil). Orkestratör benimser/itiraz eder.
ipcRouter.register("orchestrator_directive", async (data: unknown) => {
  const d = data as { text?: string } | undefined;
  await handleOrchestratorDirective(String(d?.text ?? ""));
});
// SORU modu aç/kapa (YZLLM 2026-06-19): her geçişte oturum geçmişini SİL ("kapatınca tamamen silinir").
// Açılışta chat'e hatırlatma bas. (Frontend toggle bu eventi gönderir.)
ipcRouter.register("set_question_mode", async (data: unknown) => {
  const d = data as { enabled?: boolean } | undefined;
  questionModeHistory = []; // aç VEYA kapa → geçmiş tamamen silinir (gizlilik + temiz bağlam)
  if (d?.enabled === true) {
    emitChatMessage(
      "system",
      "💬 Soru modu açık — soru modunda konuştuklarımız, soru modunu kapattığınızda tamamen silinir.",
    );
  }
});
ipcRouter.register("command_direct", async (data: unknown) => {
  const d = data as { text?: string; intent_kind?: string } | undefined;
  // intent_kind UI butonundan zorunlu; eski kayıtlarda yoksa "run" fallback.
  const intentKindRaw = String(d?.intent_kind ?? "run");
  const validKinds = ["run", "test", "build", "install", "lint"] as const;
  type Kind = (typeof validKinds)[number];
  const intentKind: Kind = (validKinds as readonly string[]).includes(intentKindRaw)
    ? (intentKindRaw as Kind)
    : "run";
  await handleCommandDirect(String(d?.text ?? ""), intentKind);
});
ipcRouter.register("phase_run_request", async (data: unknown) => {
  const d = data as { id?: number } | undefined;
  await emitPhaseRunAskq(Number(d?.id ?? 0));
});
// WP4 DAST: 🛡️ buton — yalnız açıklama+onay askq'ı açar (handleRunDastRequest);
// tarama onay sonrası handleAskqAnswer pendingDast branch'inde çalışır.
ipcRouter.register("run_dast", async () => {
  await handleRunDastRequest();
});
// v15.7 (2026-05-25): intent_direct IPC kaldırıldı — frontend sidebar
// intent button'ları artık yok, bu handler dead code'tu.
ipcRouter.register("askq_answer", async (data: unknown) => {
  const d = data as { id?: string; selected?: unknown } | undefined;
  const raw = d?.selected;
  const selected: string | string[] = Array.isArray(raw)
    ? raw.map(String)
    : String(raw ?? "");
  await handleAskqAnswer(String(d?.id ?? ""), selected);
  // Yeniden-inceleme round-4 #2: bazı askq dalları (phase-scope "Vazgeç", hata
  // "İş listesine kaydet") parkı pipeline'ı İLERLETMEDEN çözer → advanceToNextPhase
  // finally tetiklenmez + handleAskqAnswer handleUserMessage'dan geçmez → çalışan
  // kuyruk işi orphan kalır + kuyruk durur. Burada reconcile (guard'lı: pipeline
  // koşuyor/parklıysa no-op) orphan'ı uzlaştırır + bekleyeni sürdürür.
  await reconcileAndDrainTasks().catch((e: unknown) =>
    log.error("orchestrator", "askq sonrası kuyruk uzlaştırma hatası", e),
  );
});
// 🧪 Full Test (2026-07-16): buton yalnız onay askq'ı açar; koşum handleAskqAnswer
// pendingFullTest dalında (DAST deseni — onay baypası imkânsız).
ipcRouter.register("run_full_test", async () => {
  await handleRunFullTestRequest();
});
// ⏹ Full Test iptal (2026-07-22): işlevsel doğrulama uzun sürebilir → kullanıcı "İptal"e basınca
// çalışan özellik bitince kalan özellikler atlanır. Full Test lock TUTMAZ + IPC dispatch await'siz
// (app.ts) → bu handler Full Test askıdayken concurrent çalışıp AbortController'ı tetikler.
ipcRouter.register("cancel_full_test", async () => {
  if (runtime.fullTestAbort && !runtime.fullTestAbort.signal.aborted) {
    runtime.fullTestAbort.abort();
    emitChatMessage("system", "⏹ Full Test iptal ediliyor — çalışan özellik bitince kalanlar atlanacak.");
  }
});
// 🔧 Bakım Turu (2026-07-16): aynı desen — buton onay askq'ı açar.
ipcRouter.register("run_maintenance", async () => {
  await handleRunMaintenanceRequest();
});
// 🧾 Özet (2026-07-19): sohbet geçmişini önemli yerleri atlamadan Türkçe özetler (salt okuma;
// orkestratör rolü — dil hattına uygun, main'e hiçbir şey gitmez). Fire-and-forget: pipeline'ı bloklamaz.
ipcRouter.register("summarize_chat", async () => {
  if (!runtime.state || !runtime.config) {
    // MAHKEME MEDIUM (2026-07-19): chat_message YERİNE özet kanalı — özet asla sohbete/history'ye yazmaz.
    emit("chat_summary", { state: "error", message: "Özet için önce bir proje aç." });
    return;
  }
  const summaryRoot = runtime.state.project_root;
  void runChatSummary(runtime.config, summaryRoot, () => runtime.state?.project_root === summaryRoot);
});
// 🗺️ Plan Modu (2026-07-16): composer pili — AÇIKKEN kullanıcı mesajları plana çevrilir.
ipcRouter.register("set_plan_mode", async (data: unknown) => {
  const d = data as { enabled?: boolean } | undefined;
  const on = d?.enabled === true;
  setPlanMode(on);
  // MAHKEME MEDIUM (2026-07-16): mod KAPATILINCA bekleyen revizyon durumu da temizlenmeli —
  // yoksa kullanıcı modu kapattığı hâlde sonraki mesajı sessizce plan revizyonuna gidiyordu.
  if (!on) runtime.pendingPlanEdit = null;
  log.info("orchestrator", "plan mode", { enabled: on });
});
ipcRouter.register("save_api_keys", async (data: unknown) => {
  await handleSaveApiKeys(data as Partial<ApiKeys>);
});
ipcRouter.register("check_config", async () => {
  await emitConfigStatus();
});
ipcRouter.register("list_models", async (data: unknown) => {
  const d = data as { which?: string; force?: boolean } | undefined;
  await handleListModels(
    (d?.which as "translator" | "main") ?? "translator",
    Boolean(d?.force),
  );
});
ipcRouter.register("save_settings", async (data: unknown) => {
  await handleSaveSelectedModels(
    data as SelectedModels & { effort?: string; backends?: Partial<AgentBackends> },
  );
});
ipcRouter.register("read_selected_models", async () => {
  await handleReadSelectedModels();
});
// Denetim Ajanı (YZLLM 2026-06-11): sorularla orkestratörü denetle → rapor → MyCL-içi çözülebilirler
// vs kaynak-kodu-değişikliği gerekenler ayrımı → chat. NOT (2026-07-03): 🕵️ Kalite Kontrol butonu
// UI'dan kaldırıldı; bu handler bilinçli korunuyor (event tetiklenirse akış aynen koşar).
ipcRouter.register("start_quality_audit", async (data: unknown) => {
  if (!runtime.state || !runtime.config) {
    emitError("Aktif proje yok", null);
    return;
  }
  // YZLLM 2026-06-12 ("paralel-güvenli işi kaynak varsa başlat"): denetim ajanı faz çalışırken serbest koşar
  // (paralel-güvenli) ama AYNI ağır ajanı ikinci kez başlatma — çift-tık re-entrancy guard (DAST'taki gibi).
  if (_qualityAuditRunning) {
    emitChatMessage("system", "🕵️ Bir kalite denetimi zaten sürüyor — bitmesini bekle.");
    return;
  }
  _qualityAuditRunning = true;
  try {
    await runQualityAuditFlow(data);
  } finally {
    _qualityAuditRunning = false;
  }
});
let _qualityAuditRunning = false;
async function runQualityAuditFlow(data: unknown): Promise<void> {
  if (!runtime.state || !runtime.config) return;
  const questions = String((data as { questions?: unknown })?.questions ?? "").trim() || DEFAULT_QUALITY_QUESTIONS;
  const res = await runQualityAudit(runtime.config, runtime.state, questions);
  if (!res) return;
  // Raporu göster (TR).
  emitChatMessage("system", `🕵️ **Denetim Raporu**\n\n${res.reportTr}`);
  const rep = res.report;
  if (rep) {
    // Orkestratör triage: MyCL-içi ele alınabilirler (runtime) vs kaynak-kodu (geliştiriciye iletilecek).
    if (rep.fixable_in_mycl.length) {
      emitChatMessage(
        "system",
        `✅ **MyCL içinde ele alabileceklerim:**\n` + rep.fixable_in_mycl.map((x) => `• ${x}`).join("\n"),
      );
    }
    if (rep.needs_source_change.length) {
      emitChatMessage(
        "system",
        `🔧 **Bunları yapabilmem için kaynak kodumun geliştirilmesi gerekiyor** (kopyalayıp geliştiriciye/Claude'a yapıştırabilirsin):\n\n` +
          rep.needs_source_change.map((x, i) => `${i + 1}. ${x}`).join("\n"),
      );
    }
    if (!rep.fixable_in_mycl.length && !rep.needs_source_change.length) {
      emitChatMessage("system", "✅ Denetim temiz — bu koşuda kayda değer bir kalite sorunu bulunmadı.");
    }
  }
}
// v15.7 (2026-05-25): Feature flags IPC
ipcRouter.register("save_features", async (data: unknown) => {
  await handleSaveFeatures(data as Partial<import("./config.js").FeatureFlags>);
});
ipcRouter.register("read_features", async () => {
  await handleReadFeatures();
});
ipcRouter.register("run_context_trim_doctor", async () => {
  await handleRunContextTrimDoctor();
});
ipcRouter.register("list_phases", () => {
  handleListPhases();
});
ipcRouter.register("abort_phase", () => {
  if (!runtime.controller) {
    emitChatMessage("system", "Abort: aktif faz yok.");
    return;
  }
  if ("abort" in runtime.controller && typeof runtime.controller.abort === "function") {
    log.info("orchestrator", "abort_phase", {
      phase: runtime.state?.current_phase,
    });
    // YZLLM 2026-06-11: durdur-butonu = KULLANICI kesmesi — başarısızlık DEĞİL. Bu bayrak olmadan failPhase
    // kesmeyi gerçek hata sanıp escalation'a kaydediyordu (rapor %0'larla doldu) + analiz başlatıyordu.
    _userInitiatedAbort = true;
    runtime.controller.abort();
    emitChatMessage(
      "system",
      `Abort sinyali gönderildi (Faz ${runtime.state?.current_phase}). Mevcut tur tamamlanınca durur.`,
    );
  } else {
    emitError("Aktif denetleyici durdurmayı desteklemiyor", null);
  }
});
ipcRouter.register("load_messages", async (data: unknown) => {
  await handleLoadMessages(
    data as { since_ts: number; until_ts?: number; limit: number },
  );
});
// Token-timeline: proje açılışında/yenilemede tüm faz-cost geçmişini frontend'e ver
// (cost_phase canlı emit'i yalnız BU session'ın fazlarını taşır; load_costs geçmişi de getirir).
ipcRouter.register("load_costs", async () => {
  if (!runtime.state?.project_root) {
    emit("cost_history", { costs: [] });
    return;
  }
  try {
    const costs = await readCosts(runtime.state.project_root);
    emit("cost_history", { costs });
    // Panel açılışında öngörüyü de ver (naif avg×17 yerine per-faz medyan tahmini).
    emit("cost_forecast", { forecast: predictPipelineCost(costs, Array.from({ length: 17 }, (_, i) => i + 1)) });
  } catch (err) {
    log.warn("orchestrator", "load_costs failed", err);
    emit("cost_history", { costs: [] });
  }
});
ipcRouter.register("shutdown", () => {
  gracefulShutdown("ipc-shutdown");
});
// v15.7 (2026-05-24): iş kuyruğu IPC handler'ları
ipcRouter.register("task_queue_add", async (data: unknown) => {
  await handleTaskQueueAdd(data as { text: string });
});
ipcRouter.register("task_queue_remove", async (data: unknown) => {
  await handleTaskQueueRemove(data as { id: string });
});
// v15.13 (saha 3/5): Oto-cevap toggle (Orkestrator yanındaki checkbox).
ipcRouter.register("set_auto_answer", (data: unknown) => {
  setAutoAnswerSuggested((data as { enabled?: boolean } | undefined)?.enabled === true);
});
// HİÇBİR ŞEY SORMA (tam otonom) toggle (YZLLM 2026-07-09). Oto-cevabın ÜST-SEVİYESİ (superset):
// açıkken MyCL kullanıcıya hiç sormaz; zor/riskli kararlar mahkemeye. Güvenlik tabanı (bash-guard, Faz 13) korunur.
ipcRouter.register("set_never_ask", (data: unknown) => {
  setNeverAsk((data as { enabled?: boolean } | undefined)?.enabled === true);
});
// Duraklat/Devam (YZLLM 2026-06-13): paused=true → yeni LLM çağrıları bir sonraki
// sınırda bekler (in-flight tur tamamlanır); paused=false → kaldığı yerden devam.
ipcRouter.register("set_paused", (data: unknown) => {
  setPaused((data as { paused?: boolean } | undefined)?.paused === true);
});

async function dispatch(msg: IncomingCommand): Promise<void> {
  await ipcRouter.dispatch(msg);
}

/**
 * `<project>/.mycl/history.log`'tan geçmiş event chunk'ı yükler ve UI'a
 * `history_chunk` event'i olarak yollar. Boot'ta App.tsx 48h initial load,
 * sonra ChatPanel üst-scroll 24h chunk lazy-load çağırır.
 */
async function handleLoadMessages(input: {
  since_ts: number;
  until_ts?: number;
  limit: number;
}): Promise<void> {
  if (!runtime.state?.project_root) {
    emit("history_chunk", {
      events: [],
      older_available: false,
      oldest_returned_ts: 0,
    });
    return;
  }
  try {
    const result = await loadHistoryMessages(runtime.state.project_root, input);
    emit("history_chunk", result);
  } catch (err) {
    log.warn("orchestrator", "load_messages failed", err);
    emit("history_chunk", {
      events: [],
      older_available: false,
      oldest_returned_ts: 0,
    });
  }
}

// v15.1 Core: main() boot logic'i App'e taşındı. Module-global state
// (runtime.state/runtime.config/runtime.controller) hâlâ index.ts'de — v15.1.1'de
// App instance field'larına alınacak. Şu an composition root + DI hazırlığı.
async function main(): Promise<void> {
  // İş 6 (YZLLM 2026-06-20): GLOBAL logları (~/.mycl) 6 aydan eski satırlardan buda — PROJE
  // logları (<proje>/.mycl) ASLA silinmez. Fail-soft, non-blocking (boot'u geciktirmez).
  void pruneOldLogs(globalConfigDir()).catch(() => {});
  // HIZLI OTURUMLAR (2026-07-18): budama yalnız boot'ta koşuyordu — günlerce açık kalan oturumda
  // loglar sınırsız büyüyordu. 6 saatte bir tekrarla (unref: kapanışı engellemez; fail-soft).
  const logPruneTimer = setInterval(() => {
    void pruneOldLogs(globalConfigDir()).catch(() => {});
  }, 6 * 60 * 60_000);
  logPruneTimer.unref?.();
  const app = new App({
    loadI18n,
    startRuntimeHttpServer,
    emitConfigStatus,
    dispatch,
    gracefulShutdown,
  });
  await app.start();
  // CANLILIK BEKÇİSİ (YZLLM 2026-07-18 "hiç bir zaman durmayacağını garanti etmeliyiz"): bilinen dur
  // noktaları devam mekanizmalarına bağlı; bu, KAÇIRILMIŞ dur noktaları için yapısal emniyet ağı —
  // sistem tamamen boşta + meşru bekleme yok (askq/park/kesinti zamanlayıcısı) + seçilebilir iş varsa
  // kuyruğu GÖRÜNÜR sürdürür. Döngü üretemez: attempts tavanını doldurmuş işler seçilemez.
  startLivenessWatchdog(async () => {
    if (!runtime.state) return;
    const pendingOk =
      nextPendingTask(await readTasks(runtime.state.project_root).catch(() => [])) !== null;
    const snap = {
      busy: _handlingUserMessage || _pipelineDepth > 0 || runtime.controller !== null || _draining,
      askqOpen: getActiveAskq() !== null || isPipelineParked(),
      outageWaiting: isLlmOutageWaiting(),
      hasPending: pendingOk,
    };
    if (!shouldKickQueue(snap)) return;
    emitChatMessage(
      "system",
      "🫀 Canlılık bekçisi: sistem boşta ama bekleyen iş var — kuyruğu sürdürüyorum (donma yok).",
    );
    await appendAuditModule(runtime.state.project_root, {
      ts: Date.now(),
      phase: runtime.state.current_phase as PhaseId,
      event: "liveness-watchdog-kick",
      caller: "mycl-orchestrator",
      detail: "boşta + bekleyen iş + devam mekanizması yok → kuyruk sürüldü",
    }).catch(() => {});
    await kickWorkQueue();
  });
}

void main();
