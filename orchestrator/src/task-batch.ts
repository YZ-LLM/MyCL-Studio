// task-batch — ⚡ Paralel iş kümeleme: kuyruktaki BAĞIMSIZ işlerin kod yazması paralel worktree'lerde.
//
// Neden (YZLLM 2026-07-16, "orta yol" KULLANICI KARARI): birden çok iş varken hız için farklı
// worktree'lerde çalışılsın, biten ana ağaca birleştirilsin — AMA hiçbir MyCL kuralı atlanmasın.
// Tasarım: bağımsız işlerin YALNIZ KOD YAZMA kısmı paralel (kanıtlanmış module-parallel motoru:
// worktree + ayrık kapsam + kapsam-kontrollü kopya birleştirme); birleştirme sonrası TÜM kalite
// fazları (9→17, Faz 6 dahil) birleşik sonuçta TEK SEFER, EKSİKSİZ koşar (multi_agent_selection
// emsali). Tam bağımsız pipeline'lar REDDEDİLDİ (12 teklik çatışma noktası).
//
// FAIL-CLOSED her kenarda: bayrak kapalı / <2 iş / LLM bölemedi / kapsamlar ayrık değil / git yok /
// ağaç kirli / worker-birleştirme hatası → SIRALI akış (hiçbir iş kaybolmaz). LLM önerir, KOD karar
// verir (shouldParallelize deterministik kapısı — decompose.ts deseni).

import { runReasoning } from "./llm-reasoning.js";
import { selectModelForTask } from "./model-catalog.js";
import { extractKindBlock } from "./cli-json.js";
import { shouldParallelize } from "./module-parallel/independence.js";
import type { ModuleWork } from "./module-parallel/dispatch.js";
import type { MyclConfig } from "./config.js";
import type { TaskQueueItem } from "./task-queue/types.js";

/** Bir kümedeki iş adayı: kuyruk işi + LLM'in öngördüğü ayrık yazma kapsamı. */
export interface BatchCandidate {
  task: TaskQueueItem;
  scope_paths: string[];
}

/** v1 küme tavanı — makine yükü + abonelik limiti doğal sınırı (bekleyen bağımsız iş genelde 2-3). */
export const MAX_BATCH = 3;

const JUDGE_SYSTEM = [
  "You are a PLANNING assistant. Your ONLY job: decide which of the given work-queue tasks are",
  "GENUINELY INDEPENDENT and can be coded in parallel without touching the same files.",
  "You MUST NOT write code, create files, run commands, or use ANY tools. Output a PLAN only.",
  "For each task you judge parallel-safe, predict its DISJOINT write scope_paths (relative path",
  "prefixes it will create/modify; NO two parallel tasks may share any path or parent dir).",
  "If tasks are coupled (same feature/files/layer), unsure, or scopes would overlap: put FEWER",
  "tasks in parallel — leaving all serial is an acceptable answer.",
  "Respond with EXACTLY ONE JSON object and NOTHING ELSE — no prose, no code fences:",
  '{"kind":"task_batch","parallel":[{"task_index":0,"scope_paths":["src/x/"]}]}',
  "task_index refers to the numbered task list you are given (0-based).",
].join("\n");

/**
 * SAF: hakem yanıtını parse + DETERMİNİSTİK kapıdan geçir. Geçersiz index / boş kapsam /
 * <2 aday / kapsam çakışması → null (SIRALI; fail-closed). LLM över, kapıyı kod geçer.
 */
export function parseBatchResponse(raw: string, tasks: readonly TaskQueueItem[]): BatchCandidate[] | null {
  const block = extractKindBlock(raw, ["task_batch"]) as { parallel?: unknown } | null;
  if (!block || !Array.isArray(block.parallel)) return null;
  const seen = new Set<number>();
  const candidates: BatchCandidate[] = [];
  for (const item of block.parallel) {
    const rec = item as { task_index?: unknown; scope_paths?: unknown };
    if (
      typeof rec.task_index !== "number" ||
      !Number.isInteger(rec.task_index) ||
      rec.task_index < 0 ||
      rec.task_index >= tasks.length ||
      seen.has(rec.task_index)
    ) {
      return null; // bozuk/çift index → tüm öneri güvenilmez (fail-closed)
    }
    if (!Array.isArray(rec.scope_paths) || rec.scope_paths.length === 0 || !rec.scope_paths.every((p) => typeof p === "string" && p.trim())) {
      return null;
    }
    seen.add(rec.task_index);
    candidates.push({ task: tasks[rec.task_index]!, scope_paths: (rec.scope_paths as string[]).map((p) => p.trim()) });
  }
  if (candidates.length < 2) return null;
  const gate = shouldParallelize(
    candidates.map((c) => ({ id: c.task.id, scope_paths: c.scope_paths })),
    { enabled: true },
  );
  return gate.parallel ? candidates : null;
}

/**
 * LLM bağımsızlık hakemi: bekleyen işlerden paralel-güvenli alt kümeyi + ayrık kapsamları öner.
 * Hata/bölememe → null (SIRALI). Backend-aware (api/cli — runReasoning).
 */
export async function judgeBatch(
  config: MyclConfig,
  tasks: readonly TaskQueueItem[],
  projectRoot: string,
): Promise<BatchCandidate[] | null> {
  if (tasks.length < 2) return null;
  const list = tasks.map((t, i) => `${i}. ${t.text}`).join("\n");
  const res = await runReasoning(config, {
    systemPrompt: JUDGE_SYSTEM,
    userMessage: `Plan only — do NOT implement. Which of these queued tasks can be coded in parallel?\n\n${list}`,
    modelId: selectModelForTask("orchestration", config.selected_models.model_tiers).modelId,
    projectRoot,
  });
  if (!res.ok) return null;
  return parseBatchResponse(res.text, tasks);
}

/** SAF: küme adaylarını module-parallel motorunun ModuleWork girdisine çevir (modül id = iş id). */
export function candidatesToModules(candidates: readonly BatchCandidate[]): ModuleWork[] {
  return candidates.map((c) => ({
    id: c.task.id,
    scope_paths: c.scope_paths,
    brief: c.task.text,
  }));
}
