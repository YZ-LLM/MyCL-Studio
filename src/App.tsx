// App — MyCL Studio v14 entry. Splash ↔ Main layout state machine.

import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { Splash } from "./components/Splash";
import { Settings } from "./components/Settings";
import { GuideModal } from "./components/GuideModal";
import { QualityAuditModal } from "./components/QualityAuditModal";
import { AppHeader } from "./components/AppHeader";
import { RightActionBar, type RightPanel } from "./components/RightActionBar";
import { OrchestratorPanel } from "./components/OrchestratorPanel";
import { PhaseSidebar } from "./components/PhaseSidebar";
import {
  ChatPanel,
  type ChatMessage,
  type PendingAskq,
} from "./components/ChatPanel";
import { TranslatorPanel, type TranslationEntry } from "./components/TranslatorPanel";
import { ClaudeSimulator, type CCEvent } from "./components/ClaudeSimulator";
import { useOrchestrator } from "./hooks/useOrchestrator";
import type {
  AgentBackends,
  ModelTiers,
  DesignWorkflowMode,
  CostRecord,
  ModelInfo,
  OrchestratorEvent,
  PhaseId,
  PhaseStatus,
  PhaseSummary,
  PipelineEndEvent,
  TaskQueueItem,
} from "./types/events";
import { TaskQueuePanel } from "./components/TaskQueuePanel";
import { TokenTimelinePanel } from "./components/TokenTimelinePanel";
import { ErrorDrawer } from "./components/ErrorDrawer";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ConfigStatus =
  | { state: "unknown" }
  | { state: "ready" }
  | {
      state: "missing";
      reason:
        | "api_keys_missing"
        | "model_selection_missing"
        | "load_failed"
        | "i18n_load_failed";
      detail?: string;
    };

interface ModelsList {
  models: ModelInfo[];
  fetched_at: number;
  loading: boolean;
}

const EMPTY_LIST: ModelsList = { models: [], fetched_at: 0, loading: false };

/** v15.6 — orkestrator ajan event'i (modal'da gösterilir). */
export interface AgentThinkingEvent {
  ts: number;
  /** YZLLM 2026-06-26 (mahkeme #10): monoton benzersiz sıra no — aynı-ms olaylar React key çakışmasıyla
   *  görünümden DÜŞMESİN (req 3 "yaptığı herşeyi göster"). ts tek başına benzersiz değil. */
  seq?: number;
  sub: "started" | "completed" | "tool_use" | "decision" | "error";
  /** Agent Teams görünürlüğü: hangi ajan (örn. "Mimari"/"UX"). Tek orkestratörde boş. */
  agent_label?: string;
  turn?: number;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  decision?: Record<string, unknown>;
  error?: string;
}

interface MainState {
  messages: ChatMessage[];
  pendingAskq: PendingAskq | null;
  /** Orkestratör "şu projeyi aç" istedi (ör. okunamayan proje kopyalandı → kopyayı aç). useEffect tüketir + temizler. */
  pendingOpenRequest: { path: string; integrate?: boolean } | null;
  /** Entegre (foreign-origin) projede oto-cevap bastırılıyor → checkbox devre-dışı görünür (YZLLM). */
  autoAnswerSuppressed: boolean;
  translations: TranslationEntry[];
  ccEvents: CCEvent[];
  ccBanner: {
    version: string;
    model: string;
    cwd: string;
    turn?: number;
    max_turns?: number;
    /** Cumulative token totals (faz boyunca tüm turn'ler toplanır). */
    tokens_input: number;
    tokens_output: number;
    cache_read: number;
    cache_write: number;
    turns_counted: number;
  } | null;
  phase: PhaseId;
  /** Ulaşılan en yüksek pipeline fazı — debug (Faz 0) sırasında "yarım kalan" fazı işaretlemek için. */
  maxPhase: PhaseId;
  phaseStatus: PhaseStatus;
  /** YZLLM 2026-06-12: İterasyonun Faz 1 hedefi (NİYET kutusu). Backend'den iteration_intent ile gelir;
   *  null ise ChatPanel "ilk user mesajı" heuristiğine düşer (geri uyum). */
  iterationIntent: string | null;
  /** Sticky loading banner — emitPhaseRunning / emitPhaseIdle ile yönetilir. */
  runningBanner: { label: string; detail?: string; ts: number } | null;
  /** Feature 3 history state. */
  historyLoaded: boolean;
  oldestLoadedTs: number;
  olderAvailable: boolean;
  loadingOlder: boolean;
  /** v15.6 — Orkestrator ajan event listesi (max 100 entry, dedup by ts). */
  agentEvents: AgentThinkingEvent[];
  /** Orkestratörün TÜM önemli aktivitesi (tool_use + decision + error) — Orkestra panelini besler;
   *  agentEvents'ten ayrı, daha yüksek cap (500) → uzun oturumda aktivite yutulmaz ("yaptığı herşey"). */
  orchestratorActivity: AgentThinkingEvent[];
  /** Monoton aktivite sayacı (mahkeme #10): her kabul edilen agent_event'e benzersiz seq verir → React key
   *  çakışması/olay-düşmesi olmaz (aynı-ms olaylar korunur). */
  agentEventSeq: number;
  /** Faz geçiş işaretçileri (her faz başlangıcı: ts + faz no) — chat'te faz çizgisi + faza tıklayınca jump. */
  phaseMarkers: { ts: number; to: number }[];
  /**
   * v15.6 — Aktif agent.respond() çağrı sayısı. started → +1, completed → -1.
   * 0 değil ise composer'da loading spinner gösterilir. Paralel boot + user
   * message akışı için counter (bool değil).
   */
  agentBusyCount: number;
  /** v15.7 — İş kuyruğu (proje-spesifik). Backend `task_queue_loaded` ve
   *  `task_queue_changed` ile günceller. */
  taskQueue: TaskQueueItem[];
  /** v15.7 (2026-05-26) — Session token totals (madde 13). Header badge. */
  tokenTotals: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    api_calls: number;
  };
  /** Token-timeline — faz-bazında token harcaması (cost.jsonl). cost_phase canlı
   *  upsert eder, cost_history (load_costs yanıtı) tümünü değiştirir. */
  costTimeline: CostRecord[];
  /** Akış sonu DÜRÜST hüküm (pipeline_end). null = henüz akış bitmedi / yeni akış.
   *  PARTIAL/FAIL ise sidebar başarısız gate'lere ⚠️ basar, header çip gösterir. */
  pipelineVerdict: PipelineEndEvent["data"] | null;
}

const INITIAL_STATE: MainState = {
  messages: [],
  pendingAskq: null,
  pendingOpenRequest: null,
  autoAnswerSuppressed: false,
  translations: [],
  ccEvents: [],
  ccBanner: null,
  runningBanner: null,
  phase: 1,
  maxPhase: 1 as PhaseId,
  phaseStatus: "running",
  iterationIntent: null,
  historyLoaded: false,
  oldestLoadedTs: 0,
  olderAvailable: true,
  loadingOlder: false,
  agentEvents: [],
  agentEventSeq: 0,
  orchestratorActivity: [],
  phaseMarkers: [],
  agentBusyCount: 0,
  taskQueue: [],
  tokenTotals: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    api_calls: 0,
  },
  costTimeline: [],
  pipelineVerdict: null,
};

function reduce(state: MainState, ev: OrchestratorEvent): MainState {
  if (ev.kind === "chat_message") {
    const data = ev.data;
    const newMsg = {
      id: state.messages.length + 1,
      role: data.role,
      text: data.text,
      ts: data.ts,
    };
    // Runtime hata mesajları rolling window — chat'e spam etmesin (2026-05-22).
    // Yeni "🔴 Runtime hata yakalandı" mesajı gelince eski runtime mesajlarından
    // son 1 tanesini koru, geri kalanı sil. Yeni mesajla birlikte ekranda max 2.
    const isRuntimeErrorMsg = /^🔴\s+\*\*(Runtime hata yakalandı|UI runtime hata)/.test(
      data.text,
    );
    if (isRuntimeErrorMsg) {
      const nonRuntime = state.messages.filter(
        (m) =>
          !/^🔴\s+\*\*(Runtime hata yakalandı|UI runtime hata)/.test(m.text),
      );
      const runtimeMessages = state.messages.filter((m) =>
        /^🔴\s+\*\*(Runtime hata yakalandı|UI runtime hata)/.test(m.text),
      );
      // Son 1 eski runtime mesajını koru → yenisiyle birlikte ekranda 2 görünür.
      const keepRecentRuntime = runtimeMessages.slice(-1);
      return {
        ...state,
        messages: [...nonRuntime, ...keepRecentRuntime, newMsg],
      };
    }
    return {
      ...state,
      messages: [...state.messages, newMsg],
    };
  }
  if (ev.kind === "open_project_request") {
    // Orkestratör "şu projeyi aç" istedi (okunamayan proje kopyalandı → kopyayı aç). useEffect tüketir.
    return { ...state, pendingOpenRequest: ev.data };
  }
  if (ev.kind === "auto_answer_mode") {
    // Entegre projede oto-cevap bastırılıyor → checkbox devre-dışı görünsün (kararları kullanıcı verir).
    return { ...state, autoAnswerSuppressed: ev.data.suppressed };
  }
  if (ev.kind === "error") {
    const d = ev.data;
    const detailText = d.detail
      ? typeof d.detail === "string"
        ? d.detail
        : JSON.stringify(d.detail, null, 2)
      : undefined;
    return {
      ...state,
      messages: [
        ...state.messages,
        {
          id: state.messages.length + 1,
          role: "error",
          text: d.reason,
          detail: detailText,
          ts: Date.now(),
        },
      ],
    };
  }
  if (ev.kind === "translation") {
    const d = ev.data;
    return {
      ...state,
      translations: [
        ...state.translations,
        {
          id: state.translations.length + 1,
          dir: d.dir,
          input: d.input,
          output: d.output,
          model: d.model,
          elapsed_ms: d.elapsed_ms,
          ok: d.ok,
          ts: d.ts,
        },
      ],
    };
  }
  if (ev.kind === "askq") {
    return {
      ...state,
      pendingAskq: {
        id: ev.data.id,
        ts: Date.now(), // mesajlar da Date.now() → sonra yazılan mesaj kartın altında görünür
        question: ev.data.question,
        options: ev.data.options,
        allow_other: ev.data.allow_other,
        multi_select: ev.data.multi_select,
        suggested_option: ev.data.suggested_option,
      },
      phaseStatus: "waiting",
    };
  }
  if (ev.kind === "iteration_intent") {
    // YZLLM 2026-06-12: NİYET kutusu = iterasyonun Faz 1 hedefi (sabit). null → heuristiğe düş.
    return { ...state, iterationIntent: ev.data.text };
  }
  if (ev.kind === "token_totals") {
    return { ...state, tokenTotals: ev.data };
  }
  if (ev.kind === "cost_phase") {
    // Token-timeline: canlı faz-cost. Aynı (phase, iteration) varsa GÜNCELLE, yoksa EKLE
    // (faz yeniden koşarsa duplike olmasın); ts'e göre sıralı kalsın.
    const rec = ev.data;
    const idx = state.costTimeline.findIndex(
      (c) => c.phase === rec.phase && c.iteration === rec.iteration,
    );
    const costTimeline =
      idx >= 0
        ? state.costTimeline.map((c, i) => (i === idx ? rec : c))
        : [...state.costTimeline, rec];
    return { ...state, costTimeline };
  }
  if (ev.kind === "cost_history") {
    // load_costs yanıtı — geçmiş tüm faz-cost'u (proje açılışı). Tümünü değiştir.
    return { ...state, costTimeline: ev.data.costs };
  }
  if (ev.kind === "askq_resolved") {
    // v15.7 (2026-05-26): Backend askq cevap işledi (kapı bekçisi answer_askq
    // veya askq UI click). pendingAskq eşleşirse clear et — askq kartı UI'dan kalkar.
    if (state.pendingAskq && state.pendingAskq.id === ev.data.id) {
      // YZLLM 2026-06-12: askq cevaplandı → "yanıt bekleniyor" durumu kalksın (bayat kalmasın). Faz devam eder
      // (running); bittiyse sonraki phase_changed düzeltir. Yalnız "waiting" iken sıfırla, diğer durumlara dokunma.
      return {
        ...state,
        pendingAskq: null,
        phaseStatus: state.phaseStatus === "waiting" ? "running" : state.phaseStatus,
      };
    }
    return state;
  }
  if (ev.kind === "phase_running") {
    return {
      ...state,
      runningBanner: {
        label: ev.data.label,
        detail: ev.data.detail,
        ts: ev.data.ts,
      },
    };
  }
  if (ev.kind === "phase_idle") {
    return { ...state, runningBanner: null };
  }
  if (ev.kind === "phase_changed") {
    // Banner phase_changed status=running ile AÇILMAZ (yanıltıcı: Phase 7
    // deferred Claude turn'ü yok). Banner sadece claude_stream init ile açılır.
    // Ama complete/error/waiting → generic claude banner'ı kapat. Spesifik
    // emitPhaseRunning ile açılmışsa (label != "🤖 Model çalışıyor") korunur.
    const isGenericClaude =
      state.runningBanner?.label === "🤖 Model çalışıyor";
    const closeBanner =
      isGenericClaude &&
      (ev.data.status === "complete" ||
        ev.data.status === "error" ||
        ev.data.status === "waiting");
    // Yeni akış/iterasyon Faz 1'de "running" ile başlar → eski hüküm rozetlerini
    // temizle (önceki koşunun ⚠️'leri yeni akışa sızmasın).
    const freshRun = ev.data.to === 1 && ev.data.status === "running";
    // Faz geçiş işaretçileri (YZLLM: chat'te faz geçişinde çizgi + faza tıklayınca ilk mesaja git). Bir faz
    // BAŞLAYINCA (status=running, yeni numara) {ts, to} kaydedilir; freshRun (yeni iterasyon) listeyi sıfırlar.
    // ts = frontend Date.now() (backend+frontend aynı makine → mesaj ts'leriyle karşılaştırılabilir).
    const lastMarker = state.phaseMarkers[state.phaseMarkers.length - 1];
    let phaseMarkers = state.phaseMarkers;
    if (ev.data.status === "running" && ev.data.to >= 1) {
      if (freshRun) {
        phaseMarkers = [{ ts: Date.now(), to: ev.data.to }];
      } else if (!lastMarker || lastMarker.to !== ev.data.to) {
        phaseMarkers = [...state.phaseMarkers, { ts: Date.now(), to: ev.data.to }].slice(-100);
      }
    }
    return {
      ...state,
      phaseMarkers,
      phase: ev.data.to,
      // Debug (Faz 0) maxPhase'i DEĞİŞTİRMEZ; freshRun (yeni iterasyon) sıfırlar. "Yarım kalan" faz = maxPhase.
      maxPhase: freshRun
        ? (1 as PhaseId)
        : ev.data.to === 0
          ? state.maxPhase
          : (Math.max(state.maxPhase, ev.data.to) as PhaseId),
      phaseStatus: ev.data.status,
      pendingAskq: null,
      runningBanner: closeBanner ? null : state.runningBanner,
      pipelineVerdict: freshRun ? null : state.pipelineVerdict,
    };
  }
  if (ev.kind === "pipeline_end") {
    // Akış sonu DÜRÜST hüküm — sidebar/header bu sayede gate-fail'i gösterir.
    return { ...state, pipelineVerdict: ev.data };
  }
  if (ev.kind === "history_chunk") {
    const d = ev.data;
    const chatMessages: ChatMessage[] = [];
    const translations: TranslationEntry[] = [];
    const ccEvents: CCEvent[] = [];
    for (const e of d.events) {
      const data = e.data as Record<string, unknown>;
      if (e.kind === "chat_message") {
        chatMessages.push({
          id: 0,
          role: data.role as ChatMessage["role"],
          text: String(data.text ?? ""),
          ts: e.ts,
        });
      } else if (e.kind === "translation") {
        translations.push({
          id: 0,
          dir: data.dir as TranslationEntry["dir"],
          input: String(data.input ?? ""),
          output: String(data.output ?? ""),
          model: String(data.model ?? ""),
          elapsed_ms: Number(data.elapsed_ms ?? 0),
          ok: Boolean(data.ok),
          ts: e.ts,
        });
      } else if (e.kind === "claude_stream") {
        const sub = String(data.sub ?? "");
        // token_usage ve init Reducer'da banner için kullanılır; visible stream'e
        // dahil değil. Tarihte de panel'de gösterilmesin → skip.
        if (sub === "token_usage" || sub === "init" || sub === "relevance_call") {
          continue;
        }
        ccEvents.push({
          id: 0,
          sub: sub as CCEvent["sub"],
          text: typeof data.text === "string" ? data.text : undefined,
          tool_name: typeof data.tool_name === "string" ? data.tool_name : undefined,
          tool_input:
            typeof data.tool_input === "object" && data.tool_input !== null
              ? (data.tool_input as Record<string, unknown>)
              : undefined,
          is_error: typeof data.is_error === "boolean" ? data.is_error : undefined,
          system: typeof data.system === "string" ? data.system : undefined,
          user_message:
            typeof data.user_message === "string" ? data.user_message : undefined,
          ts: e.ts,
        });
      }
    }
    // History chunk her zaman PREPEND + stable sort by ts. `isInitial` ayrımı
    // yanlıştı: boot sırasında user mesaj yazarsa (state.messages dolarken
    // historyLoaded=false), gelen history_chunk live mesajı override ediyordu
    // (3. göz QC HIGH 4 bulgusu). Şimdi her zaman merge + sort: history
    // event'leri normalde state.messages'ın ts'lerinden eski olur, sort sadece
    // defensive (clock skew / lazy chunk overlap edge case'i).
    const stableSort = <T extends { ts: number }>(arr: T[]): T[] => {
      // ts EQ olan event'lerin göreli sırası korunsun → indexed sort.
      return arr
        .map((item, idx) => ({ item, idx }))
        .sort((a, b) => a.item.ts - b.item.ts || a.idx - b.idx)
        .map(({ item }) => item);
    };
    // ts-based dedupe: history_chunk birden fazla kez gelirse (boot effect
    // duplicate dispatch ya da backend echo) aynı event'leri tekrar prepend
    // etmez. Üretim raporu (2026-05-20): "1 yazdım 6 görünüyor" — kullanıcı
    // 1 user mesajı + 3 history user msg → 4 beklenir, 6 göründü. Reducer
    // idempotent değildi. Şimdi: mevcut state'in ts setine bakar, varsa skip.
    const existingMsgTs = new Set(state.messages.map((m) => m.ts));
    const existingTrTs = new Set(state.translations.map((t) => t.ts));
    const existingCcTs = new Set(state.ccEvents.map((c) => c.ts));
    const dedupedChat = chatMessages.filter((m) => !existingMsgTs.has(m.ts));
    const dedupedTr = translations.filter((t) => !existingTrTs.has(t.ts));
    const dedupedCc = ccEvents.filter((c) => !existingCcTs.has(c.ts));
    const newMessages = stableSort([...dedupedChat, ...state.messages]);
    const newTranslations = stableSort([...dedupedTr, ...state.translations]);
    const newCcEvents = stableSort([...dedupedCc, ...state.ccEvents]);
    return {
      ...state,
      messages: newMessages.map((m, i) => ({ ...m, id: i + 1 })),
      translations: newTranslations.map((t, i) => ({ ...t, id: i + 1 })),
      ccEvents: newCcEvents.map((c, i) => ({ ...c, id: i + 1 })),
      historyLoaded: true,
      oldestLoadedTs:
        d.oldest_returned_ts > 0 ? d.oldest_returned_ts : state.oldestLoadedTs,
      olderAvailable: d.older_available,
      loadingOlder: false,
    };
  }
  if (ev.kind === "claude_stream") {
    const d = ev.data;
    if (d.sub === "init") {
      // Yeni faz başladı → cumulative token sayaçlarını sıfırla. Faz değişimi
      // sırasında system prompt değiştiği için cache de invalidate olur; ayrı
      // ayrı izlemek anlamlı.
      // Sticky loading banner: gerçek model turn'ü başlıyor. Spesifik
      // emitPhaseRunning ile zaten detaylı banner açıksa (Hata Ara, smoke test)
      // KORUNUR; aksi takdirde generic "🤖 Model çalışıyor" banner açılır.
      // sub="stop" veya "token_usage" ile bu generic banner kapanır.
      return {
        ...state,
        ccBanner: {
          version: d.text ?? "v?",
          model: d.model ?? state.ccBanner?.model ?? "?",
          cwd: d.cwd ?? state.ccBanner?.cwd ?? "?",
          turn: d.turn ?? state.ccBanner?.turn,
          max_turns: d.max_turns ?? state.ccBanner?.max_turns,
          tokens_input: 0,
          tokens_output: 0,
          cache_read: 0,
          cache_write: 0,
          turns_counted: 0,
        },
        runningBanner: state.runningBanner ?? {
          label: "🤖 Model çalışıyor",
          detail: d.model,
          ts: d.ts ?? Date.now(),
        },
      };
    }
    // sub === "stop": model bir turn'ü tamamladı → generic "🤖 Model çalışıyor"
    // banner'ı kapat. Codegen loop'unda kısa flicker olabilir; kullanıcı
    // (2026-05-23) yanıltıcı görünmektense flicker'ı tercih etti. Spesifik
    // emitPhaseRunning banner'ları (Hata Ara, smoke test) korunur.
    if (d.sub === "stop") {
      const isGenericClaude =
        state.runningBanner?.label === "🤖 Model çalışıyor";
      return {
        ...state,
        runningBanner: isGenericClaude ? null : state.runningBanner,
      };
    }
    if (d.sub === "token_usage" && d.usage) {
      // Cumulative — her runTurn sonunda bir kez emit edilir.
      const prev = state.ccBanner;
      const cacheRead = d.usage.cache_read_input_tokens ?? 0;
      const cacheWrite = d.usage.cache_creation_input_tokens ?? 0;
      return {
        ...state,
        ccBanner: {
          version: prev?.version ?? "v?",
          model: d.model ?? prev?.model ?? "?",
          cwd: prev?.cwd ?? "?",
          turn: prev?.turn,
          max_turns: prev?.max_turns,
          tokens_input: (prev?.tokens_input ?? 0) + d.usage.input_tokens,
          tokens_output: (prev?.tokens_output ?? 0) + d.usage.output_tokens,
          cache_read: (prev?.cache_read ?? 0) + cacheRead,
          cache_write: (prev?.cache_write ?? 0) + cacheWrite,
          turns_counted: (prev?.turns_counted ?? 0) + 1,
        },
      };
    }
    // Diğer sub'lar (text/tool_use/tool_result/retry/error/stop/request) →
    // visible event stream'e ekle. CCEventKind union'ı token_usage'ı içermez.
    return {
      ...state,
      ccEvents: [
        ...state.ccEvents,
        {
          id: state.ccEvents.length + 1,
          sub: d.sub as CCEvent["sub"],
          text: d.text,
          tool_name: d.tool_name,
          tool_input: d.tool_input,
          is_error: d.is_error,
          system: d.system,
          user_message: d.user_message,
          ts: d.ts,
        },
      ],
    };
  }
  // v15.6: Orkestrator ajan event'leri — "🧠 Orkestrator" modal'da listelenir.
  // Dedup by ts; max 100 entry (en eski drop). Reverse-chronological görünüm
  // için modal kendisi reverse() yapar; store kronolojik tutar.
  if (ev.kind === "agent_event") {
    const d = ev.data;
    // Busy counter: started/completed sayaca etki eder. ETİKETSİZ (tek orkestratör) → yalnız sayaç.
    // ETİKETLİ (Agent Teams perspektif/modül ajanı) → ayrıca listele ki "hangi ajan başladı/bitti" görünsün.
    if (d.sub === "started" || d.sub === "completed") {
      const agentBusyCount =
        d.sub === "started"
          ? state.agentBusyCount + 1
          : Math.max(0, state.agentBusyCount - 1);
      if (!d.agent_label) return { ...state, agentBusyCount };
      const teamEvent: AgentThinkingEvent = {
        ts: d.ts,
        sub: d.sub,
        agent_label: d.agent_label,
      };
      const m = [...state.agentEvents, teamEvent];
      return {
        ...state,
        agentBusyCount,
        agentEvents: m.length > 100 ? m.slice(m.length - 100) : m,
      };
    }
    const newEvent: AgentThinkingEvent = {
      ts: d.ts,
      seq: state.agentEventSeq, // benzersiz key (mahkeme #10) — aynı-ms olaylar görünümden düşmesin
      sub: d.sub,
      agent_label: d.agent_label,
      turn: d.turn,
      tool_name: d.tool_name,
      tool_input: d.tool_input,
      decision: d.decision,
      error: d.error,
    };
    // Yeniden-işleme guard'ı (mahkeme #10): YALNIZ GERÇEK tekrarı ele (effect re-fire/StrictMode aynı olayı iki kez
    // verirse) — ts'i AYNI ama içeriği FARKLI distinct olayları (aynı-ms iki tool_use) DÜŞÜRME. Eski "ts === d.ts"
    // tek başına distinct olayları yutuyordu (req 3 "yaptığı herşeyi göster" ihlali). İçerik-bazlı tam eşleşme:
    const isReprocessed = state.agentEvents.some(
      (e) =>
        e.ts === d.ts &&
        e.sub === d.sub &&
        e.tool_name === d.tool_name &&
        e.error === d.error &&
        JSON.stringify(e.tool_input) === JSON.stringify(d.tool_input) &&
        JSON.stringify(e.decision) === JSON.stringify(d.decision),
    );
    if (isReprocessed) return state;
    const merged = [...state.agentEvents, newEvent];
    // Max 100 entry — en eskileri drop (slice from end)
    const capped = merged.length > 100 ? merged.slice(merged.length - 100) : merged;
    // Orkestratörün TÜM önemli aktivitesi (tool_use + decision + error) AYRI + daha yüksek cap'li store'da
    // birikir → agentEvents'in 100-cap'i bunu yutmasın. YZLLM "yaptığı HERŞEYİ yazsın; o iterasyonda neler
    // yapıldı hepsini anlayabileyim". Cap 500 (tool_use bol olabilir); started/completed (yaşam-döngüsü gürültüsü)
    // hariç. Orkestra paneli bu store'u sade Türkçe gösterir.
    const isActivity = d.sub === "tool_use" || d.sub === "decision" || d.sub === "error";
    const acts = isActivity ? [...state.orchestratorActivity, newEvent] : state.orchestratorActivity;
    const actCapped = acts.length > 500 ? acts.slice(acts.length - 500) : acts;
    return {
      ...state,
      agentEvents: capped,
      orchestratorActivity: actCapped,
      agentEventSeq: state.agentEventSeq + 1, // kabul edilen olay → sayacı ilerlet (benzersiz seq)
    };
  }
  // v15.7 (2026-05-24): İş kuyruğu — backend her değişiklikte tam listeyi yollar
  if (ev.kind === "task_queue_loaded" || ev.kind === "task_queue_changed") {
    return { ...state, taskQueue: ev.data.items };
  }
  // v15.7 (2026-05-25): Feature flags — read_features / save_features sonrası
  // backend push. Stored in MainState yerine ayrı state'te (Settings'e prop geçirilir).
  return state;
}

function App() {
  const orch = useOrchestrator();
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [mainState, setMainState] = useState<MainState>(INITIAL_STATE);
  const [processedCount, setProcessedCount] = useState(0);
  // v15.13 (saha 3/5): Oto-cevap toggle (Orkestrator yanındaki checkbox). localStorage'da
  // saklanır; backend'e config_status ready'de (restore) + her değişimde komutla bildirilir.
  // YZLLM 2026-06-20: DEFAULT AÇIK — yalnız kullanıcı açıkça kapattıysa ("0") kapalı; ilk açılışta açık.
  const [autoAnswer, setAutoAnswer] = useState<boolean>(
    () => localStorage.getItem("mycl_auto_answer") !== "0",
  );
  const handleAutoAnswerToggle = (enabled: boolean): void => {
    setAutoAnswer(enabled);
    localStorage.setItem("mycl_auto_answer", enabled ? "1" : "0");
    void orch.send({ kind: "set_auto_answer", data: { enabled } });
  };


  // v15.13 (saha 5/5): kullanıcı aksiyonu beklenirken (askq) OS bildirimi.
  // Açılışta izin iste (sessiz başarısız — bildirim plugin'i yoksa akışı bozma).
  useEffect(() => {
    void (async () => {
      try {
        if (!(await isPermissionGranted())) await requestPermission();
      } catch {
        /* bildirim yoksa sessiz geç */
      }
    })();
  }, []);

  // Yeni bir askq gelince (id değişince) bildirim — yalnız pencere ODAKTA DEĞİLSE
  // (kullanıcı zaten bakıyorsa spam etme). Tek askq başına bir kez.
  const lastNotifiedAskq = useRef<string | null>(null);
  useEffect(() => {
    const askq = mainState.pendingAskq;
    if (!askq || lastNotifiedAskq.current === askq.id) return;
    lastNotifiedAskq.current = askq.id;
    void (async () => {
      try {
        const focused = await getCurrentWindow()
          .isFocused()
          .catch(() => true);
        if (focused) return; // odakta → bildirme
        if (!(await isPermissionGranted())) return;
        sendNotification({
          title: "MyCL — yanıtın bekleniyor",
          body: askq.question.slice(0, 140),
        });
      } catch {
        /* sessiz */
      }
    })();
  }, [mainState.pendingAskq]);
  const [configStatus, setConfigStatus] = useState<ConfigStatus>({
    state: "unknown",
  });
  const [savingKeys, setSavingKeys] = useState(false);
  const [savingModels, setSavingModels] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // YZLLM 2026-06-15: Proje teknik dökümanı ("Proje Dökümanı" butonu) — içerik
  // tech_doc event'inden (.mycl/tech-doc.md). Kullanım kılavuzu artık projenin
  // İÇİNDE (Faz 17 in-app kılavuz sayfaları), MyCL'de Kılavuz butonu kaldırıldı.
  const [projectDoc, setProjectDoc] = useState("");
  const [projectDocOpen, setProjectDocOpen] = useState(false);
  // 2026-06-11 (YZLLM, #6): Spec okuma kapısı popup — onaydan önce spec'i biçimli gösterir.
  const [specReviewOpen, setSpecReviewOpen] = useState(false);
  const [specReviewText, setSpecReviewText] = useState("");
  // 2026-06-11 (YZLLM): Kalite Kontrol (denetim ajanı) popup.
  const [qualityAuditOpen, setQualityAuditOpen] = useState(false);
  // v15.7: İş kuyruğu drawer açık/kapalı
  const [taskQueueOpen, setTaskQueueOpen] = useState(false);
  const [tokenTimelineOpen, setTokenTimelineOpen] = useState(false);
  // v15.7 (2026-05-25): Feature flags (Playwright vb.). Backend read_features → features_value event ile dolur.
  const [features, setFeatures] = useState<{
    playwright_enabled: boolean;
    over_engineering_control?: boolean;
  }>({
    playwright_enabled: true,
    over_engineering_control: false,
  });
  // v15.8 (2026-05-30): Main model efor seçimi (CLI backend için). selected_models event'inden gelir.
  const [currentEffort, setCurrentEffort] = useState<string>("max");
  // v15.8: rol başına backend (api/cli). selected_models event'inden gelir.
  const [currentBackends, setCurrentBackends] = useState<AgentBackends | undefined>(undefined);
  const [phasesList, setPhasesList] = useState<PhaseSummary[]>([]);
  // Faz kapsamı (YZLLM 2026-06-26): kapsam onaylanınca çalışacak fazlar; PhaseSidebar kapsam-dışı opsiyonelleri
  // soluk gösterir. null → kapsam henüz belirlenmedi (normal görünüm, vurgulama yok).
  const [neededPhases, setNeededPhases] = useState<number[] | null>(null);
  const [modelsTranslator, setModelsTranslator] = useState<ModelsList>(EMPTY_LIST);
  const [modelsMain, setModelsMain] = useState<ModelsList>(EMPTY_LIST);
  const [currentSelected, setCurrentSelected] = useState<{ translator?: string; main?: string } | null>(null);
  // v15.13 (auto-model + çok-ajanlı tasarım): Settings seçicileri için mevcut değerler.
  const [currentModelTiers, setCurrentModelTiers] = useState<ModelTiers | undefined>(undefined);
  const [currentDesignWorkflow, setCurrentDesignWorkflow] = useState<DesignWorkflowMode | undefined>(undefined);
  const [currentAgentTeamsOptIn, setCurrentAgentTeamsOptIn] = useState<boolean | undefined>(undefined);
  const [currentMultiAgentSelection, setCurrentMultiAgentSelection] = useState<boolean | undefined>(undefined);
  const [currentCacheTtl, setCurrentCacheTtl] = useState<"5m" | "1h" | undefined>(undefined);
  /**
   * Boot history load guard: request yolda iken effect re-fire ederse 2.
   * send'i bloklar. onProjectSelected'ta reset (yeni proje = fresh request).
   */
  const historyRequestedRef = useRef(false);
  /** "Proje Aç" (mevcut projeyi entegre et) → open_project'e integrate=true taşır. Tek-atış: ilk
   *  gönderimden sonra temizlenir (reconnect re-send'leri yeniden onboarding tetiklemesin). */
  const pendingIntegrateRef = useRef(false);
  /** Sağ panelde açık olan ajan görünümü (null → kapalı). Aynı anda yalnız BİRİ açık;
   *  butona basınca o panel açılır, açıksa kapanır (toggle). Default kapalı (chat'e odak). */
  const [activeRightPanel, setActiveRightPanel] = useState<RightPanel | null>(null);
  /** Sol panel (Faz Sidebar) açık/kapalı toggle. Default açık — kullanıcı
   *  fazları kolayca görsün; gerekirse header `📑` ile gizler. */
  const [leftPanelsOpen, setLeftPanelsOpen] = useState(true);
  /** v15.7 (2026-05-27): Alt hata çekmecesi. Header "HATA" badge'ine tıklayınca
   *  açılır; chat'teki role:"error" + "❌" prefix system mesajlarını gösterir. */
  const [errorDrawerOpen, setErrorDrawerOpen] = useState(false);
  // v15.7 (2026-05-24): activeIntent state kaldırıldı — composer altındaki
  // "Soru Sor" / "Hata Ayıkla" button'ları kalktı. Orchestrator ajan composer
  // metnini otomatik classify ediyor (question/debug/chat/develop), kullanıcı
  // manuel intent seçmeye gerek duymuyor.
  /**
   * Cross-panel focus: chat'te tıklanan mesajın ts'i. null iken highlight yok.
   * Pencere mantığı: [selectedTs, sonraki user/askq-answer ts'i) — translator
   * ve claude_stream event'leri bu pencerede associated sayılır.
   */
  const [selectedTs, setSelectedTs] = useState<number | null>(null);

  // Yeni event'leri reducer'a feed et + config/model/selection event'lerini izole et.
  // KRİTİK: `mainState` deps'te OLMAMALI — setMainState async tamamlanmadan
  // mainState yeni referans alıp effect'i re-fire ederse, processedCount henüz
  // güncellenmediği için aynı `fresh` slice tekrar işlenir → user mesajları
  // duplicate eklenir (3-4 kez). Fix: functional setState + minimal deps.
  // Yan-effect (setConfigStatus / setSettingsOpen / setCurrentSelected /
  // setPhasesList / setModelsTranslator / setModelsMain / setSavingKeys /
  // setSavingModels) idempotent oldukları için duplicate risk yok; sadece
  // reducer state ekleme non-idempotent → functional callback ile race-free.
  useEffect(() => {
    if (orch.events.length <= processedCount) return;
    const fresh = orch.events.slice(processedCount);
    for (const ev of fresh) {
      if (ev.kind === "config_status") {
        if (ev.data.ready) {
          setConfigStatus({ state: "ready" });
          void orch.send({ kind: "read_selected_models" });
          void orch.send({ kind: "read_features" });
          // v15.13 (saha 3/5): oto-cevap tercihini (localStorage) backend'e geri yükle.
          void orch.send({ kind: "set_auto_answer", data: { enabled: autoAnswer } });
        } else {
          setConfigStatus({
            state: "missing",
            reason: ev.data.reason,
            detail: ev.data.detail,
          });
          // v15.8: İlk açılış onboarding — config eksik OLAN HER durumda Settings'i
          // otomatik aç. Önceden yalnız model_selection_missing açıyordu; ama boot'ta
          // ÖNCE api_keys_missing emit ediliyor (index.ts) → yeni kullanıcı boş ekranda
          // kalıyordu. Settings render `initialTab`'ı reason'a göre seçer (api_keys vb.).
          setSettingsOpen(true);
        }
        setSavingKeys(false);
        setSavingModels(false);
      } else if (ev.kind === "models_list") {
        const update = {
          models: ev.data.models,
          fetched_at: ev.data.fetched_at,
          loading: false,
        };
        if (ev.data.which === "translator") setModelsTranslator(update);
        else setModelsMain(update);
      } else if (ev.kind === "spec_review") {
        // 2026-06-11 (#6): spec okuma kapısı → spec'i biçimli popup'ta aç.
        setSpecReviewText(ev.data.spec_tr ?? "");
        setSpecReviewOpen(true);
      } else if (ev.kind === "selected_models") {
        setCurrentSelected(ev.data.selected ?? null);
        if (ev.data.effort) setCurrentEffort(ev.data.effort);
        if (ev.data.backends) setCurrentBackends(ev.data.backends);
        if (ev.data.model_tiers) setCurrentModelTiers(ev.data.model_tiers);
        if (ev.data.design_workflow) setCurrentDesignWorkflow(ev.data.design_workflow);
        if (typeof ev.data.agent_teams_optin === "boolean")
          setCurrentAgentTeamsOptIn(ev.data.agent_teams_optin);
        if (typeof ev.data.multi_agent_selection === "boolean")
          setCurrentMultiAgentSelection(ev.data.multi_agent_selection);
        if (ev.data.cache_ttl) setCurrentCacheTtl(ev.data.cache_ttl);
      } else if (ev.kind === "phases_list") {
        setPhasesList(ev.data.phases);
      } else if (ev.kind === "needed_phases") {
        setNeededPhases(ev.data.phases);
      } else if (ev.kind === "features_value") {
        setFeatures({
          playwright_enabled: ev.data.features.playwright_enabled,
          over_engineering_control: ev.data.features.over_engineering_control ?? false,
        });
      } else if (ev.kind === "tech_doc") {
        setProjectDoc(ev.data.content);
      }
    }
    setMainState((current) => {
      let next = current;
      for (const ev of fresh) {
        if (
          ev.kind === "config_status" ||
          ev.kind === "models_list" ||
          ev.kind === "selected_models" ||
          ev.kind === "phases_list" ||
          ev.kind === "needed_phases" ||
          ev.kind === "features_value" ||
          ev.kind === "user_guide" ||
          ev.kind === "tech_doc"
        ) {
          continue;
        }
        next = reduce(next, ev);
      }
      return next;
    });
    setProcessedCount(orch.events.length);
  }, [orch.events, processedCount, orch]);

  // WP4 DAST: 🛡️ buton → backend açıklama+onay askq'ı açar (buton doğrudan taramaz).
  const sendRunDast = () => {
    void orch.send({ kind: "run_dast" });
  };

  const handleSaveApiKeys = (
    translator: string,
    main: string,
    orchestrator?: string,
    zaiTranslator?: string,
    zaiMain?: string,
    zaiOrchestrator?: string,
  ) => {
    setSavingKeys(true);
    // Kayıt bir PATCH (merge): boş alan gönderme → orkestratör mevcut key'i korur (silmez).
    // Böylece z.ai key'i eklerken claude key'lerini (formda boş) yeniden girmeye gerek yok.
    void orch.send({
      kind: "save_api_keys",
      data: {
        ...(translator ? { translator } : {}),
        ...(main ? { main } : {}),
        ...(orchestrator ? { orchestrator } : {}),
        ...(zaiTranslator ? { zai_translator: zaiTranslator } : {}),
        ...(zaiMain ? { zai_main: zaiMain } : {}),
        ...(zaiOrchestrator ? { zai_orchestrator: zaiOrchestrator } : {}),
      },
    });
  };

  const handleSaveModels = (
    translator: string,
    main: string,
    orchestrator?: string,
    effort?: string,
    backends?: AgentBackends,
    modelTiers?: ModelTiers,
    designWorkflow?: DesignWorkflowMode,
    agentTeamsOptIn?: boolean,
    cacheTtl?: "5m" | "1h",
    multiAgentSelection?: boolean,
  ) => {
    setSavingModels(true);
    if (effort) setCurrentEffort(effort);
    if (backends) setCurrentBackends(backends);
    if (modelTiers) setCurrentModelTiers(modelTiers);
    if (designWorkflow) setCurrentDesignWorkflow(designWorkflow);
    if (typeof agentTeamsOptIn === "boolean") setCurrentAgentTeamsOptIn(agentTeamsOptIn);
    if (typeof multiAgentSelection === "boolean") setCurrentMultiAgentSelection(multiAgentSelection);
    if (cacheTtl) setCurrentCacheTtl(cacheTtl);
    void orch.send({
      kind: "save_settings",
      data: {
        translator,
        main,
        ...(orchestrator ? { orchestrator } : {}),
        ...(effort ? { effort } : {}),
        ...(backends ? { backends } : {}),
        ...(modelTiers ? { model_tiers: modelTiers } : {}),
        ...(designWorkflow ? { design_workflow: designWorkflow } : {}),
        ...(typeof agentTeamsOptIn === "boolean" ? { agent_teams_optin: agentTeamsOptIn } : {}),
        ...(typeof multiAgentSelection === "boolean" ? { multi_agent_selection: multiAgentSelection } : {}),
        ...(cacheTtl ? { cache_ttl: cacheTtl } : {}),
      },
    });
    // config_status sonrası modal kapanır
    setSettingsOpen(false);
  };

  const handleFetchModels = (which: "translator" | "main", force: boolean) => {
    if (which === "translator")
      setModelsTranslator((p) => ({ ...p, loading: true }));
    else setModelsMain((p) => ({ ...p, loading: true }));
    void orch.send({ kind: "list_models", data: { which, force } });
  };

  // Cmd+, klavye kısayolu — Settings toggle.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        // Model selection missing iken kapatma engellenir; toggle değil sadece aç.
        if (configStatus.state === "missing" && configStatus.reason === "model_selection_missing") {
          setSettingsOpen(true);
        } else {
          setSettingsOpen((p) => !p);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [configStatus]);

  const onProjectSelected = (path: string, opts?: { integrate?: boolean }) => {
    // Yeni proje = fresh history request gerekir → ref reset (boot effect
    // tekrar tetiklensin). open_project send'i tek noktadan (useEffect)
    // tetiklenir — burada inline send YAPMA, aksi takdirde projectPath dep'i
    // değişip useEffect de tetikleniyor → çift open_project + duplicate
    // backend boot mesajları.
    // "Proje Aç" (mevcut projeyi entegre et) → integrate bayrağını taşı (useEffect open_project'e koyar).
    pendingIntegrateRef.current = opts?.integrate === true;
    historyRequestedRef.current = false;
    setProjectPath(path);
    setMainState({ ...INITIAL_STATE });
  };

  // Orkestratör "şu projeyi aç" istedi (okunamayan proje erişilebilir konuma kopyalandı → kopyayı aç).
  // onProjectSelected mainState'i INITIAL_STATE'e sıfırlar → pendingOpenRequest temizlenir, tekrar tetiklenmez.
  useEffect(() => {
    const req = mainState.pendingOpenRequest;
    if (!req) return;
    onProjectSelected(req.path, { integrate: req.integrate });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainState.pendingOpenRequest]);

  // Orchestrator hazır olduğunda proje aç event'ini yolla (gecikme olursa).
  // `orch.bootSequence` her ready event'inde artar — orchestrator restart
  // (auto-update veya crash recovery) sonrası open_project'i YENİDEN gönder
  // ki runtime.state null kalmasın (L1 — "no active project" fix).
  useEffect(() => {
    if (orch.ready && projectPath) {
      const integrate = pendingIntegrateRef.current;
      pendingIntegrateRef.current = false; // tek-atış: reconnect re-send'i yeniden onboarding tetiklemesin
      void orch.send({ kind: "open_project", data: { path: projectPath, integrate } }).catch(
        () => {},
      );
      // v15.7 (2026-05-24): Rust state'e window→project register et — diğer
      // pencerelerin Splash'i bu projeyi "açık" görüp grizleyecek.
      void (async () => {
        try {
          const win = await import("@tauri-apps/api/window");
          const label = win.getCurrentWindow().label;
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("register_window_project", {
            windowLabel: label,
            projectPath,
          });
        } catch (err) {
          console.warn("register_window_project failed", err);
        }
      })();
      // Son projeler kaydı TEK NOKTADAN burada: bir proje GERÇEKTEN açıldığında (orch.ready)
      // — Splash "Yeni Klasör/Proje Aç", recent-tıklama VE okunamayan-proje KOPYA reopen'ı
      // (open_project_request) hepsi projectPath'i set edip bu effect'e düşer. Önceden kopya yolu
      // Splash'ı baypas ettiği için recent'e DÜŞMÜYORDU (YZLLM: "entegre modunda açtığım proje de son
      // projelere gelsin"). register_window_project'TEN BAĞIMSIZ kendi try'ı (mahkeme B-6: register fail
      // edince kullanıcının asıl istediği recent kaydı sessizce atlanmasın). Idempotent (recent.rs dedupe+başa-al).
      void (async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("add_recent_project", { path: projectPath });
        } catch (err) {
          console.warn("add_recent_project failed", err);
        }
      })();
      // Restart sonrası history de yeniden yüklenmeli — guard reset.
      if (orch.bootSequence > 1) {
        historyRequestedRef.current = false;
        setMainState((s) => ({ ...s, historyLoaded: false }));
      }
    }
  }, [orch.ready, orch.bootSequence, projectPath]);

  // Sol sidebar için faz listesi — orchestrator hazır olur olmaz bir kez çek.
  // phasesList boş kalırsa PhaseSidebar TR isimleri gösteremez (fallback "Faz N").
  // Restart sonrası bootSequence artar → liste yeniden gelir.
  useEffect(() => {
    if (orch.ready) {
      void orch.send({ kind: "list_phases" }).catch(() => {});
    }
  }, [orch.ready, orch.bootSequence]);

  // Feature 3 boot load: config hazır + proje açıkken bir kez 48h history çek.
  // İki katmanlı guard:
  //   1. `mainState.historyLoaded` — reducer history_chunk'ı işledikten sonra
  //      true; yeniden send tetiklenmez.
  //   2. `historyRequestedRef` — request yolda iken (response gelmeden)
  //      effect re-fire ederse send tekrarlanmasın. mainState referansı
  //      başka state değişimlerinde de yenilenir; deps `mainState.history
  //      Loaded` boolean ama React shallow refleks yine fire edebilir.
  //   `onProjectSelected`'ta ref reset edilir (yeni proje = fresh request).
  useEffect(() => {
    if (
      configStatus.state === "ready" &&
      projectPath &&
      !mainState.historyLoaded &&
      !historyRequestedRef.current
    ) {
      historyRequestedRef.current = true;
      // 48h boot load. Limit 2000 — yoğun aktivite günlerinde (claude_stream
      // text deltaları event sayısını şişirir) 500 sınırı erken cut-off'a yol
      // açıyordu, kullanıcı "geçmiş gelmiyor" raporladı (2026-05-23).
      const since_ts = Date.now() - 48 * 60 * 60 * 1000;
      void orch
        .send({ kind: "load_messages", data: { since_ts, limit: 2000 } })
        .catch(() => {
          historyRequestedRef.current = false; // retry mümkün
        });
      // Token-timeline: proje açılışında tüm faz-cost geçmişini de iste (cost_history
      // yanıtı costTimeline'ı doldurur; sonra cost_phase canlı upsert eder).
      void orch.send({ kind: "load_costs" }).catch(() => {});
    }
  }, [configStatus.state, projectPath, mainState.historyLoaded, orch]);

  // ChatPanel üst scroll → 24h daha eski chunk yükle.
  const handleLoadOlder = () => {
    if (!mainState.olderAvailable || mainState.loadingOlder) return;
    if (mainState.oldestLoadedTs <= 0) return;
    setMainState((s) => ({ ...s, loadingOlder: true }));
    void orch
      .send({
        kind: "load_messages",
        data: {
          since_ts: mainState.oldestLoadedTs - 24 * 60 * 60 * 1000,
          until_ts: mainState.oldestLoadedTs,
          limit: 2000,
        },
      })
      .catch(() => {
        setMainState((s) => ({ ...s, loadingOlder: false }));
      });
  };

  /**
   * ▶ Çalıştır butonu gibi deterministic intent için classifier bypass:
   * `command_direct` IPC → orchestrator handleCommandIntent direkt çağrılır.
   * Chat'e user balon optimistic eklenir (sendUserMessage paraleli).
   */
  // Duraklat/Devam (YZLLM 2026-06-13): MyCL'i geçici askıya al — yeni LLM çağrısı
  // başlatmaz (mevcut tur biter), token yakmaz; tekrar tıkla → kaldığı yerden devam.
  const [paused, setPausedState] = useState(false);
  const handlePauseToggle = (): void => {
    const next = !paused;
    setPausedState(next);
    void orch.send({ kind: "set_paused", data: { paused: next } });
  };

  const sendRunCommand = () => {
    const text = "projeyi çalıştır";
    setMainState((s) => ({
      ...s,
      messages: [
        ...s.messages,
        { id: s.messages.length + 1, role: "user", text, ts: Date.now() },
      ],
    }));
    void orch.send({
      kind: "command_direct",
      data: { text, intent_kind: "run" },
    });
  };

  /**
   * Sol sidebar — faz tıklaması: backend askq açar (Çalıştır / Vazgeç).
   * v15.7 (2026-05-28): Tek deterministik mod. Chat'e optimistic balon eklenir.
   */
  // TEK tık → o fazın chat'teki ilk mesajına git (en son geçişini bul → selectedTs = faz başlangıç ts).
  const navigateToPhase = (id: PhaseId): void => {
    const marker = [...mainState.phaseMarkers].reverse().find((m) => m.to === id);
    if (marker) setSelectedTs(marker.ts);
  };
  const sendPhaseRunRequest = (id: PhaseId) => {
    setMainState((s) => ({
      ...s,
      messages: [
        ...s.messages,
        {
          id: s.messages.length + 1,
          role: "user",
          text: `Faz ${id} tıklandı`,
          ts: Date.now(),
        },
      ],
    }));
    void orch.send({ kind: "phase_run_request", data: { id } });
  };

  const sendUserMessage = (text: string) => {
    // v15.7 (2026-05-26): KAPI BEKÇİSİ — composer mesajı HER ZAMAN orkestratöre
    // gider. Eski bypass (askq açıkken otomatik askq_answer) kaldırıldı: orkestratör
    // ajan kapı bekçisi rolünde mesajı yorumlar (askq cevabı mı, bağlam değişimi mi,
    // sohbet mi). Orkestratör answer_askq action seçerse askq programatik cevaplanır;
    // chat seçerse askq UI açık kalır.
    setMainState((s) => ({
      ...s,
      messages: [
        ...s.messages,
        { id: s.messages.length + 1, role: "user", text, ts: Date.now() },
      ],
    }));
    // Ana composer her zaman normal `user_message` (orkestratör kapı bekçisi → iş/sohbet kararını verir).
    // (Soru modu toggle kaldırıldı; orkestratöre kalıcı yönerge artık Orkestra panelindeki direktif composer'ından.)
    void orch.send({ kind: "user_message", data: { text } });
  };

  // v15.7: handleIntentClick kaldırıldı — intent button'ları yok artık.

  // v15.7 (2026-05-24): İş kuyruğu handler'ları
  const handleAddTaskToQueue = (text: string) => {
    void orch.send({ kind: "task_queue_add", data: { text } });
  };
  const handleTaskDelete = (id: string) => {
    void orch.send({ kind: "task_queue_remove", data: { id } });
  };
  const handleTaskApply = (item: TaskQueueItem) => {
    // Faz kontrolü TaskQueuePanel'de zaten yapıldı (disabled buton); burada
    // ekstra güvenlik. Faz 1'desek prompt olarak gönder.
    if (mainState.phase !== 1) {
      setMainState((s) => ({
        ...s,
        messages: [
          ...s.messages,
          {
            id: s.messages.length + 1,
            role: "system",
            text: `İş yalnızca Faz 1'de uygulanabilir (şu an Faz ${mainState.phase}).`,
            ts: Date.now(),
          },
        ],
      }));
      return;
    }
    sendUserMessage(item.text);
  };

  const handleTaskReadd = (item: TaskQueueItem) => {
    // FROZEN-GOAL #17: düşen işi FAZ-BAĞIMSIZ yeniden gönder (yeni kullanıcı mesajı → orkestratör yönlendirir).
    // handleTaskApply Faz 1'e kapılı; düşen iş genelde başka fazda olduğu için ayrı, kapısız yol.
    sendUserMessage(item.text);
  };

  const answerAskq = (id: string, selected: string | string[]) => {
    const display = Array.isArray(selected)
      ? selected.length === 0
        ? "Vazgeç"
        : `${selected.length} seçim`
      : selected;
    setMainState((s) => {
      const now = Date.now();
      const newMessages = [...s.messages];
      // v15.6 (2026-05-24): Cevap sonrası askq kartı kaybolduğunda kullanıcı
      // ne sorulduğunu görebilsin diye soruyu chat history'sine sistem mesajı
      // olarak yansıt. Backend zaten history.log'a appendHistory yapıyor
      // (reload için), bu sadece live session UI.
      if (s.pendingAskq) {
        newMessages.push({
          id: newMessages.length + 1,
          role: "system",
          text: s.pendingAskq.question,
          ts: now - 1, // kullanıcı cevabından milisaniye önce → kronolojik sıra
        });
      }
      newMessages.push({
        id: newMessages.length + 1,
        role: "user",
        text: display,
        ts: now,
      });
      return {
        ...s,
        pendingAskq: null,
        messages: newMessages,
      };
    });
    void orch.send({ kind: "askq_answer", data: { id, selected } });
  };

  // Composer her zaman açık (yalnız orch hazır değilse kapalı). Askq pending
  // olsa bile kullanıcı yazabilsin; gönderdiğinde askq otomatik cancel edilir
  // (sendUserMessage içinde). Buton'lar (Çalıştır/Hata Ara) askq açıkken
  // disabled — yan akışı bozmasınlar.
  const composerDisabled = !orch.ready;
  const buttonsDisabled = useMemo(
    () => !orch.ready || mainState.pendingAskq !== null,
    [orch.ready, mainState.pendingAskq],
  );

  /**
   * Highlight penceresi: [selectedTs, nextBoundaryTs). nextBoundaryTs =
   * selectedTs'den büyük ilk user/askq-answer (frontend "user" rolü) mesajı ts.
   * Yoksa +Infinity (yani selectedTs sonrası tüm event'ler). selectedTs null →
   * pencere null → hiç highlight yok.
   */
  const highlightWindow = useMemo<{ from: number; to: number } | null>(() => {
    if (selectedTs === null) return null;
    const next = mainState.messages.find(
      (m) => m.ts > selectedTs && m.role === "user",
    );
    return { from: selectedTs, to: next?.ts ?? Number.POSITIVE_INFINITY };
  }, [selectedTs, mainState.messages]);

  const settingsView = (
    <Settings
      open={settingsOpen}
      initialTab={
        configStatus.state === "missing" && configStatus.reason === "api_keys_missing"
          ? "api_keys"
          : "models"
      }
      forceModelSetup={
        configStatus.state === "missing" &&
        (configStatus.reason === "model_selection_missing" ||
          configStatus.reason === "api_keys_missing")
      }
      currentSelected={currentSelected}
      currentBackends={currentBackends}
      currentModelTiers={currentModelTiers}
      currentDesignWorkflow={currentDesignWorkflow}
      currentAgentTeamsOptIn={currentAgentTeamsOptIn}
      currentMultiAgentSelection={currentMultiAgentSelection}
      currentCacheTtl={currentCacheTtl}
      modelsTranslator={modelsTranslator}
      modelsMain={modelsMain}
      onFetchModels={handleFetchModels}
      onSaveModels={handleSaveModels}
      onSaveApiKeys={handleSaveApiKeys}
      onClose={() => setSettingsOpen(false)}
      savingModels={savingModels}
      savingKeys={savingKeys}
      errorDetail={
        configStatus.state === "missing" && configStatus.reason === "load_failed"
          ? configStatus.detail
          : undefined
      }
      features={features}
      effort={currentEffort}
      onSaveFeatures={(f) => {
        // v15.8: kısmi toggle — mevcut state'e merge (her checkbox kendi alanını gönderir).
        setFeatures((cur) => ({ ...cur, ...f }));
        void orch.send({ kind: "save_features", data: f });
      }}
    />
  );

  // Setup zorlu (api_keys veya model_selection eksik) → splash/main yerine
  // sadece header + Settings overlay.
  if (configStatus.state === "missing") {
    return (
      <div className="app">
        <header className="app-header" data-tauri-drag-region>
          <span className="app-title" data-tauri-drag-region>MyCL Studio</span>
          <span className="app-version" data-tauri-drag-region title="Çalışan build zamanı (yerel)">
            {__BUILD_TIME__}
          </span>
          <span className="app-phase-indicator" data-tauri-drag-region>kurulum</span>
        </header>
        {settingsView}
      </div>
    );
  }

  if (!projectPath) {
    return (
      <div className="app">
        <header className="app-header" data-tauri-drag-region>
          <span className="app-title" data-tauri-drag-region>MyCL Studio</span>
          <span className="app-version" data-tauri-drag-region title="Çalışan build zamanı (yerel)">
            {__BUILD_TIME__}
          </span>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            style={{
              marginLeft: "auto",
              fontSize: 12,
              background: "transparent",
              border: "1px solid var(--border)",
              padding: "4px 10px",
            }}
            title="Ayarlar (Cmd+,)"
          >
            ⚙ Ayarlar
          </button>
          <span className="app-phase-indicator">
            {configStatus.state === "ready"
              ? "hazır"
              : orch.ready
                ? "config kontrol ediliyor..."
                : "boot..."}
          </span>
        </header>
        <Splash onProjectSelected={onProjectSelected} />
        {orch.lastError && (
          <p
            style={{
              padding: "12px 16px",
              color: "var(--error)",
              fontSize: 12,
            }}
          >
            {orch.lastError}
          </p>
        )}
        {settingsView}
      </div>
    );
  }

  const translatorLabel = currentSelected?.translator ?? "—";
  const mainLabel = currentSelected?.main ?? "—";

  // v15.7 (2026-05-27): Hata kayıtları — drawer için filtrele.
  // role:"error" emitError + emitChatMessage("error",...) kaynaklı.
  // role:"system" + ❌ prefix mechanical fail mesajları (e2e-fail vb).
  const errorEntries = mainState.messages.filter(
    (m) =>
      m.role === "error" ||
      (m.role === "system" && m.text.trimStart().startsWith("❌")),
  );

  return (
    <div className="app">
      <AppHeader
        projectPath={projectPath}
        phase={mainState.phase}
        currentJob={mainState.iterationIntent}
        // YZLLM 2026-06-12: model GERÇEKTEN çalışırken (runningBanner aktif) header "çalışıyor" göstersin —
        // bayat "yanıt bekleniyor" (askq cevaplandıktan sonra kalan) yanıltmasın. runningBanner canlı gerçek.
        status={mainState.runningBanner ? "running" : mainState.phaseStatus}
        onPhaseIndicatorClick={() => setErrorDrawerOpen((o) => !o)}
        errorCount={errorEntries.length}
        pipelineVerdict={mainState.pipelineVerdict?.verdict ?? null}
      />
      <div
        className={
          "app-main" +
          (leftPanelsOpen ? "" : " left-collapsed") +
          (activeRightPanel ? "" : " right-collapsed")
        }
      >
        {leftPanelsOpen && (
          <>
            <PhaseSidebar
              phases={phasesList}
              currentPhase={mainState.phase}
              maxPhase={mainState.maxPhase}
              disabled={buttonsDisabled}
              onPhaseClick={sendPhaseRunRequest}
              onPhaseNavigate={navigateToPhase}
              gateFailures={mainState.pipelineVerdict?.gateFailures}
              neededPhases={neededPhases}
            />
            <div className="divider" />
          </>
        )}
        <ChatPanel
          messages={mainState.messages}
          currentJob={mainState.iterationIntent}
          pendingAskq={mainState.pendingAskq}
          runningBanner={mainState.runningBanner}
          disabled={composerDisabled}
          onSend={sendUserMessage}
          onAskqAnswer={answerAskq}
          selectedTs={selectedTs}
          onMessageSelected={setSelectedTs}
          phaseMarkers={mainState.phaseMarkers}
          olderAvailable={mainState.olderAvailable}
          loadingOlder={mainState.loadingOlder}
          onLoadOlder={handleLoadOlder}
          agentBusy={mainState.agentBusyCount > 0}
          onAddTaskToQueue={handleAddTaskToQueue}
          autoAnswer={autoAnswer}
          onAutoAnswerToggle={handleAutoAnswerToggle}
          autoAnswerDisabled={mainState.autoAnswerSuppressed}
          onDocClick={() => setProjectDocOpen(true)}
          docAvailable={projectDoc.trim().length > 0}
          onQualityAuditClick={() => setQualityAuditOpen(true)}
          onDastClick={sendRunDast}
          dastRunning={mainState.runningBanner?.label === "🛡️ Güvenlik Taraması (DAST)"}
        />
        {activeRightPanel && (
          <>
            <div className="divider" />
            <div className="panel-right-single">
              {activeRightPanel === "main" && (
                <ClaudeSimulator
                  events={mainState.ccEvents}
                  banner={mainState.ccBanner}
                  modelLabel={mainLabel}
                  highlightWindow={highlightWindow}
                />
              )}
              {activeRightPanel === "translator" && (
                <TranslatorPanel
                  entries={mainState.translations}
                  modelLabel={translatorLabel}
                  highlightWindow={highlightWindow}
                />
              )}
              {activeRightPanel === "orchestrator" && (
                <OrchestratorPanel
                  events={mainState.orchestratorActivity}
                  onDirective={(text) => {
                    void orch.send({ kind: "orchestrator_directive", data: { text } });
                  }}
                />
              )}
            </div>
          </>
        )}
        <RightActionBar
          onExecuteClick={sendRunCommand}
          executeDisabled={buttonsDisabled}
          onPauseToggle={handlePauseToggle}
          paused={paused}
          activeRightPanel={activeRightPanel}
          onRightPanelToggle={(panel) =>
            setActiveRightPanel((cur) => (cur === panel ? null : panel))
          }
          onToggleLeftClick={() => setLeftPanelsOpen((p) => !p)}
          leftPanelsOpen={leftPanelsOpen}
          onToggleTaskQueueClick={() => setTaskQueueOpen((o) => !o)}
          taskQueueOpen={taskQueueOpen}
          taskQueueCount={mainState.taskQueue.length}
          tokenTotals={mainState.tokenTotals}
          onTokenBadgeClick={() => setTokenTimelineOpen((o) => !o)}
          onSettingsClick={() => setSettingsOpen(true)}
        />
      </div>
      {settingsView}
      <GuideModal
        open={projectDocOpen}
        content={projectDoc}
        title="Proje Dökümanı"
        onClose={() => setProjectDocOpen(false)}
      />
      {/* 2026-06-11 (YZLLM, #6): Spec okuma kapısı popup — onaydan önce spec'i biçimli (markdown) gösterir. */}
      <GuideModal
        open={specReviewOpen}
        content={specReviewText}
        onClose={() => setSpecReviewOpen(false)}
        title="📋 Spec İncelemesi"
      />
      {/* 2026-06-11 (YZLLM): Kalite Kontrol — denetim ajanı popup (düzenlenebilir sorular + başlat). */}
      <QualityAuditModal
        open={qualityAuditOpen}
        onClose={() => setQualityAuditOpen(false)}
        onStart={(questions) => void orch.send({ kind: "start_quality_audit", data: { questions } })}
      />
      <TaskQueuePanel
        open={taskQueueOpen}
        items={mainState.taskQueue}
        currentPhase={mainState.phase}
        onClose={() => setTaskQueueOpen(false)}
        onItemApply={handleTaskApply}
        onItemReadd={handleTaskReadd}
        onItemDelete={handleTaskDelete}
      />
      <TokenTimelinePanel
        open={tokenTimelineOpen}
        costs={mainState.costTimeline}
        onClose={() => setTokenTimelineOpen(false)}
      />
      <ErrorDrawer
        open={errorDrawerOpen}
        errors={errorEntries}
        onClose={() => setErrorDrawerOpen(false)}
      />
    </div>
  );
}

export default App;
