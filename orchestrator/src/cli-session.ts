// cli-session — resume-yetenekli `claude` CLI çalıştırıcı (interaktif fazlar için).
//
// runClaudeCli tek-atıştır (--no-session-persistence). Faz-ortası askq gereken
// fazlar (qa-askq, production-schema approval, Faz 0 D2) için: ilk tur --session-id
// <uuid> ile başlatılır, ajan soru yazıp bitince MyCL kullanıcıya sorar, cevabı
// --resume <uuid> ile aynı oturuma geri besler. Her tur ayrı process (hata
// izolasyonu); oturum bağlamı claude'un kendi disk oturumunda taşınır.
//
// Abonelik: API key ENJEKTE EDİLMEZ (claudeSpawnEnv). cli-run.ts ile aynı parse;
// ek olarak onText (UI stream köprüsü) + observer (Faz 8 tool_use) callback'leri.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { claudeSpawnEnv, resolveClaudePath } from "./codegen/cli-backend.js";
import { log } from "./logger.js";

export interface CliSessionTurnOpts {
  /** Sabit oturum kimliği (faz-instance başına bir uuid, tüm turlar aynı). */
  sessionId: string;
  /** İlk tur false (--session-id); sonraki turlar true (--resume). */
  resume: boolean;
  /** İlk tur: görev metni; sonraki turlar: askq cevabı (EN). */
  userMessage: string;
  /** Sadece ilk turda --append-system-prompt olarak geçer. */
  systemPrompt?: string;
  modelId: string;
  cwd: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  effort?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** Assistant metin parçaları geldikçe (UI stream köprüsü). */
  onText?: (text: string) => void;
  /** Her tool_use için (Faz 8 observer köprüsü). */
  observer?: (toolUse: { name: string; input: Record<string, unknown> }) => void;
}

export interface CliSessionResult {
  ok: boolean;
  text: string;
  toolUses: Array<{ name: string; input: Record<string, unknown> }>;
  turns: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;

function buildArgs(opts: CliSessionTurnOpts): string[] {
  const args: string[] = ["-p", opts.userMessage];
  if (opts.resume) {
    args.push("--resume", opts.sessionId);
  } else {
    args.push("--session-id", opts.sessionId);
    if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
  }
  args.push(
    "--model",
    opts.modelId,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits", // non-interactive: izin beklemede ASILMASIN
    "--add-dir",
    opts.cwd,
  );
  // NOT: --no-session-persistence KOYMA — --resume oturumun diskte olmasını gerektirir.
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", ...opts.allowedTools);
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
 * Tek oturum-turu çalıştır (ilk veya resume). Tüm assistant metnini + tool_use'ları
 * toplar. Hata/timeout → { ok:false, error }.
 */
export function runClaudeCliSession(opts: CliSessionTurnOpts): Promise<CliSessionResult> {
  const args = buildArgs(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const claudeBin = resolveClaudePath() ?? "claude";

  return new Promise<CliSessionResult>((resolve) => {
    let settled = false;
    const texts: string[] = [];
    const toolUses: CliSessionResult["toolUses"] = [];
    let turns = 0;
    let resultIsError = false;
    let resultSeen = false;
    let stderrTail = "";

    const child = spawn(claudeBin, args, {
      cwd: opts.cwd,
      env: claudeSpawnEnv(), // API key YOK → abonelik; PATH zenginleştirilir
      stdio: ["ignore", "pipe", "pipe"],
    });

    const done = (r: CliSessionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* zaten bitti */ }
      resolve(r);
    };

    const timer = setTimeout(() => {
      log.warn("cli-session", "timeout — killing claude", { timeoutMs, resume: opts.resume });
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
            opts.onText?.(b.text);
          } else if (b.type === "tool_use") {
            const tu = {
              name: String(b.name ?? ""),
              input: (b.input as Record<string, unknown>) ?? {},
            };
            toolUses.push(tu);
            opts.observer?.(tu);
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
