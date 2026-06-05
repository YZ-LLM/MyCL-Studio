// cli-run — genel, tek-atışlık `claude` CLI çalıştırıcı (abonelik auth).
//
// v15.8 (2026-05-31): translator + orchestrator rolleri "cli" backend'inde bunu
// kullanır. codegen'in CliCodegenBackend'i kendi UI-stream'li loop'unu kullanır;
// bu helper UI-panel/observer KÖPRÜSÜ OLMADAN sadece sonucu (metin + tool_use'lar
// + turn/hata) toplar. API key ENJEKTE EDİLMEZ → kurulu abonelik (oauthAccount).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { guardSandboxOrWarn, sandboxSettingsArgs } from "./agent-sandbox.js";
import { noteRateLimitEvent, type RateLimitInfo } from "./cli-rate-limit.js";
import { claudeSpawnEnv, resolveClaudePath } from "./codegen/cli-backend.js";
import type { TokenUsage } from "./cli-session.js";
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
  /** Assistant metin parçaları geldikçe (UI stream köprüsü). */
  onText?: (text: string) => void;
  /** Her tool_use için (review-yoğun fazların aktivitesini yüzeye çıkarır). */
  observer?: (toolUse: { name: string; input: Record<string, unknown> }) => void;
  /**
   * v15.13: claudeSpawnEnv ÜSTÜNE eklenecek ekstra env değişkenleri (örn. Agent Teams /
   * Workflow flag'leri: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, CLAUDE_CODE_WORKFLOWS). MyCL
   * tarafından enjekte edilir (process.env'den değil) → safe-env filtresi etkilemez. Yalnız
   * ilgili çağrıda set edilir → diğer çağrıların davranışı değişmez.
   */
  extraEnv?: Record<string, string>;
}

export interface CliRunResult {
  ok: boolean;
  /** Birleştirilmiş assistant metni (tool_use bloklar hariç). */
  text: string;
  toolUses: Array<{ name: string; input: Record<string, unknown> }>;
  turns: number;
  error?: string;
  /** result olayından alınan token kullanımı (faz-başına maliyet raporu için). */
  usage?: TokenUsage;
}

// IDLE timeout (mutlak değil): her stdout/stderr satırında sıfırlanır →
// uzun-ama-aktif tur öldürülmez; yalnız bu süre HİÇ çıktı gelmezse asılı sayılır.
const DEFAULT_TIMEOUT_MS = 300_000;

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
    // v15.10: partial mesajlar — uzun thinking/sentez idle-kill olmasın (stdout
    // canlılığı). Bkz cli-session.ts aynı gerekçe.
    "--include-partial-messages",
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
  // v15.11 GÜVENLİK: --settings ile sandbox (+ ultracode) — ajanı opts.cwd'ye hapset.
  args.push(...sandboxSettingsArgs(opts.cwd, opts.effort === "ultracode"));
  if (opts.effort && opts.effort !== "ultracode") {
    args.push("--effort", opts.effort);
  }
  return args;
}

/**
 * `claude` CLI'ı tek-atışta çalıştırır, tüm assistant metnini + tool_use'ları toplar.
 * Hata/timeout durumunda `{ ok:false, error }` döner — caller SDK'ya düşebilir.
 */
export function runClaudeCli(opts: CliRunOpts): Promise<CliRunResult> {
  // v15.11 GÜVENLİK: spawn-öncesi sandbox kapısı (enforce + sandbox yok → çalıştırma).
  if (!guardSandboxOrWarn()) {
    return Promise.resolve({
      ok: false,
      text: "",
      toolUses: [],
      turns: 0,
      error: "sandbox kurulamadı (policy=enforce) — ajan çalıştırılmadı",
    });
  }
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
    let usage: TokenUsage | undefined;

    // Mutlak yol + zenginleştirilmiş PATH — minimal PATH'te bare "claude" ENOENT.
    const claudeBin = resolveClaudePath() ?? "claude";
    const child = spawn(claudeBin, args, {
      cwd: opts.cwd,
      // API key YOK → abonelik; PATH zenginleştirilir. extraEnv (varsa) ÜSTE eklenir
      // (Agent Teams/Workflow flag'leri için; yoksa davranış birebir korunur).
      env: opts.extraEnv ? { ...claudeSpawnEnv(), ...opts.extraEnv } : claudeSpawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timer: ReturnType<typeof setTimeout>;
    const done = (r: CliRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* zaten bitti */ }
      resolve(r);
    };

    // IDLE-bazlı: her çıktı satırında sıfırlanır → uzun ama aktif tur öldürülmez.
    const resetTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        log.warn("cli-run", "idle timeout — killing claude", { timeoutMs });
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
      if (type === "rate_limit_event") {
        // v15.12 Auto Mode: abonelik usage-limit + resetsAt sinyali.
        noteRateLimitEvent(ev.rate_limit_info as RateLimitInfo | undefined);
      } else if (type === "assistant") {
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
      // idle timer'ı SIFIRLAMA — stderr gürültüsü stdout-hang'i maskelemesin.
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
