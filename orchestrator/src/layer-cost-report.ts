// layer-cost-report — Katman Maliyeti Raporu (YZLLM 2026-07-12).
//
// Pipeline bitiminde tek koşudaki her DOĞRULAMA/İNCELEME katmanının ne yaptığını + (dürüstçe ölçülebildiği yerde)
// maliyetini DETERMİNİSTİK olarak (LLM YOK — sayılar dosyalardan) chat'e basar. Kullanıcı hangi katmanın çok
// maliyet üretip az değer kattığını GÖRÜP gereksiz katmanı KENDİSİ budar (otomatik budama YOK — insan karar verir).
//
// DÜRÜSTLÜK İLKELERİ (çapraz-aile mahkemesi 2026-07-12, 6 bulgu düzeltildi):
//   • DEĞER YARGISI YOK: Tek bir yeşil koşuda "0 bulgu" katmanın ÇALIŞTIĞI kanıtıdır, GEREKSİZLİK kanıtı DEĞİL
//     (güvenlik/test ağlarının değeri fire ETMEDİKLERİ koşullardadır). Katmanı "gereksiz olabilir" diye
//     işaretlemek "No false positives" ihlali → yapılmaz. Rapor yalnız GERÇEĞİ (koştu / ne yakaladı / süre) gösterir.
//   • İZOLE EDİLEMEYEN MALİYETİ ATFETME: per-katman token diske kalıcı tutulmuyor; bir faz birden çok katman +
//     ana codegen barındırır (Faz 8 = çoğunlukla TDD codegen). Faz-toplamını tek katmana yazmak yanıltıcı → per-katman
//     TOKEN gösterilmez; faz-toplamı AYRI "Faz LLM maliyeti" bölümünde (faz düzeyi, bölünemez) sunulur.
//   • SÜRE yalnız GÜVENİLİR ölçülen yerde: agent_group'lu LLM katmanları (Faz 9) için agents.jsonl grup-aralığı
//     (started→completed, agent_label ile bağlanır — completed event'i agent_group taşımaz). Grup yoksa süre gösterilmez.
//   • YALNIZ OTOMATİK pipeline katmanları: kullanıcı-tetikli 🛡️/Denetim/verify-feature HARİÇ; Faz 17 pentest
//     2026-06-22'den beri no-op (yalnız manuel 🛡️ buton) → envanterde YOK (phase-17-complete "koştu" sayılmaz).
// Flag-gated (layer_cost_report, default AÇIK) + fail-soft (ASLA throw etmez, pipeline'ı bozmaz).

import { readAuditLog, readCosts } from "./audit.js";
import { eventsSince } from "./harness-verdict.js";
import { readAgentTrace, type AgentTraceRecord } from "./agent-trace.js";
import { type MyclConfig } from "./config.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import type { AuditEvent, CostRecord, State } from "./types.js";

const PHASE_NAMES: Record<number, string> = {
  8: "TDD Uygulama", 9: "Risk İncelemesi",
};

/** Bir doğrulama katmanının statik tanımı (yalnız OTOMATİK pipeline katmanları). */
interface LayerDef {
  id: string;
  name: string;
  /** Koştuğu faz; null = evrensel. NOT: ad 'Faz N' öneki İÇERMEZ — format [Faz N] etiketini tek kaynaktan ekler. */
  phase: number | null;
  kind: "llm" | "mekanik";
  /**
   * agents.jsonl'daki agent_group (LLM katmanları için per-katman süre — SUBSTRING eşleşir; grup adı sürüklenirse
   * yine yakalar). Yoksa süre GÖSTERİLMEZ (faz-toplamını atfetmek yanıltıcı → BULGU 4).
   */
  group?: string;
  /** Bu katmanın audit.log'a yazdığı TÜM event adları (koştu-mu). Listeler DISJOINT (her event tek katmana). */
  events: string[];
  /** Bunlardan hangileri "bir şey buldu" demek (kalanı = temiz geçti). */
  findingEvents: string[];
  purpose: string;
}

// Katman↔event adları gerçek `appendAudit` çağrılarından (2026-07-12) doğrulandı — tahmin yok.
const LAYER_INVENTORY: LayerDef[] = [
  // ── Faz 8: güven-sağlamlaştırma ─────────────────────────────────────────────
  {
    // FINDING-ONLY: yalnız `tdd-tests-weak` (mutasyon YAKALANMADI = testler zayıf). Temiz-güçlü koşuda İZ YOK →
    // rapor bu katmanı yalnız bir zayıflık BULUNCA gösterir (temiz koşuda "koşmadı" görünür; kabul edilen sınır —
    // Faz-8 gate `lastEvent` tdd-green olmalı, oraya tanı-event'i eklemek YEŞİL koşuyu kırıyordu → eklenmedi).
    // `tdd-unverified` KASITLI hariç — mutasyon probu DEĞİL, ayrı Faz-8 sinyali (phase-8.ts:1011/1035/1055).
    id: "mutation-probe", name: "Mutasyon/test geçerliği probu", phase: 8, kind: "llm",
    events: ["tdd-tests-weak"], findingEvents: ["tdd-tests-weak"],
    purpose: "yeşil testler gerçekten kırılmayı yakalıyor mu (mutasyon hayatta kalırsa testler zayıf)",
  },
  {
    // FINDING-ONLY: yalnız `adversarial-test-fail` (bir AC ihlali bulundu). Temiz koşuda İZ YOK (aynı
    // gate-lastEvent gerekçesi) → rapor yalnız bir kırılma BULUNCA gösterir.
    id: "adversarial-test", name: "Bağımsız düşman testi", phase: 8, kind: "llm",
    events: ["adversarial-test-fail"], findingEvents: ["adversarial-test-fail"],
    purpose: "kodu kırmaya çalışan ayrı ajan (sahte-yeşil panzehiri)",
  },
  {
    id: "tech-debt-scan-8", name: "Teknik borç tarayıcı", phase: 8, kind: "mekanik",
    events: ["tdd-tech-debt-detected", "tdd-tech-debt-clean"], findingEvents: ["tdd-tech-debt-detected"],
    purpose: "yazılan kodda credential/kısayol/borç deseni (deterministik regex)",
  },
  {
    id: "consent-observer", name: "Davranış onayı gözlemcisi", phase: 8, kind: "mekanik",
    events: ["behavior-consent-violation", "behavior-consent-stale-artifact"],
    findingEvents: ["behavior-consent-violation", "behavior-consent-stale-artifact"],
    purpose: "onaysız dokunulmaması gereken yola yazım (MyCL projeleri)",
  },
  {
    id: "foreign-baseline", name: "Yabancı proje baseline regresyonu", phase: 8, kind: "mekanik",
    events: ["behavior-baseline-regression"], findingEvents: ["behavior-baseline-regression"],
    purpose: "yabancı projede var olan davranış bozuldu mu (baseline karşılaştırması)",
  },
  // ── Faz 9: risk incelemesi (agent_group'lu → per-katman süre ölçülür) ───────
  {
    id: "risk-review", name: "Risk İncelemesi (bulan+çürüten debate)", phase: 9, kind: "llm",
    group: "İnceleme", events: ["phase-9-complete", "risk-decision", "phase-9-tech-debt-scan"],
    findingEvents: ["risk-decision"],
    purpose: "7-eksen çok-ajanlı bulan + bağımsız çürüten + mahkeme birleştirme",
  },
  {
    id: "parallel-risk-fix", name: "Paralel risk düzeltme + birleştirme mahkemesi", phase: 9, kind: "llm",
    group: "Paralel Düzeltme", events: ["risk-fix-parallel-applied"], findingEvents: ["risk-fix-parallel-applied"],
    purpose: "≥2 fix izole kopyalarda paralel + çakışan dosya çapraz-aile mahkemesi",
  },
  // ── Faz 10-16: mekanik gate'ler (süre ölçülmüyor; ~0 token) ─────────────────
  { id: "lint", name: "Lint (+semgrep code-quality+arch)", phase: 10, kind: "mekanik", events: ["lint-pass", "lint-fail"], findingEvents: ["lint-fail"], purpose: "profil lint + kod-kalitesi taraması" },
  { id: "simplify", name: "Sadeleştirme", phase: 11, kind: "mekanik", events: ["simplify-pass", "simplify-fail"], findingEvents: ["simplify-fail"], purpose: "ölü kod / gereksiz karmaşıklık (ts-prune vb.)" },
  { id: "perf", name: "Performans", phase: 12, kind: "mekanik", events: ["perf-pass", "perf-fail"], findingEvents: ["perf-fail"], purpose: "profil perf komutu (yoksa sessiz skip)" },
  { id: "security", name: "Güvenlik (+9 extra_scan)", phase: 13, kind: "mekanik", events: ["security-pass", "security-fail"], findingEvents: ["security-fail"], purpose: "csp/semgrep-secrets/security-audit/gitleaks — pipeline'ın tek oto güvenlik taraması" },
  { id: "unit", name: "Birim Testler", phase: 14, kind: "mekanik", events: ["unit-pass", "unit-fail"], findingEvents: ["unit-fail"], purpose: "değişen-dosya-ilgili birim testler" },
  { id: "integration", name: "Entegrasyon Testleri", phase: 15, kind: "mekanik", events: ["integration-pass", "integration-fail"], findingEvents: ["integration-fail"], purpose: "entegrasyon test paketi" },
  { id: "e2e", name: "E2E Testler", phase: 16, kind: "mekanik", events: ["e2e-pass", "e2e-fail"], findingEvents: ["e2e-fail"], purpose: "Playwright/hurl (UI'sız projede atlanır)" },
  // NOT: Faz 17 Pentest ENVANTERDE YOK — 2026-06-22'den beri otomatik koşmaz (no-op; yalnız 🛡️ manuel buton).
  //      `phase-17-complete` pipeline-tamamlanma işaretidir, pentest-ran sinyali DEĞİL → "koştu" saymak yanıltıcı.
  // ── Faz 10-16 boyunca: gate-autofix regresyon guard ─────────────────────────
  {
    id: "regression-guard", name: "Regresyon guard (gate-autofix sonrası)", phase: null, kind: "mekanik",
    events: ["regression-guard-pass", "regression-guard-fail"], findingEvents: ["regression-guard-fail"],
    purpose: "bir gate kendi içini düzeltince tam test paketi geri gitmiş mi",
  },
];

/** Tek katmanın hesaplanmış satırı. SAF üretim. */
export interface LayerCostRow {
  id: string;
  name: string;
  phase: number | null;
  kind: "llm" | "mekanik";
  ran: boolean;
  /** LLM zamanı (ms) — YALNIZ agent_group'lu katmanlar için güvenilir grup-aralığından; aksi null (ölçülmüyor). */
  durationMs: number | null;
  /** Ne yakaladı — kısa TR özet (koştu ise). */
  caught: string;
  /** Bu koşuda bir şey buldu mu (yalnız GERÇEK, yargısız — "gereksiz" çıkarımı YAPILMAZ). */
  hadFinding: boolean;
}

/** Faz düzeyi LLM maliyeti (per-katman değil — dürüstçe faz-toplamı). */
export interface PhaseCost {
  phase: number;
  tokens: number;
  durationMs: number | null;
}

function fmtDur(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}sn`;
  return `${Math.floor(s / 60)}dk ${s % 60}sn`;
}

function fmtTok(n: number): string {
  if (n < 1000) return `${n}`;
  return `~${Math.round(n / 1000)}k`;
}

/**
 * agents.jsonl'da bir grubun süresi (ms). GERÇEK iz şekli: agent_group YALNIZ 'started' event'lerinde bulunur;
 * 'completed'/token_usage kayıtları agent_group TAŞIMAZ ama agent_label taşır. Bu yüzden: grubun label'larını
 * started'lardan topla → o label'lı TÜM kayıtların (completed dahil) son ts'ini bul. min(started) → max(o label'lar).
 * Yoksa null. (Mahkeme BULGU 2: eski kod yalnız started ts'lerini görüp bitiş süresini kaçırıyordu.)
 */
function groupSpan(trace: AgentTraceRecord[], groupSub: string): number | null {
  const labels = new Set<string>();
  let min = Infinity;
  for (const t of trace) {
    if (t.sub === "started" && t.agent_group?.includes(groupSub)) {
      if (t.agent_label) labels.add(t.agent_label);
      if (t.ts < min) min = t.ts;
    }
  }
  if (labels.size === 0 || min === Infinity) return null;
  let max = -Infinity;
  for (const t of trace) {
    if (t.agent_label && labels.has(t.agent_label) && t.ts > max) max = t.ts;
  }
  if (max <= min) return null;
  return max - min;
}

/**
 * SAF (test edilebilir): bu iterasyonun audit event'leri + agent iz kayıtlarından her katmanın {koştu, süre, bulgu}
 * satırını üretir. Kaynaklar ÇAĞRIDAN ÖNCE bu-iterasyona süzülmüş olmalı. Token BURADA ATFEDİLMEZ (per-katman
 * kalıcı değil + faz-paylaşımlı → yanıltıcı). Token faz düzeyinde aggregatePhaseCosts ile ayrı sunulur.
 */
export function aggregateLayerCosts(events: AuditEvent[], trace: AgentTraceRecord[]): LayerCostRow[] {
  const eventSet = new Set(events.map((e) => e.event));
  const rows: LayerCostRow[] = [];
  for (const L of LAYER_INVENTORY) {
    const ran =
      L.events.some((ev) => eventSet.has(ev)) ||
      (L.group ? trace.some((t) => t.agent_group?.includes(L.group!)) : false);

    const matched = events.filter((e) => L.events.includes(e.event));
    const findings = matched.filter((e) => L.findingEvents.includes(e.event));
    let caught: string;
    if (!ran) {
      caught = "koşmadı / uygulanmadı";
    } else if (findings.length > 0) {
      const d = findings[findings.length - 1].detail;
      caught = `${findings.length} bulgu` + (d ? ` — ${String(d).slice(0, 80)}` : "");
    } else {
      const info = matched.find((e) => e.detail)?.detail;
      caught = "temiz geçti (bulgu yok)" + (info ? ` — ${String(info).slice(0, 80)}` : "");
    }

    // Süre: YALNIZ agent_group'lu katmanlar için güvenilir grup-aralığı. Grup yoksa null (faz-toplamı atfetme — BULGU 4).
    const durationMs = ran && L.kind === "llm" && L.group ? groupSpan(trace, L.group) : null;

    rows.push({ id: L.id, name: L.name, phase: L.phase, kind: L.kind, ran, durationMs, caught, hadFinding: findings.length > 0 });
  }
  return rows;
}

/** SAF: cost.jsonl'dan, İÇİNDE doğrulama LLM katmanı koşan fazların faz-toplam maliyeti (token+süre). Faz düzeyi — bölünemez. */
export function aggregatePhaseCosts(rows: LayerCostRow[], costs: CostRecord[]): PhaseCost[] {
  const llmPhases = new Set<number>();
  for (const r of rows) if (r.ran && r.kind === "llm" && r.phase != null) llmPhases.add(r.phase);
  const tok = new Map<number, number>();
  const dur = new Map<number, number>();
  for (const c of costs) {
    if (!llmPhases.has(c.phase)) continue;
    tok.set(c.phase, (tok.get(c.phase) ?? 0) + c.input_tokens + c.output_tokens);
    if (typeof c.duration_ms === "number") dur.set(c.phase, (dur.get(c.phase) ?? 0) + c.duration_ms);
  }
  return [...tok.keys()]
    .sort((a, b) => a - b)
    .map((p) => ({ phase: p, tokens: tok.get(p) ?? 0, durationMs: dur.get(p) ?? null }));
}

/** Türkçe rapor metni. Yargısız GERÇEKLER + faz-toplam maliyet + dürüst değer-kararı notu (oto-budama YOK). SAF. */
export function formatLayerCostReport(rows: LayerCostRow[], phaseCosts: PhaseCost[]): string {
  const ran = rows.filter((r) => r.ran);
  if (ran.length === 0) return "";

  // Ölçülen süreye sahip (Faz 9 LLM) katmanlar önce (pahalı→ucuz); sonra süresiz katmanlar faza göre sıralı.
  const sorted = [...ran].sort((a, b) => {
    const da = a.durationMs ?? -1;
    const db = b.durationMs ?? -1;
    if (db !== da) return db - da;
    return (a.phase ?? 99) - (b.phase ?? 99);
  });

  const lines = sorted.map((r) => {
    const tag = r.phase != null ? `Faz ${r.phase}` : "evrensel";
    const dur = r.durationMs != null ? ` · ${fmtDur(r.durationMs)}` : "";
    return `• [${tag}] ${r.name}: ${r.caught}${dur}`;
  });

  const costLines = phaseCosts.map((pc) => {
    const dur = pc.durationMs != null ? ` · ${fmtDur(pc.durationMs)}` : "";
    const note = pc.phase === 8 ? " (çoğu ana TDD codegen — probe/düşman testi küçük pay)" : "";
    return `• Faz ${pc.phase} (${PHASE_NAMES[pc.phase] ?? "?"}): ${fmtTok(pc.tokens)} token${dur}${note}`;
  });
  const costBlock = costLines.length
    ? `\n\n**Faz LLM maliyeti** (faz düzeyi — token katman başına kalıcı tutulmuyor, tek katmana bölünemez):\n${costLines.join("\n")}`
    : "";

  const valueNote =
    `\n\n💡 **Değer kararı senin:** tek bir yeşil koşu bir katmanın gereksiz olduğunu KANITLAMAZ — güvenlik/test ` +
    `ağlarının değeri, fire ETMEDİKLERİ koşullardadır. Bir katman ÇOK sayıda koşuda hiçbir şey yakalamıyorsa ` +
    `budamayı değerlendir. Otomatik budama yok — karar senin.`;

  return (
    `📊 **Katman Maliyeti Raporu** — bu koşuda ${ran.length} doğrulama katmanı çalıştı ` +
    `(ne yaptı; süre yalnız güvenilir ölçülen Faz 9 katmanlarında):\n${lines.join("\n")}${costBlock}${valueNote}`
  );
}

/**
 * IMPURE: pipeline-end'de çağrılır. Bu iterasyonun audit + agent-iz + cost kaynaklarını okur → deterministik
 * katman raporu chat'e. Flag KAPALI / hiç katman koşmadı → no-op. ASLA throw etmez (pipeline'ı bozmaz).
 */
export async function runLayerCostReport(state: State, config: MyclConfig): Promise<void> {
  try {
    if (!config.features.layer_cost_report) return;
    const iterStart = state.iteration_started_at ?? 0;
    const events = eventsSince(await readAuditLog(state.project_root), iterStart);
    if (events.length === 0) return;
    const trace = (await readAgentTrace(state.project_root)).filter((t) => (t.ts ?? 0) >= iterStart);
    const costs = (await readCosts(state.project_root)).filter((c) => (c.ts ?? 0) >= iterStart);

    const rows = aggregateLayerCosts(events, trace);
    const phaseCosts = aggregatePhaseCosts(rows, costs);
    const report = formatLayerCostReport(rows, phaseCosts);
    if (!report) return; // hiç katman koşmadı
    emitChatMessage("system", report);
  } catch (e) {
    log.warn("layer-cost-report", "report failed (non-fatal)", e);
  }
}
