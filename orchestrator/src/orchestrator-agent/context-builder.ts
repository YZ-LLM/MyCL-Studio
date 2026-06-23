// orchestrator-agent/context-builder — state + audit + spec → agent system
// prompt context section.
//
// Comprehensive system prompt (assets/agent-prompts/orchestrator-system.md)
// dosya başına ~3000 token. Bu module mevcut state snapshot'ını + son audit
// event'lerini + son chat mesajlarını dinamik bir "CURRENT CONTEXT" section
// olarak ekler. Agent karar verirken hem statik bilgi (pipeline mimari) hem
// dinamik durum (current_phase, intent_summary, vb.) görsün.

import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readAuditLogTail, readDecisions, readHandoffs, readWtf } from "../audit.js";
import type { HandoffRecord, WtfRecord } from "../audit.js";
import { log } from "../logger.js";
import { peekProjectMap, formatProjectMap } from "../onboarding/project-map.js";
import { extractFeatureChunks } from "../relevance/chunk-store.js";
import { buildRelevantOrchestratorContext } from "../relevance/injectors.js";
import { buildProjectFacts } from "../project-facts.js";
import { listAvailableModules, type ModuleSummary } from "../module-stock.js";
import {
  readProjectMemory,
  readGeneralMemory,
} from "../agent-memory/store.js";
import type { AgentMemoryEntry } from "../agent-memory/types.js";
import type { MyclConfig } from "../config.js";
import {
  buildConversationContext,
  renderConversationSection,
} from "../conversation-context.js";
import { getActiveAskq, type ActiveAskqSnapshot } from "../ipc.js";
import type { DecisionRecord, State } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Asset path resolve — phase-registry.ts ile aynı pattern (ASSETS_ROOT).
 * Bundle'da `dist/orchestrator-agent/context-builder.js` → `..` → dist →
 * `..` → orchestrator → `..` → mycl-v14 root → `assets/agent-prompts/`.
 * Dev mode'da da aynı yapı.
 */
const ASSETS_ROOT = resolve(__dirname, "..", "..", "..", "assets");
const PROMPT_ASSET_PATH = resolve(
  ASSETS_ROOT,
  "agent-prompts",
  "orchestrator-system.md",
);

function resolveAssetPath(): string {
  return PROMPT_ASSET_PATH;
}

let cachedSystemPrompt: string | null = null;

/**
 * Statik sistem promptu yükler ve cache'ler. Process lifetime boyunca disk'ten
 * bir kez okunur — prompt asset değişirse orchestrator restart gerek.
 */
export async function loadStaticSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt;
  const path = resolveAssetPath();
  try {
    cachedSystemPrompt = await fs.readFile(path, "utf-8");
    return cachedSystemPrompt;
  } catch (err) {
    throw new Error(
      `agent system prompt asset load failed: ${path} — ${String(err)}`,
    );
  }
}

export interface AgentContextSnapshot {
  /** Mevcut faz numarası (0-17). */
  current_phase: number;
  /** Pipeline tamamlanma sayısı. */
  iteration_count: number;
  /** Phase 1 onaylı intent — Phase 4 spec input. */
  intent_summary: string | null;
  /** Spec.md onaylı mı (Phase 4). */
  spec_approved: boolean;
  /** Pending UI tweak request var mı (Phase 6 → Phase 5 loop). */
  pending_ui_tweak: string | null;
  /** Phase 0 D2_WAITING durumu — askq cevabı bekleniyor. */
  pending_diagnostic_phase: string | null;
  /** Veritabanı kullanılıyor mu (Phase 2 classifier set). */
  has_database: boolean | null;
  /** UI fazları skip mi (library/cli/api/ml/game için true). */
  skip_ui_phases: boolean;
  /** Dev server PID (Phase 5 sonrası). */
  dev_server_pid: number | null;
  /** TDD compliance skoru (Phase 8 sonrası). */
  tdd_compliance_score: number | null;
  /** Son N audit event (chronological). */
  recent_audit: Array<{ ts: number; phase: number; event: string; caller: string }>;
  /** v15.8: Son N ADR kararı — "neden böyle karar verildi" (decisions.jsonl). */
  recent_decisions: DecisionRecord[];
  /** ③ (Missions handoff): son N faz devri — durum + keşfedilen sorun (handoffs.jsonl).
   *  Orkestratör son faz sonuçlarını görüp HEDEFLİ takip önerebilir (rewrite değil). */
  recent_handoffs: HandoffRecord[];
  /** WTF/gotcha (Cichra karar-yakalama): bilinen tuzaklar/taşıyıcı-kod notları (wtf.jsonl) —
   *  dokunmadan önce görülsün ki bilerek-böyle olan şey yanlışlıkla bozulmasın. */
  recent_wtf: WtfRecord[];
  /** Onboarding (yabancı koda hakimiyet): projenin en merkezi modülleri (hazır digest, boş olabilir). */
  project_map: string;
  /** Pipeline en az bir kez Faz 17'yi tamamladı mı (yeni iterasyon tetikleyici). */
  was_pipeline_completed: boolean;
  /** v15.6: Projeye özel son N hafıza girişi. */
  project_memory: AgentMemoryEntry[];
  /** v15.6: Genel hafıza son N girişi. */
  general_memory: AgentMemoryEntry[];
  /** v15.11: .mycl/features.md başlık-indeksi — orkestratör mevcut özellikleri
   * görüp grounded soru sorar. Detay için features.md'yi kendi Read'ler. */
  feature_headings: string[];
  /** Modül-stoğu (discover): bu stack için stoklu reuse-edilebilir modüller. Orkestratör
   *  yeni feature isteğinde reuse önerir (auto-wire YOK; ajan karar verir). */
  available_modules: ModuleSummary[];
}

/**
 * State → context snapshot. Audit log son 30 event ile zenginleştirilir.
 * Agent bunu okuyup `current_phase`'e göre doğru karar verir.
 */
export async function buildAgentContext(
  state: State,
): Promise<AgentContextSnapshot> {
  // v15.7 (2026-05-25): Tail-only — büyük projede 2-5 MB full read yerine
  // son ~125 KB. Hem recent (10 event inject) hem wasCompleted (per-iteration
  // check) için 500 event yeterli — pratik vakaların %99'unda son
  // iter-N-start tail içinde. Edge case (uzun mid-iter session, 500+ event
  // birikti): wasCompleted false döner → agent "yeni iş bekleniyor" der;
  // hatalı true'dan daha az zararlı.
  const auditAll = await readAuditLogTail(state.project_root, 500);
  // Doğru-karar/recall (2026-06-04): son-10 → son-30. Orkestratör daha derin geçmiş
  // görür (önceki iterasyonun faz geçişleri/onayları); render kısa (phase/event/caller).
  const recent = auditAll.slice(-30).map((e) => ({
    ts: e.ts,
    phase: typeof e.phase === "number" ? e.phase : 0,
    event: e.event,
    caller: e.caller,
  }));
  // v15.6 (2026-05-24): `was_pipeline_completed` GÜNCEL iterasyona göre
  // hesaplanır. Eskiden tüm audit'i tarayıp eski iterasyonda phase-17 olduysa
  // hep `true` dönüyordu → boot check ajan yeni başlayan iterasyon için
  // "tamamlandı" diyordu (false positive). Şimdi: en son `iteration-N-start`
  // event'inden SONRA phase-17/20-complete var mı diye bakar. İlk iterasyonun
  // explicit start event'i yok (audit "iteration-2-start"'tan başlar), o yüzden
  // iteration_count=1 için tüm audit taranır (eski davranış).
  const iterCount = state.iteration_count ?? 1;
  let wasCompleted: boolean;
  if (iterCount === 1) {
    wasCompleted = auditAll.some(
      (e) => e.event === "phase-17-complete" || e.event === "phase-20-complete",
    );
  } else {
    const startEvent = auditAll.find(
      (e) => e.event === `iteration-${iterCount}-start`,
    );
    const startTs = startEvent?.ts ?? 0;
    wasCompleted = auditAll.some(
      (e) =>
        e.ts > startTs &&
        (e.event === "phase-17-complete" || e.event === "phase-20-complete"),
    );
  }
  // v15.6: Hafıza inject — son 10 project + son 5 general. Limit defansif
  // (büyük hafıza dosyaları token bütçesini şişirmesin).
  // v15.7 (2026-05-26): General memory `currentStack` ile filtrelenir —
  // cross-project leak koruması. state.stack bilinmiyorsa filter atlanır
  // (geriye-uyumlu).
  // Doğru-karar/recall (2026-06-04): proje 10→15, genel 5→8, ADR 3→8. Daha derin
  // "ne yapmıştık / neden böyle karar vermiştik" bağlamı (limitler defansif kalır).
  const [projectMemory, generalMemory] = await Promise.all([
    readProjectMemory(state.project_root, 15).catch((e) => {
      log.error("context-builder", "proje-belleği okunamadı (gerçek hata, ENOENT değil)", { error: String(e) });
      return [];
    }),
    readGeneralMemory(8, state.stack).catch((e) => {
      log.error("context-builder", "genel-bellek okunamadı (gerçek hata)", { error: String(e) });
      return [];
    }),
  ]);
  // errno NOT (sessiz-fallback denetimi): readDecisions/Handoffs/Wtf ENOENT'i (dosya yok) upstream'de
  // [] yapar → buradaki catch yalnız GERÇEK hatayı (bozulma/parse) yakalar. Sessiz [] orkestratörün
  // ADR/devir/tuzak bağlamını kaybettirir (WTF kaybı = bilerek-böyle olanı bozma riski) → log.error ile
  // izlenebilir kıl (best-effort bağlam olduğundan chat-spam yapma, ama sessiz de bırakma).
  const recentDecisions = (
    await readDecisions(state.project_root).catch((e) => {
      log.error("context-builder", "decisions okunamadı (ADR bağlamı kayıp — gerçek hata, ENOENT değil)", { error: String(e) });
      return [];
    })
  ).slice(-8);
  // ③ (Missions handoff): son faz devirleri — orkestratör son sonuçları (özellikle fail +
  // keşfedilen sorun) görüp HEDEFLİ takip önerebilsin (rewrite değil). Defansif limit.
  const recentHandoffs = (
    await readHandoffs(state.project_root).catch((e) => {
      log.error("context-builder", "handoffs okunamadı (faz-devir bağlamı kayıp — gerçek hata)", { error: String(e) });
      return [];
    })
  ).slice(-6);
  // WTF/gotcha: bilinen tuzaklar — orkestratör dokunmadan önce görsün (bilerek-böyle olanı bozmasın).
  const recentWtf = (
    await readWtf(state.project_root).catch((e) => {
      log.error("context-builder", "WTF/gotcha okunamadı — bilinen-tuzak bağlamı kayıp (bilerek-böyle olanı bozma riski)", { error: String(e) });
      return [];
    })
  ).slice(-6);
  // v15.11: features.md başlık-indeksi (ucuz; full body değil — token bütçesi).
  const featureHeadings = (
    await extractFeatureChunks(state.project_root).catch((e) => {
      log.error("context-builder", "features.md başlık-indeksi okunamadı (gerçek hata)", { error: String(e) });
      return [];
    })
  )
    .map((c) => c.metadata.heading)
    .filter((h): h is string => typeof h === "string");
  // Modül-stoğu (discover): bu stack için stoklu modüller (özet; stack-filtre + limit).
  const availableModules = await listAvailableModules(state.stack).catch(() => []);
  return {
    current_phase: state.current_phase ?? 0,
    iteration_count: state.iteration_count ?? 1,
    intent_summary: state.intent_summary ?? null,
    spec_approved: state.spec_approved ?? false,
    pending_ui_tweak: state.pending_ui_tweak ?? null,
    pending_diagnostic_phase: state.pending_diagnostic?.phase ?? null,
    has_database: state.has_database ?? null,
    skip_ui_phases: state.skip_ui_phases ?? false,
    dev_server_pid: state.dev_server_pid ?? null,
    tdd_compliance_score: state.tdd_compliance_score ?? null,
    recent_audit: recent,
    recent_decisions: recentDecisions,
    recent_handoffs: recentHandoffs,
    recent_wtf: recentWtf,
    project_map: ((): string => {
      const m = peekProjectMap(state.project_root);
      return m ? formatProjectMap(m) : "";
    })(),
    was_pipeline_completed: wasCompleted,
    project_memory: projectMemory,
    general_memory: generalMemory,
    feature_headings: featureHeadings,
    available_modules: availableModules,
  };
}

/**
 * Snapshot → Markdown section. Agent system prompt'una "## CURRENT CONTEXT"
 * olarak append edilir.
 */
export function renderContextSection(ctx: AgentContextSnapshot): string {
  const lines: string[] = ["", "---", "", "## CURRENT CONTEXT (live snapshot)", ""];
  lines.push(`- **current_phase**: ${ctx.current_phase}`);
  lines.push(`- **iteration_count**: ${ctx.iteration_count}`);
  lines.push(`- **was_pipeline_completed**: ${ctx.was_pipeline_completed}`);
  lines.push(`- **spec_approved**: ${ctx.spec_approved}`);
  lines.push(`- **intent_summary**: ${ctx.intent_summary ? `"${ctx.intent_summary.slice(0, 200)}"` : "null"}`);
  lines.push(`- **pending_ui_tweak**: ${ctx.pending_ui_tweak ? `"${ctx.pending_ui_tweak.slice(0, 100)}"` : "null"}`);
  lines.push(`- **pending_diagnostic_phase**: ${ctx.pending_diagnostic_phase ?? "null"}`);
  lines.push(`- **has_database**: ${ctx.has_database === null ? "null" : ctx.has_database}`);
  lines.push(`- **skip_ui_phases**: ${ctx.skip_ui_phases}`);
  lines.push(`- **dev_server_pid**: ${ctx.dev_server_pid ?? "null"}`);
  lines.push(`- **tdd_compliance_score**: ${ctx.tdd_compliance_score ?? "null"}`);
  // v15.11: Mevcut özellikler — orkestratör "X var mı?" diye sormak yerine bilir.
  lines.push("", "### Mevcut özellikler (.mycl/features.md başlıkları)", "");
  if (ctx.feature_headings.length === 0) {
    lines.push("(henüz dökümante edilmiş özellik yok)");
  } else {
    for (const h of ctx.feature_headings) lines.push(`- ${h}`);
    lines.push("", "(detay için .mycl/features.md'yi Read et)");
  }
  // Modül-stoğu (discover): stoklu reuse-edilebilir modüller (bu stack). Orkestratör
  // yeni feature isteğinde bunlardan birini önerebilir (auto-wire YOK — bkz §7.1).
  lines.push("", "### Stoklu modüller (~/.mycl/modules — bu stack)", "");
  if (ctx.available_modules.length === 0) {
    lines.push("(stoklu modül yok)");
  } else {
    for (const m of ctx.available_modules) {
      const db = m.db_tables.length > 0 ? `db: ${m.db_tables.join(",")}` : "db: yok";
      const rt = m.routes.length > 0 ? `route: ${m.routes.join(",")}` : "route: yok";
      lines.push(`- **${m.name}** (${m.fileCount} dosya, ${db}, ${rt})`);
    }
    lines.push("", "(reuse için: ilgili modülü `~/.mycl/modules/<token>/` altından Read et + projeye ADAPTE et)");
  }
  lines.push("", "### Recent audit events (last 30)", "");
  if (ctx.recent_audit.length === 0) {
    lines.push("(no events)");
  } else {
    for (const e of ctx.recent_audit) {
      lines.push(`- phase=${e.phase} event=${e.event} caller=${e.caller}`);
    }
  }
  // v15.8: Son kararlar (ADR) — agent yeni isteğin önceki kararla çelişip
  // çelişmediğini görür ("zaten X'e karar vermiştik").
  lines.push("", "### Recent decisions (ADR, last 3)", "");
  if (ctx.recent_decisions.length === 0) {
    lines.push("(no decisions)");
  } else {
    for (const d of ctx.recent_decisions) {
      const reason = d.reason ? ` — ${d.reason.slice(0, 80)}` : "";
      lines.push(`- Phase ${d.phase} (iter ${d.iteration}): ${d.chosen}${reason}`);
    }
  }
  // ③ (Missions handoff): son faz devirleri — agent son sonuçları (özellikle fail + keşfedilen
  // sorun) görüp HEDEFLİ takip önerebilir ("Faz 8 testsiz AC3 ile fail → o AC için test/fix").
  lines.push("", "### Recent phase handoffs (last 6 — Missions devir)", "");
  if (ctx.recent_handoffs.length === 0) {
    lines.push("(no handoffs)");
  } else {
    for (const h of ctx.recent_handoffs) {
      const disc =
        h.discovered && h.discovered.length > 0
          ? ` | keşfedilen: ${h.discovered.join("; ").slice(0, 120)}`
          : "";
      lines.push(
        `- Faz ${h.phase} (iter ${h.iteration}): ${h.status} — ${h.summary.slice(0, 100)}${disc}`,
      );
    }
  }
  // WTF/gotcha: bilinen tuzaklar — agent BİR ŞEYE DOKUNMADAN ÖNCE okusun ki bilerek-böyle olanı bozmasın.
  lines.push("", "### Bilinen tuzaklar / WTF (dokunmadan önce oku)", "");
  if (ctx.recent_wtf.length === 0) {
    lines.push("(kayıtlı tuzak yok)");
  } else {
    for (const w of ctx.recent_wtf) {
      const loc = w.location ? `[${w.location}] ` : "";
      lines.push(`- ${loc}${w.note.slice(0, 180)}`);
    }
  }
  // Onboarding: yabancı/mevcut projenin merkezi modül haritası (hazırsa) — AI ilk turdan iskeleti bilsin.
  if (ctx.project_map) {
    lines.push("", ctx.project_map);
  }
  // v15.6: Hafıza bölümü — agent karar verirken geçmiş kararları referans alır
  lines.push(
    "",
    "## RELEVANT MEMORY (last 10 project + 5 general)",
    "",
    "### Projeye özel",
  );
  if (ctx.project_memory.length === 0) {
    lines.push("(yok)");
  } else {
    for (const m of ctx.project_memory) {
      const date = new Date(m.ts).toLocaleString("tr-TR", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
      lines.push(
        `- [${date}] topic=\`${m.topic_slug}\` — ${m.summary.slice(0, 200)}`,
      );
      if (m.affected_files && m.affected_files.length > 0) {
        lines.push(`  files: ${m.affected_files.slice(0, 5).join(", ")}`);
      }
    }
  }
  lines.push("", "### Genel", "");
  if (ctx.general_memory.length === 0) {
    lines.push("(yok)");
  } else {
    for (const m of ctx.general_memory) {
      const date = new Date(m.ts).toLocaleString("tr-TR", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
      lines.push(
        `- [${date}] topic=\`${m.topic_slug}\` — ${m.summary.slice(0, 200)}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * v15.7 (2026-05-26): Aktif askq snapshot'ı agent context'ine ekler. Composer
 * mesajı askq açıkken gelirse, agent "bu mesaj askq sorusuna bir cevap mı,
 * yoksa askq dışı bir genel mesaj mı" diye yorumlar.
 *
 * Kullanıcı kuralı: "Composer'dan bişeyler yazılırsa, o soru için değil,
 * daha genel kapsamda bi cevap ya da eleştri yapılıyor demektir. Orkestra
 * ajanı anlamaya çalışır onu. gerekirse soru sorar."
 *
 * Default davranış: askq açık + composer mesajı → `chat` action ile cevapla,
 * askq UI açık kalır, kullanıcı isterse askq'dan da seçim yapabilir.
 */
function renderActiveAskqSection(askq: ActiveAskqSnapshot | null): string {
  if (!askq) return "";
  const lines: string[] = ["", "---", "", "## AKTİF ASKQ (kullanıcı askq UI'da, ama composer'dan yazdı)", ""];
  lines.push(`- **askq_id**: ${askq.id}`);
  lines.push(`- **question** (TR): "${askq.question.slice(0, 300)}"`);
  lines.push("- **options** (TR):");
  for (let i = 0; i < askq.options.length; i++) {
    const opt = askq.options[i];
    const label = typeof opt === "string" ? opt : opt.label;
    lines.push(`  ${i + 1}. "${label}"`);
  }
  lines.push("");
  lines.push(
    "**ÖNEMLİ**: Kullanıcı askq UI yerine composer'dan yazdı — bu mesaj " +
      "askq cevabı DEĞİL, daha genel bir mesaj/eleştri/soru. Sen:",
  );
  lines.push("1. Kullanıcı mesajını yorumla — askq sorusuyla ilgili mi, başka bir şey mi?");
  lines.push("2. İlgiliyse: açıklama ver, gerekirse 1 kısa soru (`ask_clarify`).");
  lines.push("3. İlgisizse / yeni konu: `chat` veya uygun action.");
  lines.push("4. Askq UI'sını CANCEL etme — kullanıcı askq'dan da cevap verebilir.");
  return lines.join("\n");
}

/**
 * Komple agent system prompt — static asset + dinamik context section.
 *
 * v15.7 (2026-05-26): Konuşma bağlamı eklendi (son 3 user mesajı + opsiyonel
 * 5+ mesaj sonrası özet). Orkestratör "her şeyi bilen" rolü gereği önceki
 * konuşmayı görür → bağlam kayması azalır. config zorunlu çünkü özet için
 * translator modeli çağrılır.
 */
export async function buildAgentSystemPrompt(
  state: State,
  config: MyclConfig,
  userMessage?: string,
): Promise<string> {
  const staticPart = await loadStaticSystemPrompt();
  // Doğru-karar/recall: userMessage varsa relevance-tabanlı geri-çağırmayı da paralel
  // çek (ekstra gecikme gizlenir). Boş/triviyal → "" (bölüm eklenmez). Fail-safe.
  const [ctx, conv, relevantRecall, facts] = await Promise.all([
    buildAgentContext(state),
    buildConversationContext(config, state),
    userMessage
      ? buildRelevantOrchestratorContext(config, state, userMessage).catch(() => "")
      : Promise.resolve(""),
    // YZLLM 2026-06-10: beyin (orkestratör) projenin temel gerçeklerini (dil JS/TS, framework) BİLSİN —
    // körüne karar vermesin. "Proje bilgisini cömertçe ver → daha iyi yanıt."
    buildProjectFacts(state.project_root).catch((e) => {
      log.error("context-builder", "proje-gerçekleri (dil/framework/paket) kurulamadı — bağlam EKSİK", { error: String(e) });
      return null;
    }),
  ]);
  const askqSection = renderActiveAskqSection(getActiveAskq());
  const convSection = renderConversationSection(conv);
  const factsSection = facts?.summary ? `\n\n### Proje gerçekleri\n${facts.summary}` : "";
  return `${staticPart}\n${renderContextSection(ctx)}${factsSection}${convSection}${relevantRecall}${askqSection}`;
}
