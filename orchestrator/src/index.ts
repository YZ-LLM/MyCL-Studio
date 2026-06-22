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
  zaiKeyForRole,
  type AgentBackends,
  type ApiKeys,
  type ClaudeCodeFlags,
  type SelectedModels,
} from "./config.js";
import { loadOrInit, save as saveState } from "./state.js";
import { ensurePendingIterationDir, currentSpecPath } from "./devs-paths.js";
import { finalizeDevsArtifacts } from "./devs-finalize.js";
import { refreshDevsSpecs } from "./devs-spec-refresh.js";
import { clearHistory } from "./history.js";
import { appendAbandonedIntent } from "./abandoned-intents.js";
import {
  appendAudit as appendAuditModule,
  appendCost,
  readCosts,
  readAuditLog,
  readAuditLogTail,
  wasPipelineCompleted,
} from "./audit.js";
import { computeVerdict, eventsSince, type HarnessVerdict } from "./harness-verdict.js";
import { buildPipelineEndLines } from "./pipeline-end-summary.js";
import { detectInterruptedPhase2To9Pure } from "./resume-detection.js";
import { SerialWorkQueue } from "./serial-queue.js";
import {
  runDast,
  deriveRoutesFromFiles,
  findingToTaskText,
  severityToPriority,
  dedupeFindingsByTemplate,
  type DastSummary,
} from "./dast-runner.js";
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
} from "./task-queue/store.js";
import { intakeAndEnqueue } from "./task-queue/intake.js";
import type { TaskQueueItem } from "./task-queue/types.js";
import {
  beginPhaseCost,
  clearActiveAskq,
  emit,
  emitAskq,
  emitAskqResolved,
  emitChatMessage,
  emitError,
  emitIterationIntent,
  emitPhaseChanged,
  emitPhaseRunning,
  emitPhaseIdle,
  emitTechDoc,
  getActiveAskq,
  setHistoryRoot,
  takePhaseCost,
} from "./ipc.js";
import {
  appendHistory,
  loadMessages as loadHistoryMessages,
} from "./history-loader.js";
import {
  analyzeAndAskError,
  type ErrorContext,
  OPT_ACCEPT_CONTINUE,
  OPT_QUEUE,
  OPT_REANALYZE,
  type PendingErrorAnalysis,
} from "./error-analysis.js";
import { listModels } from "./models.js";
import { computeTiersFromModels } from "./model-catalog.js";
import { sumSecurityFindings, stepSecurityConvergence } from "./security-convergence.js";
import { runQualityAudit, DEFAULT_QUALITY_QUESTIONS } from "./quality-audit.js";
import { runRegressionGuard } from "./regression-guard.js";
import { isApiAccountError, isEnvironmentError, environmentErrorAdvice } from "./claude-api.js";
import { isClaudeAvailable } from "./codegen/cli-backend.js";
import { discoverModelsViaWeb, verifyModelCallable } from "./model-discovery.js";
import { ensureAgentSkills } from "./skills-setup.js";
import { runGateAutofix } from "./gate-autofix.js";
import { inspectGateFinding, mahkemeRuling, type MahkemeAction } from "./inspector.js";
import { Phase0Controller } from "./phase-0.js";
import { snapshotPrototype } from "./prototype-cache.js";
import { extractStockedModules } from "./module-stock.js";
import { generateGuideShots } from "./guide-shots.js";
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
import { Phase5Controller } from "./phase-5.js";
import { Phase6Controller } from "./phase-6.js";
import { ensureDevServerForReview } from "./smoke-test.js";
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
import { setSandboxPolicy } from "./agent-sandbox.js";
import { setCacheTtl } from "./codegen/cli-backend.js";
import { autoAnswerSuggested, setAutoAnswerSuggested } from "./auto-answer.js";
import { bootstrapLivingDocs, updateLivingDocs } from "./living-docs.js";
import { globalConfigDir } from "./paths.js";
import { pruneOldLogs } from "./log-retention.js";
import { getCachedProjectMap, clearProjectMapCache } from "./onboarding/project-map.js";
import { runMultiAgentSelection } from "./module-parallel/select.js";
import { reviewMergedModules, formatReview } from "./module-parallel/review.js";
import { setAgentTraceRoot } from "./agent-trace.js";
import { buildTouchpointSummary } from "./fix/touch-map.js";
import { formatBlastRadius } from "./fix/dep-graph/index.js";
import { MechanicalRunnerBase } from "./base/mechanical-runner.js";
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
import { verifyFeatureHandler } from "./verify-feature.js";
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
import { readFile as fsReadFile } from "node:fs/promises";
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
  } | null;
  // F1 (2026-06-04): Faz-fail sonrası LLM hata analizi askq'ı bekleniyor.
  // failPhase → analyzeAndAskError askq emit etti; cevap geldiğinde
  // handleAskqAnswer bu kaydı id ile eşleyip "Çöz" / "İş listesine kaydet" /
  // "Tekrar analiz et" dalını işler. null → açık analiz-askq'ı yok.
  pendingErrorAnalysis: PendingErrorAnalysis | null;
  // WP4 DAST (2026-06-04): 🛡️ buton emitAskq onay kartı açtı; "Başlat"/"İptal"
  // cevabı bekleniyor. null → açık DAST onay-askq'ı yok. handleAskqAnswer KATI
  // eşleşmeyle (askqId === id && selected === Başlat) işler; tarama yalnız buradan
  // tetiklenir (tek çağrı-noktası → onay-baypası imkânsız).
  pendingDast: { askqId: string } | null;
  // İş kuyruğu (YZLLM 2026-06-14): şu an Faz 1'den işlenen kuyruk işinin id'si.
  // pipeline-end bunu "done"+tarih ile damgalar + sıradaki bekleyen işi başlatır.
  // null → kuyruk-dışı iterasyon (örn. resume) ya da çalışan iş yok.
  currentTaskId: string | null;
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
  pendingDast: null,
  currentTaskId: null,
};

// WP4 DAST: onay-askq seçenek etiketi + "çalışıyor" banner etiketi. handleAskqAnswer
// taramayı YALNIZ selected === DAST_START_LABEL iken çalıştırır (kesin string eşleşme).
const DAST_START_LABEL = "🛡️ Başlat";
const DAST_RUNNING_LABEL = "🛡️ Güvenlik Taraması (DAST)";

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
  runtime.pendingDast = null;
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
const autoSolveSig = new Map<number, { sig: string; count: number }>();

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
  const GATE_DIMS: Record<number, string> = {
    10: "Lint", 11: "Sadeleştirme", 12: "Performans", 13: "Güvenlik",
    14: "Birim test", 15: "Entegrasyon", 16: "E2E", 17: "Sızma testi",
  };
  let audit: Awaited<ReturnType<typeof readAuditLogTail>>;
  try {
    audit = await readAuditLogTail(state.project_root, 500);
  } catch {
    return;
  }
  const since = state.iteration_started_at ?? 0;
  const thisIter = audit.filter((e) => (e.ts ?? 0) >= since);
  const passed: string[] = [];
  const skipped: string[] = [];
  for (const [nStr, dim] of Object.entries(GATE_DIMS)) {
    const n = Number(nStr);
    const skip = thisIter.find((e) => e.event === `phase-${n}-skipped`);
    const done = thisIter.some((e) => e.event === `phase-${n}-complete`);
    if (skip) skipped.push(`${dim}${skip.detail ? ` (${String(skip.detail).split(" ")[0]})` : ""}`);
    else if (done) passed.push(dim);
  }
  const lines = [`🔎 **Doğrulama özeti**`];
  if (passed.length) lines.push(`✅ Doğrulandı: ${passed.join(", ")}`);
  if (skipped.length) {
    lines.push(
      `⚠️ **DOĞRULANMADI (atlandı)**: ${skipped.join(", ")}`,
      `Bu boyutlar bu koşuda kontrol EDİLMEDİ (araç yok/uygulanamaz). "Geçti" anlamına gelmez — bilerek kabul et veya aracı ekle.`,
    );
  }
  emitChatMessage("system", lines.join("\n"));
}

// Merdiven KALDIRILDI (YZLLM 2026-06-16 "merdiven kullanmıcaz"): faz model+eforu artık iş-türüne göre SABİT
// (escalatedModelEffort) → "hangi model hangi işte iyi" merdiven-öğrenme raporu anlamını yitirdi → no-op
// (faz-complete kanca yeri korunur; ileride audit/telemetri için kullanılabilir).
async function recordRungOutcome(_n: PhaseId, _success: boolean): Promise<void> {}

// Verify-up yükseltme sınırı: faz başına en çok 2 (maliyet emniyeti; merdiven zaten sonlu). İterasyon başında temizlenir.
// Faz 13 güvenlik oto-çözüm sayacı (Oto-cevap açıkken otomatik fix denemesi sınırı; iterasyon başında sıfırlanır).
let _securityAutoResolveCount = 0;
// CASCADE-GUARD (YZLLM 2026-06-19): bu iterasyon bir güvenlik-bulgusu sistem-işinden mi doğdu. Faz 17 (Sızma
// Testi) güvenlik-iterasyonunda bulguları YENİDEN kuyruğa YAZMAZ → bulgu→Faz3→Faz17→bulgu sonsuz-cascade'i kırılır
// (normal iterasyon enqueue eder; onun fix-iterasyonları yalnız doğrular). runDevelopIteration başında set edilir.
let _iterationIsSecurityFix = false;
// Yakınsama-kırıcı (YZLLM 2026-06-14: "MyCL'e yakınsama-kırıcı ekle"): güvenlik fix'leri bulguları AZALTMIYORSA
// sonsuz döngüye girme. _securityAutoResolveCount iterasyon başında sıfırlanır (deep-solution yeni iterasyon açınca
// cap hiç dolmaz) → bu ikili İTERASYONDAN BAĞIMSIZ kalıcı; yalnız proje açılışında / Faz 13 çözülünce sıfırlanır.
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
}

async function failPhase(n: PhaseId, ctrl?: FailReasonHolder): Promise<void> {
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
    emitChatMessage(
      "system",
      "⛔ **Anthropic API krediniz/bakiyeniz yetersiz** + abonelik (`claude`) yok — bu bir ortam sorunu, proje hatası " +
        "DEĞİL. Plans & Billing'den kredi yükleyin (ya da `claude` kurup CLI moduna geçin), sonra **'Çalıştır'** ile " +
        "devam edin. Otomatik tırmanma/analiz YAPMADIM — hepsi API gerektirir, aynı hatayı verirdi.",
    );
    return; // STOP — escalation YOK, analiz YOK, fix YOK.
  }
  // GEÇİCİ API YÜKÜ (YZLLM 2026-06-17 canlı bulgu): "529 Overloaded" = Anthropic API aşırı-yük, GEÇİCİ. 5-deneme +
  // ~67s backoff sonrası bile sürüyorsa PROJE/KOD hatası DEĞİL → oto-çözüm/debug/tweak ANLAMSIZ. (Canlı kanıt:
  // 529 → tweak-modu → ajan ne yapacağını bilemeyip 9 dk cache/transcript dosyalarını kurcaladı, UI yazmadı.)
  // DUR + net rehber; kullanıcı birkaç dakika sonra "Çalıştır" ile aynı işi tekrar başlatır (auth/ortam ile aynı kalıp).
  if (/overloaded_error|"status":\s*529|\bOverloaded\b/i.test(`${ctrl?.lastFailReason ?? ""}\n${message}`)) {
    emitChatMessage(
      "system",
      "⏳ **Anthropic API şu an çok yoğun (529 Overloaded)** — 5 deneme + backoff'a rağmen geçmedi. Bu GEÇİCİ bir " +
        "yük (proje/kod hatası DEĞİL). Birkaç dakika bekleyip **'Çalıştır'** ile aynı işi tekrar başlat. Debug/düzeltme " +
        "YAPMADIM — hepsi yine API gerektirir, aynı hatayı verirdi.",
    );
    return; // STOP — oto-çözüm/debug/tweak YOK (geçici API yükü; ajanı boşa kurcalamaya sokma).
  }
  // GENEL ORTAM hatası (YZLLM 2026-06-11, E2BIG-döngüsü logu): E2BIG/port-dolu/komut-yok/spawn → PROJE hatası DEĞİL,
  // model zayıflığı DEĞİL. Debug/oto-çözüm döngüsü (proje kodunu kurcalar) ANLAMSIZ + ajan döngüye girer (logda
  // AC-marker'ı stub/yorumla geçmeye çalışıp sahte-yeşile kaydı). DUR + ortama-özel net rehber; tırmanma/analiz/fix YOK.
  {
    const envReason = `${ctrl?.lastFailReason ?? ""}\n${message}`;
    if (isEnvironmentError(envReason)) {
      emitChatMessage("system", `⛔ ${environmentErrorAdvice(envReason)}`);
      return; // STOP — proje-fix döngüsüne GİRME.
    }
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
  const prev = autoSolveSig.get(n);
  const sameSig = prev?.sig === sig;
  const priorCount = sameSig ? prev!.count : 0;
  let autoResolve = otoCevap && priorCount < AUTO_SOLVE_MAX;
  const exhausted = otoCevap && priorCount >= AUTO_SOLVE_MAX;
  // ⚖️ MAHKEME (sorun-zamanı / problem-triggered, YZLLM tasarımı): otomatik fix dispatch'inden ÖNCE müfettiş bu
  // faz-hatasını BAĞLAYICI inceler — gerçek kod sorunu mu, false-positive/gereksiz mi. Merkezi yol KUTSAL →
  // force-pass YOK: suppress/escalate (fix gereksiz/riskli/false-positive) → otomatik fix YERİNE İNSANA yönlendir
  // (autoResolve=false; mevcut askq makinesi devralır). proceed → normal oto-çözüm. Flag KAPALIYSA atlanır
  // (davranış değişmez, sıfır risk). Yalnız oto-çözüm GERÇEKTEN denenecekken konuşur (gereksiz mahkeme yok).
  let mahkemeDiverted = false;
  if (autoResolve && runtime.config.features.inspector_enabled) {
    try {
      const insp = await inspectGateFinding(runtime.config, {
        projectRoot: runtime.state.project_root,
        gateLabel: `Faz ${n}`,
        errors: ctrl?.lastFailReason ?? message,
      });
      const ruling = mahkemeRuling(insp);
      if (ruling.convened && ruling.action !== "proceed") {
        // FROZEN-GOAL (escalate-stall fix, canlı Arcelik_BO 2026-06-22): bu noktada otoCevap ZATEN açık
        // (mahkeme yalnız autoResolve=otoCevap iken koşar). Oto-modda askq'da BLOKLAMAK = SESSİZ STALL
        // (kullanıcı izlemiyor → soru cevapsız asılı kalır; frozen-goal "asla sessizce tıkanma" ihlali —
        // canlı kanıt: Faz 10 false-positive/auth bulgusunda donma). Çözüm: LOUD ACCEPT-CONTINUE — bulgu
        // RAPORA/audit'e yazılır (YUTULMAZ), çalışan kod riske atılmaz (oto-fix YOK), faz kabul-devam eder
        // (insan sonra raporu inceler). Faz 13 güvenlik yolundaki kanıtlı desenin genel failPhase'e taşınması.
        mahkemeDiverted = true;
        await appendAuditModule(runtime.state.project_root, {
          ts: Date.now(),
          phase: n,
          event: `mahkeme-${ruling.action}-accept-continue`,
          caller: "mycl-orchestrator",
          detail: ruling.summary.slice(0, 400),
        }).catch(() => {});
        emitChatMessage(
          "system",
          `⚖️ Mahkeme (${ruling.action}): oto-modda akış BLOKLANMAZ — Faz ${n} bulgusu RAPORA yazıldı, çalışan ` +
            `kod riske atılmadan kabul-devam edildi (sonra inceleyebilirsin).\n${ruling.summary}`,
        );
        await advanceToNextPhase(n);
        return;
      }
    } catch (e) {
      log.warn("orchestrator", "mahkeme failPhase incelemesi hata (yutuldu → normal akış)", { error: String(e) });
    }
  }
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
  if (exhausted) {
    const rb = takeRollback();
    if (rb) {
      const ok = await restoreSnapshot(rb, runtime.state.project_root);
      emitChatMessage(
        "system",
        ok
          ? `↩️ Otomatik düzeltmeler bu hatayı çözmedi — başarısız değişiklikleri **geri aldım** (${rb.method === "git" ? "git checkpoint" : "yedek"}; ilk denemeden önceki temiz hale). Şimdi seçenekleri sana soruyorum.`
          : `⚠️ Geri alma denedim ama tam başarılı olamadı (${rb.method}). Değişiklikleri elle kontrol etmen gerekebilir; seçenekleri sana soruyorum.`,
      );
    } else {
      emitChatMessage("system", "Seçenekleri sana soruyorum (geri alınacak snapshot yok).");
    }
  }
  runtime.pendingErrorAnalysis = await analyzeAndAskError(runtime.state, runtime.config, errCtx, {
    autoResolve,
  }).catch(() => null);
  const pendingAuto = runtime.pendingErrorAnalysis;
  if (pendingAuto?.auto_selected_solution) {
    autoSolveSig.set(n, { sig, count: priorCount + 1 });
    // Aynı routing'i (askq-cevap dalı) otomatik sür — soru kartı hiç açılmadı.
    await handleAskqAnswer(pendingAuto.id, pendingAuto.auto_selected_solution).catch((e: unknown) =>
      log.error("orchestrator", "auto-solve routing failed", e),
    );
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
}

/** Config'i yüklemeyi dener, durumu UI'a yollar. */
async function emitConfigStatus(): Promise<boolean> {
  try {
    runtime.config = await loadConfig();
    applyConfigDerivedSettings(runtime.config); // restart'sız aktif: singleton'ları her yüklemede tazele
    log.info("config", "loaded", {
      selected_models: runtime.config.selected_models,
    });
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

async function handleOpenProject(path: string): Promise<void> {
  log.info("orchestrator", "open_project", { path });
  // Yeni proje → güvenlik yakınsama-kırıcı durumunu sıfırla (eski projenin sayacı taşınmasın).
  _securityFindingsPrev = null;
  _securityNoProgress = 0;
  // Aktif controller varsa yeni proje açma — state ortasında değişim yasak.
  if (runtime.controller) {
    emitError("active phase running — close current project first", {
      phase: runtime.state?.current_phase,
    });
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
    emitPhaseChanged(runtime.state.current_phase, runtime.state.current_phase, "running");
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
        `Niyet toplama yarıda kalmıştı — devam ediyorum (niyet: "${interrupted.intentText.slice(0, 100)}").\n\nBirkaç soru tekrar gelebilir; cevaplarsın, Faz 2'ye geçilir.`,
      );
      void restartPhase1WithIntent(interrupted.intentText).catch((e) => {
        log.error("orchestrator", "boot-resume restartPhase1WithIntent failed", e);
        emitError("boot resume failed", String(e));
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
      runtime.state = { ...runtime.state, pending_ui_tweak: undefined, updated_at: Date.now() };
      await saveState(runtime.state);
      emitChatMessage(
        "system",
        "🖥️ Bekleyen \"Playwright headless\" tweak'i uygulanmadı — headless:false sabit kuralın (browser görünür kalır, testi gözleyebilirsin). Kaldığım yerden devam ediyorum.",
      );
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
      let phaseId = interrupted29.phaseId;
      // YZLLM 2026-06-16: spec-gerektiren faza (>4: UI-codegen/DB/TDD/risk) resume edilecek ama iter-spec DOSYASI
      // YOKSA (devs/_pending silinmiş/temizlenmiş — currentSpecPath dosya-varlığını kontrol etmez) → Faz 4'ten başla
      // (spec'i devs/_pending'e yeniden üret). Aksi halde Faz 8 "spec.md missing" ile takılırdı — Faz 2+3 per-iter
      // spec kırılganlığı (spec artık kök yerine devs/_pending'de; o silinirse spec-okuyucular spec bulamaz).
      if (phaseId > 4) {
        const specPath = currentSpecPath(runtime.state);
        const specExists = await import("node:fs/promises").then((m) =>
          m.access(specPath).then(() => true).catch(() => false),
        );
        if (!specExists) {
          emitChatMessage(
            "system",
            `ℹ️ Faz ${phaseId}'in spec'i bulunamadı (devs/ temizlenmiş olabilir) — spec'i yeniden üretmek için Faz 4'ten devam ediyorum.`,
          );
          phaseId = 4 as PhaseId;
        }
      }
      // Faz 2/3/4 (spec-üretici/öncesi) resume: boot-resume Faz 1 girişini ATLADIĞI için ensurePendingIterationDir
      // çağrılmadı → devs/_pending/<ts>/ dizini yoksa Faz 4 spec'i oraya YAZAMAZ (writeFile ENOENT → "boot resume
      // failed"). Dizini burada garantile (devs/ silinmiş/yeni-resume senaryosu). Fail-soft.
      if (phaseId <= 4 && runtime.state.iteration_started_at) {
        await ensurePendingIterationDir(
          runtime.state.project_root,
          runtime.state.iteration_started_at,
        ).catch((e: unknown) =>
          log.warn("orchestrator", "boot-resume ensurePendingIterationDir failed", e),
        );
      }
      emitChatMessage(
        "system",
        `📍 Faz ${phaseId} yarıda kalmıştı — kaldığı yerden devam ediyorum.`,
      );
      void advanceToNextPhase((phaseId - 1) as PhaseId).catch((e) => {
        log.error("orchestrator", "boot-resume advanceToNextPhase failed", e);
        emitError("boot resume failed", String(e));
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
    if (runtime.config && runtime.state && !midPipeline) {
      void bootstrapLivingDocs(runtime.state, runtime.config).catch((e: unknown) =>
        log.warn("orchestrator", "living-docs bootstrap failed (non-fatal)", e),
      );
    }

    // Onboarding (yabancı koda hakimiyet): proje haritasını ARKA PLANDA hesapla (open'ı bloklamaz) →
    // orkestratör recall'ı sonraki turlarda merkezi modülleri görür. Proje değişti → eski harita temizlendi.
    clearProjectMapCache();
    void getCachedProjectMap(runtime.state.project_root).catch((e: unknown) =>
      log.warn("orchestrator", "project-map onboarding failed (non-fatal)", e),
    );

    // agent-skills AUTO-KURULUM (YZLLM 2026-06-09: "sadece önermesin, bağlasın"): yoksa pinli commit'ten
    // arka planda kur → cli-backend --plugin-dir ile codegen ajanlarına bağlar. Non-blocking, fail görünür.
    void ensureAgentSkills().catch((e: unknown) =>
      log.warn("orchestrator", "agent-skills kurulum hatası (non-fatal)", e),
    );

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
            const askqId = randomUUID();
            _pendingModelUpgrade = { askqId, model: t.strong };
            emitChatMessage(
              "system",
              `🆕 Güncel güçlü model bulundu: **${t.strong}** (şu an: ${currentStrong}). Geçmek istersen soruyorum — ayarların korunur, ben otomatik değiştirmiyorum.`,
            );
            emitAskq({
              id: askqId,
              question: `Yeni güçlü model ${t.strong} çıkmış. Main ajan + strong (kalite-kritik) görevler için buna geçeyim mi?`,
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
      // Greenfield/temiz açılış: HİÇ iş başlamamış (yeni proje — niyet bile yok,
      // ilk iterasyon) → boot karşılaması ATLA (YZLLM 2026-06-17: "yarım kalan iş
      // yoksa ilk mesajı yazmasın; yarım kalan iterasyon varsa yazsın"). Greenfield
      // phase=1'de boot agent'ı matriste "intent boş → Niyet bekleniyor" kuralını
      // seçip gereksiz karşılama üretiyordu — programatik olarak burada kesiyoruz
      // (agent hiç çağrılmaz → token de tasarruf). iteration_count>1 ya da intent_summary
      // dolu ya da phase>1 → gerçek devam-eden/biten iş VAR → karşılama korunur.
      const isCleanStart =
        (st.current_phase ?? 0) <= 1 &&
        (st.iteration_count ?? 1) === 1 &&
        !st.intent_summary;
      const hasPending =
        !isCleanStart &&
        ((st.current_phase > 0 && st.current_phase < 17) ||
          !!st.pending_ui_tweak ||
          st.dev_server_pid !== undefined);
      if (hasPending) {
        void runBootStatusCheck(runtime.config, st);
      }
    }
  } catch (err) {
    log.error("orchestrator", "open_project failed", err);
    emitError("open_project failed", String(err));
  }
}

/**
 * v15.6 boot durum özeti: kullanıcı projeyi açtığında agent state'i okur,
 * yarıda kalan iş varsa TEK CÜMLE ile özetleyip ne yapılması gerektiğini
 * söyler. Sadece `chat` action'ı kabul edilir — boot'ta phase tetikleme,
 * askq sorma, hafıza önerme YOK. Background fire-and-forget (await çağrı
 * yeri void).
 */
async function runBootStatusCheck(
  cfg: MyclConfig,
  st: State,
): Promise<void> {
  try {
    const decision = await respondAsOrchestrator(
      cfg,
      st,
      "[BOOT_CHECK] Kullanıcı projeyi yeni açtı, henüz bir mesaj yazmadı. " +
        "TÜM gerekli bilgi YUKARIDAKİ `## CURRENT CONTEXT (live snapshot)` " +
        "bölümünde — current_phase, pending_ui_tweak, dev_server_pid, " +
        "spec_approved, intent_summary, was_pipeline_completed, son 10 audit " +
        "event hepsi orada. **Read/Bash KULLANMA, dosya tekrar okuma** — " +
        "context yeterli. DİREKT `decide_action` çağır.\n\n" +
        "## YASAK 1: iterasyon numarası söyleme\n" +
        "Kullanıcı iterasyon sayacını umursamıyor — teknik fazlalık. ASLA " +
        "'6. iterasyon', 'iteration 5', 'N. iterasyon' deme.\n\n" +
        "## YASAK 2: gelecek söz verme\n" +
        "Boot check SADECE `chat` action'ı yapabilirsin — phase tetikleyemezsin, " +
        "dev server başlatamazsın, askq açamazsın. Bu yüzden 'dev server " +
        "başlayacak', 'haber veririm', 'şimdi X yapıyorum', 'tarayıcıyı " +
        "açacağım' gibi GELECEK VAADLERİ KESİNLİKLE YASAK. Söylediğini " +
        "yapamadığın için kullanıcı söz tutulmadığını görür.\n" +
        "Sadece (a) ŞU ANKİ DURUMU özetle ve (b) KULLANICININ YAPACAĞI eylemi " +
        "söyle (örn. sidebar'dan tıklama, mesaj yazma).\n\n" +
        "## Event yorumlama\n" +
        "- `iteration-N-start` = yeni iterasyon başladı, niyet bekleniyor.\n" +
        "- `phase-17-complete` = pipeline tamamlandı.\n" +
        "- `tdd-red`, `phase-N-fail` = test failure → yarıda kalmış iş VAR.\n\n" +
        "## Karar matrisi (söylem örnekleri)\n" +
        "- current_phase ∈ [2..16] (mid-pipeline, yarıda) → bu faz OTOMATİK kaldığı " +
        "yerden devam eder; kullanıcının bir şey yapmasına gerek YOK. Kullanıcıya " +
        "ASLA 'faza tıkla / Sadece Çalıştır seç / devam etmek için ...' DEME — " +
        "bekletme/yönlendirme YASAK (YZLLM 2026-06-13). reason='boot clean' (sessiz geç).\n" +
        "- pending_ui_tweak set → bu otomatik ele alınır; kullanıcıya 'tıkla / " +
        "yazman yeterli / devam etmek için ...' DEME (YZLLM 2026-06-13: bekletme/" +
        "yönlendirme yok). reason='boot clean' (sessiz geç).\n" +
        "- pending_diagnostic set → 'Debug çözüm seçimi bekliyor — chat'te " +
        "askq açılacak.'\n" +
        "- current_phase=1 + intent_summary boş → 'Niyet bekleniyor — ne " +
        "yapmak istersin?'\n" +
        "- current_phase=1 + son `tdd-red`/`phase-N-fail` var → 'Önceki " +
        "[faz adı] çalışmasında [kısa özet] yarıda kaldı. Devam mı yeni iş mi?'\n" +
        "- current_phase=1 + audit boş + iteration_count=1 → reason='boot clean'\n\n" +
        "action='chat' + reason ile 1-2 cümle Türkçe özet. ZORUNLU: " +
        "action='chat', iterasyon numarası söyleme, gelecek söz verme, " +
        "başka action seçme, phase tetikleme, askq sorma, hafıza önerme.",
    );
    if (decision.action === "chat") {
      // Şema reason'ı zorunlu, message_to_user'ı opsiyonel tutar — ajan
      // çoğu zaman sadece reason doldurur. executeAgentDecision ile aynı
      // fallback pattern: message_to_user ?? reason.
      const raw = decision.message_to_user ?? decision.reason ?? "";
      const msg = raw.trim();
      // "boot clean" sentinel: ajan durum temiz dediğinde mesaj emit etme.
      const isClean = /^boot[\s\-_]?clean\b/i.test(msg) || msg.length < 5;
      if (!isClean) {
        emitChatMessage("assistant", msg);
      }
    }
  } catch (err) {
    log.warn("orchestrator", "boot status check failed", err);
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
  } catch {
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
  } catch {
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
    emitError("no active project", null);
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    emitError("task_queue_add: empty text", null);
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
    emitError("task_queue_add failed", String(err));
  }
}

async function handleTaskQueueRemove({ id }: { id: string }): Promise<void> {
  if (!runtime.state) {
    emitError("no active project", null);
    return;
  }
  try {
    await removeTask(runtime.state.project_root, id);
    const items = await readTasks(runtime.state.project_root);
    emit("task_queue_changed", { items });
  } catch (err) {
    log.warn("task-queue", "remove failed", err);
    emitError("task_queue_remove failed", String(err));
  }
}

/**
 * Proje açılışında mevcut iş kuyruğunu frontend'e gönderir.
 *
 * BOOT UZLAŞTIRMA (YZLLM 2026-06-14, düşman-inceleme #3/#13): currentTaskId
 * yalnız bellektedir → restart/çökme sonrası "running" damgalı bir iş ORPHAN
 * kalır (gerçekte koşmuyor). nextAutoPendingTask yalnız "pending" seçtiğinden bu
 * iş asla yeniden seçilmez + kuyruk dürüst yansımaz. Açılışta "running" işleri
 * "dropped"a çevir (görünür "tamamlanmadan durdu"; gerekirse kullanıcı yeniden
 * ekler). Yeni pencere = yeni süreç → in-memory _drainActive zaten false.
 *
 * YZLLM 2026-06-15 ("şu an iş listesindekileri sıra sıra pipeline'dan geçirsin"):
 * orphan uzlaştırmasından sonra bekleyen iş varsa iş-listesi sürücüsünü ateşle —
 * proje açılışında mevcut işler kendiliğinden sırayla işlenmeye başlar.
 */
async function emitInitialTaskQueue(projectRoot: string): Promise<void> {
  try {
    let items = await readTasks(projectRoot);
    // YZLLM 2026-06-15 (iş-listesi-güdümlü): "running" orphan = restart/çökmeyle
    // yarıda kalmış iş-listesi işi → "pending"e geri al (yeniden-kuyruğa). Kuyruk
    // onu Faz 1'den yeniden işler; boot-resume devreye girmez (hasPendingQueueWork).
    // (Terminal fail "dropped" damgasını drain-içi reconcile vurur → sonsuz-retry yok.)
    const orphans = items.filter((it) => (it.status ?? "pending") === "running");
    for (const orphan of orphans) {
      await patchTask(projectRoot, orphan.id, { status: "pending" }).catch((e) =>
        log.warn("task-queue", "boot orphan reconcile failed", e),
      );
    }
    if (orphans.length > 0) {
      items = await readTasks(projectRoot);
      log.info("orchestrator", "boot: orphan 'running' işler 'pending'e (yeniden-kuyruğa) alındı", {
        count: orphans.length,
      });
    }
    emit("task_queue_loaded", { items });
    // Bekleyen iş varsa iş-listesini sırayla işlemeye başla (kullanıcı mesaj
    // göndermeden — iş-listesi kendiliğinden boşalan sıralı kuyruktur).
    await kickWorkQueue();
  } catch (err) {
    log.warn("task-queue", "initial load failed", err);
  }
}

async function handleSaveApiKeys(keys: Partial<ApiKeys>): Promise<void> {
  log.info("orchestrator", "save_api_keys", { keys }); // logger REDACT eder
  // MERGE-aware validasyon (z.ai, YZLLM 2026-06-22): kayıt PATCH'tir — boş alan mevcut key'i silmez.
  // z.ai key'i eklerken claude key'lerini yeniden girmeye zorlama + z.ai-only kurulumu engelleme.
  // Merge sonrası (claude translator+main) YA DA (bir z.ai key) varsa geçerli; ikisi de yoksa reddet.
  if (!keys || !(await hasUsableKeysAfterMerge(keys))) {
    emitError(
      "save_api_keys: en az claude translator+main YA DA bir z.ai key gerekli (kayıt boş bırakılamaz)",
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
    emitError("save_api_keys failed", String(err));
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
    emitError("save_settings: translator + main model required", null);
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
        // "zai" = z.ai (GLM) sağlayıcısı (YZLLM 2026-06-21) — sessizce eleme; geçerli 4. değer.
        if (v === "api" || v === "cli" || v === "auto" || v === "zai") clean[role] = v;
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
        v === "cli" ? "Abonelik" : v === "auto" ? "Auto" : v === "zai" ? "Z.AI" : "API";
      emitChatMessage(
        "system",
        `✅ Ayarlar uygulandı — yeniden başlatma GEREKMEZ. Bir sonraki iş şu ayarla koşar:\n` +
          `• Backend → main: ${label(b?.main)}, translator: ${label(b?.translator)}, orkestratör: ${label(b?.orchestrator)}\n` +
          `• Model → main: ${fresh.selected_models.main}` +
          `${flagsPatch.effort ? ` · efor: ${flagsPatch.effort}` : ""}`,
      );
      // R1 (adversarial review): Sağlayıcı=Z.AI seçili ama o rolün z.ai key'i yoksa resolveProvider
      // sessizce claude'a düşer → katı kural #4 ihlali. Seçim-anında GÖRÜNÜR uyar (correct-by-construction;
      // resolveProvider hot-path olduğu için orada değil, burada — tek doğru yer).
      const missingZai = (["main", "translator", "orchestrator"] as const).filter(
        (r) => b?.[r] === "zai" && !zaiKeyForRole(fresh.api_keys, r),
      );
      if (missingZai.length > 0) {
        emitChatMessage(
          "system",
          `⚠️ Sağlayıcı=Z.AI seçtiniz ama şu rol(ler)in z.ai key'i girilmemiş: **${missingZai.join(", ")}** → ` +
            `bu rol(ler) z.ai DEĞİL, güvenli şekilde claude ile koşacak. z.ai'yi etkinleştirmek için ` +
            `Ayarlar → API Anahtarları'ndan ilgili z.ai key'ini girin.`,
        );
      }
    }
  } catch (err) {
    log.error("orchestrator", "save_selected_models failed", err);
    emitError("save_settings failed", String(err));
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
    // Frontend'e güncel feature değerini de geri yolla (toggle confirm).
    try {
      const fresh = await readFeatures();
      emit("features_value", { features: fresh });
    } catch {
      emit("features_value", { features: { playwright_enabled: true } });
    }
  } catch (err) {
    log.error("orchestrator", "save_features failed", err);
    emitError("save_features failed", String(err));
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
    emitError("read_selected_models failed", String(err));
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
): Promise<void> {
  log.info("orchestrator", "command_direct", {
    text_len: text.length,
    intent_kind: intentKind,
  });
  if (!runtime.state || !runtime.config) {
    emitError("no active project", null);
    return;
  }
  // History persistence: user mesajını yaz (frontend setMainState ile UI'ya
  // optimistic eklenmiştir).
  if (runtime.state.project_root) {
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
  await commandDirectQueue.submit({ text, intentKind });
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
    emitError("no active project", null);
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
}>({
  isExternallyBusy: () =>
    runtime.controller !== null || _handlingUserMessage || _pipelineDepth > 0,
  exec: ({ text, intentKind }) => runCommandDirectBody(text, intentKind),
  onEnqueue: (_item, position) =>
    emitChatMessage(
      "system",
      `🧾 İş kuyruğa alındı (sıra ${position}) — çalışan iş bitince işlenecek.`,
    ),
  onResume: (item, remaining) =>
    emitChatMessage(
      "system",
      `▶️ Kuyruktan alındı, işleniyor: "${item.text.slice(0, 40)}"${remaining > 0 ? ` (kalan ${remaining})` : ""}.`,
    ),
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
    emitError("no active project", null);
    return;
  }
  const q = text.trim();
  if (!q) return;
  try {
    emitPhaseRunning("🔎 Soru cevaplanıyor (salt-okunur danışma)…");
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
    emitChatMessage("assistant", answer);
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
async function handleUserMessageInner(text: string): Promise<void> {
  log.info("orchestrator", "user_message", { text_len: text.length });
  if (!runtime.state || !runtime.config) {
    emitError("no active project", null);
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
  try {
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
    emitError("no active project", null);
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
  switch (decision.action) {
    case "chat": {
      const msg = decision.message_to_user ?? decision.reason;
      emitChatMessage("assistant", msg);
      return;
    }
    case "ask_clarify": {
      // Doğru-karar/proaktif-risk (2026-06-04): clarify_options doluysa SOMUT
      // seçenekler (risk + gerçek alternatifler); yoksa jenerik Evet/Hayır/Vazgeç.
      // Cevap akışı DEĞİŞMEZ: agent_clarify_ → handleAskqAnswer → "Vazgeç" sessiz
      // kapanış, diğer seçim handleUserMessage'e → ajan o yönle yeniden karar verir.
      const askqId = `agent_clarify_${randomUUID()}`;
      const rich = decision.clarify_options && decision.clarify_options.length > 0;
      emitAskq({
        id: askqId,
        question: decision.message_to_user ?? decision.reason,
        options: rich ? [...decision.clarify_options!, "Vazgeç"] : ["Evet", "Hayır", "Vazgeç"],
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
        emitChatMessage("assistant", decision.reason);
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
          await ensureDevServerForReview(runtime.state, runtime.config);
          emitChatMessage(
            "system",
            "👀 Bildirdiklerin kuyruğa eklendi. Bu işin UI'sini onaylıyor musun → `tamam` (Faz 7'e geçeriz) · düzeltme istersen yaz · `iptal` ile durdur.",
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
      emitChatMessage("assistant", decision.reason);
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
      // koyul" KURAL'ı işe-başlamak içindir, işi YOK ETMEK için değil).
      const chatMsg =
        decision.message_to_user
          ? `${decision.reason}\n\n${decision.message_to_user}`
          : decision.reason;
      emitChatMessage("assistant", chatMsg);
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
      emitChatMessage("assistant", summaryMsg);
      const askqId = `mem_propose_${randomUUID()}`;
      runtime.pendingMemoryProposal = {
        askqId,
        proposal,
        topic_slug: topicSlug,
        user_text: text,
        decision_action: decision.action,
      };
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
      await appendAuditModule(runtime.state.project_root, {
        ts: Date.now(),
        phase: runtime.state.current_phase,
        event: "optional-phases-set",
        caller: "mycl-orchestrator",
        detail: `optional=[${optional.join(",")}] scope=[${newScope.join(",")}]`,
      });
      emitChatMessage("assistant", decision.reason);
      if (decision.message_to_user) {
        emitChatMessage("assistant", decision.message_to_user);
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
        emitChatMessage("assistant", decision.reason);
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
      if (decision.reason) emitChatMessage("assistant", decision.reason);
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
    emitError("no active project", null);
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
  priorAnalysis?: { solutions_tr: string[] },
): Promise<void> {
  if (!runtime.state || !runtime.config) {
    emitError("no active project", null);
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
      emitError("phase-0 spec not found in registry", null);
      return;
    }
    if (!runtime.state || !runtime.config) {
      emitError("phase 0 cannot start: runtime not initialized", null);
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
async function runDevelopIteration(
  text: string,
  opts?: { seedIntent?: string; startPhase?: PhaseId },
): Promise<void> {
  if (!runtime.state || !runtime.config) {
    emitError("no active project", null);
    return;
  }
  // Cascade-guard: seed'lenmiş başlangıç = güvenlik-bulgusu sistem-işi → Faz 17 bu iterasyonda re-enqueue YAPMAZ.
  _iterationIsSecurityFix = Boolean(opts?.seedIntent);
  // İzolasyon (YZLLM 2026-06-15, canlı test #2): bu, iş-listesindeki TEK işi işleyen
  // iterasyon → tüm fazlar (1..9) konuşma geçmişini KATMASIN, yoksa orijinal çok-bug'lı
  // mesaj sızıp işleri birleştirir. Bayrak state üzerinden advanceToNextPhase'e taşınır.
  runtime.state = { ...runtime.state, iteration_isolated: true };
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
    runtime.state = {
      ...runtime.state,
      current_phase: 1,
      spec_approved: false,
      spec_hash: undefined,
      tdd_compliance_score: undefined,
      dev_server_pid: undefined,
      intent_summary: undefined,
      intent_summary_raw: undefined,
      ui_flow_active: false,
      regression_block_active: false,
      // UI tweak state'i yeni iterasyon'a sızmamalı — Phase 6 onayı sonrası
      // zaten sıfırlanıyor ama force-complete veya yarım kalan pipeline'da
      // kalmış olabilir; defensive.
      pending_ui_tweak: undefined,
      pending_ui_review: undefined,
      ui_tweak_count: undefined,
      pending_backend_fix: undefined,
      pending_migrations: undefined,
      pending_diagnostic: undefined,
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
    // v15.6: yeni iterasyon — NDJSON metadata bağlamı update.
    setRecordContext({ iteration: newIter, phase: 1 });
    _securityAutoResolveCount = 0;
    emitChatMessage(
      "system",
      `🔄 Yeni iterasyon başlıyor (#${newIter}). Eski spec.md/kod referans olarak korunuyor; Claude Faz 1'de Read ile bakabilir.`,
    );
    emitPhaseChanged(runtime.state.current_phase, 1, "running");
  }

  // Güvenlik/pentest SİSTEM-İŞİ (YZLLM 2026-06-19): niyet bulgudan türetildiği için Faz 1 (niyet) + Faz 2
  // (hassasiyet) ATLA, seed'lenmiş intent_summary ile doğrudan startPhase'ten (genelde Faz 3) başla.
  if (opts?.seedIntent && opts.startPhase && opts.startPhase > 1) {
    const iterTs = runtime.state.iteration_started_at ?? Date.now();
    runtime.state = {
      ...runtime.state,
      intent_summary: opts.seedIntent,
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
      `🛡️ Güvenlik sistem-işi Faz ${opts.startPhase}'ten ele alınıyor (niyet bulgudan türetildi; Faz 1/2 atlandı).`,
    );
    await advanceToNextPhase((opts.startPhase - 1) as PhaseId);
    return;
  }

  // Phase 1 — yeni intent başlatma. current_phase 1 ya da intent_summary yok.
  const spec = getSpec(1);
  if (!spec) {
    log.error("orchestrator", "phase 1 spec missing");
    emitError("phase 1 spec missing", null);
    return;
  }
  log.info("orchestrator", "phase 1 start");
  // QC A-1 (borç): non-null assert yerine explicit guard. Pre-condition
  // handleUserMessage entry'sinde sağlanır ama defansif kontrol kod okunaklığı.
  if (!runtime.state || !runtime.config) {
    emitError("phase 1 cannot start: runtime not initialized", null);
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
    runtime.pendingPhaseScope !== null ||
    runtime.pendingMemoryProposal !== null ||
    runtime.pendingDast !== null ||
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
    emitError("no active project", null);
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
async function startNextPendingTask(): Promise<boolean> {
  if (!runtime.state) return false;
  if (runtime.currentTaskId) return false; // #4: canlı/parkta işi EZME
  const root = runtime.state.project_root;
  const next = nextPendingTask(await readTasks(root));
  if (!next) {
    _drainActive = false; // bekleyen iş kalmadı → oturum bitti
    return false;
  }
  await patchTask(root, next.id, { status: "running" });
  runtime.currentTaskId = next.id;
  await emitQueueChangedFor(root);
  // YZLLM 2026-06-15: üst bar + "İş" kutusu o anki işi göstersin (iş başında set et;
  // eskiden yalnız Faz 1 sonunda doluyordu → işlenirken boş kalıyordu). Metin zaten TR.
  emitIterationIntent(next.text);
  emitChatMessage(
    "system",
    `▶️ İş başlıyor (öncelik ${next.priority ?? "—"}): _"${next.text.slice(0, 90)}"_`,
  );
  // Güvenlik/pentest sistem-işi → niyet bulgudan türetildi → from_phase'ten (Faz 3) başla, Faz 1/2 atla.
  if (next.source === "security" && typeof next.from_phase === "number" && next.from_phase > 1) {
    await runDevelopIteration(next.text, {
      seedIntent: next.text,
      startPhase: next.from_phase as PhaseId,
    });
  } else {
    await runDevelopIteration(next.text);
  }
  return true;
}

/**
 * pipeline-end'de (Faz 17 / next===null) çağrılır: çalışan kuyruk işini "done" +
 * completed_at ile damgala (KİLİT — tekrar uygulanamaz). Sıradaki işe geçiş
 * BURADA değil, advanceToNextPhase finally → reconcileAndDrainTasks'te (seri).
 * currentTaskId yoksa no-op (kuyruk-dışı iterasyon, örn. resume).
 */
async function onTaskMaybeComplete(projectRoot: string): Promise<void> {
  if (!runtime.currentTaskId) return;
  const doneId = runtime.currentTaskId;
  runtime.currentTaskId = null;
  await patchTask(projectRoot, doneId, { status: "done", completed_at: Date.now() });
  await emitQueueChangedFor(projectRoot);
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
        await patchTask(root, id, { status: "dropped" }); // retriable DEĞİL → sonsuz-retry yok
        await emitQueueChangedFor(root);
        emitChatMessage(
          "system",
          "⏹ Çalışan iş tamamlanmadan durdu — kuyrukta 'düştü' işaretlendi (gerekirse yeniden ekle).",
        );
      }
      if (!_drainActive) break; // aktif drain oturumu yok → yalnız orphan uzlaştırıldı
      _handlingUserMessage = true; // seri garanti (kullanıcı mesajıyla yarış yok)
      let ran = false;
      try {
        ran = await startNextPendingTask();
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
  } catch {
    return false;
  }
  const lower = spec.toLowerCase();
  if (skip_unless === "has_ui") {
    return /\b(ui|frontend|görsel|ekran|sayfa|button|web|react|vue|svelte)\b/.test(
      lower,
    );
  }
  if (skip_unless === "has_web_target") {
    // Sızma testi UI gerektirmez: HTTP sunan her proje (web VEYA API) hedeftir.
    // UI terimleri + api/sunucu terimleri. Yalnız CLI/library/ml (HTTP yok) → false.
    return /\b(ui|frontend|görsel|ekran|sayfa|button|web|react|vue|svelte|angular|next|api|rest|endpoint|http|server|sunucu|backend|express|fastapi|flask|django|rails|graphql|swagger|openapi)\b/.test(
      lower,
    );
  }
  if (skip_unless === "has_nfr") {
    return /\b(load|performance|throughput|latency|nfr|tps|rps|p95|p99)\b/.test(lower);
  }
  if (skip_unless === "has_database") {
    // NoSQL/ORM/kalıcılık terimleri de eklendi (kod-analiz): yalnız structured has_database
    // undefined olduğunda heuristic'e düşülür; Mongo/Redis/NoSQL projeleri kaçmasın.
    return /\b(database|veritabanı|db|prisma|sql|postgres|mysql|sqlite|mongo|mongodb|redis|nosql|orm|persist|persistence|supabase|firestore|dynamodb)\b/.test(
      lower,
    );
  }
  return true;
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
  try {
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
  const fixes = (decisions ?? []).filter(
    (d) => String(d.decision).trim().toLowerCase() === "fix",
  );
  if (fixes.length === 0) return state;
  emitChatMessage(
    "system",
    `🔧 Faz 9 — ${fixes.length} risk "düzelt" işaretlendi; her birini ilgili fazda otomatik düzeltiyorum (UI→Faz 5, DB→Faz 7, kod→Faz 8).`,
  );

  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i];
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
          ? `⏭ Risk ${i + 1}/${fixes.length} atlandı — UI riski ama proje UI içermiyor: ${detail.slice(0, 120)}`
          : `⏭ Risk ${i + 1}/${fixes.length} atlandı — DB riski ama proje veritabanı kullanmıyor: ${detail.slice(0, 120)}`,
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
      `🔧 Risk ${i + 1}/${fixes.length} → ${phaseName} ile düzeltiliyor: ${detail.slice(0, 160)}`,
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
        emitChatMessage("system", `✅ Risk ${i + 1}/${fixes.length} düzeltildi (${phaseName}).`);
      } else {
        emitChatMessage(
          "system",
          `⚠️ Risk ${i + 1}/${fixes.length} düzeltilemedi (${phaseName}) — açık bırakıldı, sonraki riske geçiyorum.`,
        );
      }
    } catch (err) {
      log.error("orchestrator", "risk-fix dispatch hata", err);
      emitChatMessage(
        "system",
        `⚠️ Risk ${i + 1}/${fixes.length} düzeltme hata verdi — açık bırakıldı: ${String(err).slice(0, 120)}`,
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
  const cfg: MyclConfig = runtime.config;
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
    }

    const next = PHASE_TRANSITIONS[cur];
    if (next === null || next === undefined) {
      // v15.8 (2026-05-30): Akış sonu DÜRÜST özet — istenen vs gerçekte
      // doğrulanan. Yanlış "her şey tamam" hissini önler.
      await emitPipelineEndSummary(state);
      // v15.11: Yaşayan dökümantasyon + UI kılavuzu güncelle (projeye dokunuldu).
      // Non-blocking — fail görünür uyarı, pipeline'ı bloklamaz.
      await updateLivingDocs(state, cfg).catch((e: unknown) =>
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
      // #1 deliği (YZLLM 2026-06-11): sessiz gate-atlama şeffaflığı. Pipeline bitince hangi kalite boyutunun
      // GERÇEKTEN doğrulandığını, hangisinin ATLANDIĞINI (araç yok / uygulanamaz) açıkça göster — atlanan gate
      // "geçti" gibi görünmesin. Kullanıcı neyin doğrulanmadığını bilerek kabul etsin.
      await emitVerificationSummary(state);
      // YZLLM 2026-06-14: İŞ KUYRUĞU — bu iterasyon bir kuyruk işiyse "done" +
      // tamamlanma-tarihi ile damgala (KİLİT: tekrar uygulanamaz) + kuyrukta
      // bekleyen iş varsa sıradakini başlat. currentTaskId yoksa no-op.
      await onTaskMaybeComplete(state.project_root);
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
          `🧭 Proje stack'i tespit edildi: **${freshStack}** — mekanik kalite-gate'leri (lint/test/…) bu profile göre çalışacak.`,
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
          ui_flow_active: false,
          regression_block_active: false,
          pending_ui_tweak: undefined,
          ui_tweak_count: undefined,
          pending_backend_fix: undefined,
          pending_migrations: undefined,
          pending_diagnostic: undefined,
          needed_phases: undefined,
          needed_phases_proposed: undefined,
          updated_at: Date.now(),
        };
        runtime.state = state;
        await saveState(state);
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
          if (autoAnswerSuggested()) {
            // Oto-cevap (YZLLM 2026-06-15): faz-kapsam askq'si qa-askq dışı DOĞRUDAN emit →
            // autoAnswer'ı kaçırıyordu (47 dk takılma sebeplerinden biri). Açıksa "Önerilen
            // seti onayla"yı otomatik seç; askq'yi UI'a göstermeden fall-through ile devam et
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
            // fall-through → recordPhaseComplete(3) + cur=3 + continue
          } else {
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
      const hasUi = await shouldRunMechanical(state.project_root, "has_ui");
      const tweakRequested = !!state.pending_ui_tweak;
      if (!tweakRequested && (state.skip_ui_phases || !hasUi)) {
        // QC E-2: audit detail kullanıcı için net olsun — structured skip
        // (Phase 2 classifier) vs heuristic skip (spec.md UI taraması) ayrımı.
        // project_type undefined olabilen eski state'lerde "unknown" fallback.
        const reason = state.skip_ui_phases
          ? `classifier_skip project_type=${state.project_type ?? "unknown"}`
          : "no_ui_in_spec";
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 5,
          event: "phase-5-skipped",
          caller: "mycl-orchestrator",
          detail: reason,
        });
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 5,
          event: "phase-5-complete",
          caller: "mycl-orchestrator",
        });
        emitChatMessage(
          "system",
          state.skip_ui_phases
            ? `Faz 5 atlandı — proje tipi UI gerektirmiyor (${state.project_type ?? "?"}).`
            : "Faz 5 atlandı — spec'te UI yok.",
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
      emitChatMessage(
        "system",
        "Faz 8 başlıyor — TDD codegen. Bu biraz sürebilir.",
      );
      const p8 = new Phase8Controller({ state, config: cfg, spec });
      const r = await runController(p8, () => p8.run(), "TDD uygulanıyor");
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
              `🎯 Scoped kalite: değişen ${sc.files.length} dosya + bağımlıları taranıyor; sistem-gate'leri (sadeleştirme/perf/entegrasyon/load) tam taramaya bırakıldı.`,
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
          `⏭ Faz ${next} (${phaseLabelTR(next, spec)}) bu scoped koşuda atlandı — tüm-sistem taraması büyük taramada koşar.`,
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

      // Faz 17 = SIZMA TESTİ (YZLLM 2026-06-19): yük testi YERİNE pentest. Mekanik runner KOŞMAZ —
      // runPhase17Pentest (DAST katana+nuclei) çalışır; bulgular gate'i düşürmez, Faz-3 iş-kuyruğuna
      // sistem işi olur (cascade-guard'lı). Faz her zaman "complete" (pentest bulgu bulsa da akış sürer).
      if (next === 17) {
        const { status: pentestStatus, partial } = await runPhase17Pentest(state, cfg);
        disarmRollback();
        // Faz 17 YEŞİL ancak pentest tam-koşup 0-bulgu ise (YZLLM 2026-06-20). `partial` (bulgu>0 veya timeout)
        // → "soft_complete_after_fail" → verdict PARTIAL (sahte-yeşil yok). Koşamadı (env) → partial=false →
        // verdict cezalanmaz. Pipeline yine tamamlandı (phase-17-complete → completed=true).
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
              });
              const ruling = mahkemeRuling(insp);
              if (ruling.convened) {
                // Güvenlik: suppress ASLA (savunmacı — highStakes regex'i kaçırsa bile) → escalate'e çevir.
                secMahkemeAction = ruling.action === "suppress" ? "escalate" : ruling.action;
                if (secMahkemeAction === "proceed") secMahkemeGuidance = ruling.summary;
                emitChatMessage("system", `⚖️ Mahkeme (Faz 13 güvenlik — ${secMahkemeAction}): ${ruling.summary}`);
              }
            } catch (e) {
              log.warn("orchestrator", "mahkeme Faz 13 incelemesi hata (yutuldu → proceed)", { error: String(e) });
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
        // ASLA devretmez. Yakınsama yoksa (bulgular azalmıyorsa) fix'i bir ÜST BASAMAĞA yükseltip otomatik düzeltmeye
        // DEVAM eder; tepe basamakta da çözülemezse OTOMATİK "kabul et + devam" (LOUD rapor — sessiz değil, bulgular
        // yutulmaz). _securityAutoResolveCount iterasyonda sıfırlandığı için güvenilmez → esas: basamak + bulgu-azalması
        // (security-convergence.ts, SAF + test'li). Oto-cevap KAPALIYSA eski blocking-askq (insan kabul/yeniden-analiz).
        const auto = autoAnswerSuggested();
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
            { autoResolve: auto },
          ).catch(() => null);
        }
        if (auto) {
          // ELLE DÜZELTME YOK (YZLLM 2026-06-14): otomatik fix varsa uygula; yoksa OTOMATİK "kabul et + devam" (LOUD).
          if (pending?.auto_selected_solution) {
            _securityAutoResolveCount++;
            runtime.pendingErrorAnalysis = pending;
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
        // Oto-cevap KAPALI → blocking askq (insan KABUL/yeniden-analiz seçer; "elle DÜZELT" değil).
        if (!pending) {
          const fallbackId = `error_analysis_${randomUUID()}`;
          pending = {
            id: fallbackId,
            phase: 13,
            blocking: true,
            options: [OPT_ACCEPT_CONTINUE, OPT_REANALYZE],
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
            options: [OPT_ACCEPT_CONTINUE, OPT_REANALYZE],
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
            if (ruling.convened) {
              mahkemeAction = ruling.action;
              if (ruling.action === "proceed") mahkemeGuidance = ruling.summary; // B5: gerekçe fix'e taşınır
              emitChatMessage("system", `⚖️ Mahkeme (${ruling.action}): ${ruling.summary}`);
            }
          } catch (e) {
            // Mahkeme hatası → güvenli varsayılan proceed (mevcut davranış korunur; mahkeme akışı BOZMAZ).
            log.warn("orchestrator", "mahkeme gate-incelemesi hata (yutuldu → proceed)", { error: String(e) });
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
 * Tüm 20 fazın özet bilgisini UI'a yollar — Aşamalar sayfası için.
 * Her giriş: id, type, name_tr, name_en, has_controller, required_audits,
 * config (askq/production/mechanical).
 */
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
  for (const f of unique) {
    const task: TaskQueueItem = {
      id: randomUUID(),
      ts: Date.now(),
      text: findingToTaskText(f),
      priority: severityToPriority(f.severity),
      status: "pending",
      source: "security",
      from_phase: 3,
    };
    await appendTask(projectRoot, task);
  }
  await emitQueueChangedFor(projectRoot);
  const more = summary.total > summary.findings.length ? ` (nuclei toplam ${summary.total} bulgu raporladı; örneklem tekilleştirildi)` : "";
  emitChatMessage(
    "system",
    `🛡️ ${origin}: ${unique.length} benzersiz güvenlik bulgusu iş kuyruğuna **sistem işi** olarak eklendi${more} — ` +
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
async function enqueueSecurityFixTask(projectRoot: string, text: string): Promise<void> {
  const task: TaskQueueItem = {
    id: randomUUID(),
    ts: Date.now(),
    text,
    priority: 2, // güvenlik → yüksek öncelik
    status: "pending",
    source: "security",
    from_phase: 3,
  };
  await appendTask(projectRoot, task);
  await emitQueueChangedFor(projectRoot);
  await kickWorkQueue();
}

/**
 * Faz 17 = SIZMA TESTİ (YZLLM 2026-06-19): yük testi YERİNE gerçek pentest. Mevcut DAST motoru
 * (katana+nuclei) çalışan app'i AKTİF tarar. Canlı dev server gerekir → ensureDevServerForReview;
 * yoksa runDast görünür "no_target" döner (sahte-yeşil yok). Bulgular gate'i DÜŞÜRMEZ — her biri
 * enqueueSecurityFindings ile Faz-3 iterasyonu olur. CASCADE-GUARD: bu iterasyon güvenlik-fix'inden
 * doğduysa re-enqueue YAPILMAZ (bulgu→Faz3→Faz17→bulgu sonsuz döngüsü kırılır; yalnız doğrular).
 */
async function runPhase17Pentest(
  state: State,
  config: MyclConfig,
): Promise<{ status: PhaseStatus; partial: boolean }> {
  emitPhaseRunning("🔪 Faz 17: Sızma Testi (pentest)…", "katana+nuclei — yalnız localhost");
  try {
    await ensureDevServerForReview(state, config).catch((e) =>
      log.warn("phase-17", "dev server ensure failed (pentest yine dener)", e),
    );
    // İş 3 (araç atlanamaz): pentest araçlarını garanti et — yoksa kur (sessiz skip yok).
    await ensureSecurityTools(["nuclei", "katana"]);
    // İŞ 1 (YZLLM 2026-06-20): Faz 17 pentest YALNIZ bu iterasyonda değişen işe scope'lanır.
    // changed_scope'tan route türet; çıkarsa scoped tara, çıkmazsa (non-Next / eşlenemez) full
    // (kuşkuda dahil et). Tüm-proje + güncel-CVE taraması ayrı iş → 🛡️ Güvenlik Taraması butonu.
    const scopeRoutes = deriveRoutesFromFiles(state.changed_scope?.files ?? []);
    if (scopeRoutes.length > 0) {
      emitChatMessage(
        "system",
        `🔪 Faz 17 yalnız değişen işe scope'landı: ${scopeRoutes.join(", ")} (tüm proje için 🛡️ Güvenlik Taraması).`,
      );
    }
    // Pentest sırasında runtime-error-watcher'ı sustur (saldırı trafiği=hata değil; flood+çevirmen-boğulma+ısınma önle).
    setPentestActive(true);
    const res = await runDast(state, { scopeRoutes }).finally(() => setPentestActive(false));
    emitChatMessage("system", res.summary_tr);
    if (res.ok) {
      if (_iterationIsSecurityFix) {
        const remaining = res.findings_count ?? 0;
        emitChatMessage(
          "system",
          remaining > 0
            ? `🔪 Sızma Testi (güvenlik-fix doğrulaması): ${remaining} bulgu hâlâ var — cascade önlemek için OTOMATİK yeni iş AÇILMADI (gerekirse 🛡️ butonuyla yeniden tara).`
            : "🔪 Sızma Testi: güvenlik-fix sonrası bu yüzeyde aktif bulgu kalmadı.",
        );
      } else {
        const n = await enqueueSecurityFindings(state.project_root, res.summary, "Sızma Testi (Faz 17)");
        if (n === 0) emitChatMessage("system", "🔪 Faz 17 Sızma Testi: aktif zafiyet bulunmadı (temiz).");
      }
    }
    // YZLLM 2026-06-20 (DÜZELTME): Faz 17 YEŞİL ANCAK pentest TAM koşup HİÇ bulgu yoksa ("bulgularını fix
    // etmeden Faz 17 yeşil olamaz"). YEŞİL ("complete", partial=false) = res.ok + 0 bulgu.
    //  • bulgu>0 (zafiyet, fix gerek — kuyruğa girdi) → "error" + partial=true (verdict PARTIAL).
    //  • timeout (eksik tarama, temiz doğrulanamaz) → "error" + partial=true.
    //  • koşamadı (server/nuclei yok = ENV/skip, app suçu değil — semgrep-skip gibi) → "error" sidebar ama
    //    partial=FALSE (verdict'i cezalandırma; tool/env eksik). (Faz 17 has_web_target'ta koşar — web VEYA API.)
    const findings = res.findings_count ?? 0;
    if (res.ok && findings === 0) return { status: "complete", partial: false };
    if (res.ok && findings > 0) return { status: "error", partial: true };
    if (res.error === "timeout") return { status: "error", partial: true };
    return { status: "error", partial: false }; // koşamadı (env) → kırmızı ama verdict cezalanmaz
  } finally {
    emitPhaseIdle();
  }
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
    emitChatMessage("system", "Zaten bir güvenlik-tarama onayı bekleniyor.");
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
      "için durum-değiştiren bağlantılar tetiklenebilir — `logout`/`delete`/`purge` gibi açıkça " +
      "yıkıcı görünen yollar güvenlik için atlanır, ama özel durum-değiştiren GET endpoint'lerin " +
      "olabilir. Aktif test + tüm-app gezme nedeniyle geçici yük / yan etki olabilir ve tarama " +
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
          `Bağımlılık zafiyetlerini gider — \`${dep.tool}\` eşik-üstü (yüksek+) zafiyet bildirdi. İlgili paketleri güvenli sürüme güncelle; tarama temiz geçsin.`,
        );
      }
      for (const label of sast.findings) {
        await enqueueSecurityFixTask(
          st.project_root,
          `SAST güvenlik bulgularını gider (semgrep ${label}). Bulguları Faz 13/audit'ten oku, kök nedeni düzelt; yeniden tara temiz olsun.`,
        );
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
      return;
    }
    if (sel === OPT_QUEUE) {
      await appendTask(runtime.state.project_root, {
        id: randomUUID(),
        ts: Date.now(),
        text: `Faz ${cached.phase} hatası (çözülmeden ertelendi): ${cached.solutions_tr[0] ?? "—"}`,
        // Ertelenmiş hatırlatma → source=manual: auto-drain'e GİRMEZ (istemsiz
        // oto-çalıştırma yok; kullanıcı "Uygula" ile bilerek tetikler).
        status: "pending",
        source: "manual",
      }).catch((e) => log.warn("orchestrator", "error-analysis task append fail", e));
      emitChatMessage(
        "system",
        "📋 Hata iş listesine kaydedildi — çözmeden devam edebilirsin.",
      );
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
      await advanceToNextPhase(p);
      return;
    }
    // Diğer her seçim ("Çöz" jeneriği veya somut bir çözüm metni) → mevcut debug
    // akışı (Faz 0 / debug_triage). bugReport = hata + seçilen yön + öneriler.
    emitChatMessage(
      "system",
      `🔧 Çözüm uygulanıyor: **${sel}** — debug akışı (Faz 0) başlatılıyor.`,
    );
    const bugReport =
      `Faz ${cached.phase} başarısız oldu.\nSeçilen çözüm yönü: ${sel}` +
      (cached.solutions_tr.length > 0
        ? `\nÖnerilen çözümler:\n${cached.solutions_tr.join("\n")}`
        : "");
    const fakeOutcome: DispatchOutcome = {
      handled: false,
      action: "debug_triage",
      intent: {
        kind: "debug",
        reasoning: "(error-analysis) kullanıcı çözüm seçti",
      },
    };
    // Orkestratörün ZATEN bulduğu çözümleri yapılandırılmış olarak taşı → Faz 0 D1
    // bunları sıfırdan yeniden türetmez, DOĞRULAR (handoff çözüm-kaybı fix'i).
    await executeDispatchedIntent(bugReport, fakeOutcome, {
      solutions_tr: cached.solutions_tr,
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
          "📌 Fix öncesi checkpoint alındı — regresyonda otomatik geri alınabilir; mekanik kalite-gate'leri değişen dosyalara odaklanacak (scoped).",
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
    emitError("no active controller", { id });
    return;
  }
  // submitAskqAnswer'ı olan her controller cevabı kabul eder: qa (P1/P2/P9),
  // production (P3/P4/P7) ve v15.8'den beri codegen (P5/P8 doubt-driven eskalasyon).
  if ("submitAskqAnswer" in runtime.controller) {
    runtime.controller.submitAskqAnswer(id, selectedText);
  } else {
    emitError("active phase does not accept askq answers", { id });
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

async function emitPhaseRunAskq(phaseId: number, directRun = false): Promise<void> {
  if (!runtime.state || !runtime.config) {
    emitError("no active project", null);
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
    emitError(`phase ${phaseId} spec yok`, null);
    return;
  }
  // Faz TR etiketi i18n'den (ortak yardımcı)
  const label = phaseLabelTR(phaseId, spec);
  if (directRun) {
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
  if (!runtime.state || !runtime.config) {
    emitError("no active project", null);
    return;
  }
  const spec = PHASE_SPECS[phaseId];
  if (!spec) {
    emitError(`phase ${phaseId} spec yok`, null);
    return;
  }

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
    emitError(`phase ${phaseId} only-run failed`, String(err));
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
      const p = new Phase8Controller({ state, config: cfg, spec });
      runtime.controller = p;
      try {
        result = String(await p.run());
      } finally {
        runtime.controller = null;
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
        "Çalışan test MyCL'in oluşturduğu **genel bir sayfa-açılır kontrolü** — senin özel isteğini (örneğin belirli bir özelliğin gerçekten çalışması) test etmez.",
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
      verdict = computeVerdict(eventsSince(allEvents, state.iteration_started_at ?? 0));
    } catch (err) {
      log.warn("orchestrator", "verdict compute failed (non-blocking)", err);
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
      });
    }
  } catch (err) {
    log.warn("orchestrator", "pipeline end summary failed", err);
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
  const d = data as { path?: string } | undefined;
  // Proje değişiyor → önceki projeye ait bekleyen command_direct'ler bayat → at.
  commandDirectQueue.clear();
  await handleOpenProject(String(d?.path ?? ""));
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
// Denetim Ajanı (YZLLM 2026-06-11): "MyCL Kalite Kontrol Testi" butonu → (düzenlenmiş) sorularla orkestratörü
// denetle → rapor → MyCL-içi çözülebilirler vs kaynak-kodu-değişikliği gerekenler ayrımı → chat.
ipcRouter.register("start_quality_audit", async (data: unknown) => {
  if (!runtime.state || !runtime.config) {
    emitError("no active project", null);
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
    emitError("active controller does not support abort", null);
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
  const app = new App({
    loadI18n,
    startRuntimeHttpServer,
    emitConfigStatus,
    dispatch,
    gracefulShutdown,
  });
  await app.start();
}

void main();
