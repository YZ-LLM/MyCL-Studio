// module-parallel/review — birleşik paralel çıktıya ANLAMSAL / business-logic code review.
//
// Mekanik kapılar (Faz 10-17) mekaniği denetler (lint/test/perf/güvenlik) ama "bütün hâlinde anlamlı mı, business
// logic doğru mu, paralel bölmenin kaçırdığı gizli kuplaj var mı?" sorusunu yanıtlamaz. Bağımsız ajanlar birbirini
// GÖRMEDEN yazdığı için birleşik sonuç holistik incelenmeli. Bulguları YÜZEYE çıkarır (hard-block değil — mekanik
// kapılar zaten sert durak; bu, anlamsal emniyet ağı). LLM review başarısızsa bloklamaz (gates yine koşar).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runClaudeCli } from "../cli-run.js";
import { extractKindBlock } from "../cli-json.js";
import type { MyclConfig } from "../config.js";
import { selectModelForTask } from "../model-catalog.js";

const REVIEW_SYSTEM = [
  "You review code written by MULTIPLE INDEPENDENT agents IN PARALLEL, then merged. Each agent saw ONLY its own",
  "module. Judge the INTEGRATED result AS A WHOLE:",
  "(1) business-logic correctness, (2) cross-module coherence (do the modules fit together sensibly?),",
  "(3) hidden coupling the parallel split may have missed (a module's behavior secretly depending on another).",
  "Do NOT nitpick style/formatting/tests — lint and tests cover those. Focus on SEMANTIC / business issues only.",
  'Output ONLY JSON, nothing else: {"kind":"review","ok":true,"issues":[{"file":"path","severity":"high|med|low","note":"..."}]}',
  "ok:true + empty issues = coherent. Be honest; if unsure, add a low-severity note. Do NOT use any tools.",
].join("\n");

const MAX_FILES = 20;
const MAX_PER_FILE = 4000;

export interface ReviewIssue {
  file: string;
  severity: "high" | "med" | "low";
  note: string;
}
export interface ReviewResult {
  ok: boolean;
  issues: ReviewIssue[];
}

/** LLM review yanıtını ayıklar (SAF). Geçersiz → {ok:true, issues:[]} (review bloklamaz). */
export function parseReviewResponse(text: string): ReviewResult {
  const block = extractKindBlock(text, ["review"]);
  if (!block) return { ok: true, issues: [] };
  const rawIssues = Array.isArray(block.issues) ? block.issues : [];
  const issues: ReviewIssue[] = [];
  for (const item of rawIssues) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (typeof m.file === "string" && typeof m.note === "string") {
      const sev = m.severity === "high" || m.severity === "med" || m.severity === "low" ? m.severity : "low";
      issues.push({ file: m.file, severity: sev, note: m.note });
    }
  }
  return { ok: block.ok !== false, issues };
}

/**
 * Birleşik modül dosyalarını okuyup holistik anlamsal review yapar. Dosya yoksa / review başarısızsa
 * {ok:true, issues:[]} (bloklamaz — mekanik kapılar sert durak). SALT-OKUNUR (kod yazmaz).
 */
export async function reviewMergedModules(
  config: MyclConfig,
  projectRoot: string,
  files: string[],
): Promise<ReviewResult> {
  const parts: string[] = [];
  for (const f of files.slice(0, MAX_FILES)) {
    try {
      const content = await readFile(join(projectRoot, f), "utf-8");
      parts.push(`### ${f}\n\`\`\`\n${content.slice(0, MAX_PER_FILE)}\n\`\`\``);
    } catch {
      // dosya okunamadı → atla
    }
  }
  if (parts.length === 0) return { ok: true, issues: [] };
  const res = await runClaudeCli({
    systemPrompt: REVIEW_SYSTEM,
    userMessage: `Review these merged, parallel-written modules as a whole:\n\n${parts.join("\n\n")}`,
    modelId: selectModelForTask("review", config.selected_models.model_tiers).modelId, // kalite-kritik → strong
    cwd: projectRoot,
    allowedTools: [],
  });
  if (!res.ok) return { ok: true, issues: [] };
  return parseReviewResponse(res.text);
}

/** Kullanıcıya yazılacak özet (Türkçe). */
export function formatReview(r: ReviewResult): string {
  if (r.issues.length === 0) {
    return "🔎 Anlamsal review: birleşik çıktı tutarlı görünüyor (business-logic + modüller-arası uyum).";
  }
  const order = { high: 0, med: 1, low: 2 } as const;
  const lines = [...r.issues]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((i) => `  • [${i.severity}] ${i.file}: ${i.note}`);
  return ["🔎 Anlamsal review — dikkat edilmesi gerekenler:", ...lines].join("\n");
}
