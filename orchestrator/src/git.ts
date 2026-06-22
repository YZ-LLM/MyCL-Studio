// git — proje git history'sine read-only erişim. Relevance engine'in
// `extractGitChunks` çağrısı için commit log + diff stats.
//
// Pattern: child_process.spawn + safeEnv() allowlist + LC_ALL=C deterministic
// output. tool-handlers.ts'in Bash handler örneğine paralel ama doğrudan
// `git` binary çağrılır (bash shell yok, daha az saldırı yüzeyi).
//
// Fail policy:
//   - `isGitRepo` false → boş array semantiği (git altında olmayan proje;
//     relevance opsiyonel context). Caller (chunk-store) bunu yakalar.
//   - Git komut error (exit ≠ 0, exit ≠ 128) → GitError throw. Caller
//     engine relevance fail-safe ile yakalar (emitError + boş array).
//   - ENOENT (git binary yok) → GitError throw. Sistemde git yoksa kullanıcı
//     bunu görmeli — hata GİZLENMEZ.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { safeEnv } from "./safe-env.js";
import { log } from "./logger.js";

export class GitError extends Error {
  override readonly name = "GitError";
}

export interface GitCommit {
  /** Full SHA (40 char). */
  sha: string;
  /** Commit timestamp (unix ms). */
  ts: number;
  /** Commit message ilk satırı. */
  subject: string;
}

export interface GitCommitStats {
  files_changed: number;
  insertions: number;
  deletions: number;
  /** İlk 20 değişen dosya yolu. */
  files: string[];
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * git komutunu güvenli ortamla (safeEnv + LC_ALL=C) çalıştırır. Stdout/stderr
 * buffer'lanır; uzun çıktı sorun değil (commit log + stat çıktıları kısa).
 */
function runGit(projectRoot: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // YZLLM 2026-06-12 (ANSI-sınıfı sağlamlaştırma — regression-diff kökünün aynısı): `color.ui=always`
    // yapılandırması git çıktısına ANSI enjekte edip --stat/--name-only PARSE'ını (^-çapalı regex) sessizce
    // bozabilir. Non-TTY'de git zaten kapatır ama config'i ezerek GARANTİYE al ("ize/varsayıma güvenme").
    const child = spawn("git", ["-c", "color.ui=false", ...args], {
      cwd: projectRoot,
      env: { ...safeEnv(), LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (d) => outChunks.push(d as Buffer));
    child.stderr.on("data", (d) => errChunks.push(d as Buffer));
    child.on("error", (err) => {
      // ENOENT: git binary yok. Diğer spawn error'ları da burada.
      reject(new GitError(`git spawn failed: ${String(err)}`));
    });
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
        code: code ?? -1,
      });
    });
  });
}

/**
 * Proje bir git working tree'si mi? `git rev-parse --is-inside-work-tree`
 * exit 0 → true; exit 128 → false (not a git repo veya outside work tree).
 * Diğer exit kodları → GitError throw.
 */
export async function isGitRepo(projectRoot: string): Promise<boolean> {
  const r = await runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (r.code === 0) return true;
  if (r.code === 128) return false;
  throw new GitError(`unexpected git exit ${r.code}: ${r.stderr.slice(0, 200)}`);
}

/**
 * Son N commit'i kronolojik tersine (newest first) döndür. Format:
 * `git log -<limit> --format=%H%x09%ct%x09%s` → her satır SHA<TAB>unix_ts<TAB>subject.
 */
export async function getRecentCommits(
  projectRoot: string,
  limit: number = 50,
): Promise<GitCommit[]> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new GitError(`invalid limit: ${limit}`);
  }
  const r = await runGit(projectRoot, [
    "log",
    `-${limit}`,
    "--format=%H%x09%ct%x09%s",
  ]);
  if (r.code !== 0) {
    throw new GitError(`git log failed (exit ${r.code}): ${r.stderr.slice(0, 200)}`);
  }
  const lines = r.stdout.split("\n").filter((l) => l.length > 0);
  const commits: GitCommit[] = [];
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ts = Number(parts[1]) * 1000; // git --format=%ct seconds → ms
    if (!Number.isFinite(ts)) continue;
    commits.push({
      sha: parts[0],
      ts,
      subject: parts.slice(2).join("\t"),
    });
  }
  return commits;
}

/**
 * Commit'in --stat çıktısını parse et: değişen dosya sayısı + insert/delete +
 * ilk 20 dosya yolu. `git show <sha> --stat --format=` ile mesaj çıktısı
 * bastırılır, sadece stat block'u alınır.
 *
 * Stat çıktısı tipik:
 *   src/foo.ts | 12 ++++++------
 *   src/bar.ts |  3 ++-
 *    2 files changed, 11 insertions(+), 4 deletions(-)
 */
export async function getCommitStats(
  projectRoot: string,
  sha: string,
): Promise<GitCommitStats> {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) {
    throw new GitError(`invalid sha: ${sha}`);
  }
  const r = await runGit(projectRoot, ["show", sha, "--stat", "--format="]);
  if (r.code !== 0) {
    throw new GitError(`git show failed (exit ${r.code}): ${r.stderr.slice(0, 200)}`);
  }
  return parseStatOutput(r.stdout);
}

/**
 * Pure helper: `git show --stat --format=` çıktısını parse eder. Export edildi
 * çünkü unit test edilmesi gereken tek pure logic.
 */
export function parseStatOutput(stdout: string): GitCommitStats {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  const files: string[] = [];

  for (const line of lines) {
    // Summary satırı: "N files? changed, X insertions?(+), Y deletions?(-)"
    const summaryMatch = line.match(
      /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
    );
    if (summaryMatch) {
      filesChanged = Number(summaryMatch[1]) || 0;
      insertions = Number(summaryMatch[2]) || 0;
      deletions = Number(summaryMatch[3]) || 0;
      continue;
    }
    // File satırı: " path/to/file.ts | NN ++++----"
    const fileMatch = line.match(/^\s*([^|]+?)\s+\|\s+/);
    if (fileMatch && files.length < 20) {
      files.push(fileMatch[1].trim());
    }
  }

  return { files_changed: filesChanged, insertions, deletions, files };
}

/** Bir kaynak satırını en son değiştiren commit (git blame çıktısı). */
export interface GitBlameLine {
  /** Kısa SHA (10 char). */
  sha: string;
  /** Commit yazarı. */
  author: string;
  /** Commit zamanı (unix ms). */
  ts: number;
  /** Commit mesajı ilk satırı. */
  summary: string;
  /** Blame edilen dosya satır numarası. */
  line: number;
}

/** 40 karakterlik hex (git SHA) mı? Saf char kontrolü — regex yok. */
function isHex40(s: string): boolean {
  if (s.length !== 40) return false;
  for (const c of s) {
    const hex = (c >= "0" && c <= "9") || (c >= "a" && c <= "f");
    if (!hex) return false;
  }
  return true;
}

/**
 * `git blame -L <s>,<e> --line-porcelain -- <file>` çıktısını parse eder.
 * --line-porcelain her satır için tam başlığı tekrarlar; her blok
 * `<sha> <orig> <final>` başlığıyla başlar, `author`/`committer-time`/`summary`
 * alanlarını taşır ve `\t`-prefix'li içerik satırıyla biter. Export — pure,
 * unit-testlenebilir (parseStatOutput gibi).
 */
export function parseBlamePorcelain(stdout: string): GitBlameLine[] {
  const out: GitBlameLine[] = [];
  let cur: { sha?: string; author?: string; ts?: number; summary?: string; line?: number } = {};
  for (const raw of stdout.split("\n")) {
    if (raw.startsWith("\t")) {
      // İçerik satırı → mevcut bloğu kapat.
      if (cur.sha && typeof cur.line === "number") {
        out.push({
          sha: cur.sha.slice(0, 10),
          author: cur.author ?? "?",
          ts: cur.ts ?? 0,
          summary: cur.summary ?? "",
          line: cur.line,
        });
      }
      cur = {};
      continue;
    }
    const sp = raw.indexOf(" ");
    const head = sp === -1 ? raw : raw.slice(0, sp);
    const rest = sp === -1 ? "" : raw.slice(sp + 1);
    if (isHex40(head)) {
      const toks = raw.split(" ");
      cur.sha = head;
      const finalLine = Number(toks[2]);
      if (Number.isFinite(finalLine)) cur.line = finalLine;
    } else if (head === "author") {
      cur.author = rest;
    } else if (head === "committer-time") {
      const t = Number(rest) * 1000;
      if (Number.isFinite(t)) cur.ts = t;
    } else if (head === "summary") {
      cur.summary = rest;
    }
  }
  return out;
}

/**
 * `file` dosyasının `[startLine, endLine]` aralığını en son değiştiren
 * commit'leri döndürür (git blame). Untracked/commit'siz dosya veya geçersiz
 * aralık → boş array (graceful; blame kanıtı opsiyonel). Dosya `--` sonrası
 * geçirilir (option injection engeli).
 */
export async function getBlameForLines(
  projectRoot: string,
  file: string,
  startLine: number,
  endLine: number,
): Promise<GitBlameLine[]> {
  if (typeof file !== "string" || file.length === 0 || file.startsWith("-")) {
    throw new GitError(`invalid blame file: ${file}`);
  }
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    throw new GitError(`invalid blame range: ${startLine},${endLine}`);
  }
  const r = await runGit(projectRoot, [
    "blame",
    "-L",
    `${startLine},${endLine}`,
    "--line-porcelain",
    "--",
    file,
  ]);
  // exit ≠ 0 → dosya untracked/yok veya satır aralığı dosya dışında. Kanıt
  // opsiyonel; sessizce boş dön (throw etme — D1 akışı bozulmasın).
  if (r.code !== 0) return [];
  return parseBlamePorcelain(r.stdout);
}

// ── Write işlemleri (checkpoint / rollback) ──────────────────────────────────
// runGit READ-ONLY kalır; write komutları ayrı allowlist'li runGitWrite'tan
// geçer (saldırı yüzeyi ayrımı). MyCL state'i (.mycl) ve hata kataloğu
// (error_folder) rollback'ten DAİMA hariç tutulur.

const GIT_WRITE_ALLOWED = new Set(["checkout", "clean", "reset", "stash", "add"]);
const ROLLBACK_EXCLUDES = [".mycl", "error_folder"];

function runGitWrite(projectRoot: string, args: string[]): Promise<SpawnResult> {
  if (args.length === 0 || !GIT_WRITE_ALLOWED.has(args[0])) {
    return Promise.reject(new GitError(`git write komutuna izin yok: ${args[0] ?? "(boş)"}`));
  }
  return runGit(projectRoot, args);
}

export interface CheckpointResult {
  /** Checkpoint kuruldu mu (rollback mümkün mü). */
  ok: boolean;
  /** ok ise rollback hedefi (HEAD sha). */
  ref?: string;
  /** ok=false ise neden — kullanıcıya GÖRÜNÜR (sessiz değil). */
  reason?: string;
}

/** Working tree temiz mi? `git status --porcelain` boş → temiz. */
export async function isWorkingTreeClean(projectRoot: string): Promise<boolean> {
  const r = await runGit(projectRoot, ["status", "--porcelain"]);
  if (r.code !== 0) {
    throw new GitError(`git status failed (exit ${r.code}): ${r.stderr.slice(0, 200)}`);
  }
  return r.stdout.trim().length === 0;
}

/**
 * Fix öncesi checkpoint. SADECE git deposu + TEMİZ working-tree'de etkin: kirli
 * tree'de kullanıcının kaydedilmemiş WIP'i otomatik geri alma sırasında
 * kaybolabilir → ok:false + görünür `reason` (sessiz fallback yok). Temizse
 * ref = HEAD sha (rollback hedefi).
 */
export async function createCheckpoint(projectRoot: string): Promise<CheckpointResult> {
  let inRepo: boolean;
  try {
    inRepo = await isGitRepo(projectRoot);
  } catch {
    return { ok: false, reason: "git durumu okunamadı" };
  }
  if (!inRepo) return { ok: false, reason: "git deposu değil — otomatik geri alma yok" };

  let clean: boolean;
  try {
    clean = await isWorkingTreeClean(projectRoot);
  } catch {
    return { ok: false, reason: "git status okunamadı" };
  }
  if (!clean) {
    return {
      ok: false,
      reason: "kaydedilmemiş değişiklik var — otomatik geri alma kapalı (önce commit/stash et)",
    };
  }

  const r = await runGit(projectRoot, ["rev-parse", "HEAD"]);
  if (r.code !== 0) return { ok: false, reason: "commit yok (HEAD çözülemedi)" };
  return { ok: true, ref: r.stdout.trim() };
}

/**
 * Checkpoint'e geri al — fix'in değişikliklerini at, pre-fix temiz duruma dön.
 * Tracked değişiklikler `ref`'e döndürülür + fix'in oluşturduğu untracked
 * dosyalar temizlenir. `.mycl` (MyCL state) ve `error_folder` (hata kataloğu)
 * DAİMA hariç. Yalnız `createCheckpoint` ok:true döndüyse çağrılmalı (temiz
 * başlangıç garantisi → yalnız fix'in değişiklikleri geri alınır).
 */
export async function restoreCheckpoint(projectRoot: string, ref: string): Promise<boolean> {
  if (!/^[0-9a-f]{4,40}$/i.test(ref)) {
    throw new GitError(`invalid checkpoint ref: ${ref}`);
  }
  const excludePathspecs = ROLLBACK_EXCLUDES.map((p) => `:(exclude)${p}`);
  const co = await runGitWrite(projectRoot, ["checkout", ref, "--", ".", ...excludePathspecs]);
  const cleanArgs = ["clean", "-fd"];
  for (const p of ROLLBACK_EXCLUDES) {
    cleanArgs.push("-e", p);
  }
  const cl = await runGitWrite(projectRoot, cleanArgs);
  return co.code === 0 && cl.code === 0;
}

/** Bir yolun `.mycl`/`error_folder` (MyCL state + hata kataloğu) altında mı. */
function isExcludedScopePath(file: string): boolean {
  return ROLLBACK_EXCLUDES.some((ex) => file === ex || file.startsWith(`${ex}/`));
}

/**
 * Değişen dosyaları döndürür (scoped mekanik gate'ler için "değişen kapsam").
 * `since` (bir commit sha) verilirse working tree'nin o commit'ten bu yana
 * değişenleri (fix checkpoint'i = temiz HEAD → tam fix değişiklikleri); yoksa
 * HEAD'den bu yana working-tree değişiklikleri. Untracked (yeni) dosyalar da
 * dahil. `.mycl` + `error_folder` hariç. Yollar projectRoot-relative.
 *
 * Fail-safe: git repo değil / hata → boş array (kanıt opsiyonel; scope boşsa
 * caller tüm-proje fallback yapar — asla "temiz" varsayma).
 */
export async function getChangedFiles(
  projectRoot: string,
  since?: string,
): Promise<string[]> {
  // since yalnız geçerli sha ise kullanılır (option injection engeli); değilse HEAD.
  const base = since && /^[0-9a-f]{4,40}$/i.test(since) ? since : "HEAD";
  const files = new Set<string>();

  let anyFailed = false;
  // Tracked değişiklikler: working tree (staged + unstaged) vs base.
  const diff = await runGit(projectRoot, ["diff", "--name-only", "--relative", base, "--"]);
  if (diff.code === 0) {
    for (const line of diff.stdout.split("\n")) {
      const f = line.trim();
      if (f.length > 0) files.add(f);
    }
  } else anyFailed = true;
  // Untracked (fix'in yeni oluşturduğu dosyalar).
  const untracked = await runGit(projectRoot, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.code === 0) {
    for (const line of untracked.stdout.split("\n")) {
      const f = line.trim();
      if (f.length > 0) files.add(f);
    }
  } else anyFailed = true;

  // KISMİ başarısızlık tehlikesi (sessiz-fallback denetimi): diff geçip ls-files başarısız olursa elde
  // untracked'siz PARTIAL bir küme kalır; boş olmadığı için caller full-fallback yapmaz → yeni runtime
  // dosyaları taranmadan gate geçer (false-green). Herhangi biri başarısızsa küme GÜVENİLMEZ → boş dön
  // (caller tüm-proje fallback yapar = "kuşkuda full") + GÖRÜNÜR log (asla partial-scope ile daraltma).
  if (anyFailed) {
    log.error("git", "getChangedFiles: git komutu başarısız → değişen-dosya kümesi güvenilmez, tüm-proje fallback", {
      diffCode: diff.code,
      untrackedCode: untracked.code,
      stderr: `${diff.stderr ?? ""} ${untracked.stderr ?? ""}`.trim().slice(0, 200),
    });
    return [];
  }
  return [...files].filter((f) => !isExcludedScopePath(f));
}

/**
 * since-ref'ten BU ANA kadar tracked dosyaların birleşik (unified, context'siz) diff'i.
 * Faz 8 repro-gate'in "static-only change" (tip-only/ölü-kod) sınıflandırması satır-seviyesi
 * içerik ister (getChangedFiles yalnız yol verir). since geçerli sha değilse HEAD. Hata → "" (fail-soft).
 * NOT: `git diff` UNTRACKED (yeni) dosyaları İÇERMEZ — yeni dosya = olası runtime kod → caller
 * static-only saymamalı (getChangedFiles untracked'ı listeler; fark = yeni dosya).
 */
export async function getDiffSinceRef(projectRoot: string, since?: string): Promise<string> {
  const base = since && /^[0-9a-f]{4,40}$/i.test(since) ? since : "HEAD";
  const r = await runGit(projectRoot, ["diff", "--unified=0", "--relative", base, "--"]).catch(
    () => null,
  );
  return r && r.code === 0 ? r.stdout : "";
}

/**
 * Paralel codegen için İZOLE çalışma kopyası (git worktree): `<projectRoot>/.mycl/worktrees/<id>`'de
 * mevcut HEAD'den detached bir worktree kurar → worker burada kendi modülünü yazar (diğerlerinden izole).
 * Başarısızsa null döner → caller SERİ yola düşer (fail-closed). git repo değil / worktree desteklenmiyorsa null.
 */
export async function createWorktree(
  projectRoot: string,
  id: string,
): Promise<{ path: string } | null> {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || "mod";
  const wtPath = join(projectRoot, ".mycl", "worktrees", safe);
  // Tekrar-çalıştırma güvenliği: varsa önce kaldır.
  await runGit(projectRoot, ["worktree", "remove", "--force", wtPath]).catch(() => undefined);
  const r = await runGit(projectRoot, ["worktree", "add", "--detach", wtPath, "HEAD"]);
  if (r.code !== 0) {
    log.warn("git", "worktree add başarısız → seri yola düşülecek", {
      id,
      stderr: r.stderr.slice(0, 200),
    });
    return null;
  }
  return { path: wtPath };
}

/** Worktree'yi kaldır (force) + prune. İdempotent; hata yutulur (temizlik adımı). */
export async function removeWorktree(projectRoot: string, wtPath: string): Promise<void> {
  await runGit(projectRoot, ["worktree", "remove", "--force", wtPath]).catch(() => undefined);
  await runGit(projectRoot, ["worktree", "prune"]).catch(() => undefined);
}
