// ipc — UI'a (Tauri Rust → Frontend) event yollama helper'ları.
//
// stdout'a NDJSON yazar; Tauri Rust line-by-line parse edip Tauri event
// olarak frontend'e emit eder. Tek bir global emit fonksiyonu var, modüller
// bunu çağırır. Her emit ayrıca debug log'a tee edilir.
//
// Persistence (Feature 3, 2026-05-20): emitChatMessage/emitTranslation/
// emitClaudeStream her birinin aktif proje varsa `<project>/.mycl/history.log`
// dosyasına append eder. setHistoryRoot ile aktif proje yolu set edilir
// (handleOpenProject'te). Full fidelity — skip-persist guard yok.

import { appendHistory } from "./history-loader.js";
import { traceAgentEvent } from "./agent-trace.js";
import { currentAgentRun } from "./agent-cost-context.js";
import { log } from "./logger.js";
import type { ModelTokenUsage, PhaseId, PhaseStatus, TranslationDir } from "./types.js";

export type ClaudeStreamSub =
  | "init"
  | "request"
  | "text"
  | "tool_use"
  | "tool_result"
  | "retry"
  | "error"
  | "stop"
  | "token_usage"
  | "relevance_call";

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  /** Prompt caching aktifse: bu turda cache'e yazılan token miktarı. */
  cache_creation_input_tokens?: number;
  /** Prompt caching aktifse: bu turda cache'ten okunan token miktarı (%90 indirim). */
  cache_read_input_tokens?: number;
  /** CLI/abonelik result'tan gelen gerçek $ (API yolu vermez → undefined). F1. */
  total_cost_usd?: number;
  /** Bu çağrının modeli — per-model döküm + birincil model için. F1. */
  model?: string;
}

/**
 * Aktif proje root'u. handleOpenProject çağrısında set edilir. null iken
 * history.log persistence skip edilir (proje açılmadan emit edilen erken
 * event'ler — örn. config_status — kaydedilmez).
 */
let activeProjectRoot: string | null = null;

export function setHistoryRoot(root: string | null): void {
  activeProjectRoot = root;
}

export function emit(kind: string, data?: unknown): void {
  log.debug("ipc-out", kind, data);
  process.stdout.write(JSON.stringify({ kind, data }) + "\n");
}

/**
 * UI event'ini history.log'a fire-and-forget append eder. Hata log.warn'a
 * düşer ama emit akışı kesilmez. `ts` payload'tan okunur; yoksa Date.now()
 * fallback (örn. event'in ts'i yoksa kayıp olmasın).
 */
function persistHistory(kind: string, data: { ts?: number; [k: string]: unknown }): void {
  if (!activeProjectRoot) return;
  const ts = typeof data.ts === "number" ? data.ts : Date.now();
  appendHistory(activeProjectRoot, { ts, kind, data }).catch((err) => {
    log.warn("ipc-history", `append ${kind} failed`, err);
  });
}

export function emitChatMessage(
  role: "user" | "assistant" | "system" | "error",
  text: string,
  opts?: { persist?: boolean },
): void {
  // Kullanıcı talebi (2026-05-23): MyCL chat'te assistant cümleleri tek satıra.
  // Bir satırda 2 cümle olmayacak şekilde sentence boundary'lerde newline.
  // Sadece assistant role'üne uygulanır — user/system/error mesajlar dokunulmaz
  // (system mesajları çoğu tek cümle veya yapılandırılmış emoji + label).
  const processed = role === "assistant" ? splitSentences(text) : text;
  const payload = { role, text: processed, ts: Date.now() };
  emit("chat_message", payload);
  // `persist: false` → transient boot/welcome mesajları için. Her açılışta
  // emit edilirse history.log'da birikir; UI'da N. açılışta N kez görünür.
  if (opts?.persist !== false) persistHistory("chat_message", payload);
}

/**
 * Cümle sonu (. ? !) + boşluk + büyük harf pattern'ini `\n` ile değiştirir.
 * Code block (```), inline code (`), URL ve markdown liste item içeriği
 * korunur (regex doğrudan satırda uygulansa da, kod bloğu BLOK olarak
 * atlanır). Kısaltmalar (Mr., Dr., vb.) için minimal whitelist; Türkçe
 * dilinde nadir, bu yüzden basit pattern yeterli.
 *
 * Algoritma:
 *   1. Code block'ları (``` ... ```) marker'la replace et.
 *   2. Inline code (`...`) marker'la replace et.
 *   3. Sentence regex: `[.!?]` + boşluk + büyük/Türkçe harf → newline.
 *   4. Marker'ları geri koy.
 *
 * Test edilebilir, export edilmiş (splitSentences).
 */
export function splitSentences(text: string): string {
  if (!text) return text;
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Code blocks (``` ... ```)
  let masked = text.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    return `CB${codeBlocks.length - 1}`;
  });

  // 2. Inline code (`...`)
  masked = masked.replace(/`[^`\n]+`/g, (m) => {
    inlineCodes.push(m);
    return `IC${inlineCodes.length - 1}`;
  });

  // 3. Sentence boundary: `.`, `!`, `?` + space + capital letter / Türkçe upper
  //    (A-ZÇĞİÖŞÜ). Lookahead ile bir sonraki cümle başlangıç harfini koru.
  //    Negative lookbehind: kısaltmalar (örn "v.s.", "vb.", "Bn.") — Türkçe
  //    dilinde kısaltma sonrası genelde tek harf veya rakam gelir; basit
  //    whitelist gerekirse buraya eklenebilir.
  masked = masked.replace(
    /([.!?])\s+(?=[A-ZÇĞİÖŞÜ])/g,
    "$1\n",
  );

  // 4. Marker'ları geri koy
  masked = masked.replace(/IC(\d+)/g, (_, i) => inlineCodes[Number(i)]);
  masked = masked.replace(/CB(\d+)/g, (_, i) => codeBlocks[Number(i)]);

  return masked;
}

export function emitTranslation(opts: {
  dir: TranslationDir;
  input: string;
  output: string;
  model: string;
  elapsed_ms: number;
  ok: boolean;
}): void {
  const payload = { ...opts, ts: Date.now() };
  emit("translation", payload);
  persistHistory("translation", payload);
}

export type AskqOption = string | { label: string; value: string };

/**
 * v15.7 (2026-05-26): Aktif askq snapshot — composer'dan mesaj geldiğinde
 * orchestrator agent context'ine eklenir. Agent "bu mesaj askq cevabı mı,
 * yoksa genel mesaj mı" diye yorumlar. emitAskq'da set, askq cevap geldiğinde
 * (askq_answer handler) clearActiveAskq ile temizlenir.
 */
export interface ActiveAskqSnapshot {
  id: string;
  question: string;
  options: AskqOption[];
  allow_other?: boolean;
  multi_select?: boolean;
  /** v15.7 (2026-05-26): Faz 1/2 ana ajanın önerdiği seçenek (TR). UI vurgular. */
  suggested_option?: string;
}

/**
 * v15.7 (2026-05-27): Askq stack. Eskiden tek slot vardı; bir askq açıkken
 * orkestratör başka askq emit ederse (örn. Phase 2 askq açık + agent_decision
 * confirm askq) eski snapshot kayboluyordu → cevap geldiğinde Phase 2
 * controller suspended kalıyordu (Bug 3).
 *
 * Stack semantik: emitAskq yeni askq'yı stack'e push eder. getActiveAskq
 * en üstteki (LIFO) askq'yı döner — composer kapı bekçisi en yeni askq'ya
 * cevap olarak yorumlar. clearActiveAskq(id) verilen id'yi stack'ten kaldırır
 * (id verilmezse tüm stack temizlenir, defansif).
 *
 * Cap 8 — abuse koruması; pratikte 1-2 askq'dan fazla olmamalı.
 */
const askqStack: ActiveAskqSnapshot[] = [];
const ASKQ_STACK_MAX = 8;

export function getActiveAskq(): ActiveAskqSnapshot | null {
  return askqStack.length > 0 ? askqStack[askqStack.length - 1]! : null;
}

export function clearActiveAskq(id?: string): void {
  if (!id) {
    askqStack.length = 0;
    return;
  }
  const idx = askqStack.findIndex((a) => a.id === id);
  if (idx >= 0) askqStack.splice(idx, 1);
}

/**
 * v15.7 (2026-05-26): Askq cevap işlendi event. Frontend pendingAskq state'ini
 * bu id ile eşleştirip clear eder. Kullanıcı composer'dan askq cevabı yazınca
 * (kapı bekçisi answer_askq action ile) UI askq kartı kaybolur.
 */
export function emitAskqResolved(id: string): void {
  _askqPending = false; // cevap geldi → heartbeat "bekliyorum"u bıraksın
  // YZLLM 2026-06-17: askq cevaplandı → emit→cevap aralığını faz-içi bekleme toplamına
  // ekle (faz süresinden düşülecek). currentAskqEmitTs yoksa (oto-cevap/faz-dışı) no-op.
  // Bu, tüm askq cevap/iptal yollarının (handleAskqAnswer + cancel_pipeline) ortak
  // geçtiği TEK nokta → biriktirmeyi burada yapmak kapsamı garanti eder.
  if (activePhaseCost && activePhaseCost.currentAskqEmitTs !== undefined) {
    activePhaseCost.askqWaitMs += Date.now() - activePhaseCost.currentAskqEmitTs;
    activePhaseCost.currentAskqEmitTs = undefined;
  }
  emit("askq_resolved", { id });
}

/**
 * v15.7 (2026-05-26): Session token totals — production readiness madde 13.
 * Process-local accumulator. Restart'ta sıfırlanır. Project switch'te değişmez
 * (kullanıcı tüm session token tüketimini görür). UI'da basit badge.
 */
const sessionTokenTotals = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  api_calls: 0,
};

export function getSessionTokenTotals(): typeof sessionTokenTotals {
  return { ...sessionTokenTotals };
}

/**
 * v15.8 (2026-05-31): Per-faz token kovası — merkezî, kontrolcü dokunmadan.
 * index.ts faz başlamadan `beginPhaseCost`, bittiğinde `takePhaseCost` çağırır.
 * Aktif kova varken her `recordTokenUsage` ona da ekler (turn = api_call başına).
 * Aktif kova yoksa (faz-dışı routing/relevance) yalnızca session totals'a gider.
 */
interface PhaseCostBucket {
  phase: number;
  iteration: number;
  /** Faz başlangıç ts (Date.now) — süre hesabı (YZLLM 2026-06-16: token çizelgesine süre). */
  started_at: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** CLI fazlarında biriken gerçek $ (API yolu USD vermez → undefined kalır). F1. */
  total_cost_usd?: number;
  /** Per-model token dökümü — recordTokenUsage akışından birikir. F1. */
  model_usage?: Record<string, ModelTokenUsage>;
  /**
   * YZLLM 2026-06-17: Faz-içi toplam askq-bekleme süresi (ms). Her askq emit→cevap
   * aralığı buraya eklenir. Faz süresinden (duration_ms) çıkarılır — kullanıcının
   * soruya cevap verme beklemesi MyCL çalışması DEĞİL (Faz 1 niyet "27dk" görünüyordu
   * ama çoğu cevap-bekleme). Oto-cevaplanan askq'lerde ~0 (sorun değil).
   */
  askqWaitMs: number;
  /** O an açık askq'nin emit zamanı (Date.now). Cevap gelince fark askqWaitMs'e eklenir. */
  currentAskqEmitTs?: number;
}
let activePhaseCost: PhaseCostBucket | null = null;

export function beginPhaseCost(phase: number, iteration: number): void {
  activePhaseCost = {
    phase,
    iteration,
    started_at: Date.now(),
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    // Faz geçişinde açık askq kalmaz → kova temiz başlar.
    askqWaitMs: 0,
    currentAskqEmitTs: undefined,
  };
}

/** Aktif kovayı döndürüp temizler (faz tamamlanınca). Kova yoksa null. */
export function takePhaseCost(): PhaseCostBucket | null {
  const b = activePhaseCost;
  activePhaseCost = null;
  return b;
}

export function recordTokenUsage(usage: ClaudeUsage): void {
  sessionTokenTotals.input_tokens += usage.input_tokens;
  sessionTokenTotals.output_tokens += usage.output_tokens;
  sessionTokenTotals.cache_creation_input_tokens +=
    usage.cache_creation_input_tokens ?? 0;
  sessionTokenTotals.cache_read_input_tokens +=
    usage.cache_read_input_tokens ?? 0;
  sessionTokenTotals.api_calls += 1;
  emit("token_totals", { ...sessionTokenTotals });

  if (activePhaseCost) {
    activePhaseCost.turns += 1;
    activePhaseCost.input_tokens += usage.input_tokens;
    activePhaseCost.output_tokens += usage.output_tokens;
    activePhaseCost.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
    activePhaseCost.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
    // F1: gerçek $ yalnız tanımlıysa biriktir (API yolu USD vermez → undefined kalır,
    // uydurma 0 YOK). Per-model döküm: çağrı modeli varsa o modelin kovasına ekle.
    if (usage.total_cost_usd !== undefined) {
      activePhaseCost.total_cost_usd =
        (activePhaseCost.total_cost_usd ?? 0) + usage.total_cost_usd;
    }
    if (usage.model) {
      const mu = (activePhaseCost.model_usage ??= {});
      const e = (mu[usage.model] ??= {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      });
      e.input_tokens += usage.input_tokens;
      e.output_tokens += usage.output_tokens;
      e.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
      e.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
    }
  }
  // YZLLM 2026-06-27: bir alt-ajan bağlamında çalışıyorsak (paralel takım üyesi) bu usage'ı O AJANA atfet →
  // Ajan Takımı popup'ı token'ı ajan-başına biriktirir. Bağlam yoksa (orkestratör/ana akış) yalnız global muhasebe.
  const ar = currentAgentRun();
  if (ar) {
    emit("agent_event", {
      sub: "token_usage",
      agent_label: ar.label,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      },
      ts: Date.now(),
      ev_id: ++_agentEvId, // mahkeme H2: dedup için benzersiz id
    });
  }
}

export function emitAskq(opts: {
  id: string;
  question: string;
  options: AskqOption[];
  allow_other?: boolean;
  multi_select?: boolean;
  suggested_option?: string;
}): void {
  // v15.7 (2026-05-27): Stack push — eski snapshot KORUNUR.
  const snapshot: ActiveAskqSnapshot = {
    id: opts.id,
    question: opts.question,
    options: opts.options,
    allow_other: opts.allow_other,
    multi_select: opts.multi_select,
    suggested_option: opts.suggested_option,
  };
  // Aynı id zaten varsa override (idempotent emit guard)
  const existingIdx = askqStack.findIndex((a) => a.id === opts.id);
  if (existingIdx >= 0) {
    askqStack[existingIdx] = snapshot;
  } else {
    askqStack.push(snapshot);
    if (askqStack.length > ASKQ_STACK_MAX) askqStack.shift();
  }
  _askqPending = true; // açık soru → heartbeat "yanıtını bekliyorum" göstersin (çalışıyor değil)
  // YZLLM 2026-06-17: askq emit anını aktif faz-kovasına yaz → cevap gelince bekleme
  // süresi hesaplanıp faz süresinden düşülür. Faz-dışı emit'te kova yok → no-op.
  if (activePhaseCost) activePhaseCost.currentAskqEmitTs = Date.now();
  emit("askq", opts);
}

export function emitPhaseChanged(
  from: PhaseId,
  to: PhaseId,
  status: PhaseStatus,
): void {
  emit("phase_changed", { from, to, status });
}

/**
 * YZLLM 2026-06-26: Faz kapsamı (needed_phases) frontend'e — kapsam onaylanınca PhaseSidebar çalışacak fazları
 * BELİRGİN, kapsam-dışı opsiyonelleri SOLUK gösterir. null/[] → kapsam henüz belirlenmedi (vurgulama yok, normal
 * görünüm). Scope değişen her noktada + boot'ta çağrılır (caller runtime.state.needed_phases'i verir).
 */
export function emitNeededPhases(phases: number[] | null): void {
  emit("needed_phases", { phases: phases ?? null });
}

/**
 * YZLLM 2026-06-12: NİYET kutusu, İTERASYONUN Faz 1 hedefini gösterir (iterasyon boyunca sabit) — son user
 * mesajını ("Hayır, kalsın" gibi askq cevabı) DEĞİL. Frontend "ilk user mesajı" heuristiği boot/trim sonrası
 * yanlış oluyordu (Faz 1 mesajı yüklü pencerede olmayabilir). Backend state.intent_summary_raw güvenilir kaynak;
 * boot'ta + Faz 1 onayında emit edilir. null → kutu temizlenir (niyet henüz yok / yeni iterasyon).
 */
export function emitIterationIntent(text: string | null | undefined): void {
  emit("iteration_intent", { text: text ?? null });
}

/**
 * Sticky loading bar — uzun-running operasyonlar (Phase 6 fix turn, Hata Ara
 * scan, Phase 0 D1/D3) sırasında MyCL ana chat panelinde gösterilir. Caller
 * try/finally ile emitPhaseIdle eşleştirmek ZORUNDA — eşleşmezse banner
 * kalıcı görünür kalır.
 */
// ── Heartbeat (YZLLM 2026-06-12): uzun işlerde 30sn'de bir chat'e durum yaz — basit "çalışıyor" DEĞİL,
// modelin SON YAPTIĞI / üzerinde çalıştığı ADIM (canlı tool_use'lardan). "4 dk takıldı mı?" kaygısının kalıcı
// çözümü. Mesajlar transient (persist:false) — history.log'u şişirmesin. emitPhaseRunning başlatır, Idle durdurur.
const HEARTBEAT_MS = 60_000; // YZLLM 2026-06-20: durum mesajı dakikada bir (30s çok kısaydı).
let _hbTimer: ReturnType<typeof setInterval> | null = null;
let _hbStart = 0;
let _hbLabel = "";
let _lastStep = "";
let _lastStepTs = 0; // _lastStep ne zaman güncellendi → heartbeat "şu an" mı "son adım (bayat)" mı ayırır
// YZLLM 2026-06-13: açık askq varken faz teknik olarak SENİN cevabını bekler — "çalışıyor/düşünüyor"
// göstermek YANILTICI ("sorunca cevabı beklemeden devam etti" hissi). emitAskq set eder; cevap (emitAskqResolved),
// model-aktivitesi (emitClaudeStream tool_use) veya faz-geçişi (running/idle) temizler → heartbeat dürüst durum gösterir.
let _askqPending = false;

/**
 * YZLLM 2026-06-26 (mahkeme M2/M3): faz göstergesi (heartbeat banner VEYA parked askq) ŞU AN kullanımda mı?
 * Kalıcı yönerge değerlendirmesi (handleOrchestratorDirective) bu göstergeye DOKUNMAMALI eğer aktifse — yoksa
 * çalışan fazı sahte-IDLE gösterir ya da askq'nin "yanıtını bekliyorum" sessizliğini bozar. true → banner'a dokunma.
 */
export function isPhaseIndicatorActive(): boolean {
  return _hbTimer !== null || _askqPending;
}

/** Yol → yalnız DOSYA ADI (son segment). YZLLM 2026-06-21: heartbeat ham komut/yol değil, çalışılan dosya adını gösterir. */
function baseName(p: unknown): string {
  const segs = String(p ?? "").split(/[/\\]/).filter(Boolean);
  return segs.length ? segs[segs.length - 1] : String(p ?? "");
}

/** Bash komutundan üzerinde çalışılan dosyayı çıkar (heuristik): yol-ayraçlı veya uzantılı son anlamlı token. */
function bashFile(cmd: string): string | null {
  for (const raw of cmd.split(/\s+/).reverse()) {
    const tok = raw.replace(/^['"]+|['"]+$/g, "");
    if (!tok || tok.startsWith("-") || /[<>|&;()]/.test(tok)) continue; // flag / redirect / pipe / subshell atla
    if (tok.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(tok)) return tok; // yol-ayraçlı veya uzantılı → dosya
  }
  return null;
}

/** claude_stream olayından insan-okur "adım" üret — YALNIZ çalışılan DOSYA ADI (ham komut/uzun yol değil).
 *  text=reasoning → atlanır. Export: test. */
export function describeStep(opts: { sub: ClaudeStreamSub; tool_name?: string; tool_input?: Record<string, unknown> }): string | null {
  if (opts.sub !== "tool_use" || !opts.tool_name) return null;
  const t = opts.tool_name;
  const inp = opts.tool_input ?? {};
  if (t === "Write") return `\`${baseName(inp.file_path ?? inp.path)}\` yazılıyor`;
  if (t === "Edit" || t === "MultiEdit") return `\`${baseName(inp.file_path ?? inp.path)}\` düzenleniyor`;
  if (t === "Read") return `\`${baseName(inp.file_path ?? inp.path)}\` okunuyor`;
  if (t === "Bash") {
    const f = bashFile(String(inp.command ?? ""));
    return f ? `\`${baseName(f)}\` üzerinde çalışılıyor` : "komut çalıştırılıyor";
  }
  if (t === "Glob" || t === "Grep") return `\`${String(inp.pattern ?? inp.query ?? "").slice(0, 50)}\` aranıyor`;
  return `${t} aracı kullanılıyor`;
}

function startHeartbeat(label: string): void {
  stopHeartbeat();
  _hbLabel = label;
  _hbStart = Date.now();
  _lastStep = "";
  _lastStepTs = 0;
  _askqPending = false; // yeni faz çalışıyor → varsa bayat "bekliyorum" durumunu temizle
  _hbTimer = setInterval(() => {
    // YZLLM 2026-06-13: askq açıkken heartbeat TAMAMEN SESSİZ — "yanıtını bekliyorum"u her 30s tekrarlama
    // (gürültü). Soru kartı zaten görünür; kullanıcı beklendiğini biliyor. Cevap/abort gelince (emitAskqResolved
    // → _askqPending=false) heartbeat kendiliğinden tekrar konuşur. Tüm fazlar için geçerli.
    if (_askqPending) return;
    const now = Date.now();
    const secs = Math.round((now - _hbStart) / 1000);
    let line: string;
    if (!_lastStep) {
      line = "planlıyor / düşünüyor (henüz dosyaya/komuta dokunmadı)";
    } else {
      const ageSec = Math.round((now - _lastStepTs) / 1000);
      // YZLLM 2026-06-12: adım bayatsa "şu an" YANILTICI (örn. dosya 1sn'de okundu ama _lastStep 60sn stale kaldı →
      // "1 dk okuyor" gibi görünür). Bayat (>1 heartbeat) ise dürüstçe "son adım (Ns önce), beri yeni eylem yok".
      line =
        ageSec > Math.round(HEARTBEAT_MS / 1000) + 5
          ? `son adım (~${ageSec}s önce): ${_lastStep} — o zamandan beri yeni dosya/komut YOK (düşünüyor…)`
          : `şu an: ${_lastStep}`;
    }
    // YZLLM 2026-06-27: heartbeat durumu CHAT panelini ŞİŞİRMESİN → alttaki BANDA (runningBanner) yaz. Band detail'i
    // her 60s'de canlı durumla güncellenir (label sabit _hbLabel); chat temiz kalır. phase_running re-emit yan etkisiz
    // (frontend reducer yalnız runningBanner'ı set eder); faz-geçişi/idle bandı normalde kapatır.
    emit("phase_running", { label: _hbLabel, detail: `${secs}s sürüyor · ${line}`, ts: now });
  }, HEARTBEAT_MS);
  // Süreç çıkışını engellememesi için unref (varsa).
  (_hbTimer as unknown as { unref?: () => void })?.unref?.();
}
function stopHeartbeat(): void {
  if (_hbTimer) {
    clearInterval(_hbTimer);
    _hbTimer = null;
  }
}

export function emitPhaseRunning(label: string, detail?: string): void {
  emit("phase_running", { label, detail, ts: Date.now() });
  startHeartbeat(label);
}
export function emitPhaseIdle(): void {
  _askqPending = false; // faz bitti → bekleme durumu da temizlenir
  emit("phase_idle", { ts: Date.now() });
  stopHeartbeat();
}

export function emitClaudeStream(opts: {
  sub: ClaudeStreamSub;
  text?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  is_error?: boolean;
  model?: string;
  cwd?: string;
  /** Codegen/qa-askq loop turn progress — UI banner'a "Turn N/M" basar. */
  turn?: number;
  max_turns?: number;
  /** sub="request" ile birlikte: system prompt + initial user mesajı (EN). */
  system?: string;
  user_message?: string;
  /** sub="token_usage" payload — input/output + cache_creation/cache_read tokens. */
  usage?: ClaudeUsage;
  /** Cross-panel correlation: opt-in. Caller turn boyunca aynı ts geçirebilir. */
  ts?: number;
}): void {
  const payload = { ...opts, ts: opts.ts ?? Date.now() };
  emit("claude_stream", payload);
  persistHistory("claude_stream", payload);
  // Heartbeat için "son adım"ı + zamanını yakala (somut tool_use → "X yazılıyor / npm test çalıştırılıyor").
  const step = describeStep(opts);
  if (step) {
    _lastStep = step;
    _lastStepTs = Date.now();
    _askqPending = false; // model yeniden aktif (tool çağırıyor) → cevap verilmiş, artık beklemiyoruz
  }
}

export function emitError(reason: string, detail?: unknown): void {
  emit("error", { reason, detail });
}

/**
 * v15.6: Orkestrator ajan event'leri — frontend "🧠 Orkestrator" modalında
 * gösterilir. Agent tool loop her turda tool_use + final decision için emit
 * eder; UI reverse-chronological listeler. claude_stream pattern'i taklit
 * eder ama history.log'a persist EDİLMEZ (modal real-time, history şişmesin).
 */
export type AgentEventSub =
  | "started"     // agent.respond() çağrısı başladı — UI loading göstersin
  | "completed"   // agent.respond() bitti (başarılı/hatalı fark etmez) — loading kapansın
  | "tool_use"     // Read/Grep/Bash çağrısı (turn + tool_name + tool_input)
  | "decision"    // decide_action tool çağrısı (final karar — AgentDecision payload)
  | "error";      // agent loop fail (timeout, parse error, API error)

/** Ajan-olayı token özeti (Ajan Takımı popup'ı için; agent_event sub="token_usage" recordTokenUsage'dan emit edilir). */
export interface AgentEventUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

// YZLLM 2026-06-27 (mahkeme H2): her agent_event'e MONOTON benzersiz id — frontend reducer aynı olayı (StrictMode
// çift-invoke / effect re-fire) tekrar işlerse atlasın (token ÇİFT-sayımı + ajan-koşusu çift-açılması önlenir).
let _agentEvId = 0;

export function emitAgentEvent(opts: {
  sub: AgentEventSub;
  /** Agent Teams görünürlüğü: hangi ajan (örn. "Mimari"/"UX"). Tek orkestratörde verilmez. */
  agent_label?: string;
  /** YZLLM 2026-06-27: takım/grup adı (popup'ta gruplama) — "Tasarım Paneli"/"Modül Codegen" vb. started'da verilir. */
  agent_group?: string;
  /** YZLLM 2026-06-27: ajanın çalıştığı pipeline fazı (popup "hangi fazda"). started'da verilir. */
  phase?: number;
  turn?: number;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  decision?: Record<string, unknown>;
  error?: string;
  ts?: number;
}): void {
  const payload = { ...opts, ts: opts.ts ?? Date.now(), ev_id: ++_agentEvId };
  emit("agent_event", payload);
  // Kalıcı iz (kör nokta kalmasın): UI'ya ephemeral gösterilen her olay .mycl/traces/agents.jsonl'a da yazılır.
  void traceAgentEvent(payload);
}

/**
 * v15.11: UI kullanma kılavuzu (.mycl/user-guide.md) içeriğini frontend'e push.
 * Açılışta (varsa) + her güncellemede. "Kılavuz" sekmesi/modalı bunu gösterir.
 */
export function emitUserGuide(content: string): void {
  emit("user_guide", { content });
}

/** YZLLM 2026-06-14: TR teknik dökümanı (.mycl/tech-doc.md) MyCL penceresine push (emitUserGuide ikizi). */
export function emitTechDoc(content: string): void {
  emit("tech_doc", { content });
}
