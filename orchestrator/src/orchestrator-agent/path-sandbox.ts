// orchestrator-agent/path-sandbox — proje izolasyonu için path validation.
//
// Kullanıcı talebi (v15.6 — 2026-05-24): "projeler asla birbirine
// karışmamalıdır". Process model zaten her pencereye ayrı subprocess veriyor
// (record-context.ts singleton process-local) ama agent'ın Read/Grep/Bash
// tool'larında absolute path verirse başka projeye erişim YASAĞI kod
// seviyesinde zorlanmıyordu. Bu modül bu boşluğu kapatır.
//
// Pure utility — I/O sadece `realpathWithinRoot` async fonksiyonunda (symlink
// escape kontrolü). isPathWithinRoot/validatePathForAgent senkron, no I/O.

import { promises as fs } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";

/**
 * Verilen path proje root'unun altında mı?
 *
 * Edge case'ler:
 * - `..` traversal: `resolve` ile normalize edilir, kök dışına çıkarsa false.
 * - Adjacent-prefix collision: `/Users/u/proj` ile `/Users/u/proj-evil/x`
 *   ayrılır — `startsWith(rootAbs + sep)` trailing-sep guard'ı sayesinde.
 * - Trailing slash: rootAbs normalize edilir, `/Users/u/proj/` ile
 *   `/Users/u/proj` aynı kabul.
 *
 * NOT: Symlink escape bu sync fonksiyonla yakalanmaz — caller `realpath`
 * post-check yapmalı (örn. `realpathWithinRoot`).
 */
export function isPathWithinRoot(projectRoot: string, target: string): boolean {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) return false;
  if (typeof target !== "string" || target.length === 0) return false;
  const rootAbs = normalize(resolve(projectRoot));
  // target absolute değilse projectRoot'a relative resolve et
  const targetAbs = isAbsolute(target)
    ? normalize(resolve(target))
    : normalize(resolve(projectRoot, target));
  if (targetAbs === rootAbs) return true;
  return targetAbs.startsWith(rootAbs + sep);
}

export interface ValidatedPath {
  ok: true;
  /** Absolute, normalize edilmiş path. Caller bunu kullanır. */
  resolved: string;
}

export interface InvalidPath {
  ok: false;
  reason: string;
}

/**
 * Agent tool çağrılarından gelen path'i doğrular ve absolute resolved path
 * döner. Caller bu resolved path'i fs.readFile vs. ile kullanır.
 *
 * Tilde (`~`) expansion YAPMAZ — agent home dizinine erişmemeli (zaten
 * ~/.mycl/secrets.json gibi user-global dosyalar var).
 */
export function validatePathForAgent(
  projectRoot: string,
  rawPath: string,
): ValidatedPath | InvalidPath {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { ok: false, reason: "empty or non-string path" };
  }
  if (rawPath.startsWith("~")) {
    return { ok: false, reason: "tilde (~) expansion not allowed" };
  }
  if (!isPathWithinRoot(projectRoot, rawPath)) {
    return { ok: false, reason: "resolved path outside project root" };
  }
  const resolved = isAbsolute(rawPath)
    ? normalize(resolve(rawPath))
    : normalize(resolve(projectRoot, rawPath));
  return { ok: true, resolved };
}

/**
 * Bash komutundan path-benzeri argüman token'larını çıkarır.
 *
 * Pozitif (extract eder):
 * - Absolute path (`/Users/x`)
 * - Tilde-leading (`~/foo`) — validate edilirken reject olur ama yakalanır
 * - Parent-traversal (`../foo`)
 *
 * Negatif (yok sayar):
 * - Flag (`-rn`, `--name`, `-l`)
 * - Sayısal (`5`, `100`)
 * - Pattern (`*.ts`) — relative resolution'a güvenir, content olarak path değil
 * - Salt relative (`README.md`, `src/foo.ts`) — root altında resolve olur, OK
 * - First-token komut adı (`cat`, `find`, `git`)
 *
 * Quoted token'ların outer quote'larını strip eder. Boşluklu path'ler
 * (`'foo bar.txt'`) tek token olarak yakalanır.
 *
 * NOT: shell parsing heuristic — kompleks komutlar (subshells, variable
 * expansion) için %100 garanti değil ama validateBashCommand zaten
 * destructive pattern check yapıyor (subshell `$()`, backtick reject).
 */
export function extractPathTokensFromBash(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed.length === 0) return [];
  // Basit token splitter: boşluk ayır, quoted ('...' veya "...") tek token tut
  const tokens: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (!ch) continue;
    if (quote) {
      if (ch === quote) {
        tokens.push(buf);
        buf = "";
        quote = null;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = "";
      }
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) tokens.push(buf);
  // İlk token (komut adı: cat, find, git) skip; sonrası flag mı, path-benzeri mi?
  const pathTokens: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    // Flag → yok say
    if (t.startsWith("-")) continue;
    // Path-benzeri kriter: absolute, tilde, ya da `../` ile başlar
    if (t.startsWith("/") || t.startsWith("~") || t.startsWith("../")) {
      pathTokens.push(t);
    }
    // Diğerleri (`README.md`, `*.ts`, `5`, `src/foo.ts`) — relative resolve
    // ile root altında kalır, ayrıca check etmeye gerek yok.
  }
  return pathTokens;
}

/**
 * Async post-check: Read sonrası gerçek path symlink ile root dışına
 * kaçıyor mu? `fs.realpath` çözümler; ENOENT (dosya yok) durumunda sync
 * sonucu yeterli (yeni dosya — symlink olamaz).
 *
 * Sadece Read tool'unda çağrılır (Bash performance için sync kalır).
 */
export async function realpathWithinRoot(
  projectRoot: string,
  target: string,
): Promise<boolean> {
  try {
    const realTarget = await fs.realpath(target);
    const realRoot = await fs.realpath(projectRoot).catch(() => projectRoot);
    const rootAbs = normalize(realRoot);
    if (realTarget === rootAbs) return true;
    return realTarget.startsWith(rootAbs + sep);
  } catch (err) {
    // ENOENT: dosya yok — sync sonucu yeterli, symlink concern yok
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return isPathWithinRoot(projectRoot, target);
    }
    // Diğer hata (permission vb.) — defansif false
    return false;
  }
}
