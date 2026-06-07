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
//   --allowedTools/--disallowedTools, --no-session-persistence,
//   --append-system-prompt. (v15.9: --max-budget-usd KALDIRILDI — gerekli
//   codegen'i kesiyordu; maliyet sınırı bu sürümde YOK, --max-turns de YOK.)
//
// Güvenlik (SDK bash-guard/path-sandbox paritesi KISMİ): cwd=project_root +
// --add-dir <project_root> ile dosya erişimi sınırlı; --disallowedTools ile
// tehlikeli bash reddedilir; env safeEnv() (API key ENJEKTE EDİLMEZ → abonelik
// OAuth/keychain). --bare KULLANILMAZ: claude --help'e göre "OAuth and keychain
// are never read" — aboneliği kırardı (kullanıcı API key'siz CLI kullanıyor).
// İnce write-deny (.mycl/ vb.) tam birebir değil — not.
//
// UYARI: stream-json olay şeması + permission-mode davranışı CANLI doğrulama
// ister (gerçek `claude -p` koşumu, LLM maliyeti). Parser defansif yazıldı.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { MAIN_AGENT_LANGUAGE_REMINDER } from "../agent-language.js";
import { guardSandboxOrWarn, sandboxSettingsArgs } from "../agent-sandbox.js";
import { noteRateLimitEvent, type RateLimitInfo } from "../cli-rate-limit.js";
import type { CodegenOutcome, CodegenRunOpts } from "../base/codegen-controller.js";
import type { CodegenBackend } from "./backend.js";
import { emitChatMessage, emitClaudeStream, recordTokenUsage } from "../ipc.js";
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

// undefined = henüz çözülmedi; null = bulunamadı; string = mutlak yol.
let claudePathCache: string | null | undefined;

/**
 * `claude` CLI'ın MUTLAK yolunu çöz. Paketlenmiş .app Finder'dan açılınca PATH
 * minimaldir (`/usr/bin:/bin`...) ve `claude` standart kurulumda `~/.local/bin`'de
 * → düz `command -v claude` (minimal PATH) onu BULAMAZ. Bilinen konumlar + login
 * shell fallback ile sağlam çöz. Sonuç process boyunca cache'lenir.
 */
export function resolveClaudePath(): string | null {
  if (claudePathCache !== undefined) return claudePathCache;
  const home = homedir();
  const candidates = [
    join(home, ".local", "bin", "claude"), // resmi installer (claude.ai/install.sh)
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      claudePathCache = c;
      return c;
    }
  }
  // Login shell fallback — kullanıcı profili (nvm/asdf/özel PATH) yüklensin.
  for (const shell of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (!existsSync(shell)) continue;
    try {
      const out = execSync(`${shell} -lc 'command -v claude'`, {
        timeout: 3000,
        encoding: "utf-8",
      }).trim();
      if (out && existsSync(out)) {
        claudePathCache = out;
        return out;
      }
    } catch {
      /* bu shell başarısız — sıradakini dene */
    }
  }
  claudePathCache = null;
  return null;
}

/** `claude` CLI erişilebilir mi? (resolveClaudePath != null) */
export function isClaudeAvailable(): boolean {
  return resolveClaudePath() !== null;
}

/**
 * `claude` spawn'ı için env: safeEnv() + claude'un bulunduğu dizin ve bilinen bin
 * konumları PATH'in başına eklenir → claude kendi alt-process'lerini (node, rg)
 * ve kendini bulabilsin. API key ENJEKTE EDİLMEZ → abonelik (oauthAccount).
 */
// v15.14 (F2): prompt cache ömrü — modül-singleton (setSandboxPolicy deseni). index.ts
// config yüklenince setCacheTtl ile set eder; claudeSpawnEnv "1h"de ENABLE_PROMPT_CACHING_1H
// enjekte eder (CLI/abonelik yolu; 3 spawn noktası bu env'i kullanır → tek nokta, threadleme yok).
let _cacheTtl: "5m" | "1h" = "5m";
export function setCacheTtl(ttl: "5m" | "1h" | undefined): void {
  _cacheTtl = ttl === "1h" ? "1h" : "5m";
}

export function claudeSpawnEnv(): NodeJS.ProcessEnv {
  const base = safeEnv();
  const home = homedir();
  const resolved = resolveClaudePath();
  const extras = [
    resolved ? dirname(resolved) : "",
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter(Boolean);
  const prev = base.PATH ?? "";
  return {
    ...base,
    PATH: [...extras, prev].filter(Boolean).join(":"),
    LC_ALL: "C",
    // v15.14 (macOS izin pencereleri): claude'un IDE/tarayıcı oto-bağlanma taraması
    // (DevToolsActivePort: Chrome/Brave/Edge + kurulu-uygulama enumerasyonu) macOS TCC'de
    // "başka uygulama verisi / Downloads / Apple Music" izinlerini tetikliyordu. MyCL claude'u
    // HEADLESS sürüyor — IDE'ye bağlanmaya/gereksiz trafiğe İHTİYACI YOK → ikisini de kapat
    // (claude env'le sorunsuz çalışıyor, doğrulandı). Tarama olmadan TCC prompt'u çıkmaz.
    CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // F2: 1 saatlik prompt cache (yalnız "1h"de; aksi env'e KOYMA = 5dk varsayılan).
    ...(_cacheTtl === "1h" ? { ENABLE_PROMPT_CACHING_1H: "1" } : {}),
  };
}

/**
 * agent-skills dizini opt-in tespiti (`<config>/agent-skills`).
 *
 * Skills'i AÇIKÇA --plugin-dir ile bağlarız: kullanıcının global plugin
 * setine bağımlı olmadan MyCL'in agent-skills'ini deterministik yükler.
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
    // v15.11 GÜVENLİK: spawn-öncesi sandbox kapısı (enforce + sandbox yok → çalıştırma).
    if (!guardSandboxOrWarn()) {
      return { kind: "failed", reason: "sandbox kurulamadı (policy=enforce) — codegen çalıştırılmadı" };
    }
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
      // Mutlak yol — minimal PATH'te bare "claude" ENOENT verir (paketlenmiş .app).
      const claudeBin = resolveClaudePath() ?? "claude";
      const child = spawn(claudeBin, args, {
        cwd: opts.state.project_root,
        // v15.8: API key ENJEKTE EDİLMEZ → abonelik (oauthAccount); PATH zenginleştirilir
        // (claudeSpawnEnv) ki claude kendi alt-process'lerini bulsun.
        env: claudeSpawnEnv(),
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
    if (type === "rate_limit_event") {
      // v15.12 Auto Mode: abonelik usage-limit + resetsAt sinyali.
      noteRateLimitEvent(ev.rate_limit_info as RateLimitInfo | undefined);
      return;
    }
    if (type === "assistant") {
      const msg = ev.message as { content?: unknown[] } | undefined;
      const content = Array.isArray(msg?.content) ? msg!.content : [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          emitClaudeStream({ sub: "text", text: b.text });
          if (this.opts.onTestResult) {
            for (const r of parseTestResultMarkers(b.text)) {
              this.opts.onTestResult(r.green, r.detail);
            }
          }
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
        const u = {
          input_tokens: Number(usage.input_tokens ?? 0),
          output_tokens: Number(usage.output_tokens ?? 0),
          cache_read_input_tokens: Number(usage.cache_read_input_tokens ?? 0),
          cache_creation_input_tokens: Number(usage.cache_creation_input_tokens ?? 0),
        };
        emitClaudeStream({ sub: "token_usage", usage: u });
        // F1: codegen fazının faz-maliyet kovasını doldur + gerçek $ + model (eskiden
        // cost yalnız loglanıp atılıyordu; kova hiç dolmuyordu). Aktif kova yoksa no-op.
        recordTokenUsage({ ...u, total_cost_usd: cost, model: this.opts.modelId });
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
    // v15.12: user mesajına İngilizce-çıktı hatırlatması (recency, belt-and-suspenders).
    const args: string[] = [
      "-p",
      `${opts.initialUserMessage}\n\n${MAIN_AGENT_LANGUAGE_REMINDER}`,
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
      "--no-session-persistence",
      // v15.9: --max-budget-usd KALDIRILDI (Ümit). $2 cap opus/ultracode tam-app
      // codegen'ini ortada kesiyordu (Faz 5 exit=1 → degraded). Maliyet sınırı
      // gerekli işi kesmemeli; gereksiz harcama ajan scope disiplini + faz/tur
      // yapısıyla önlenir, $-cap ile değil.
    ];
    // agent-skills opt-in: dizin varsa --plugin-dir ile açıkça bağla.
    const skillsDir = resolveSkillsDir();
    if (skillsDir) {
      args.push("--plugin-dir", skillsDir);
    }
    // v15.11 GÜVENLİK: --settings ile sandbox (+ ultracode) — ajanı proje-root'a hapset.
    args.push(...sandboxSettingsArgs(opts.state.project_root, effort === "ultracode"));
    if (effort && effort !== "ultracode") {
      args.push("--effort", effort);
    }
    return args;
  }
}

/**
 * v15.8: Ajan metnindeki `MYCL_TEST_RESULT: green|red[: <neden>]` marker'larını
 * çıkar (Faz 8 TDD self-report; CLI stream-json tool_result.is_error taşımaz).
 * REGEX YOK — düz substring satır taraması (kullanıcı kuralı). Saf + test edilebilir.
 */
export function parseTestResultMarkers(
  text: string,
): Array<{ green: boolean; detail: string }> {
  const MARKER = "MYCL_TEST_RESULT:";
  const out: Array<{ green: boolean; detail: string }> = [];
  for (const line of text.split("\n")) {
    const idx = line.indexOf(MARKER);
    if (idx < 0) continue;
    const rest = line.slice(idx + MARKER.length).trim();
    const lower = rest.toLowerCase();
    if (lower.startsWith("green")) out.push({ green: true, detail: rest });
    else if (lower.startsWith("red")) out.push({ green: false, detail: rest });
  }
  return out;
}
