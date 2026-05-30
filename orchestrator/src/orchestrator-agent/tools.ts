// orchestrator-agent/tools — read-only tool tanımları + Bash safe-list.
//
// Agent KARARLI olmak için spec.md / kod okuyabilir; ama Write/Edit YASAK.
// Bash sadece read-only komutlara (ls/pwd/cat/git status vb.) izin verir;
// destructive (rm, >, &&, ;) execute YASAK.

import type { ToolDef } from "../claude-api.js";
import { DECIDE_ACTION_TOOL_SCHEMA } from "./decision.js";
import {
  extractPathTokensFromBash,
  validatePathForAgent,
} from "./path-sandbox.js";

/**
 * Bash safe-list — komut ilk token bunlardan biri ise PASS, değilse reject.
 * Multi-command (`;`, `&&`, `|`, redirect `>`, `>>`) tek seferde reject —
 * agent niyeti basit bir okuma değil, kompleks shell scripting demek.
 */
const SAFE_BASH_FIRST_TOKEN: ReadonlySet<string> = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc",
  "git",  // sadece git status/log/diff — alt-komut güvenliği aşağıda
  "find", "echo",  // echo tutarlı debug için
]);

const SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "branch", "remote", "config",
]);

const DESTRUCTIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /;/, /&&/, /\|\|/, /\|/, />/, /</, /\$\(/, /`/,  // shell metakarakter
  /\brm\b/, /\bmv\b/, /\bcp\b/, /\bchmod\b/, /\bchown\b/,
  /\bcurl\b/, /\bwget\b/, /\bnc\b/, /\bssh\b/,
];

export interface BashValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * v15.6 (2026-05-24): `projectRoot` opsiyonel parametre eklendi — proje
 * izolasyonu için path argüman sandbox. Verilirse her absolute / `~` / `..`
 * ile başlayan token validate edilir; root dışına işaret ediyorsa reject.
 * Geriye uyumlu: mevcut çağrılar (test'ler) projectRoot vermeden çalışır.
 */
export function validateBashCommand(
  cmd: string,
  projectRoot?: string,
): BashValidationResult {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty command" };
  }
  // Destructive pattern check
  for (const pat of DESTRUCTIVE_PATTERNS) {
    if (pat.test(trimmed)) {
      return { ok: false, reason: `destructive pattern matched: ${pat}` };
    }
  }
  // İlk token kontrolü
  const firstToken = trimmed.split(/\s+/)[0];
  if (!firstToken || !SAFE_BASH_FIRST_TOKEN.has(firstToken)) {
    return {
      ok: false,
      reason: `command not in safe-list: ${firstToken ?? "(empty)"} (allowed: ${[...SAFE_BASH_FIRST_TOKEN].join(", ")})`,
    };
  }
  // git özel: alt-komut kontrolü
  if (firstToken === "git") {
    const sub = trimmed.split(/\s+/)[1];
    if (!sub || !SAFE_GIT_SUBCOMMANDS.has(sub)) {
      return {
        ok: false,
        reason: `git subcommand not allowed: ${sub ?? "(missing)"} (allowed: ${[...SAFE_GIT_SUBCOMMANDS].join(", ")})`,
      };
    }
  }
  // v15.6: path argüman sandbox (projectRoot verildiyse)
  if (projectRoot) {
    const pathTokens = extractPathTokensFromBash(trimmed);
    for (const token of pathTokens) {
      const v = validatePathForAgent(projectRoot, token);
      if (!v.ok) {
        return {
          ok: false,
          reason: `path argument outside project root: ${token} (${v.reason})`,
        };
      }
    }
  }
  return { ok: true };
}

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: "Read",
    description:
      "Dosya oku (UTF-8 metin). Path ZORUNLU olarak `state.project_root` " +
      "altında olmalı — başka proje veya home dizini (~) erişimi REDDEDİLİR. " +
      "Symlink ile escape de engellenir. Tipik kullanım: spec.md, brief.md, " +
      "kaynak dosyalar bug araştırması için.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Project root altında absolute veya relative yol. Dışına çıkarsa tool error döner.",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "Grep",
    description:
      "Pattern arama (extended regex, recursive). Path ZORUNLU olarak " +
      "`state.project_root` altında olmalı. Tipik kullanım: error message " +
      "tracking, API endpoint bulma, function locate.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "regex pattern" },
        path: {
          type: "string",
          description:
            "Project root altında file veya dir. Dışına çıkarsa tool error döner.",
        },
      },
      required: ["pattern", "path"],
    },
  },
  {
    name: "Bash",
    description:
      "Read-only shell komutları: ls, pwd, cat, head, tail, wc, find, " +
      "git status/log/diff/show/branch/remote/config. Destructive YASAK " +
      "(rm, mv, cp, chmod, network calls, pipes, redirects, command chaining). " +
      "Yol argümanları proje root altında olmalı — absolute path ile başka " +
      "proje erişimi REDDEDİLİR.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Tek read-only shell komutu." },
      },
      required: ["command"],
    },
  },
  {
    name: "decide_action",
    description:
      "ZORUNLU son tool çağrısı. Agent kararını yapılandırılmış JSON ile döner. " +
      "action + reason ZORUNLU; target_phase sadece run_phase için; " +
      "message_to_user opsiyonel (chat/ask_clarify için).",
    input_schema: DECIDE_ACTION_TOOL_SCHEMA,
  },
];
