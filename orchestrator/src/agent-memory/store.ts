// agent-memory/store — append/read helpers.
//
// Pattern: abandoned-intents.ts'in birebir taklit. Atomic POSIX O_APPEND +
// fsync (lock yok, line-level atomicity PIPE_BUF garantisi ile).

import { promises as fs } from "node:fs";
import { open as openSync } from "node:fs/promises";
import { dirname, join } from "node:path";
import { globalConfigFile } from "../paths.js";
import { log } from "../logger.js";
import { enrichRecord } from "../record-context.js";
import {
  AgentMemoryError,
  type AgentMemoryEntry,
  type AgentDecisionLogEntry,
} from "./types.js";

/**
 * v15.6 (2026-05-24): Genel hafıza cross-project (`~/.mycl/agent-memory-
 * general.jsonl`). Bir projede yanlışlıkla credential / API key kaydedilirse
 * başka projelerde sızıntı olur. Bu regex'ler suspicious pattern yakalar,
 * log.warn'a düşer — BLOCK ETMEZ (advisory). İleride otomatik sanitize için
 * hazırlık.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "anthropic/openai-key", re: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: "api-key-assignment", re: /api[_-]?key[\s:=]+["']?[A-Za-z0-9_\-]{16,}/i },
  { name: "password-assignment", re: /password[\s:=]+["']?[^\s"']{6,}/i },
  { name: "bearer-token", re: /bearer\s+[A-Za-z0-9._-]{20,}/i },
];

function scanForCredentials(entry: AgentMemoryEntry): string[] {
  const haystack = JSON.stringify(entry);
  const hits: string[] = [];
  for (const { name, re } of CREDENTIAL_PATTERNS) {
    if (re.test(haystack)) hits.push(name);
  }
  return hits;
}

const MYCL_DIR = ".mycl";
const PROJECT_MEMORY_FILE = "agent-memory.jsonl";
const PROJECT_DECISIONS_FILE = "agent-decisions.jsonl";
const GENERAL_MEMORY_FILE = "agent-memory-general.jsonl";

function projectMemoryPath(projectRoot: string): string {
  return join(projectRoot, MYCL_DIR, PROJECT_MEMORY_FILE);
}

function projectDecisionsPath(projectRoot: string): string {
  return join(projectRoot, MYCL_DIR, PROJECT_DECISIONS_FILE);
}

function generalMemoryPath(): string {
  // v15.8 (2026-05-30): Platform-aware global config dir (paths.ts).
  return globalConfigFile(GENERAL_MEMORY_FILE);
}

async function appendJsonl<T extends object>(
  path: string,
  entry: T,
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // v15.6: metadata enrichment — dataset/replay için sabit anchor alanları
  // (_session, _iter, _phase, _schema_v, _record_ts).
  const enriched = enrichRecord(entry, 1);
  const line = JSON.stringify(enriched) + "\n";
  const fh = await openSync(path, "a");
  try {
    await fh.write(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function readJsonl<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AgentMemoryError(`read failed: ${path} — ${String(err)}`);
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const entries: T[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as T);
    } catch (err) {
      throw new AgentMemoryError(
        `bad line in ${path}: ${line.slice(0, 100)} (${String(err)})`,
      );
    }
  }
  return entries;
}

// ─── Project memory ─────────────────────────────────────────────────────

export async function appendProjectMemory(
  projectRoot: string,
  entry: AgentMemoryEntry,
): Promise<void> {
  await appendJsonl(projectMemoryPath(projectRoot), entry);
}

export async function readProjectMemory(
  projectRoot: string,
  limit?: number,
): Promise<AgentMemoryEntry[]> {
  const all = await readJsonl<AgentMemoryEntry>(projectMemoryPath(projectRoot));
  if (limit === undefined) return all;
  return all.slice(-limit);
}

// ─── General memory ─────────────────────────────────────────────────────

export async function appendGeneralMemory(entry: AgentMemoryEntry): Promise<void> {
  // v15.6: cross-project sızıntı koruması — credential pattern uyarısı
  // (BLOCK ETMEZ, sadece log.warn). Genel hafıza tüm projelerde okunur.
  const hits = scanForCredentials(entry);
  if (hits.length > 0) {
    log.warn(
      "agent-memory",
      "general memory write looks credential-shaped (cross-project leak risk)",
      { topic_slug: entry.topic_slug, matched: hits },
    );
  }
  await appendJsonl(generalMemoryPath(), entry);
}

/**
 * v15.7 (2026-05-26): Stack-aware filter. `currentStack` verilirse cross-project
 * leak koruması devreye girer:
 *   - scope="universal" entry → her zaman dahil
 *   - scope="stack-specific" + tech_stack === currentStack → dahil
 *   - scope="stack-specific" + tech_stack !== currentStack → SKIP (leak engellenir)
 *   - scope field'ı YOK (eski kayıt) → defansif default: "stack-specific" varsay,
 *     tech_stack yok kabul edip currentStack ile karşılaştır — uyumsuzsa skip.
 *     Backfill mantığı: eski kayıtlar genelde yazıldığı projenin stack'ine
 *     özel. Yanlış pozitif (skip) tercih edilir, yanlış negatif (leak) değil.
 *
 * `currentStack` undefined ise (state.stack bilinmiyor): tüm entry'ler döner
 * (geriye-uyumlu davranış; eski caller'lar etkilenmez).
 */
export async function readGeneralMemory(
  limit?: number,
  currentStack?: string,
): Promise<AgentMemoryEntry[]> {
  const all = await readJsonl<AgentMemoryEntry>(generalMemoryPath());
  let filtered = all;
  if (currentStack !== undefined) {
    filtered = all.filter((e) => {
      if (e.scope === "universal") return true;
      // "stack-specific" veya field yok → defansif filter
      const stack = e.tech_stack;
      if (stack === undefined) {
        // Eski kayıt — tech_stack bilinmiyor; defansif olarak skip
        return false;
      }
      return stack === currentStack;
    });
  }
  if (limit === undefined) return filtered;
  return filtered.slice(-limit);
}

// ─── Decision log (raw — 2nd confirmation detection input) ──────────────

export async function appendAgentDecisionLog(
  projectRoot: string,
  entry: AgentDecisionLogEntry,
): Promise<void> {
  await appendJsonl(projectDecisionsPath(projectRoot), entry);
}

export async function readAgentDecisionLog(
  projectRoot: string,
  limit?: number,
): Promise<AgentDecisionLogEntry[]> {
  const all = await readJsonl<AgentDecisionLogEntry>(
    projectDecisionsPath(projectRoot),
  );
  if (limit === undefined) return all;
  return all.slice(-limit);
}
