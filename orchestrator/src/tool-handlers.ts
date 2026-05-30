// tool-handlers — Custom tool implementations (Read/Write/Edit/Bash/Glob/Grep).
//
// MIMARI KURAL: Claude Code subprocess YASAK. Bu dosya Claude'un tool_use
// çağrılarını MyCL Studio tarafında (Node fs + child_process) gerçekleştirir.
// Claude yalnız "ne yapmalı" karar verir (Anthropic SDK tool_use yayar); BIZ
// exec ederiz; sonucu tool_result olarak SDK'ya geri yazarız.
//
// Güvenlik:
//   - Path normalize edilir; project_root dışına çıkmak yasak (`..` filtre).
//   - denied_paths: .mycl/, node_modules/, dist/, build/, .git/ default deny.
//   - Bash command: 60s timeout, LC_ALL=C, cwd=project_root.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { inspectBashCommand } from "./bash-guard.js";
import { log } from "./logger.js";
import { safeEnv } from "./safe-env.js";

export interface ToolContext {
  project_root: string;
  /** Phase spec'inde tanımlı extra deny path'leri. */
  extra_denied_paths?: string[];
  /**
   * Default-denied prefix'leri (örn. `.mycl/`) içinde KALAN ama bu faz için
   * yazımına izin verilen spesifik dosyalar. Match varsa denied check
   * atlanır. Örnek: Faz 5 `.mycl/patterns.md`, Faz 20 `.mycl/validation-report.md`
   * yazımı için bu listeyi kullanır. Proje köküne göreli ya da mutlak yol.
   */
  extra_allowed_paths?: string[];
  /**
   * Glob pattern'leri olarak phase-specific deny. Faz 20 mock cleanup gibi
   * "test dosyalarına dokunma" kurallarını uygular. Örn:
   *   ["**\/*.test.*", "**\/__tests__/**"]
   * Match path proje köküne göreli olarak değerlendirilir.
   */
  extra_denied_patterns?: string[];
}

/**
 * Uzun-sürebilen komutlar için default timeout ön-tahmini. Kullanıcı
 * `input.timeout` belirtmediği zaman uygulanır. Pattern listesi paket
 * yöneticileri ve derleyici tooling'i kapsar — bunlar cold cache'te 60sn'i
 * aşar, fail eder pipeline'ı keserdi.
 *
 * Match yoksa standart 60_000 ms.
 */
export function inferDefaultTimeout(cmd: string): number {
  const LONG_PATTERNS = [
    /\bnpm\s+(install|ci|i)\b/i,
    /\bpnpm\s+(install|i)\b/i,
    /\byarn(\s+install)?\b/i,
    /\bpip\s+install\b/i,
    /\bpip3\s+install\b/i,
    /\bbundle\s+install\b/i,
    /\bcargo\s+(build|test|fetch|update)\b/i,
    /\bgo\s+(build|test|mod\s+(download|tidy))\b/i,
    /\b(npx|pnpx)\s+playwright\s+install\b/i,
    /\bdocker\s+(build|pull)\b/i,
    /\bgradle\s+(build|assemble)\b/i,
    /\bmvn\s+(install|compile|package)\b/i,
  ];
  return LONG_PATTERNS.some((re) => re.test(cmd)) ? 300_000 : 60_000;
}

/**
 * Basit glob → regex dönüştürücü. ** → .*, * → [^/]*, ? → [^/].
 * Diğer regex meta-karakterleri escape edilir.
 */
export function globToRegex(pattern: string): RegExp {
  return new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§§§")
        .replace(/\*/g, "[^/]*")
        .replace(/§§§/g, ".*")
        .replace(/\?/g, "[^/]") +
      "$",
  );
}

export interface ToolResult {
  content: string;
  is_error: boolean;
}

const DEFAULT_DENIED_PREFIXES = [
  ".mycl/",
  "node_modules/",
  "dist/",
  "build/",
  ".git/",
];

function normalizeAndCheck(
  inputPath: string,
  ctx: ToolContext,
  forWrite: boolean,
): { absPath: string; relPath: string } | { error: string } {
  if (!inputPath) return { error: "path required" };
  const abs = isAbsolute(inputPath)
    ? resolvePath(inputPath)
    : resolvePath(ctx.project_root, inputPath);
  const rel = relative(ctx.project_root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { error: `path outside project_root: ${inputPath}` };
  }
  if (forWrite) {
    // Faza özgü whitelist — match varsa default denied prefix atlanır.
    // (extra_denied_paths yine de uygulanır; whitelist deny'a karşı değil,
    //  yalnızca default deny prefix'lerine karşı dispens verir.)
    const allowMatch = (ctx.extra_allowed_paths ?? []).some((allowed) => {
      const allowedAbs = isAbsolute(allowed)
        ? allowed
        : resolvePath(ctx.project_root, allowed);
      return abs === allowedAbs || abs.startsWith(allowedAbs + "/");
    });
    if (!allowMatch) {
      for (const prefix of DEFAULT_DENIED_PREFIXES) {
        if (rel.startsWith(prefix) || rel === prefix.replace(/\/$/, "")) {
          return { error: `path in default denied area: ${rel}` };
        }
      }
    }
    for (const extra of ctx.extra_denied_paths ?? []) {
      const extraAbs = isAbsolute(extra) ? extra : resolvePath(ctx.project_root, extra);
      if (abs === extraAbs || abs.startsWith(extraAbs + "/")) {
        return { error: `path in phase-denied area: ${rel}` };
      }
    }
    for (const pattern of ctx.extra_denied_patterns ?? []) {
      if (globToRegex(pattern).test(rel)) {
        return { error: `path matches denied pattern "${pattern}": ${rel}` };
      }
    }
  }
  return { absPath: abs, relPath: rel };
}

/* ============================================================
 * Tool: Read
 * Input: { file_path: string; offset?: number; limit?: number }
 * ============================================================ */
export async function handleRead(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const filePath = String(input.file_path ?? input.path ?? "");
  const offset = Number(input.offset ?? 0);
  const limit = Number(input.limit ?? 2000);
  const check = normalizeAndCheck(filePath, ctx, false);
  if ("error" in check) return { content: check.error, is_error: true };

  try {
    const raw = await fs.readFile(check.absPath, "utf-8");
    const lines = raw.split("\n");
    const sliced = lines.slice(offset, offset + limit);
    const formatted = sliced
      .map((l, i) => `${String(offset + i + 1).padStart(6)}\t${l}`)
      .join("\n");
    return { content: formatted, is_error: false };
  } catch (err) {
    return { content: `read failed: ${String(err)}`, is_error: true };
  }
}

/* ============================================================
 * Tool: Write
 * Input: { file_path: string; content: string }
 * ============================================================ */
export async function handleWrite(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const filePath = String(input.file_path ?? input.path ?? "");
  const content = String(input.content ?? "");
  const check = normalizeAndCheck(filePath, ctx, true);
  if ("error" in check) return { content: check.error, is_error: true };

  try {
    // mkdir -p the parent dir
    const parent = check.absPath.substring(0, check.absPath.lastIndexOf("/"));
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(check.absPath, content, { encoding: "utf-8" });
    return {
      content: `wrote ${content.length} chars to ${check.relPath}`,
      is_error: false,
    };
  } catch (err) {
    return { content: `write failed: ${String(err)}`, is_error: true };
  }
}

/* ============================================================
 * Tool: Edit
 * Input: { file_path: string; old_string: string; new_string: string;
 *         replace_all?: boolean }
 * Semantik: old_string dosyada ÖZGÜN olmalı (tek occurrence) — değilse
 * replace_all=true gerekir veya error.
 * ============================================================ */
export async function handleEdit(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const filePath = String(input.file_path ?? input.path ?? "");
  const oldString = String(input.old_string ?? "");
  const newString = String(input.new_string ?? "");
  const replaceAll = Boolean(input.replace_all ?? false);
  if (!oldString) {
    return { content: "old_string required", is_error: true };
  }
  if (oldString === newString) {
    return { content: "old_string and new_string are identical", is_error: true };
  }
  const check = normalizeAndCheck(filePath, ctx, true);
  if ("error" in check) return { content: check.error, is_error: true };

  try {
    const raw = await fs.readFile(check.absPath, "utf-8");
    const occurrences = raw.split(oldString).length - 1;
    if (occurrences === 0) {
      return {
        content: `old_string not found in ${check.relPath}`,
        is_error: true,
      };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        content: `old_string matches ${occurrences} occurrences; need replace_all=true or more context`,
        is_error: true,
      };
    }
    const updated = replaceAll
      ? raw.split(oldString).join(newString)
      : raw.replace(oldString, newString);
    await fs.writeFile(check.absPath, updated, { encoding: "utf-8" });
    return {
      content: `edited ${check.relPath} (${occurrences} replacement${occurrences > 1 ? "s" : ""})`,
      is_error: false,
    };
  } catch (err) {
    return { content: `edit failed: ${String(err)}`, is_error: true };
  }
}

/* ============================================================
 * Tool: Bash
 * Input: { command: string; timeout?: number (ms, max 600000) }
 * ============================================================ */
export async function handleBash(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const command = String(input.command ?? "");
  if (!command.trim()) return { content: "command required", is_error: true };

  // Güvenlik: spawn'dan önce yıkıcı pattern check. Match varsa erken reddet.
  const guard = inspectBashCommand(command);
  if (guard.blocked) {
    log.warn("tool-handlers", "bash blocked by guard", {
      reason: guard.reason,
      command: command.slice(0, 200),
    });
    return {
      content: `bash command refused by guard: ${guard.reason}`,
      is_error: true,
    };
  }

  // Kullanıcı timeout vermediyse komut pattern'ine göre tahmin et (npm install
  // gibi uzun komutlar için 5 dk default). Verdiyse onun değerini kullan.
  const rawTimeout =
    input.timeout !== undefined && input.timeout !== null
      ? Number(input.timeout)
      : inferDefaultTimeout(command);
  const timeoutMs = Math.min(Math.max(rawTimeout, 1000), 600_000);
  log.info("tool-handlers", "bash exec", {
    command: command.slice(0, 200),
    cwd: ctx.project_root,
    timeoutMs,
  });
  return new Promise<ToolResult>((resolve) => {
    // v15.8 (2026-05-28): Cross-platform shell spawn.
    // - macOS/Linux: bash -lc (login shell, pulls .bashrc PATH adjustments)
    // - Windows: cmd /c (PowerShell de mümkün ama npm/git komutları cmd'de
    //   uyumlu; PowerShell quoting daha karmaşık → cmd seçilir)
    const isWin = process.platform === "win32";
    const shellCmd = isWin ? "cmd.exe" : "bash";
    const shellArgs = isWin ? ["/c", command] : ["-lc", command];
    const child = spawn(shellCmd, shellArgs, {
      cwd: ctx.project_root,
      // Güvenlik: process.env spread YOK — hassas anahtarlar (ANTHROPIC_API_KEY,
      // AWS_*, vs.) child'a sızmasın. Yalnız safe-env allowlist + LC_ALL.
      env: { ...safeEnv(), LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf-8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf-8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Test runner çıktısı tipik olarak SON satırlarda özet/fail detayı tutar.
      // Baştan kesmek yerine sondan kes (tail): ilk N byte gizli, son N tam.
      const truncate = (s: string, n: number) =>
        s.length > n
          ? `...(elided ${s.length - n} earlier bytes)\n${s.slice(-n)}`
          : s;
      const out =
        `exit_code=${code}${killed ? " (killed: timeout)" : ""}\n` +
        `--- stdout ---\n${truncate(stdout, 4000)}\n` +
        `--- stderr ---\n${truncate(stderr, 2000)}`;
      resolve({ content: out, is_error: code !== 0 || killed });
    });
  });
}

/* ============================================================
 * Tool: Glob
 * Input: { pattern: string; path?: string }
 * Basit glob — `find ... -name`/`grep` ile değil, JS regex ile.
 * Yıldız ve klasör matching destekler; tam fast-glob değil.
 * ============================================================ */
export async function handleGlob(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const pattern = String(input.pattern ?? "");
  const basePath = String(input.path ?? ctx.project_root);
  const check = normalizeAndCheck(basePath, ctx, false);
  if ("error" in check) return { content: check.error, is_error: true };

  // Pattern → regex
  // ** → .*
  // *  → [^/]*
  // ?  → [^/]
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§§§")
        .replace(/\*/g, "[^/]*")
        .replace(/§§§/g, ".*")
        .replace(/\?/g, "[^/]") +
      "$",
  );

  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      const rel = relative(ctx.project_root, full);
      if (DEFAULT_DENIED_PREFIXES.some((p) => rel.startsWith(p) || rel === p.replace(/\/$/, ""))) {
        continue;
      }
      if (e.isDirectory()) {
        await walk(full);
      } else if (re.test(rel)) {
        results.push(rel);
      }
    }
  }
  try {
    await walk(check.absPath);
    return {
      content: results.length > 0 ? results.join("\n") : "(no matches)",
      is_error: false,
    };
  } catch (err) {
    return { content: `glob failed: ${String(err)}`, is_error: true };
  }
}

/* ============================================================
 * Tool: Grep
 * Input: { pattern: string; path?: string; output_mode?: "files_with_matches"|"content" }
 * ============================================================ */
export async function handleGrep(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const pattern = String(input.pattern ?? "");
  const basePath = String(input.path ?? ctx.project_root);
  const mode = String(input.output_mode ?? "files_with_matches");
  if (!pattern) return { content: "pattern required", is_error: true };
  const check = normalizeAndCheck(basePath, ctx, false);
  if ("error" in check) return { content: check.error, is_error: true };

  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return { content: `invalid regex: ${String(err)}`, is_error: true };
  }

  const matches: Array<{ file: string; line?: number; text?: string }> = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      const rel = relative(ctx.project_root, full);
      if (DEFAULT_DENIED_PREFIXES.some((p) => rel.startsWith(p) || rel === p.replace(/\/$/, ""))) {
        continue;
      }
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const raw = await fs.readFile(full, "utf-8");
        if (mode === "files_with_matches") {
          if (re.test(raw)) matches.push({ file: rel });
        } else {
          const lines = raw.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) matches.push({ file: rel, line: i + 1, text: lines[i] });
          }
        }
      } catch {
        // binary/unreadable → skip
      }
    }
  }
  try {
    await walk(check.absPath);
    let out: string;
    if (mode === "files_with_matches") {
      out = matches.length > 0 ? matches.map((m) => m.file).join("\n") : "(no matches)";
    } else {
      out =
        matches.length > 0
          ? matches.map((m) => `${m.file}:${m.line}:${m.text}`).join("\n").slice(0, 4000)
          : "(no matches)";
    }
    return { content: out, is_error: false };
  } catch (err) {
    return { content: `grep failed: ${String(err)}`, is_error: true };
  }
}

/* ============================================================
 * Tool definitions (Anthropic SDK formatı)
 * ============================================================ */
export const TOOLS_CODEGEN = [
  {
    name: "Read",
    description: "Read a file from the project. Returns content with line numbers.",
    input_schema: {
      type: "object",
      required: ["file_path"],
      properties: {
        file_path: { type: "string", description: "Relative or absolute path." },
        offset: { type: "number", description: "Starting line (0-based)." },
        limit: { type: "number", description: "Max lines (default 2000)." },
      },
    },
  },
  {
    name: "Write",
    description: "Create or overwrite a file. Parent directories created automatically.",
    input_schema: {
      type: "object",
      required: ["file_path", "content"],
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
      },
    },
  },
  {
    name: "Edit",
    description:
      "Replace old_string with new_string in a file. old_string must be unique (or set replace_all=true).",
    input_schema: {
      type: "object",
      required: ["file_path", "old_string", "new_string"],
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
    },
  },
  {
    name: "Bash",
    description: "Run a shell command. Timeout default 60s, max 600s. cwd=project_root, LC_ALL=C.",
    input_schema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        timeout: { type: "number", description: "Milliseconds, max 600000." },
      },
    },
  },
  {
    name: "Glob",
    description: "Find files matching a glob pattern. ** matches directories, * matches files.",
    input_schema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "e.g. **/*.test.ts" },
        path: { type: "string", description: "Base path; default project_root." },
      },
    },
  },
  {
    name: "Grep",
    description: "Search file contents with regex. Returns matching files or matching lines.",
    input_schema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        output_mode: { type: "string", enum: ["files_with_matches", "content"] },
      },
    },
  },
  {
    // doubt-driven eskalasyon — executeTool'da YOK; CodegenBaseController turn-loop'ta
    // intercept eder (askq'ya çevirir). Yalnızca allowed_tools'ta olan fazlarda görünür.
    name: "AskUserQuestion",
    description:
      "Escalate ONE genuinely uncertain, hard-to-reverse decision to the user instead of guessing. Use RARELY — only when the spec, existing code, and a reasonable default all fail to resolve it. Routine choices (naming, file layout, obvious defaults) must NOT use this; pick the sensible default and note it.",
    input_schema: {
      type: "object",
      required: ["question", "options"],
      properties: {
        question: { type: "string", description: "The decision, in English, 1-2 sentences." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "2-4 concrete English choices the user can pick.",
        },
        context: { type: "string", description: "Optional 1-2 sentence English background." },
      },
    },
  },
] as const;

/* ============================================================
 * Dispatcher
 * ============================================================ */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  log.info("tool-handlers", "execute", { tool: name });
  switch (name) {
    case "Read":
      return handleRead(input, ctx);
    case "Write":
      return handleWrite(input, ctx);
    case "Edit":
      return handleEdit(input, ctx);
    case "Bash":
      return handleBash(input, ctx);
    case "Glob":
      return handleGlob(input, ctx);
    case "Grep":
      return handleGrep(input, ctx);
    default:
      return { content: `unknown tool: ${name}`, is_error: true };
  }
}
