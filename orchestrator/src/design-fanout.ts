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
import { extractKindBlock } from "./cli-json.js";
import { templatePath } from "./phase-registry.js";
import { log } from "./logger.js";

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
async function runReasoningTurn(
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
      disallowedTools: ["Write", "Edit", "Bash(rm *)", "Bash(git push *)"],
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
    PERSPECTIVES.map((p, i) =>
      runReasoningTurn(config, perspectiveTemplates[i], userMsg, p.role, PERSPECTIVE_MAX_TOKENS, projectRoot),
    ),
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
