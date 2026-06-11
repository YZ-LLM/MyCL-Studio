// persistent-cli-session — KALICI `claude` süreci (Ümit 2026-06-11: "bir claude oturumu açıp her zaman onu kullan").
//
// SORUN: her çağrı ayrı `claude -p` süreci açıyordu → cold-start + ısı + 8 çekirdek saturasyonu. ÇÖZÜM: rol başına
// TEK kalıcı süreç (`--input-format stream-json`), stdin'den mesaj alır, stdout'tan turu okur, CANLI kalır → respawn
// yok, ısı düşer. Biriken bağlam zengin/tutarlı çıktı verir (claude'un compaction'ı bağlamı sınırlar). Ümit: "tek
// atışlar da var olan oturumu kullansın, sadece son turn dikkate alınsın."
//
// API ASLA terk edilmez (Ümit): bu yalnız CLI/abonelik yolu. Tek bir tur bile başarısızsa caller eski cold-start
// `runClaudeCli`'ya düşer (fail-safe, regresyon yok). Turlar SERİ (tek konuşma — araya girilemez); eşzamanlı send
// kuyruğa alınır.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { guardSandboxOrWarn, sandboxSettingsArgs } from "./agent-sandbox.js";
import {
  noteRateLimitEvent,
  finalizeCliRateLimit,
  type RateLimitInfo,
} from "./cli-rate-limit.js";
import { claudeSpawnEnv, resolveClaudePath } from "./codegen/cli-backend.js";
import { recordTokenUsage } from "./ipc.js";
import { log } from "./logger.js";

export interface PersistentSessionOpts {
  /** Rol kimliği — log/teşhis için (örn. "translator-en-tr"). */
  id: string;
  modelId: string;
  systemPrompt: string;
  /** claude'un çalışacağı dizin. Tek-atış/çevirmen için zararsız (tool yok). */
  cwd: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface SessionTurnResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * Tek kalıcı claude süreci + seri tur kuyruğu. Lazy spawn (ilk send'de). Süreç ölürse sonraki send yeniden açar
 * (tur-içi ölüm → o tur {ok:false}, caller fallback). dispose() ile kapatılır.
 */
export class PersistentClaudeSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private alive = false;
  // Aktif turun çözücüleri (stdout okuyucu bunları doldurur).
  private pending: {
    texts: string[];
    resolve: (r: SessionTurnResult) => void;
    sawRateLimitBlocked: boolean;
  } | null = null;

  constructor(private opts: PersistentSessionOpts) {}

  private buildArgs(): string[] {
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      this.opts.modelId,
      "--no-session-persistence",
      "--permission-mode",
      "acceptEdits",
      "--add-dir",
      this.opts.cwd,
      "--append-system-prompt",
      this.opts.systemPrompt,
    ];
    if (this.opts.allowedTools?.length) args.push("--allowedTools", ...this.opts.allowedTools);
    if (this.opts.disallowedTools?.length) args.push("--disallowedTools", ...this.opts.disallowedTools);
    // Çevirmen/tek-atış read-only → sandbox (cwd hapsi). ultracode yok.
    args.push(...sandboxSettingsArgs(this.opts.cwd, false));
    return args;
  }

  private start(): boolean {
    if (!guardSandboxOrWarn()) return false;
    const bin = resolveClaudePath() ?? "claude";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, this.buildArgs(), {
        cwd: this.opts.cwd,
        env: claudeSpawnEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch (e) {
      log.warn("persistent-cli", `${this.opts.id}: spawn failed`, e);
      return false;
    }
    this.child = child;
    this.alive = true;
    const rl = createInterface({ input: child.stdout });
    this.rl = rl;
    rl.on("line", (line) => this.onLine(line));
    child.stderr.on("data", () => {}); // stderr'i tüket (backpressure'ı önle)
    child.on("exit", (code) => {
      this.alive = false;
      log.info("persistent-cli", `${this.opts.id}: exited`, { code });
      // Tur-içi ölüm → bekleyen turu başarısız çöz (caller fallback eder).
      if (this.pending) {
        const pend = this.pending;
        this.pending = null;
        pend.resolve({ ok: false, text: pend.texts.join(""), error: `session exited code=${code}` });
      }
      this.child = null;
      this.rl = null;
    });
    log.info("persistent-cli", `${this.opts.id}: started (persistent)`);
    return true;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !this.pending) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // banner / NDJSON-dışı
    }
    const type = ev.type;
    if (type === "rate_limit_event") {
      const info = ev.rate_limit_info as RateLimitInfo | undefined;
      noteRateLimitEvent(info);
      // blocked sinyali tur sonucu ile finalize edilir (overage kurtarabilir).
      if (info && /reject|blocked|exceeded/i.test(String(info.status ?? ""))) {
        this.pending.sawRateLimitBlocked = true;
      }
    } else if (type === "assistant") {
      const msg = ev.message as { content?: unknown[] } | undefined;
      for (const b of Array.isArray(msg?.content) ? msg!.content : []) {
        const blk = b as Record<string, unknown>;
        if (blk.type === "text" && typeof blk.text === "string") this.pending.texts.push(blk.text);
      }
    } else if (type === "result") {
      // Tur bitti. is_error → başarısız.
      const isErr = ev.is_error === true || ev.subtype === "error";
      const usage = (ev.usage ?? (ev.message as Record<string, unknown> | undefined)?.usage) as
        | Record<string, number>
        | undefined;
      if (usage) {
        recordTokenUsage({
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        });
      }
      const pend = this.pending;
      this.pending = null;
      const ok = !isErr;
      finalizeCliRateLimit(ok); // başardıysa limit temizle; blocked+fail → API'ye geç
      pend.resolve({
        ok,
        text: pend.texts.join("").trim(),
        error: ok ? undefined : "session turn is_error",
      });
    }
  }

  /** Bir turu gönder (seri kuyruk). Süreç yoksa açar. timeoutMs içinde result gelmezse {ok:false}. */
  send(userText: string, timeoutMs = 180_000): Promise<SessionTurnResult> {
    const run = (): Promise<SessionTurnResult> =>
      new Promise<SessionTurnResult>((resolve) => {
        if (!this.alive && !this.start()) {
          resolve({ ok: false, text: "", error: "session start failed" });
          return;
        }
        const child = this.child;
        if (!child) {
          resolve({ ok: false, text: "", error: "no child" });
          return;
        }
        let settled = false;
        const finish = (r: SessionTurnResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        // pending'i finish ile sar (timeout/exit ikisini de kapsasın).
        this.pending = {
          texts: [],
          sawRateLimitBlocked: false,
          resolve: finish,
        };
        const timer = setTimeout(() => {
          log.warn("persistent-cli", `${this.opts.id}: turn timeout`, { timeoutMs });
          // Timeout → süreci öldür (kirli durumdan kaçın); sonraki send yeniden açar.
          this.kill();
          finish({ ok: false, text: this.pending?.texts.join("") ?? "", error: `turn timeout ${timeoutMs}ms` });
        }, timeoutMs);
        const msg = {
          type: "user",
          message: { role: "user", content: [{ type: "text", text: userText }] },
        };
        try {
          child.stdin.write(JSON.stringify(msg) + "\n");
        } catch (e) {
          finish({ ok: false, text: "", error: `stdin write failed: ${String(e)}` });
        }
      });
    // Seri kuyruk: bir tur bitmeden sonraki başlamasın (tek konuşma).
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private kill(): void {
    this.alive = false;
    try {
      this.rl?.close();
    } catch {
      /* yut */
    }
    try {
      this.child?.kill("SIGTERM");
    } catch {
      /* yut */
    }
    this.child = null;
    this.rl = null;
  }

  dispose(): void {
    this.kill();
  }
}

// Rol-başına singleton kayıt — aynı (id) için tek kalıcı süreç paylaşılır.
const _sessions = new Map<string, PersistentClaudeSession>();

/** id'ye göre kalıcı oturumu al/oluştur. opts yalnız ilk çağrıda kullanılır (model/prompt sabit varsayılır). */
export function getPersistentSession(opts: PersistentSessionOpts): PersistentClaudeSession {
  let s = _sessions.get(opts.id);
  if (!s) {
    s = new PersistentClaudeSession(opts);
    _sessions.set(opts.id, s);
  }
  return s;
}

/** Tümünü kapat (shutdown / proje değişimi). */
export function disposeAllPersistentSessions(): void {
  for (const s of _sessions.values()) s.dispose();
  _sessions.clear();
}

// Orphan claude süreci bırakma (bellek: stray process temizle): orkestratör çıkarken kalıcı süreçleri öldür.
let _exitHookInstalled = false;
function installExitHook(): void {
  if (_exitHookInstalled) return;
  _exitHookInstalled = true;
  for (const sig of ["exit", "SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => disposeAllPersistentSessions());
  }
}
installExitHook();
