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
  persistAgentBackends,
  persistFeatures,
  persistSelectedModels,
  readAgentBackends,
  readClaudeCodeFlags,
  readFeatures,
  readSelectedModels,
  type AgentBackends,
  type ApiKeys,
  type ClaudeCodeFlags,
  type SelectedModels,
} from "./config.js";
import { loadOrInit, save as saveState } from "./state.js";
import { clearHistory } from "./history.js";
import { appendAbandonedIntent } from "./abandoned-intents.js";
import {
  appendAudit as appendAuditModule,
  appendCost,
  readCosts,
  extractSpecSection,
  readAuditLog,
  readAuditLogTail,
  wasPipelineCompleted,
} from "./audit.js";
import { computeVerdict, type HarnessVerdict } from "./harness-verdict.js";
import { buildPipelineEndLines } from "./pipeline-end-summary.js";
import { detectInterruptedPhase2To9Pure } from "./resume-detection.js";
import { runDast } from "./dast-runner.js";
import { setRecordContext } from "./record-context.js";
import {
  appendTask,
  readTasks,
  removeTask,
} from "./task-queue/store.js";
import type { TaskQueueItem } from "./task-queue/types.js";
import {
  beginPhaseCost,
  clearActiveAskq,
  emit,
  emitAskq,
  emitAskqResolved,
  emitChatMessage,
  emitError,
  emitPhaseChanged,
  emitUserGuide,
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
import { computeTiersFromModels, modelForTier } from "./model-catalog.js";
import { buildStrengthReportTR, recordStrength } from "./model-strength-report.js";
import { runQualityAudit, DEFAULT_QUALITY_QUESTIONS } from "./quality-audit.js";
import { verifyWorkAtHigherRung } from "./verify-up.js";
import { isApiAccountError, isEnvironmentError, environmentErrorAdvice } from "./claude-api.js";
import { isClaudeAvailable } from "./codegen/cli-backend.js";
import { nextRung, resolveRung, rungLabel, rungForDomain } from "./escalation.js";
import { discoverModelsViaWeb } from "./model-discovery.js";
import { ensureAgentSkills } from "./skills-setup.js";
import { runGateAutofix } from "./gate-autofix.js";
import { Phase0Controller } from "./phase-0.js";
import { snapshotPrototype } from "./prototype-cache.js";
import { extractStockedModules } from "./module-stock.js";
import { generateGuidePdf } from "./guide-pdf.js";
import {
  setRuntimeHttpTarget,
  startRuntimeHttpServer,
  stopRuntimeHttpServer,
} from "./runtime-http-server.js";
import { detachActiveWatcher } from "./runtime-error-watcher.js";
import { Phase1Controller } from "./phase-1.js";
import { Phase2Controller } from "./phase-2.js";
import { Phase3Controller } from "./phase-3.js";
import { Phase4Controller } from "./phase-4.js";
import { Phase5Controller } from "./phase-5.js";
import { Phase6Controller } from "./phase-6.js";
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
import { runBlindspotLens, formatLensFindings } from "./pre-commit-lens.js";
import { loadProfile } from "./profile-loader.js";
import { isProcessAlive } from "./process-utils.js";
import { stopActiveDevServer } from "./dev-server-launcher.js";
import { loadI18n, t } from "./i18n.js";
import { log } from "./logger.js";
import { readFile as fsReadFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import type { CostRecord, PhaseId, PhaseSpec, State } from "./types.js";
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
  // Ümit: "çalışırken ne yaptığını söylesin her zaman." Faz controller'ı çalıştığı SÜRECE
  // sticky banner (⏳ + ne yaptığı). try/finally ile zorunlu kapanış (takılı spinner yok).
  // askq'da fn() döner → finally → idle (bekleme ≠ çalışma). Sonraki turda tekrar açılır.
  if (runningLabel) emit("phase_running", { label: runningLabel, ts: Date.now() });
  try {
    return await fn();
  } finally {
    runtime.controller = null;
    if (runningLabel) emit("phase_idle", { ts: Date.now() });
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
// 2026-06-10 (Ümit: "bu kadar kolay bişeyi çözemedi, node_modules silmeyi düşündü") — faz-fail oto-çözüm
// döngü-kıranı İMZA bazlı: aynı faz + aynı hata-imzası AUTO_SOLVE_MAX kez otomatik denenip ÇÖZÜLEMEDİYSE,
// bir daha aynı hatayı otomatik tamir etmeye çalışma (fix işe yaramıyor → kök neden başka) → kullanıcıya sor.
// Zaman PENCERESİ YOK: logda aynı hata saatlerce tekrarladı, 45-dk pencere sıfırlanınca döngü sürdü.
// FARKLI hata imzası → sayaç sıfır (yeni sorun meşru, otomatik denenir).
// Oto-cevap KAPALI: zaten otomatik düzeltmiyor (kullanıcıya sorar). Oto-cevap AÇIK (Ümit: "durmasın, darboğazda
// devam etsin"): aynı hata-imzasında bile yüksek tavana kadar (snapshot güvenliğiyle) DENEMEYE devam; farklı bir
// hata çıkarsa imza sıfırlanır (ilerleme = sınırsız sürer). Yalnız AYNI hata bu tavanı aşarsa "gerçekten takıldı"
// deyip kullanıcıya bırakır (sonsuz aynı-fix döngüsü = sahte-yeşil/kaynak israfı backstop).
const AUTO_SOLVE_MAX = 6;
const autoSolveSig = new Map<number, { sig: string; count: number }>();

// Model yükseltme önerisi (Ümit 2026-06-11): keşif yeni güçlü model bulunca OTOMATİK uygulamaz, SORAR.
// _pendingModelUpgrade: açık askq + önerilen model. _declinedModelUpgrades: bu oturumda "hayır" denenler (tekrar sorma).
let _pendingModelUpgrade: { askqId: string; model: string } | null = null;
const _declinedModelUpgrades = new Set<string>();

// Ümit 2026-06-11: kullanıcı çalışan fazı başka faza yönlendirdi → abort tamamlanınca BU fazdan OTOMATİK devam
// (tekrar yazdırma yok). failPhase'in user-abort dalı tüketir.
let _resumePhaseAfterAbort: PhaseId | null = null;

// Ümit 2026-06-11: "en yüksek model+efor yetmezse SDK'dan güncelleri çek, onlara geç." Oturum içinde aynı modeli
// tekrar tekrar benimsememek için (sonsuz döngü kıran).
const _adoptedNewerModels = new Set<string>();

/**
 * Tepe-tükenmesinde Anthropic SDK'dan (models.list) güncel modelleri çek; mevcut strong'dan FARKLI/daha yeni bir
 * güçlü model varsa config'e yaz (strong tier + main) + reload → benimsenen model id döner. Yoksa/çekilemezse null.
 */
async function tryAdoptNewerStrongModel(): Promise<string | null> {
  if (!runtime.config || !runtime.state) return null;
  const apiKey = runtime.config.api_keys.main || runtime.config.api_keys.translator;
  if (!apiKey) return null; // API anahtarı yok (salt-abonelik) → SDK listesi çekilemez
  let fetched: Awaited<ReturnType<typeof listModels>>;
  try {
    fetched = await listModels(apiKey, true);
  } catch (e) {
    log.warn("orchestrator", "topout model fetch failed", e);
    return null;
  }
  const t = computeTiersFromModels(fetched.models.map((m) => ({ id: m.id, display_name: m.display_name })));
  const sel = runtime.config.selected_models;
  const currentStrong = sel.model_tiers?.strong ?? modelForTier("strong", sel.model_tiers).id;
  if (!t.strong || t.strong === currentStrong || _adoptedNewerModels.has(t.strong)) return null;
  _adoptedNewerModels.add(t.strong);
  await persistSelectedModels({
    ...sel,
    main: t.strong,
    model_tiers: { ...(sel.model_tiers ?? {}), strong: t.strong },
  } as SelectedModels);
  runtime.config = null;
  await emitConfigStatus(); // reload + restart'sız aktif
  return t.strong;
}

// Escalation CLIMB-RETRY'ye uygun fazlar — ana loop İÇİNDE koşanlar (failPhase → advanceToNextPhase(n-1) ile aynı
// fazı doğru re-run eder). Faz 1 (intent) loop DIŞINDA koşar → climb-retry path'i kırık → hariç (yine de model'i
// merdivenden cheap'ten başlar, sadece climb-retry yapmaz). Faz 6 ayrı model kullanmaz; 0 debug; 10-17 mekanik.
const ESCALATION_PHASES = new Set<PhaseId>(
  [2, 3, 4, 5, 7, 8, 9].map((n) => n as PhaseId),
);

/** Hata imzası: faz + lastFailReason'ın ilk ~160 char'ı (sayılar normalize → port/pid/ts gürültüsü eşleşmeyi bozmasın). */
function failSignature(n: PhaseId, ctrl?: FailReasonHolder): string {
  const raw = (ctrl?.lastFailReason ?? "")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return `${n}:${raw}`;
}

// Escalation (Ümit 2026-06-11): faz → domain etiketi (rapor + "hangi işi hangi modelle yaptık").
function phaseDomain(n: PhaseId): string {
  const map: Partial<Record<number, string>> = {
    0: "debug", 1: "intent", 2: "audit", 3: "briefing", 4: "spec",
    5: "ui-codegen", 6: "ui-review", 7: "db-design", 8: "tdd-codegen", 9: "risk-review",
  };
  return map[n] ?? `phase-${n}`;
}

/**
 * #1 deliği (Ümit 2026-06-11): pipeline-end doğrulama şeffaflığı. Bu iterasyonda hangi kalite gate'i (10-17)
 * GEÇTİ vs hangisi ATLANDI (araç yok / uygulanamaz) — atlanan gate "geçti" gibi görünmesin. Audit'ten okur.
 */
async function emitVerificationSummary(state: State): Promise<void> {
  const GATE_DIMS: Record<number, string> = {
    10: "Lint", 11: "Sadeleştirme", 12: "Performans", 13: "Güvenlik",
    14: "Birim test", 15: "Entegrasyon", 16: "E2E", 17: "Yük testi",
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

/** Escalation merdiveninde bu fazın (domain'in) deneme sonucunu rapora yaz (hangi model hangi işte iyi). */
async function recordRungOutcome(n: PhaseId, success: boolean): Promise<void> {
  if (!runtime.state || !runtime.config) return;
  const domain = phaseDomain(n);
  const rung = rungForDomain(runtime.state, domain);
  const model = resolveRung(rung, runtime.config.selected_models.model_tiers).modelId;
  await recordStrength({ domain, rung: rungLabel(rung), model, success }, Date.now());
}

// Verify-up yükseltme sınırı: faz başına en çok 2 (maliyet emniyeti; merdiven zaten sonlu). İterasyon başında temizlenir.
const _verifyUpRaises = new Map<number, number>();

/**
 * Faz tamamlandı → (Ümit 2026-06-11) "yetersizliği NET anla": işi bir ÜST basamağa (önce efor+1, efor tepedeyse
 * model+1) KONTROL ettir. Yeterli → basamak kalır + rapora başarı. Yetersiz → rapora başarısızlık + domain basamağı
 * KONTROLCÜYE yükselir + faz o seviyede yeniden koşar ("rerun"). Oto-cevap kapalı / merdiven-dışı faz / tepe →
 * yalnız başarı kaydı (kontrol yok).
 */
async function completePhaseWithVerify(n: PhaseId): Promise<"ok" | "rerun"> {
  if (!runtime.state || !runtime.config) return "ok";
  const domain = phaseDomain(n);
  if (!autoAnswerSuggested() || !ESCALATION_PHASES.has(n)) {
    await recordRungOutcome(n, true);
    return "ok";
  }
  const raises = _verifyUpRaises.get(n) ?? 0;
  if (raises >= 2) {
    await recordRungOutcome(n, true);
    emitChatMessage("system", `ℹ️ Faz ${n}: üst-kontrol yükseltme sınırına ulaşıldı — mevcut sonuç kabul edildi.`);
    return "ok";
  }
  emitChatMessage("system", `🔍 Üst-basamak kontrolü: bir üst seviye Faz ${n} işini denetliyor…`);
  const v = await verifyWorkAtHigherRung(
    runtime.config,
    runtime.state,
    n,
    domain,
    phaseLabelTR(n, PHASE_SPECS[n]!),
  );
  if (v.verdict === "inadequate" && v.checker) {
    await recordRungOutcome(n, false); // bu basamak işi YETERSİZ çözdü → rapor gerçeği bilsin
    _verifyUpRaises.set(n, raises + 1);
    const model = resolveRung(v.checker, runtime.config.selected_models.model_tiers).modelId;
    runtime.state = {
      ...runtime.state,
      escalation_rungs: { ...(runtime.state.escalation_rungs ?? {}), [domain]: v.checker },
      updated_at: Date.now(),
    };
    await saveState(runtime.state);
    emitChatMessage(
      "system",
      `🔼 Üst-kontrol: iş YETERSİZ${v.reasons.length ? ` (${v.reasons.slice(0, 2).join("; ")})` : ""} → ${rungLabel(v.checker)} (${model}) seviyesine yükseltildi; Faz ${n} yeniden koşuyor.`,
    );
    return "rerun";
  }
  await recordRungOutcome(n, true);
  if (v.verdict === "adequate") {
    emitChatMessage("system", "✅ Üst-kontrol: iş yeterli — basamak korunuyor.");
  }
  return "ok";
}

async function failPhase(n: PhaseId, ctrl?: FailReasonHolder): Promise<void> {
  // Kullanıcı çalışan fazı yönlendirmeyle durdurduysa bu bir HATA değil — analiz/oto-çözüm BAŞLATMA.
  // (Ümit: "beni dinlemedi" — durdurma sonrası MyCL kendi analizine dalmasın, kullanıcının isteğine geçsin.)
  if (isUserInitiatedAbort()) {
    clearUserInitiatedAbort();
    emitChatMessage("system", `⏹ Faz ${n} durduruldu (sen yönlendirdin).`);
    // Ümit 2026-06-11: kullanıcı hedef fazı zaten söyledi → OTOMATİK oradan devam (tekrar yazdırma yok).
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
  // HESAP/ORTAM hatası (Ümit 2026-06-11): kredi/bakiye yetersiz, fatura, auth/kota → PROJE hatası DEĞİL, model
  // zayıflığı DEĞİL. Her API çağrısı aynı hatayı verir → escalation (modeli pahalıya tırmandırma) + hata-analizi
  // (o da API çağrısı) ANLAMSIZ ve kısır döngü. DUR + net söyle; tırmanma/analiz/fix YAPMA.
  if (isApiAccountError(ctrl?.lastFailReason ?? "") || isApiAccountError(message)) {
    // Ümit 2026-06-11: "API hata verince aboneliğe OTOMATİK geçmeli." Abonelik (claude CLI) varsa + şu an API'deysek
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
  // GENEL ORTAM hatası (Ümit 2026-06-11, E2BIG-döngüsü logu): E2BIG/port-dolu/komut-yok/spawn → PROJE hatası DEĞİL,
  // model zayıflığı DEĞİL. Debug/oto-çözüm döngüsü (proje kodunu kurcalar) ANLAMSIZ + ajan döngüye girer (logda
  // AC-marker'ı stub/yorumla geçmeye çalışıp sahte-yeşile kaydı). DUR + ortama-özel net rehber; tırmanma/analiz/fix YOK.
  {
    const envReason = `${ctrl?.lastFailReason ?? ""}\n${message}`;
    if (isEnvironmentError(envReason)) {
      emitChatMessage("system", `⛔ ${environmentErrorAdvice(envReason)}`);
      return; // STOP — proje-fix döngüsüne GİRME.
    }
  }
  // ESCALATION (Ümit 2026-06-11): sorun çıktı → bir ÜST basamağa çık + AYNI fazı tekrar dene (debug/oto-çözüme
  // KAÇMADAN). Yalnız Oto-cevap açıkken + LLM fazlarında (1-9; mekanik gate'ler 10-17 araç koşar, model'e duyarsız
  // → escalation anlamsız → mevcut akış). Her deneme rapora kaydedilir. Tepeye (strong·max) gelince escalation
  // biter → mevcut derin çözüm (debug/oto-çözüm) akışına düşülür.
  // Yalnız MERDİVENE BAĞLI fazlarda escalation (model+eforu escalation_rung'tan çözenler) — yoksa tırmanma boşa
  // re-run olur. Şimdilik spec (4) + codegen (8). Yeni faz bağlandıkça bu kümeye eklenir.
  // Ümit 2026-06-11: escalation YALNIZ proje/kod hatasında tırmanır. Ortam hatasında (kredi/dev-server/port/komut)
  // daha güçlü model çözmez → tırmanma anlamsız + pahalı. Kesme/abort da hata değil (rapora yazma, tırmanma).
  const failReason = ctrl?.lastFailReason ?? "";
  const projectError =
    !isEnvironmentError(failReason) && !isEnvironmentError(message) && !/\babort/i.test(failReason);
  if (autoAnswerSuggested() && ESCALATION_PHASES.has(n) && projectError) {
    const domain = phaseDomain(n);
    await recordRungOutcome(n, false);
    const cur = rungForDomain(runtime.state, domain);
    const up = nextRung(cur);
    if (up) {
      const model = resolveRung(up, runtime.config.selected_models.model_tiers).modelId;
      // PER-DOMAIN climb (monotonik): yalnız bu domain'in basamağı yükselir; diğer domain'ler dokunulmaz.
      runtime.state = {
        ...runtime.state,
        escalation_rungs: { ...(runtime.state.escalation_rungs ?? {}), [domain]: up },
        updated_at: Date.now(),
      };
      await saveState(runtime.state);
      emitChatMessage(
        "system",
        `🔼 Faz ${n} (${domain}) ${rungLabel(cur)} ile çözemedi → ${rungLabel(up)} (${model}) ile aynı işi tekrar deniyorum.`,
      );
      await advanceToNextPhase((n - 1) as PhaseId);
      return;
    }
    // Tepeye gelindi (strong·max) da çözemedi → ÖNCE Anthropic SDK'dan güncel modellere bak (Ümit 2026-06-11:
    // "elindeki en yüksek model+efor yetmezse SDK'dan güncelleri çek, onlara geç"). Daha yeni güçlü model varsa
    // otomatik geç + aynı fazı onunla dene. Yoksa derin çözüm akışına düş. "Düşürme yok": rung strong·max kalır.
    const adopted = await tryAdoptNewerStrongModel();
    if (adopted) {
      emitChatMessage(
        "system",
        `🆕 En güçlü basamak yetmedi → Anthropic'ten güncel modeli çektim: **${adopted}** strong tier'a alındı; aynı işi onunla deniyorum.`,
      );
      await advanceToNextPhase((n - 1) as PhaseId);
      return;
    }
    emitChatMessage("system", `⛰ Faz ${n} en güçlü basamakta da çözemedi (daha yeni model de yok) — derin çözüm akışına geçiyorum.`);
  }
  // Oto-çözüm YALNIZ "Oto-cevap" açıkken (Ümit: "oto-cevap işaretliyse yapar onları"). Kapalıyken MyCL
  // otomatik kod değiştirmez — seçenekleri kullanıcıya sorar (otonomi = kullanıcı opt-in'i). Ek olarak
  // döngü-kıran: AYNI imza AUTO_SOLVE_MAX kez denendiyse yine sor (sahte-yeşil/sonsuz-döngü önleme).
  const otoCevap = autoAnswerSuggested();
  const sig = failSignature(n, ctrl);
  const prev = autoSolveSig.get(n);
  const sameSig = prev?.sig === sig;
  const priorCount = sameSig ? prev!.count : 0;
  const autoResolve = otoCevap && priorCount < AUTO_SOLVE_MAX;
  const exhausted = otoCevap && priorCount >= AUTO_SOLVE_MAX;
  if (!autoResolve) {
    emitChatMessage(
      "system",
      !otoCevap
        ? "ℹ️ Oto-cevap kapalı — hatayı otomatik düzeltmiyorum; seçenekleri sana soruyorum (Oto-cevap'ı açarsan otomatik çözer)."
        : `ℹ️ Aynı hata ${AUTO_SOLVE_MAX} otomatik çözüm denemesine rağmen sürüyor — demek ki sorun değiştirdiğim yerde DEĞİL.`,
    );
  }
  // Ümit 2026-06-10: "oto-cevap açıksa ve geri almaktan başka çare yoksa MyCL kendi geri alsın."
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
 * Config'ten TÜREYEN modül-singleton'ları uygula (Ümit 2026-06-10: "kapatıp açmadan da aktif olsun").
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
    // v15.11: Açılışta mevcut UI kullanma kılavuzunu "Kılavuz" sekmesine push
    // et (varsa). Yoksa sessiz — bootstrap arka planda üretip sonra emit eder.
    void fsReadFile(pathJoin(path, ".mycl", "user-guide.md"), "utf-8")
      .then((c) => {
        if (c.trim()) emitUserGuide(c);
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

    // v15.7 (2026-05-24): İş kuyruğunu frontend'e yolla
    void emitInitialTaskQueue(path);
    // Runtime HTTP server hedef proje bilgisini güncelle — UI'dan gelen
    // POST /__mycl/runtime-error çağrıları bu projenin errors.db'sine yazar.
    setRuntimeHttpTarget({
      projectRoot: path,
      dbPath: `${path}/error_folder/errors.db`,
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
        // 2026-06-09 (Ümit): otomatik çözüm modunda boot'ta da sorma — kaldığı yerden uygula.
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
    const interrupted = await detectInterruptedPhase1(runtime.state);
    if (interrupted) {
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
    // v15.7 (2026-05-26): Phase 2-9 boot-resume (production readiness madde 08).
    // Faz 1 dışı yarım kalmış faz varsa advanceToNextPhase(N-1) ile restart.
    // Phase 5 tweak mode hariç (pending_ui_tweak akışı zaten kendi handler'ı
    // ile devam eder; çift tetik olmasın).
    const interrupted29 = await detectInterruptedPhase2To9(runtime.state);
    if (interrupted29 && !runtime.state.pending_ui_tweak) {
      const phaseId = interrupted29.phaseId;
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
    if (runtime.config && runtime.state) {
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

    // agent-skills AUTO-KURULUM (Ümit 2026-06-09: "sadece önermesin, bağlasın"): yoksa pinli commit'ten
    // arka planda kur → cli-backend --plugin-dir ile codegen ajanlarına bağlar. Non-blocking, fail görünür.
    void ensureAgentSkills().catch((e: unknown) =>
      log.warn("orchestrator", "agent-skills kurulum hatası (non-fatal)", e),
    );

    // Model AUTO-KEŞİF (Ümit 2026-06-11): LLM WEB'de Anthropic dökümanlarından güncel modelleri bulur → ASLA
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
          if (t.strong && t.strong !== currentStrong && !_declinedModelUpgrades.has(t.strong)) {
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
      const hasPending =
        (st.current_phase > 0 && st.current_phase < 17) ||
        !!st.pending_ui_tweak ||
        st.dev_server_pid !== undefined;
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
        "- current_phase ∈ [5..16] (mid-pipeline) → 'X fazı yarıda. Devam " +
        "etmek için soldaki Fazlar listesinden o faza tıkla ve \"Sadece " +
        "Çalıştır\"ı seç.' (faz adı kullan, numara değil)\n" +
        "- pending_ui_tweak set → 'UI değişikliği bekliyor — soldan Faz 5'e " +
        "tıkla.'\n" +
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
  // Ucuz erken-çıkış — audit okumadan (saf modülde de aynı guard var, IO'dan kaçın).
  if (state.current_phase < 2 || state.current_phase > 9) return null;
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
  };
  try {
    await appendTask(runtime.state.project_root, task);
    const items = await readTasks(runtime.state.project_root);
    emit("task_queue_changed", { items });
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
 */
async function emitInitialTaskQueue(projectRoot: string): Promise<void> {
  try {
    const items = await readTasks(projectRoot);
    emit("task_queue_loaded", { items });
  } catch (err) {
    log.warn("task-queue", "initial load failed", err);
  }
}

async function handleSaveApiKeys(keys: ApiKeys): Promise<void> {
  log.info("orchestrator", "save_api_keys", { keys }); // logger REDACT eder
  if (!keys || !keys.translator || !keys.main) {
    emitError("save_api_keys: both translator and main keys required", null);
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
        if (v === "api" || v === "cli" || v === "auto") clean[role] = v;
      }
      if (Object.keys(clean).length > 0) {
        await persistAgentBackends(clean);
      }
    }
    runtime.config = null;
    const ok = await emitConfigStatus(); // runtime.config'i + singleton'ları YENİDEN yükler (restart'sız aktif)
    // Görünür onay (Ümit 2026-06-10: "kapatıp açmadan da aktif olsun") — kullanıcı değişimin
    // anında geçerli olduğunu görür; bir sonraki iş/faz yeni backend+model+efor ile koşar.
    const fresh = runtime.config as MyclConfig | null;
    if (ok && fresh) {
      const b = fresh.agent_backends;
      const label = (v: string | undefined) => (v === "cli" ? "Abonelik" : v === "auto" ? "Auto" : "API");
      emitChatMessage(
        "system",
        `✅ Ayarlar uygulandı — yeniden başlatma GEREKMEZ. Bir sonraki iş şu ayarla koşar:\n` +
          `• Backend → main: ${label(b?.main)}, translator: ${label(b?.translator)}, orkestratör: ${label(b?.orchestrator)}\n` +
          `• Model → main: ${fresh.selected_models.main}` +
          `${flagsPatch.effort ? ` · efor: ${flagsPatch.effort}` : ""}`,
      );
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
      // 2026-06-11 (Ümit): tırmanılan per-domain escalation seviyeleri — ayarlarda read-only gösterilir.
      escalation_rungs: runtime.state?.escalation_rungs ?? {},
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
  if (runtime.controller) {
    emitChatMessage(
      "system",
      "Faz zaten çalışıyor — komut bekletildi.",
    );
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
// 2026-06-10 (Ümit: "beni dinlemedi" — logda: faz çalışırken "Faz 10'dan devam et" dedi, MyCL iki kez
// "önce mevcut faza cevap ver" deyip reddetti). DOĞRU davranış: kullanıcının AÇIK yönlendirmesi çalışan
// fazı EZER → çalışanı durdur (abort), yeni isteği lock boşalınca işle. Reddetme YOK.
let _pendingRedirect: string | null = null;
let _userInitiatedAbort = false;

/** Çalışan fazı/işi kullanıcı yönlendirmesi nedeniyle durdurmak için (failPhase analizini atlatır). */
function isUserInitiatedAbort(): boolean {
  return _userInitiatedAbort;
}
function clearUserInitiatedAbort(): void {
  _userInitiatedAbort = false;
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
}
async function handleUserMessageInner(text: string): Promise<void> {
  log.info("orchestrator", "user_message", { text_len: text.length });
  if (!runtime.state || !runtime.config) {
    emitError("no active project", null);
    return;
  }
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
    const lens = await runBlindspotLens(
      runtime.config,
      runtime.state.project_root,
      "decision",
      `Action: ${decision.action}${
        decision.target_phase !== undefined ? ` (phase ${decision.target_phase})` : ""
      }\nReason: ${decision.reason}`,
    );
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
      await emitPhaseRunAskq(decision.target_phase);
      return;
    }
    case "approve_ui":
    case "revise_ui":
    case "resume_pipeline":
    case "develop_new_or_iter": {
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
    case "cancel_pipeline":
    case "debug_triage": {
      // Destructive / maliyetli aksiyonlar için askq korunur:
      // - cancel_pipeline: iş kaybı riski
      // - debug_triage: Phase 0 başlatır (LLM maliyet)
      // NOT (kod-analiz 2026-06-07): `run_phase` BURADAN kaldırıldı — yukarıdaki ilk
      // `case "run_phase"` (emitPhaseRunAskq) zaten ele alıyor; JS switch ilk eşleşeni
      // çalıştırdığından buradaki dal ÖLÜ koddu (eski yorum tersini iddia ediyordu).
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
    await emitPhaseRunAskq(decision.target_phase);
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
        pending_backend_fix: undefined,
        updated_at: Date.now(),
      };
      await saveState(runtime.state);
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
    });
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
    // 2026-06-09 (Ümit: "hata çözümünü sorma, kendin çöz"): D1'in önerdiği seçenek
    // sorulmadan otomatik uygulanır — askq cevabıyla aynı routing (handleAskqAnswer).
    const diag = runtime.state?.pending_diagnostic;
    if (result === "complete" && diag?.phase === "D2_WAITING" && diag.auto_selected_label) {
      await handleAskqAnswer(diag.askq_id, diag.auto_selected_label);
    }
    return;
  }

  // outcome.action === "develop_new_or_iter" → wasPipelineCompleted ise yeni
  // iterasyon, değilse fresh Phase 1.
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
      ui_tweak_count: undefined,
      pending_backend_fix: undefined,
      pending_migrations: undefined,
      pending_diagnostic: undefined,
      // v15.6: needed_phases scope iterasyon-spesifiktir — yeni iterasyonda
      // Faz 3 LLM tekrar önerir, kullanıcı tekrar onaylar.
      needed_phases: undefined,
      needed_phases_proposed: undefined,
      iteration_count: newIter,
      // Escalation (Ümit 2026-06-11): "yeni iterasyon baştan başlamasın; önceki tecrübeler önemli; yükseltme var
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
    _verifyUpRaises.clear(); // verify-up yükseltme bütçesi iterasyon-başına
    emitChatMessage(
      "system",
      `🔄 Yeni iterasyon başlıyor (#${newIter}). Eski spec.md/kod referans olarak korunuyor; Claude Faz 1'de Read ile bakabilir.`,
    );
    emitPhaseChanged(runtime.state.current_phase, 1, "running");
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
  const p1 = new Phase1Controller({
    state: runtime.state,
    config: runtime.config,
    spec,
  });
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
    // Sonraki faz: P1 → P2 (ardışık akış).
    await advanceToNextPhase(1);
  } else {
    await failPhase(1, p1);
  }
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
  skip_unless: "has_ui" | "has_nfr" | "has_database" | "always" | undefined,
): Promise<boolean> {
  if (!skip_unless || skip_unless === "always") return true;
  let spec = "";
  try {
    spec = await fsReadFile(pathJoin(projectRoot, ".mycl", "spec.md"), "utf-8");
  } catch {
    return false;
  }
  const lower = spec.toLowerCase();
  if (skip_unless === "has_ui") {
    return /\b(ui|frontend|görsel|ekran|sayfa|button|web|react|vue|svelte)\b/.test(
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
 * (5, 6, 7, 8) etkilenir — zorunlu fazlar her zaman çalışır. needed_phases
 * undefined ise eski davranış (tüm fazlar çalışır).
 */
function isPhaseSkippedByScope(state: State, phaseId: number): boolean {
  // Ümit 2026-06-11 (#2 deliği): Faz 8 (TDD/testler) ARTIK ZORUNLU — atlanırsa hiç test yazılmaz → test-temelli
  // doğrulama (Faz 14) boşalır → kontrol delinir. Yalnız 5 (UI)/6 (UI review)/7 (DB) gerçekten opsiyonel
  // (UI/DB yoksa). Faz 8/9 + zorunlu mekanik gate'ler her zaman çalışır.
  if (phaseId !== 5 && phaseId !== 6 && phaseId !== 7) return false;
  if (!state.needed_phases || state.needed_phases.length === 0) return false;
  return !state.needed_phases.includes(phaseId);
}

export async function advanceToNextPhase(from: PhaseId): Promise<void> {
  if (!runtime.state || !runtime.config) return;
  // Narrowing — döngü içinde runtime.state assignments TS'in null-check'ini bozar.
  let state: State = runtime.state;
  const cfg: MyclConfig = runtime.config;
  let cur: PhaseId = from;
  // v15.9: değişen-kapsam bir kez hesaplanır (ilk mekanik fazda); scoped-touch
  // modunda scope'lanamayan sistem-gate'leri atlanır.
  let scopeComputed = false;
  // Ümit 2026-06-10: auto-düzeltilebilir gate (lint) bu koşuda BİR kez kendi-içinde-düzeltme denedi mi?
  // (1 satırlık lint'i sonsuz düzeltmeye çalışıp döngüye girmesin — bir deneme, olmazsa eskale.)
  const gateAutofixTried = new Set<number>();

  // ARDIŞIK akış: N → N+1, atlamasız. Controller'ı olmayan fazlar skip stub
  // ile geçer (audit phase-N-skipped + phase-N-complete) ama state.current_phase
  // tüm fazları sırayla ziyaret eder. Bu kural deterministik.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // v15.8 (2026-05-31): Önceki fazın token kovasını yaz (LLM turn'ü olduysa).
    // Faz başlangıcında beginPhaseCost set edildi; burada flush + cost.jsonl.
    // Mekanik/atlanan fazlar token üretmez → kova boş → yazılmaz.
    const prevCost = takePhaseCost();
    if (prevCost && (prevCost.turns > 0 || prevCost.input_tokens > 0)) {
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
      // F4 (item 6): proje-içi PDF kullanım kılavuzu (user-guide.md + dev-server ayaktaysa
      // rota ss'leri → public/docs/kullanim-kilavuzu.pdf). Headless Chromium; precondition
      // yoksa görünür skip. Non-blocking — kendi içinde fail-closed, asla throw.
      await generateGuidePdf(state).catch((e: unknown) =>
        log.warn("orchestrator", "guide-pdf generation failed (non-fatal)", e),
      );
      // v15.9: scoped kapsam + fix checkpoint ref tüketildi — temizle (sonraki
      // iterasyonda stale scope yanlış daraltma yapmasın).
      if (state.changed_scope || state.fix_checkpoint_ref) {
        state = { ...state, changed_scope: undefined, fix_checkpoint_ref: undefined };
        runtime.state = state;
        await saveState(state);
      }
      // #1 deliği (Ümit 2026-06-11): sessiz gate-atlama şeffaflığı. Pipeline bitince hangi kalite boyutunun
      // GERÇEKTEN doğrulandığını, hangisinin ATLANDIĞINI (araç yok / uygulanamaz) açıkça göster — atlanan gate
      // "geçti" gibi görünmesin. Kullanıcı neyin doğrulanmadığını bilerek kabul etsin.
      await emitVerificationSummary(state);
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
        if ((await completePhaseWithVerify(2)) === "rerun") { cur = 1 as PhaseId; continue; }
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
          const askqId = `phase_scope_${randomUUID()}`;
          runtime.pendingPhaseScope = { askqId, proposed };
          const phaseList = proposed
            .map((p) => `Faz ${p}`)
            .join(", ");
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
        if ((await completePhaseWithVerify(3)) === "rerun") { cur = 2 as PhaseId; continue; }
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
        if ((await completePhaseWithVerify(4)) === "rerun") { cur = 3 as PhaseId; continue; } // verify-up: yetersizse yükselt+yeniden
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
        if ((await completePhaseWithVerify(5)) === "rerun") { cur = 4 as PhaseId; continue; }
        cur = 5;
        continue;
      } else {
        await failPhase(5, p5);
        return;
      }
    }
    if (next === 6) {
      // v15.0 Batch E: structured `skip_ui_phases` öncelikli (Phase 2 classifier).
      const hasUi = await shouldRunMechanical(state.project_root, "has_ui");
      if (state.skip_ui_phases || !hasUi) {
        // QC E-2: aynı format Faz 5 ile tutarlı (structured vs heuristic skip).
        const reason = state.skip_ui_phases
          ? `classifier_skip project_type=${state.project_type ?? "unknown"}`
          : "no_ui_in_spec";
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 6,
          event: "phase-6-skipped",
          caller: "mycl-orchestrator",
          detail: reason,
        });
        await appendAuditModule(state.project_root, {
          ts: Date.now(),
          phase: 6,
          event: "phase-6-complete",
          caller: "mycl-orchestrator",
        });
        emitChatMessage(
          "system",
          state.skip_ui_phases
            ? `Faz 6 atlandı — proje tipi UI gerektirmiyor (${state.project_type ?? "?"}).`
            : "Faz 6 atlandı — UI yok.",
        );
        cur = 6;
        continue;
      }
      // Phase 6 DEFERRED mode (MyCL_Pseudocode.md:145-174): controller askq
      // açmaz, hemen "deferred" döner. State.current_phase=7 kaydedilir ve
      // outer loop STOP. User'ın bir sonraki composer mesajı router'da Phase 6
      // context'inde işlenir (approve_ui / revise_ui / cancel_pipeline).
      const p6 = new Phase6Controller({ state, config: cfg, spec });
      const r = await runController(p6, () => p6.run(), "UI inceleniyor");
      log.info("orchestrator", "phase 6 end", { result: r });
      // Phase 6 dev server'ı (boot-resume'da Faz 5 spawn atlandığı için ölü
      // olabilir) yeniden başlatmış olabilir → güncel dev_server_pid'i persist
      // et. Deferred yol normalde state kaydetmez; statePatch boşsa no-op.
      if (Object.keys(p6.statePatch).length > 0) {
        state = { ...state, ...p6.statePatch };
        runtime.state = state;
        await saveState(state);
      }
      // r === "deferred" — Header'a "YANIT BEKLENİYOR" durumunu yansıt + frontend
      // running banner'ı kapansın (waiting → banner null reducer'da).
      void r;
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
        if ((await completePhaseWithVerify(7)) === "rerun") { cur = 6 as PhaseId; continue; }
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
        "Faz 8 başlıyor — TDD codegen. Bu uzun sürebilir, maliyetli olabilir.",
      );
      const p8 = new Phase8Controller({ state, config: cfg, spec });
      const r = await runController(p8, () => p8.run(), "TDD uygulanıyor");
      log.info("orchestrator", "phase 8 end", { result: r });
      if (r === "complete") {
        if ((await completePhaseWithVerify(8)) === "rerun") { cur = 7 as PhaseId; continue; } // verify-up: yetersizse yükselt+yeniden
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
        if ((await completePhaseWithVerify(9)) === "rerun") { cur = 8 as PhaseId; continue; }
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
      if (!scopeComputed && shouldComputeScope(state)) {
        scopeComputed = true;
        try {
          const sc = await computeChangedScope(state.project_root, state.fix_checkpoint_ref);
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

      // Faz 17 (load test) için pre-step: spec.md'den Performance/NFR section'ı
      // extract et ve audit'e detail olarak yaz. k6 komutu bu threshold'ları
      // BİLMEZ (script'i kullanıcı yazar) ama Faz 20 validation report bu
      // bilgiyi audit'ten okuyabilir → load test kararının NFR ile alakası
      // tespit edilebilir.
      if (next === 17) {
        let nfrText = "";
        try {
          nfrText = await extractSpecSection(state.project_root, "Performance");
        } catch {
          try {
            nfrText = await extractSpecSection(state.project_root, "NFR");
          } catch {
            // spec.md veya section yok → NFR context boş; audit yazılmaz.
          }
        }
        if (nfrText) {
          await appendAuditModule(state.project_root, {
            ts: Date.now(),
            phase: 16,
            event: "phase-16-nfr-context",
            caller: "mycl-orchestrator",
            detail: nfrText.replace(/\s+/g, " ").slice(0, 200),
          });
        }
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
        changedScope: state.changed_scope?.files,
      });
      // Ümit: "çalışırken ne yaptığını söylesin." Mekanik faz (lint/test/build — yavaş olabilir)
      // çalıştığı sürece sticky banner. try/finally → takılı spinner yok.
      emit("phase_running", { label: phaseLabelTR(next, spec), ts: Date.now() });
      let outcome;
      try {
        outcome = await runner.run();
      } finally {
        emit("phase_idle", { ts: Date.now() });
      }
      log.info("orchestrator", `phase ${next} mechanical end`, {
        outcome: outcome.kind,
      });
      if (outcome.kind === "pass" || outcome.kind === "skipped") {
        // Faz GEÇTİ → iyi ilerlemeyi KİLİTLE: rollback noktasını temizle ki sonraki bir hatanın geri-alması
        // bu başarılı fazı UNDO etmesin (Ümit: "veri kaybına yol açmayanı tercih ederim").
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
      // Ümit kararı: güvenlik-gate-fail "TAMAMLANDI" demesin (MEDIUM dahil bloklar).
      // F1 analiz askq'ına yönlendir (Çöz / Kabul et devam / Tekrar analiz). security-fail
      // / csp-evaluator-fail / semgrep-*-fail event'lerini runner zaten yazdı → harness
      // bunları *-fail görür. Akış DURUR; "Kabul et, devam et" cevabı handleAskqAnswer'da
      // phase-13-complete (security_accepted_by_user) yazıp advanceToNextPhase(13) ile
      // sürdürür (takılma yok — kullanıcı override edebilir).
      if (next === 13) {
        emitPhaseChanged(13, 13, "error");
        let pending: PendingErrorAnalysis | null = null;
        if (runtime.state && runtime.config) {
          pending = await analyzeAndAskError(runtime.state, runtime.config, {
            phase: 13,
            message: "Faz 13 (Güvenlik) gate'i başarısız — çözülmeden tamamlandı sayılmaz.",
            detail: outcome.stderr,
            allowAcceptContinue: true,
            acceptContinuePhase: 13,
          }).catch(() => null);
        }
        if (!pending) {
          // Analiz yapılamadı (örn. API modu — orkestratör rolü CLI değil). Dead-end YOK:
          // LLM'siz doğrudan blocking karar askq'ı (Kabul et devam / Tekrar analiz).
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
      // 2026-06-10 (Ümit: "bitirdiğin bir faz olan Faz 8'e geri dönmen saçma; debug'dan sonra döneceği yeri yanlış
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
        emitChatMessage(
          "system",
          `🔧 Faz ${next} (${phaseLabelTR(next, spec)}) — bildirilen hataları fazın içinde düzeltiyorum (bu fazın işi; debug'a kaçmadan).`,
        );
        const fixRan = await runGateAutofix(state, cfg, next, phaseLabelTR(next, spec), outcome.stderr);
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
          emit("phase_running", { label: phaseLabelTR(next, spec), ts: Date.now() });
          let reOutcome;
          try {
            reOutcome = await reRunner.run();
          } finally {
            emit("phase_idle", { ts: Date.now() });
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
            cur = next;
            continue;
          }
          // Hâlâ fail → güncel çıktıyla aşağıdaki investigate+solve'a düş.
          outcome = reOutcome;
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
      "**Yalnız localhost/127.0.0.1** hedeflenir; üretim veya uzak sunucuya ASLA " +
      "çalışmaz. Aktif test olduğu için uygulamada geçici yük / yan etki olabilir " +
      "(geliştirme ortamında çalıştır). Onaylıyor musun?",
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

  // Model yükseltme önerisi cevabı (Ümit 2026-06-11): "Evet" → main + strong tier config'e yazılır + reload;
  // "Hayır" → bu oturumda tekrar sorma. Ayarlar tek doğruluk kaynağı; kabul edince config'e işlenir.
  if (_pendingModelUpgrade && id === _pendingModelUpgrade.askqId) {
    const model = _pendingModelUpgrade.model;
    _pendingModelUpgrade = null;
    const yes = /evet|geç|yes/i.test(selectedText);
    if (yes && runtime.config) {
      const sel = runtime.config.selected_models;
      await persistSelectedModels({
        ...sel,
        main: model,
        model_tiers: { ...(sel.model_tiers ?? {}), strong: model },
      } as SelectedModels);
      runtime.config = null;
      await emitConfigStatus(); // reload + applyConfigDerivedSettings (restart'sız aktif)
      emitChatMessage("system", `✅ Main ajan + strong görevler artık **${model}** kullanıyor — ayarların güncellendi.`);
    } else {
      _declinedModelUpgrades.add(model);
      emitChatMessage("system", `👍 Tamam, ${model}'e geçmedim; mevcut modelin korunuyor. (Bu oturumda tekrar sormam.)`);
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
    emit("phase_running", {
      label: DAST_RUNNING_LABEL,
      detail: "nuclei — yalnız localhost",
      ts: Date.now(),
    });
    try {
      await appendAuditModule(st.project_root, {
        ts: Date.now(),
        phase: st.current_phase,
        event: "dast-run-start",
        caller: "user",
      }).catch(() => {});
      const res = await runDast(st);
      emitChatMessage(res.ok ? "system" : "error", res.summary_tr);
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
    } catch (err) {
      emitChatMessage(
        "error",
        `Güvenlik taraması başarısız: ${String(err).slice(0, 200)}`,
      );
    } finally {
      emit("phase_idle", { ts: Date.now() });
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
    await executeDispatchedIntent(bugReport, fakeOutcome);
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
      // Debug bir KESİNTİYDİ; iptal = "sorun yokmuş → kaldığım yerden DEVAM" (Ümit: orkestratör takılıp
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
    // D5 dokunuş haritası (Ümit: "hangi çözümü seçersem nerelere dokunur").
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
      // GUARDRAIL 2 (Ümit 2026-06-10): bu MyCL'in KENDİ otomatik düzeltmesi — KULLANICI feature isteği DEĞİL.
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

async function emitPhaseRunAskq(phaseId: number): Promise<void> {
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
    // Ümit 2026-06-11: "kullanıcı zaten Faz 11 yazdı, tekrar yazdırmanın anlamı yok." Kullanıcı hangi fazı
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
    const specMdPath = `${runtime.state.project_root}/.mycl/spec.md`;
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
  try {
    const profile = await loadProfile(state.stack);
    if (profile?.default_port) defaultPort = profile.default_port;
  } catch (err) {
    log.warn("orchestrator", "profile load for default_port failed", err);
  }
  const scaffoldRes = await ensurePlaywrightScaffold(
    state.project_root,
    defaultPort,
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
    // DÜRÜST hüküm (Ümit'in #1 endişesi: "sessizce TAMAMLANDI deme"). Mekanik
    // gate'ler (Faz 10-17) SOFT — patlasa bile orkestratör `phase-N-complete`
    // (soft_complete_after_fail) yazıp devam eder. computeVerdict audit'ten
    // gerçeği çıkarır: gate-fail veya güvenlik-skip varsa hüküm PASS değildir.
    let verdict: HarnessVerdict | null = null;
    try {
      verdict = computeVerdict(await readAuditLog(state.project_root));
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
  await handleOpenProject(String(d?.path ?? ""));
});
ipcRouter.register("user_message", async (data: unknown) => {
  const d = data as { text?: string } | undefined;
  await handleUserMessage(String(d?.text ?? ""));
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
});
ipcRouter.register("save_api_keys", async (data: unknown) => {
  await handleSaveApiKeys(data as ApiKeys);
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
// Model Güç Raporu (Ümit 2026-06-11): composer'daki buton → escalation gözlemlerinden "hangi model hangi alanda
// iyi" raporunu üret + popup'a yolla.
ipcRouter.register("get_model_strength_report", async () => {
  const text = await buildStrengthReportTR();
  emit("model_strength_report", { text });
});
// Merdiven sıfırlama (Ümit 2026-06-11): ayarlardaki buton → tüm domain'ler cheap·low'dan yeniden başlar.
ipcRouter.register("reset_escalation_ladder", async () => {
  if (!runtime.state) {
    emitError("no active project", null);
    return;
  }
  runtime.state = { ...runtime.state, escalation_rungs: {}, updated_at: Date.now() };
  await saveState(runtime.state);
  emitChatMessage("system", "🪜 Model merdiveni sıfırlandı — tüm işler en düşük basamaktan (cheap · low) yeniden başlayacak.");
  await handleReadSelectedModels(); // Settings'teki "Tırmanılan seviyeler" anında tazelensin
});
// Denetim Ajanı (Ümit 2026-06-11): "MyCL Kalite Kontrol Testi" butonu → (düzenlenmiş) sorularla orkestratörü
// denetle → rapor → MyCL-içi çözülebilirler vs kaynak-kodu-değişikliği gerekenler ayrımı → chat.
ipcRouter.register("start_quality_audit", async (data: unknown) => {
  if (!runtime.state || !runtime.config) {
    emitError("no active project", null);
    return;
  }
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
});
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
    // Ümit 2026-06-11: durdur-butonu = KULLANICI kesmesi — başarısızlık DEĞİL. Bu bayrak olmadan failPhase
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
