// cli-run — genel, tek-atışlık `claude` CLI çalıştırıcı (abonelik auth).
//
// v15.8 (2026-05-31): translator + orchestrator rolleri "cli" backend'inde bunu
// kullanır. codegen'in CliCodegenBackend'i kendi UI-stream'li loop'unu kullanır;
// bu helper UI-panel/observer KÖPRÜSÜ OLMADAN sadece sonucu (metin + tool_use'lar
// + turn/hata) toplar. API key ENJEKTE EDİLMEZ → kurulu abonelik (oauthAccount).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { safeEnv } from "./safe-env.js";
import { log } from "./logger.js";

export interface CliRunOpts {
  systemPrompt: string;
  userMessage: string;
  modelId: string;
  /** claude'un çalışacağı dizin (read-only roller için zararsız). */
  cwd: string;
  /** İzinli built-in tool'lar (örn. ["Read","Grep","Bash","Glob"]). Boş/undefined → araç bayrağı yok. */
  allowedTools?: string[];
  /** Reddedilen tool kalıpları (örn. ["Write","Edit","Bash(rm *)"]). */
  disallowedTools?: string[];
  /** "ultracode" → --settings; diğerleri → --effort. */
  effort?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
}

export interface CliRunResult {
  ok: boolean;
  /** Birleştirilmiş assistant metni (tool_use bloklar hariç). */
  text: string;
  toolUses: Array<{ name: string; input: Record<string, unknown> }>;
  turns: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function buildArgs(opts: CliRunOpts): string[] {
  const args: string[] = [
    "-p",
    opts.userMessage,
    "--append-system-prompt",
    opts.systemPrompt,
    "--model",
    opts.modelId,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits", // non-interactive: izin beklemede ASILMASIN
    "--add-dir",
    opts.cwd,
    "--no-session-persistence",
  ];
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(" "));
  }
  if (opts.disallowedTools && opts.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...opts.disallowedTools);
  }
  if (opts.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  }
  if (opts.effort) {
    if (opts.effort === "ultracode") {
      args.push("--settings", JSON.stringify({ ultracode: true }));
    } else {
      args.push("--effort", opts.effort);
    }
  }
  return args;
}

/**
 * `claude` CLI'ı tek-atışta çalıştırır, tüm assistant metnini + tool_use'ları toplar.
 * Hata/timeout durumunda `{ ok:false, error }` döner — caller SDK'ya düşebilir.
 */
export function runClaudeCli(opts: CliRunOpts): Promise<CliRunResult> {
  const args = buildArgs(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<CliRunResult>((resolve) => {
    let settled = false;
    const texts: string[] = [];
    const toolUses: CliRunResult["toolUses"] = [];
    let turns = 0;
    let resultIsError = false;
    let resultSeen = false;
    let stderrTail = "";

    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env: { ...safeEnv(), LC_ALL: "C" }, // API key YOK → abonelik
      stdio: ["ignore", "pipe", "pipe"],
    });

    const done = (r: CliRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* zaten bitti */ }
      resolve(r);
    };

    const timer = setTimeout(() => {
      log.warn("cli-run", "timeout — killing claude", { timeoutMs });
      done({ ok: false, text: texts.join(""), toolUses, turns, error: `cli timeout ${timeoutMs}ms` });
    }, timeoutMs);

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return; // NDJSON olmayan satır (banner) — atla
      }
      const type = ev.type;
      if (type === "assistant") {
        const msg = ev.message as { content?: unknown[] } | undefined;
        for (const block of Array.isArray(msg?.content) ? msg!.content : []) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            texts.push(b.text);
          } else if (b.type === "tool_use") {
            toolUses.push({
              name: String(b.name ?? ""),
              input: (b.input as Record<string, unknown>) ?? {},
            });
          }
        }
      } else if (type === "result") {
        resultSeen = true;
        resultIsError = ev.is_error === true || ev.subtype === "error";
        if (typeof ev.num_turns === "number") turns = ev.num_turns;
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    child.on("error", (err) => {
      done({ ok: false, text: texts.join(""), toolUses, turns, error: `spawn failed: ${String(err)}` });
    });

    child.on("close", (code) => {
      const ok = code === 0 && (!resultSeen || !resultIsError);
      done({
        ok,
        text: texts.join(""),
        toolUses,
        turns,
        error: ok ? undefined : `claude exit=${code}${stderrTail ? ` :: ${stderrTail.slice(0, 300)}` : ""}`,
      });
    });
  });
}
