// relevance/chunk-store — kaynak başına chunk extractor'ları.
//
// Her kaynak (.mycl/{audit.log, spec.md, abandoned-intents.jsonl,
// phase-history-N.jsonl, patterns.md}) için chunk listesi üretir. Mevcut
// helper'lar üzerine kurulu (readAuditLog, extractSpecSection,
// readAbandonedIntents, loadHistory) — fail-fast pattern korunur:
// dosya yoksa boş array, corrupt ise underlying helper throw eder.
//
// Tasarım: chunk text'i ~100-500 char tutulur (LLM batch'inde token bütçesi).
// History için tool_use/tool_result blokları ilk 200 char'a kırpılır.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { readAbandonedIntents } from "../abandoned-intents.js";
import { readAuditLog } from "../audit.js";
import {
  getCommitStats,
  getRecentCommits,
  GitError,
  isGitRepo,
} from "../git.js";
import { loadHistory } from "../history.js";
import { log } from "../logger.js";
import type { Chunk } from "./types.js";

const MYCL_DIR = ".mycl";

/**
 * audit.log → her event 1 chunk. Tipik chunk text:
 *   "Phase 8: tdd-green (mycl-orchestrator) added auth middleware tests"
 */
export async function extractAuditChunks(
  projectRoot: string,
): Promise<Chunk[]> {
  const events = await readAuditLog(projectRoot);
  return events.map((e, i) => {
    const detail = e.detail ? ` ${e.detail.slice(0, 200)}` : "";
    return {
      id: `audit-${e.ts}-${i}`,
      source: "audit" as const,
      text: `Phase ${e.phase}: ${e.event} (${e.caller})${detail}`,
      metadata: {
        ts: e.ts,
        phase: e.phase,
        event: e.event,
        caller: e.caller,
      },
    };
  });
}

/**
 * Pure helper: markdown text'i `## Heading` ile böl. Her section bir chunk;
 * gövde 500 char'a kırpılır. spec/patterns/brief için ortak.
 */
function splitMarkdownByHeading(
  raw: string,
  source: "spec" | "patterns" | "brief" | "features" | "user-guide",
): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = raw.split("\n");
  let curHeading: string | null = null;
  let curBody: string[] = [];

  const flush = () => {
    if (curHeading === null) return;
    const body = curBody.join("\n").trim();
    if (!body) return;
    chunks.push({
      id: `${source}-${curHeading}`,
      source,
      text: `## ${curHeading}\n${body.slice(0, 500)}`,
      metadata: { heading: curHeading },
    });
  };

  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      curHeading = m[1];
      curBody = [];
    } else if (curHeading !== null) {
      curBody.push(line);
    }
  }
  flush();
  return chunks;
}

/**
 * spec.md → ## heading split. Her section bir chunk. Section gövdesi
 * 500 char'a kırpılır (LLM scoring için kafi context).
 *
 * Dosya yoksa boş array (ilk iterasyon). Diğer fs error → throw (caller
 * fail-safe karar verir).
 */
export async function extractSpecChunks(
  projectRoot: string,
): Promise<Chunk[]> {
  const specPath = join(projectRoot, MYCL_DIR, "spec.md");
  let raw: string;
  try {
    raw = await fs.readFile(specPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return splitMarkdownByHeading(raw, "spec");
}

/**
 * abandoned-intents.jsonl → her entry 1 chunk. Text: intent + concerns + reason.
 */
export async function extractAbandonedChunks(
  projectRoot: string,
): Promise<Chunk[]> {
  const entries = await readAbandonedIntents(projectRoot);
  return entries.map((e, i) => {
    const concerns = e.concerns.length > 0 ? e.concerns.join("; ") : "(none)";
    return {
      id: `abandoned-iter${e.iteration}-${e.ts}-${i}`,
      source: "abandoned" as const,
      text: `Intent: ${e.intent.slice(0, 200)}\nConcerns: ${concerns}\nReason: ${e.reason.slice(0, 200)}`,
      metadata: {
        ts: e.ts,
        phase: e.phase,
        iteration: e.iteration,
      },
    };
  });
}

/**
 * phase-history-N.jsonl → her ApiMessage 1 chunk. Tool_use ve tool_result
 * blokları özetlenir (ilk 200 char).
 *
 * Faz id'si zorunlu — history per-phase tutuluyor.
 */
export async function extractHistoryChunks(
  projectRoot: string,
  phase: number,
): Promise<Chunk[]> {
  // history loadHistory PhaseId tipini bekler ama runtime'da number; runtime
  // kontrolü yapmıyoruz, caller doğru phase id veriyor varsayımıyla.
  const messages = await loadHistory(
    projectRoot,
    phase as Parameters<typeof loadHistory>[1],
  );
  return messages.map((msg, i) => {
    const text = summarizeMessageContent(msg.content);
    return {
      id: `history-p${phase}-${i}`,
      source: "history" as const,
      text: `[${msg.role}] ${text.slice(0, 400)}`,
      metadata: { phase },
    };
  });
}

/**
 * brief.md → ## heading split (Phase 3 briefToMarkdown çıktısı: Summary,
 * Tags, Stakeholders, Constraints). Her section bir chunk; spec ile aynı
 * mantık, sadece source farklı.
 */
export async function extractBriefChunks(
  projectRoot: string,
): Promise<Chunk[]> {
  const briefPath = join(projectRoot, MYCL_DIR, "brief.md");
  let raw: string;
  try {
    raw = await fs.readFile(briefPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return splitMarkdownByHeading(raw, "brief");
}

/**
 * v15.11: features.md → ## heading split (her özellik 1 chunk). Yaşayan özellik
 * dökümantasyonu — MyCL projeye dokundukça günceller. Dosya yoksa boş array.
 */
export async function extractFeatureChunks(
  projectRoot: string,
): Promise<Chunk[]> {
  const p = join(projectRoot, MYCL_DIR, "features.md");
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return splitMarkdownByHeading(raw, "features");
}

/**
 * v15.11: user-guide.md → ## heading split (her görev/bölüm 1 chunk). UI kullanma
 * kılavuzu. Dosya yoksa boş array.
 */
export async function extractUserGuideChunks(
  projectRoot: string,
): Promise<Chunk[]> {
  const p = join(projectRoot, MYCL_DIR, "user-guide.md");
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return splitMarkdownByHeading(raw, "user-guide");
}

/**
 * Git history → her commit 1 chunk. text: kısa sha + subject + dosya özeti
 * + insert/delete stats. metadata.ts (commit timestamp), metadata.heading
 * (kısa sha, debug için).
 *
 * Proje git repo'su değilse boş array (relevance opsiyonel context). Git
 * komut error'larında throw — caller engine yakalar + emitError + degrade.
 */
export async function extractGitChunks(
  projectRoot: string,
  limit: number = 30,
): Promise<Chunk[]> {
  let inRepo: boolean;
  try {
    inRepo = await isGitRepo(projectRoot);
  } catch (err) {
    // GitError (örn. git binary yok) — caller karar verir; log + yeniden throw.
    log.warn("relevance/chunk-store", "isGitRepo failed", err);
    throw err;
  }
  if (!inRepo) return [];

  const commits = await getRecentCommits(projectRoot, limit);
  // Her commit için stats — paralel; bir tanesi fail ederse Promise.all throw.
  const statsList = await Promise.all(
    commits.map((c) =>
      getCommitStats(projectRoot, c.sha).catch((err) => {
        // Tek commit stats fail olursa o commit'i atla (degrade), tüm chunk
        // listesi patlamasın. Diğer git error'lar isGitRepo'da yakalanıyor.
        if (err instanceof GitError) return null;
        throw err;
      }),
    ),
  );

  return commits.map((c, i) => {
    const stats = statsList[i];
    const shortSha = c.sha.slice(0, 7);
    const filesLine = stats
      ? `Files: ${stats.files.slice(0, 5).join(", ")} (+${stats.insertions}/-${stats.deletions})`
      : "Files: (stats unavailable)";
    return {
      id: `git-${shortSha}`,
      source: "git" as const,
      text: `${shortSha} ${c.subject}\n${filesLine}`,
      metadata: {
        ts: c.ts,
        heading: shortSha,
      },
    };
  });
}

/**
 * patterns.md → ## heading split. Spec/brief ile aynı mantık.
 */
export async function extractPatternsChunks(
  projectRoot: string,
): Promise<Chunk[]> {
  const patternsPath = join(projectRoot, MYCL_DIR, "patterns.md");
  let raw: string;
  try {
    raw = await fs.readFile(patternsPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return splitMarkdownByHeading(raw, "patterns");
}

/**
 * ApiMessage content'i tek bir string'e indirger. content string ise direkt
 * dön; array ise her bloğu (text, tool_use, tool_result) özetle birleştir.
 */
function summarizeMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: string; text?: string; name?: string; input?: unknown; content?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use") {
      const inputStr = JSON.stringify(b.input ?? {}).slice(0, 200);
      parts.push(`<tool_use:${b.name ?? "?"}> ${inputStr}`);
    } else if (b.type === "tool_result") {
      const resultStr =
        typeof b.content === "string"
          ? b.content.slice(0, 200)
          : JSON.stringify(b.content ?? "").slice(0, 200);
      parts.push(`<tool_result> ${resultStr}`);
    }
  }
  return parts.join(" | ");
}
