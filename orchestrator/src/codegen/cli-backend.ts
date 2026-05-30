// codegen/cli-backend — Claude Code CLI (`claude -p`) tabanlı codegen backend.
//
// v15.8 (2026-05-30): Flag açıkken (Settings → Özellikler → Claude Code CLI)
// codegen fazları (Phase 5 + verify-feature) main ajanı SDK turn-loop yerine
// `claude` CLI subprocess'i ile çalıştırır.
//
// Gerçek bayraklar (claude 2.1.141 ile doğrulandı):
//   -p / --print, --model, --effort (low/medium/high/xhigh/max),
//   --settings '{"ultracode":true}' (ultracode efor seviyesi DEĞİL — ayrı ayar),
//   --output-format stream-json --verbose, --permission-mode, --add-dir,
//   --allowedTools/--disallowedTools, --bare, --no-session-persistence,
//   --max-budget-usd (maliyet sınırı; bu sürümde --max-turns YOK),
//   --append-system-prompt.
//
// Güvenlik (SDK bash-guard/path-sandbox paritesi KISMİ): cwd=project_root +
// --add-dir <project_root> ile dosya erişimi sınırlı; --disallowedTools ile
// tehlikeli bash reddedilir; env safeEnv() + explicit ANTHROPIC_API_KEY (--bare
// keychain okumaz). İnce write-deny (.mycl/ vb.) tam birebir değil — not.
//
// UYARI: stream-json olay şeması + permission-mode davranışı CANLI doğrulama
// ister (gerçek `claude -p` koşumu, LLM maliyeti). Parser defansif yazıldı.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CodegenOutcome, CodegenRunOpts } from "../base/codegen-controller.js";
import type { CodegenBackend } from "./backend.js";
import { emitChatMessage, emitClaudeStream } from "../ipc.js";
import { log } from "../logger.js";
import { globalConfigDir } from "../paths.js";
import { safeEnv } from "../safe-env.js";

/** Tehlikeli bash → CLI --disallowedTools (bash-guard'ın CLI karşılığı, kısmi). */
const DISALLOWED_TOOLS = [
  "Bash(rm *)",
  "Bash(sudo *)",
  "Bash(git push *)",
  "Bash(chmod *)",
  "Bash(npm publish *)",
  "Bash(yarn publish *)",
  "Bash(pnpm publish *)",
];

/** Codegen'in ihtiyaç duyduğu araçlar (auto-approve allowlist). */
const ALLOWED_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];

/** Maliyet sınırı (USD) — kullanıcı maliyet-duyarlı; runaway koruması. */
const DEFAULT_MAX_BUDGET_USD = 2.0;

let claudeAvailableCache: boolean | null = null;

/** `claude` CLI sistemde var mı? Sync + cache (factory sync olduğu için). */
export function isClaudeAvailable(): boolean {
  if (claudeAvailableCache !== null) return claudeAvailableCache;
  try {
    execSync("command -v claude", { stdio: "ignore", timeout: 3000 });
    claudeAvailableCache = true;
  } catch {
    claudeAvailableCache = false;
  }
  return claudeAvailableCache;
}

/**
 * agent-skills dizini opt-in tespiti (`<config>/agent-skills`).
 *
 * `--bare` plugin-sync'i atladığı için skills'i AÇIKÇA bağlamak gerek
 * (claude --help: "Skills still resolve via /skill-name … --plugin-dir").
 * Auto-clone YAPILMAZ (runtime network/supply-chain riski) — kullanıcı bir kez
 * `git clone https://github.com/addyosmani/agent-skills ~/.mycl/agent-skills`.
 */
export function resolveSkillsDir(): string | null {
  try {
    const dir = join(globalConfigDir(), "agent-skills");
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** skills ipucu process başına bir kez gösterilsin (spam yok). */
let skillsHintShown = false;

export class CliCodegenBackend implements CodegenBackend {
  private child: ChildProcess | null = null;
  private aborted = false;

  constructor(private readonly opts: CodegenRunOpts) {}

  abort(): void {
    this.aborted = true;
    if (this.child && this.child.pid) {
      try {
        // Negatif pid = process group (detached değil ama yine de tree dene).
        this.child.kill("SIGTERM");
      } catch (err) {
        log.warn("cli-backend", "abort kill failed", err);
      }
    }
  }

  async run(): Promise<CodegenOutcome> {
    const { opts } = this;
    const effort = opts.config.claude_code_flags.effort ?? "max";
    const args = this.buildArgs(effort);

    const skillsDir = resolveSkillsDir();
    if (skillsDir) {
      log.info("cli-backend", "agent-skills bound", { dir: skillsDir });
    } else if (!skillsHintShown) {
      skillsHintShown = true;
      emitChatMessage(
        "system",
        "💡 İpucu: senior-engineer workflow skill'lerini bağlamak için bir kez:\n`git clone https://github.com/addyosmani/agent-skills ~/.mycl/agent-skills`",
      );
    }

    log.info("cli-backend", "spawning claude CLI", {
      tag: opts.tag,
      model: opts.modelId,
      effort,
      cwd: opts.state.project_root,
    });
    emitClaudeStream({
      sub: "init",
      text: `cli-${opts.tag}`,
      model: opts.modelId,
      cwd: opts.state.project_root,
    });
    emitChatMessage(
      "system",
      `🤖 Claude Code CLI çalıştırılıyor (model: ${opts.modelId}, efor: ${effort})…`,
    );

    return new Promise<CodegenOutcome>((resolve) => {
      const child = spawn("claude", args, {
        cwd: opts.state.project_root,
        env: { ...safeEnv(), ANTHROPIC_API_KEY: opts.apiKey, LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;

      let resultIsError = false;
      let resultSeen = false;
      let numTurns = 0;
      let stderrTail = "";

      const rl = createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return; // NDJSON olmayan satır (banner vs.) — atla
        }
        try {
          this.handleEvent(ev, (turns, isErr) => {
            if (typeof turns === "number") numTurns = turns;
            if (typeof isErr === "boolean") {
              resultIsError = isErr;
              resultSeen = true;
            }
          });
        } catch (err) {
          log.warn("cli-backend", "event handler threw", err);
        }
      });

      child.stderr!.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });

      child.on("error", (err) => {
        log.error("cli-backend", "spawn error", err);
        resolve({ kind: "failed", reason: `claude CLI spawn failed: ${String(err)}` });
      });

      child.on("close", (code) => {
        this.child = null;
        emitClaudeStream({ sub: "stop", text: `cli-${opts.tag} done` });
        if (this.aborted) {
          resolve({ kind: "aborted", turns: numTurns });
          return;
        }
        // Başarı: exit 0 + result event'i is_error=false (veya result hiç
        // gelmediyse exit 0'a güven).
        if (code === 0 && (!resultSeen || !resultIsError)) {
          resolve({ kind: "done", turns: numTurns });
        } else {
          resolve({
            kind: "failed",
            reason: `claude CLI exit=${code}${stderrTail ? ` :: ${stderrTail.slice(0, 300)}` : ""}`,
          });
        }
      });
    });
  }

  /** stream-json olayını emitClaudeStream + observer'a köprüle. */
  private handleEvent(
    ev: Record<string, unknown>,
    onResult: (turns?: number, isError?: boolean) => void,
  ): void {
    const type = ev.type;
    if (type === "system") {
      // init — model/cwd zaten emit edildi; tekrar gerekmez.
      return;
    }
    if (type === "assistant") {
      const msg = ev.message as { content?: unknown[] } | undefined;
      const content = Array.isArray(msg?.content) ? msg!.content : [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          emitClaudeStream({ sub: "text", text: b.text });
        } else if (b.type === "tool_use") {
          const name = String(b.name ?? "");
          const input = (b.input as Record<string, unknown>) ?? {};
          emitClaudeStream({ sub: "tool_use", tool_name: name, tool_input: input });
          // Observer köprüsü — Phase 5 "ui-file-write" audit'i bu sayede çalışır.
          // stream-json tool_result'ı ayrı vermediği için is_error=false varsayılır.
          if (this.opts.observer) {
            void this.opts
              .observer({ tool_use: { name, input }, result: { is_error: false } })
              .catch((err) => log.warn("cli-backend", "observer threw", err));
          }
        }
      }
      return;
    }
    if (type === "result") {
      const isError = ev.is_error === true || ev.subtype === "error";
      const turns = typeof ev.num_turns === "number" ? ev.num_turns : undefined;
      const cost = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined;
      const usage = ev.usage as Record<string, unknown> | undefined;
      if (usage) {
        emitClaudeStream({
          sub: "token_usage",
          usage: {
            input_tokens: Number(usage.input_tokens ?? 0),
            output_tokens: Number(usage.output_tokens ?? 0),
            cache_read_input_tokens: Number(usage.cache_read_input_tokens ?? 0),
            cache_creation_input_tokens: Number(usage.cache_creation_input_tokens ?? 0),
          },
        });
      }
      if (cost !== undefined) {
        log.info("cli-backend", "run cost", { cost_usd: cost, turns });
      }
      onResult(turns, isError);
    }
  }

  private buildArgs(effort: string): string[] {
    const { opts } = this;
    // Faz EN system prompt + EN task — translator zaten EN üretti (mimari sınır).
    const args: string[] = [
      "-p",
      opts.initialUserMessage,
      "--append-system-prompt",
      opts.systemPrompt,
      "--model",
      opts.modelId,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ALLOWED_TOOLS.join(" "),
      "--disallowedTools",
      DISALLOWED_TOOLS.join(" "),
      "--add-dir",
      opts.state.project_root,
      "--bare",
      "--no-session-persistence",
      "--max-budget-usd",
      String(DEFAULT_MAX_BUDGET_USD),
    ];
    // agent-skills opt-in: dizin varsa --plugin-dir ile bağla (--bare sync'i atlar).
    const skillsDir = resolveSkillsDir();
    if (skillsDir) {
      args.push("--plugin-dir", skillsDir);
    }
    // Efor: ultracode AYRI ayar (--effort değil); diğerleri --effort.
    if (effort === "ultracode") {
      args.push("--settings", JSON.stringify({ ultracode: true }));
    } else {
      args.push("--effort", effort);
    }
    return args;
  }
}
