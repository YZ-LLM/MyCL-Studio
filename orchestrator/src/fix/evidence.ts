// fix/evidence — D1 (kök neden) için DETERMİNİSTİK kanıt toplar: errors.db'deki
// son runtime hataları + çözülmemiş bulgular, suç satırlarının git blame'i, ve
// son commit penceresi. LLM YOK — saf okuma. Çıktı markdown blok; phase-0 runD1
// initial message'a (Playwright probe çıktısının yanına) enjekte edilir. Amaç:
// model tahmin etmesin — kanıta atıfla YORUMLASIN (pasted konuşma prensip 3).
//
// Tüm alt-kaynaklar fail-safe: errors.db CLI yoksa / git repo değilse / dosya
// untracked ise o bölüm sessizce atlanır (kanıt opsiyonel zenginleştirme).

import {
  selectRecentRuntimeErrors,
  selectUnresolvedFindings,
  type RuntimeErrorRow,
} from "../errors-db.js";
import { getBlameForLines, getRecentCommits, isGitRepo } from "../git.js";
import { log } from "../logger.js";

const RUNTIME_LOOKBACK_MS = 24 * 60 * 60 * 1000; // son 24 saat
const MAX_ERRORS = 8;
const MAX_BLAME_FILES = 6;
const RECENT_COMMITS = 8;

export interface FixEvidenceOpts {
  projectRoot: string;
  /** ensureErrorCatalog'dan dönen mutlak errors.db yolu. */
  dbPath: string;
  /** Bug raporu + probe çıktısı — blame seed'i için file:line kaynağı. */
  extraText?: string;
}

const TOKEN_DELIMS = new Set([
  " ", "\t", "\n", "\r", "(", ")", "[", "]", "{", "}", ",", '"', "'", "`", "<", ">",
]);

/** Saf rakam mı? (regex yok) */
function isAllDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (const c of s) if (c < "0" || c > "9") return false;
  return true;
}

/** Metni delimiter set'iyle token'lara böl — regex yok. */
function tokenize(text: string): string[] {
  const toks: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (TOKEN_DELIMS.has(ch)) {
      if (cur) {
        toks.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) toks.push(cur);
  return toks;
}

/** Tek token'dan `file:line` çıkar. `src/a.ts:42`, `/abs/a.ts:42:10` → eşleşir;
 *  route/endpoint (`/api/x`, `/hata-kodlari`) → null (sayısal kuyruk yok). */
function parseToken(tok: string): { file: string; line: number } | null {
  let t = tok;
  while (t.length && (t.endsWith(":") || t.endsWith("."))) t = t.slice(0, -1);
  const parts = t.split(":");
  if (parts.length < 2) return null;
  // Sondan başlayarak ardışık sayısal parçaları topla (line[:col]).
  let i = parts.length - 1;
  const nums: number[] = [];
  while (i >= 1 && isAllDigits(parts[i])) {
    nums.unshift(Number(parts[i]));
    i--;
  }
  if (nums.length === 0) return null; // satır numarası yok → dosya:satır değil
  const file = parts.slice(0, i + 1).join(":");
  if (!file.includes(".")) return null; // uzantısız → dosya sayma (route vb.)
  const line = nums[0];
  if (!Number.isFinite(line) || line < 1) return null;
  return { file, line };
}

/**
 * Serbest metinden (stack trace, errors.db location/stack) `file:line`
 * konumlarını çıkarır. Dosya başına ilk satırı tutar, sırayı korur. Pure,
 * export — unit-testlenebilir.
 */
export function extractSourceLocations(
  text: string,
): { file: string; line: number }[] {
  if (!text) return [];
  const seen = new Map<string, number>();
  for (const tok of tokenize(text)) {
    const hit = parseToken(tok);
    if (hit && !seen.has(hit.file)) seen.set(hit.file, hit.line);
  }
  return [...seen.entries()].map(([file, line]) => ({ file, line }));
}

function formatErrorsBlock(rows: RuntimeErrorRow[]): string | null {
  if (rows.length === 0) return null;
  const lines = rows.slice(0, MAX_ERRORS).map((r) => {
    const when = new Date(r.ts).toISOString().slice(0, 19).replace("T", " ");
    const stack = r.stack ? ` — stack: ${r.stack.split("\n")[0].slice(0, 160)}` : "";
    return `- [${r.error_code}] ${r.location} (${when}): ${r.description_tr}${stack}`;
  });
  return `### errors.db — kayıtlı hatalar (çözülmemiş / son 24s runtime)\n${lines.join("\n")}`;
}

async function formatBlameBlock(
  projectRoot: string,
  seedText: string,
): Promise<string | null> {
  const locs = extractSourceLocations(seedText).slice(0, MAX_BLAME_FILES);
  if (locs.length === 0) return null;
  const out: string[] = [];
  for (const { file, line } of locs) {
    try {
      const blame = await getBlameForLines(projectRoot, file, line, line);
      if (blame.length === 0) continue;
      const b = blame[0];
      const when = b.ts ? new Date(b.ts).toISOString().slice(0, 10) : "?";
      out.push(`- ${file}:${line} → en son ${b.sha} (${b.author}, ${when}) "${b.summary}"`);
    } catch (err) {
      log.warn("fix/evidence", "blame failed (skip)", { file, line, err: String(err) });
    }
  }
  if (out.length === 0) return null;
  return `### git blame — şüpheli satırları en son değiştiren commit\n${out.join("\n")}`;
}

async function formatRecentCommitsBlock(
  projectRoot: string,
): Promise<string | null> {
  try {
    const commits = await getRecentCommits(projectRoot, RECENT_COMMITS);
    if (commits.length === 0) return null;
    const lines = commits.map((c) => {
      const when = new Date(c.ts).toISOString().slice(0, 10);
      return `- ${c.sha.slice(0, 10)} (${when}) ${c.subject}`;
    });
    return `### Son commit'ler (regresyon penceresi)\n${lines.join("\n")}`;
  } catch (err) {
    log.warn("fix/evidence", "recent commits failed (skip)", err);
    return null;
  }
}

/**
 * D1 için deterministik kanıt bloğu üretir. Hiç kanıt yoksa boş string döner
 * (caller probeOutput gibi koşullu ekler). LLM çağrısı YOK.
 */
export async function buildFixEvidence(opts: FixEvidenceOpts): Promise<string> {
  const sections: string[] = [];

  // 1) errors.db — çözülmemiş + son runtime hataları (id'ye göre tekille).
  try {
    const recent = await selectRecentRuntimeErrors(opts.dbPath, RUNTIME_LOOKBACK_MS);
    const unresolved = await selectUnresolvedFindings(opts.dbPath);
    const byId = new Map<number, RuntimeErrorRow>();
    for (const r of [...unresolved, ...recent]) byId.set(r.id, r);
    const block = formatErrorsBlock([...byId.values()].sort((a, b) => b.ts - a.ts));
    if (block) sections.push(block);
  } catch (err) {
    log.warn("fix/evidence", "errors.db read failed (skip)", err);
  }

  // git tabanlı kanıt yalnız repo ise.
  let inRepo = false;
  try {
    inRepo = await isGitRepo(opts.projectRoot);
  } catch {
    inRepo = false;
  }
  if (inRepo) {
    // 2) git blame — errors.db location/stack + bug raporu + probe stack seed'i.
    let seed = opts.extraText ?? "";
    try {
      const recent = await selectRecentRuntimeErrors(opts.dbPath, RUNTIME_LOOKBACK_MS);
      for (const r of recent) seed += `\n${r.location}\n${r.stack ?? ""}`;
    } catch {
      /* errors.db zaten yukarıda denendi; seed best-effort */
    }
    const blameBlock = await formatBlameBlock(opts.projectRoot, seed);
    if (blameBlock) sections.push(blameBlock);

    // 3) Son commit penceresi.
    const commitsBlock = await formatRecentCommitsBlock(opts.projectRoot);
    if (commitsBlock) sections.push(commitsBlock);
  }

  if (sections.length === 0) return "";
  return [
    "## DETERMİNİSTİK KANIT (MyCL topladı — UYDURMA, bu olgulara atıfla YORUMLA)",
    ...sections,
  ].join("\n\n");
}
