// design-fanout.ts — Faz 5 çok-perspektifli tasarım paneli (MyCL-native DETERMİNİSTİK fan-out).
//
// architect/ux/security/data PARALEL (read-only akıl yürütme) → synthesizer → .mycl/design.md.
// İKİ MOD (backendForRole "main"): API = Anthropic messages.create; abonelik = runClaudeCli.
// Per-rol model = subagentModelId. Sentezleyici çıktısı text-JSON ({kind:"design_plan"}) →
// extractKindBlock (iki modda da uniform; forced-tool/CLI asimetrisi yok).
//
// DETERMİNİZM: roster (4 sabit perspektif + 1 sentez), rol promptları (assets/templates/design-*.md),
// modeller (config-driven) ve çıktı şeması MyCL-authored; alt-ajanlar BİRBİRİYLE KONUŞMAZ (saf fan-out).
// Çatışma (conflicts[]) çıkarsa Agent Team müzakeresi AYRI bir katman (Layer B) — bu modül onu
// tetiklemez, yalnız conflicts'i döndürür. Herhangi perspektif düşerse kalanla devam; <2 perspektif
// veya sentez başarısız → ok:false + görünür reason → caller (phase-5) tek-ajana DÜŞER (sessiz değil).

import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  backendForRole,
  subagentModelId,
  type MyclConfig,
  type SubagentRole,
} from "./config.js";
import { runClaudeCli } from "./cli-run.js";
import { SUBAGENT_SPAWN_TOOLS } from "./tool-policy.js";
import { extractKindBlock } from "./cli-json.js";
import { templatePath } from "./phase-registry.js";
import { log } from "./logger.js";
import { emitAgentEvent } from "./ipc.js";
import { traceAgentEvent } from "./agent-trace.js";

interface PerspectiveDef {
  role: SubagentRole;
  template: string;
  label: string;
}

// Sabit roster — MyCL-authored, ajan değiştiremez (determinizm).
const PERSPECTIVES: readonly PerspectiveDef[] = [
  { role: "architect", template: "design-architect.md", label: "Mimari" },
  { role: "ux", template: "design-ux.md", label: "UX" },
  { role: "security", template: "design-security.md", label: "Güvenlik" },
  { role: "data", template: "design-data.md", label: "Veri" },
];

const PERSPECTIVE_MAX_TOKENS = 2500;
const SYNTH_MAX_TOKENS = 4000;
const PERSPECTIVE_TIMEOUT_MS = 150_000;

export interface DesignConflict {
  topic: string;
  between: string;
  summary: string;
}

export interface DesignPlanResult {
  ok: boolean;
  designMarkdown?: string;
  conflicts: DesignConflict[];
  /** kaç perspektif başarılı oldu (gözlem/log) */
  perspectivesUsed?: number;
  /** başarısızlıkta görünür neden — caller tek-ajana düşer + bunu kullanıcıya bildirir */
  reason?: string;
}

/**
 * Tek read-only akıl-yürütme turu. backend "cli" → runClaudeCli (abonelik); "api" →
 * Anthropic messages.create (generateSummary deseni). Düz metin döner.
 */
export async function runReasoningTurn(
  config: MyclConfig,
  systemPrompt: string,
  userMessage: string,
  role: SubagentRole,
  maxTokens: number,
  projectRoot: string,
): Promise<string> {
  const model = subagentModelId(config.selected_models, role);
  const backend = backendForRole(config, "main");
  if (backend === "cli") {
    const res = await runClaudeCli({
      systemPrompt,
      userMessage,
      modelId: model,
      cwd: projectRoot, // sandbox projeye hapsolur; read-only akıl yürütme
      // Saf akıl yürütme — spec userMessage'da verilir. Yazma KESİN engellenir.
      disallowedTools: [...SUBAGENT_SPAWN_TOOLS, "Write", "Edit", "Bash(rm *)", "Bash(git push *)"], // salt-okunur akıl-yürütme: alt-ajan + yazma + yıkıcı Bash yasak
      timeoutMs: PERSPECTIVE_TIMEOUT_MS,
    });
    if (!res.ok) throw new Error(res.error ?? "cli reasoning failed");
    return res.text.trim();
  }
  // API (backend "api"; "auto" da limitliyken backendForRole bunu "api"ye çözer)
  const client = new Anthropic({ apiKey: config.api_keys.main });
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  return response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

/** conflicts[] alanını tip-güvenli ayıkla (bozuk/eksik alanları atla). SAF — test edilebilir. */
export function parseConflicts(raw: unknown): DesignConflict[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignConflict[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const topic = typeof o.topic === "string" ? o.topic.trim() : "";
    if (!topic) continue;
    out.push({
      topic,
      between: typeof o.between === "string" ? o.between : "",
      summary: typeof o.summary === "string" ? o.summary : "",
    });
  }
  return out;
}

/** synthesizer ham metninden design_plan bloğunu çıkar + design.md içeriği + conflicts döndür. SAF. */
export function parseDesignPlan(
  synthText: string,
): { designMarkdown: string; conflicts: DesignConflict[] } | null {
  const block = extractKindBlock(synthText, ["design_plan"]);
  if (!block) return null;
  const designMarkdown =
    typeof block.design_markdown === "string" ? block.design_markdown.trim() : "";
  if (!designMarkdown) return null;
  return { designMarkdown, conflicts: parseConflicts(block.conflicts) };
}

/**
 * Faz 5 tasarım fan-out'unu koşar. specContent = .mycl/spec.md içeriği (caller okur/verir).
 * Başarıda .mycl/design.md yazılır + {ok:true, designMarkdown, conflicts}. Başarısızlıkta
 * {ok:false, reason} → caller tek-ajan codegen'e düşer (görünür).
 */
export async function runDesignFanout(
  config: MyclConfig,
  projectRoot: string,
  specContent: string,
): Promise<DesignPlanResult> {
  // Perspektif template'lerini yükle (MyCL-authored, assets/templates/design-*.md).
  let perspectiveTemplates: string[];
  try {
    perspectiveTemplates = await Promise.all(
      PERSPECTIVES.map((p) => readFile(templatePath(p.template), "utf-8")),
    );
  } catch (err) {
    return { ok: false, conflicts: [], reason: `tasarım template yüklenemedi: ${String(err)}` };
  }

  const userMsg = `Project spec:\n\n${specContent}`;

  // 4 perspektif PARALEL. Biri düşerse kalanla devam (allSettled).
  const settled = await Promise.allSettled(
    PERSPECTIVES.map(async (p, i) => {
      // Agent Teams görünürlüğü: her perspektif-ajanı başla/bit yayını → UI "hangi ajan çalışıyor"ı gösterir.
      emitAgentEvent({ sub: "started", agent_label: p.label });
      try {
        return await runReasoningTurn(
          config,
          perspectiveTemplates[i],
          userMsg,
          p.role,
          PERSPECTIVE_MAX_TOKENS,
          projectRoot,
        );
      } finally {
        emitAgentEvent({ sub: "completed", agent_label: p.label });
      }
    }),
  );
  const perspectives: Array<{ label: string; text: string }> = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      perspectives.push({ label: PERSPECTIVES[i].label, text: r.value });
    } else {
      const reason = r.status === "rejected" ? String(r.reason) : "boş çıktı";
      log.warn("design-fanout", "perspektif başarısız", { role: PERSPECTIVES[i].role, reason });
    }
  });
  if (perspectives.length < 2) {
    return {
      ok: false,
      conflicts: [],
      perspectivesUsed: perspectives.length,
      reason: `tasarım paneli: 4 perspektiften yalnız ${perspectives.length} başarılı — sentez anlamsız`,
    };
  }

  // Sentezleyici — perspektifleri TEK tasarım planına indirger (design_plan JSON + conflicts).
  let synthTemplate: string;
  try {
    synthTemplate = await readFile(templatePath("design-synthesizer.md"), "utf-8");
  } catch (err) {
    return { ok: false, conflicts: [], reason: `synthesizer template yüklenemedi: ${String(err)}` };
  }
  const synthUser =
    `Project spec:\n\n${specContent}\n\n---\nPerspectives:\n\n` +
    perspectives.map((p) => `## ${p.label} perspective\n${p.text}`).join("\n\n");

  let synthText: string;
  try {
    synthText = await runReasoningTurn(config, synthTemplate, synthUser, "synthesizer", SYNTH_MAX_TOKENS, projectRoot);
  } catch (err) {
    return { ok: false, conflicts: [], reason: `sentez başarısız: ${String(err)}` };
  }

  const parsed = parseDesignPlan(synthText);
  if (!parsed) {
    return { ok: false, conflicts: [], reason: "synthesizer geçerli design_plan bloğu döndürmedi" };
  }

  // .mycl/design.md yaz (tek doğruluk kaynağı; codegen bunu okur).
  try {
    await mkdir(join(projectRoot, ".mycl"), { recursive: true });
    await writeFile(join(projectRoot, ".mycl", "design.md"), parsed.designMarkdown + "\n", "utf-8");
  } catch (err) {
    return { ok: false, conflicts: parsed.conflicts, reason: `design.md yazılamadı: ${String(err)}` };
  }

  return {
    ok: true,
    designMarkdown: parsed.designMarkdown,
    conflicts: parsed.conflicts,
    perspectivesUsed: perspectives.length,
  };
}

// ───────────────── Layer B: çatışma → gerçek Agent Teams peer-müzakere ─────────────────
// runDesignFanout conflicts[] döndürdüyse + agent_teams_optin açıksa: abonelik (CLI) modunda
// GERÇEK Agent Team (CLAUDE_CODE_WORKFLOWS + CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env, extraEnv ile)
// çelişen-rol savunucularını peer-müzakereyle uzlaştırır → güncellenmiş design.md. API modunda
// (gerçek Agent Teams yok) MyCL-simüle cross-critique turu (aynı template, tek-tur muhakeme). İkisi de
// görünür (sessiz değil); başarısızsa synthesizer'ın provizyon kararı kalır (Faz A davranışı).

const NEGOTIATE_TIMEOUT_MS = 300_000; // takım müzakeresi uzun sürebilir (idle-bazlı)

export interface NegotiateResult {
  ok: boolean;
  designMarkdown?: string;
  mode: "team" | "cross-critique";
  reason?: string;
}

export function conflictsToText(conflicts: DesignConflict[]): string {
  return conflicts
    .map((c, i) => `${i + 1}. [${c.between || "?"}] ${c.topic}: ${c.summary}`)
    .join("\n");
}

export async function negotiateConflicts(
  config: MyclConfig,
  projectRoot: string,
  designMarkdown: string,
  conflicts: DesignConflict[],
): Promise<NegotiateResult> {
  const backend = backendForRole(config, "main");
  const mode: NegotiateResult["mode"] = backend === "cli" ? "team" : "cross-critique";
  if (conflicts.length === 0) return { ok: false, mode, reason: "çatışma yok" };

  let template: string;
  try {
    template = await readFile(templatePath("design-negotiate.md"), "utf-8");
  } catch (err) {
    return { ok: false, mode, reason: `negotiate template yüklenemedi: ${String(err)}` };
  }
  const userMsg =
    `Current design plan:\n\n${designMarkdown}\n\n---\nUnresolved conflicts to resolve:\n${conflictsToText(conflicts)}`;
  const synthModel = subagentModelId(config.selected_models, "synthesizer");

  let text: string;
  if (backend === "cli") {
    // GERÇEK Agent Teams (abonelik): lead, çelişen-rol savunucularından kısa-ömürlü takım kurar
    // (env flag'leri extraEnv ile), peer müzakereyle uzlaşır, güncellenmiş design_plan döner.
    const res = await runClaudeCli({
      systemPrompt: template,
      userMessage: userMsg,
      modelId: synthModel,
      cwd: projectRoot,
      disallowedTools: [...SUBAGENT_SPAWN_TOOLS, "Write", "Edit", "Bash(rm *)", "Bash(git push *)"], // salt-okunur akıl-yürütme: alt-ajan + yazma + yıkıcı Bash yasak
      extraEnv: { CLAUDE_CODE_WORKFLOWS: "1", CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" },
      timeoutMs: NEGOTIATE_TIMEOUT_MS,
    });
    if (!res.ok) return { ok: false, mode, reason: res.error ?? "takım müzakeresi başarısız" };
    text = res.text.trim();
    // Tam iz: gerçek Agent Teams peer-müzakeresi (kör nokta kalmasın) — çelişki sayısı + uzlaşı çıktısı.
    void traceAgentEvent({
      ts: Date.now(),
      agent_label: "Agent Teams müzakere",
      sub: "output",
      text: `conflicts=${conflicts.length} → ${text.slice(0, 1500)}`,
    });
  } else {
    // API (gerçek Agent Teams YOK): MyCL-simüle cross-critique — synthesizer çelişkileri tek-tur
    // muhakemeyle (her iki tarafı steel-man) çözer. Aynı template; "teams yoksa kendin akıl yürüt" der.
    const client = new Anthropic({ apiKey: config.api_keys.main });
    const response = await client.messages.create({
      model: synthModel,
      max_tokens: SYNTH_MAX_TOKENS,
      system: template,
      messages: [{ role: "user", content: userMsg }],
    });
    text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();
  }

  const parsed = parseDesignPlan(text);
  if (!parsed) return { ok: false, mode, reason: "müzakere geçerli design_plan döndürmedi" };
  try {
    await writeFile(join(projectRoot, ".mycl", "design.md"), parsed.designMarkdown + "\n", "utf-8");
  } catch (err) {
    return { ok: false, mode, reason: `design.md güncellenemedi: ${String(err)}` };
  }
  return { ok: true, designMarkdown: parsed.designMarkdown, mode };
}

// ───────────────── Faz 0 (FIX): çok-perspektifli kök-neden hipotez fan-out ─────────────────
// Debug'da tek ajan tek-ize takılabilir. D1 araştırmasından ÖNCE, toplanan DETERMİNİSTİK kanıt
// (errors.db + git blame + dep-graph + probe) üzerine 3 farklı mercekten (state/async/integration)
// PARALEL hipotez üretilir (saf-akıl-yürütme, Bash YOK → tasarım paneliyle aynı doğrulanabilir
// mekanizma). Bu adaylar D1'in user message'ına enjekte edilir; D1 araştırarak doğrular/çürütür
// (tünel-görüşünü önler). Tam paralel-İNCELEME (gerçek Workflow tool, Bash'li) ileride.

export const HYPOTHESIS_ANGLES: ReadonlyArray<{ key: string; angle: string }> = [
  {
    key: "state-data",
    angle:
      "state management & data flow (stale/incorrect state, missing update, wrong data shape, mutation)",
  },
  {
    key: "async-timing",
    angle:
      "async / timing / lifecycle (await ordering, race conditions, effect dependencies, premature render)",
  },
  {
    key: "integration-contract",
    angle:
      "integration & contract (API/DB contract mismatch, types, config/env, boundary/null errors)",
  },
];
const HYPOTHESIS_MAX_TOKENS = 1200;

function hypothesisSystemPrompt(angle: string): string {
  return (
    "You are a debugging hypothesis agent. READ-ONLY: reason ONLY on the provided bug report + evidence; " +
    "do not investigate or run anything.\n" +
    `Your lens: ${angle}.\n` +
    "Propose the SINGLE most likely root-cause hypothesis FROM YOUR LENS, citing the specific evidence that " +
    "supports it (name files / functions / values from the evidence). If your lens clearly does NOT fit this " +
    'bug, say so in one line ("Not a <lens> issue: <why>"). Be concrete and specific to THIS bug; 2-4 sentences. ' +
    "Your hypothesis feeds a follow-up investigation that will confirm or refute it."
  );
}

/**
 * Faz 0 D1 ÖNCESİ hipotez fan-out. Bug + kanıt üzerine 3 mercek paralel → aday kök-neden
 * hipotezleri (etiketli metin dizisi). Backend-dispatch + per-rol model (hypothesis→balanced)
 * runReasoningTurn ile (design fan-out ile aynı). Başarısız mercek atlanır; caller <2 ise atlar.
 */
export async function runHypothesisFanout(
  config: MyclConfig,
  projectRoot: string,
  bugReport: string,
  evidence: string,
): Promise<string[]> {
  const userMsg =
    `Bug report:\n${bugReport}\n\n---\nDeterministic evidence (error catalog, git blame, dependency graph, UI probe):\n` +
    (evidence && evidence.trim() ? evidence : "(none gathered)");
  const settled = await Promise.allSettled(
    HYPOTHESIS_ANGLES.map((h) =>
      runReasoningTurn(
        config,
        hypothesisSystemPrompt(h.angle),
        userMsg,
        "hypothesis",
        HYPOTHESIS_MAX_TOKENS,
        projectRoot,
      ),
    ),
  );
  const out: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      out.push(`[${HYPOTHESIS_ANGLES[i].key}] ${r.value}`);
    } else {
      const reason = r.status === "rejected" ? String(r.reason) : "boş çıktı";
      log.warn("hypothesis-fanout", "hipotez başarısız", { angle: HYPOTHESIS_ANGLES[i].key, reason });
    }
  });
  return out;
}
