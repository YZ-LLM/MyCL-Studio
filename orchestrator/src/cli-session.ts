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
import { sandboxSettingsArgs } from "./agent-sandbox.js";
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

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface CliSessionResult {
  ok: boolean;
  text: string;
  toolUses: Array<{ name: string; input: Record<string, unknown> }>;
  turns: number;
  error?: string;
  /** result olayından alınan token kullanımı (faz-başına maliyet raporu için). */
  usage?: TokenUsage;
}

// IDLE timeout: claude'tan bu kadar süre HİÇ çıktı gelmezse (gerçekten asılı)
// öldür. Her stdout/stderr satırında sıfırlanır → uzun-ama-aktif tur (tool-yoğun
// Faz 9 risk-review, 32k thinking) cezalandırılmaz. Mutlak değil, idle.
const DEFAULT_TIMEOUT_MS = 300_000;

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
    // v15.10: partial mesajlar — uzun thinking/sentez sırasında token delta'ları
    // stream'lenir → idle timer gerçek ilerlemede sıfırlanır, yalnız GERÇEK hang'de
    // (delta yok) tetiklenir. Çok-turlu qa-askq resume'unun sessiz asılmasını çözer.
    "--include-partial-messages",
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
  // v15.11 GÜVENLİK: --settings ile sandbox (+ ultracode) — ajanı opts.cwd'ye hapset.
  args.push(...sandboxSettingsArgs(opts.cwd, opts.effort === "ultracode"));
  if (opts.effort && opts.effort !== "ultracode") {
    args.push("--effort", opts.effort);
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
    let usage: TokenUsage | undefined;

    const child = spawn(claudeBin, args, {
      cwd: opts.cwd,
      env: claudeSpawnEnv(), // API key YOK → abonelik; PATH zenginleştirilir
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timer: ReturnType<typeof setTimeout>;
    const done = (r: CliSessionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* zaten bitti */ }
      resolve(r);
    };

    // IDLE-bazlı kill: her stdout/stderr satırında sıfırlanır → uzun ama aktif
    // tur (tool-yoğun review) öldürülmez; yalnızca timeoutMs boyunca HİÇ çıktı
    // gelmezse (gerçekten asılı) öldürür.
    const resetTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        log.warn("cli-session", "idle timeout — killing claude", { timeoutMs, resume: opts.resume });
        done({ ok: false, text: texts.join(""), toolUses, turns, usage, error: `cli idle timeout ${timeoutMs}ms` });
      }, timeoutMs);
    };
    resetTimer();

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      resetTimer();
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
        const u = ev.usage as Record<string, unknown> | undefined;
        if (u) {
          usage = {
            input_tokens: Number(u.input_tokens ?? 0),
            output_tokens: Number(u.output_tokens ?? 0),
            cache_read_input_tokens: Number(u.cache_read_input_tokens ?? 0),
            cache_creation_input_tokens: Number(u.cache_creation_input_tokens ?? 0),
          };
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      // NOT: idle timer'ı SIFIRLAMA — stderr gürültüsü (rate-limit retry vb.)
      // gerçek bir stdout-hang'i maskelemesin. Canlılık sinyali yalnız stdout
      // (partial mesajlar dahil). Sadece tail'i tut (hata teşhisi).
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
        usage,
        error: ok ? undefined : `claude exit=${code}${stderrTail ? ` :: ${stderrTail.slice(0, 300)}` : ""}`,
      });
    });
  });
}
