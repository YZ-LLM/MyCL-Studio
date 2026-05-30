// logger — NDJSON dosya bazlı diagnostic log.
//
// Hedef: orchestrator içinde olan biten her şey kalıcı kayda geçsin ki
// kullanıcı screenshot atmadan log paylaşabilsin.
//
// - Open_project'ten önce: ~/.mycl/trace.log (boot + config + setup)
// - Open_project sonrası: <projectRoot>/.mycl/trace.log (per-proje)
// - API key, "sk-ant-..." secrets, Authorization headers OTOMATIK REDACTED.
// - Async append (await yok — fire-and-forget). Tek yazıcı (orchestrator) →
//   race yok. fs.appendFile synchronous-ish gibi davranır POSIX'te.

import {
  appendFile,
  mkdir,
  open as openFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { globalConfigDir } from "./paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  data?: unknown;
}

const SECRET_KEY_RE = /sk-ant-[a-zA-Z0-9_\-]+/g;
const SECRET_FIELD_NAMES = new Set([
  "apiKey",
  "api_key",
  "authorization",
  "Authorization",
  "translator",
  "main",
]);

function redactString(s: string): string {
  return s.replace(SECRET_KEY_RE, "[REDACTED]");
}

function redact(value: unknown, parentKey?: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (parentKey === "api_keys") return "[REDACTED]";
    if (parentKey && SECRET_FIELD_NAMES.has(parentKey) && value.startsWith("sk-ant-"))
      return "[REDACTED]";
    return redactString(value);
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "api_keys") {
      out[k] = { translator: "[REDACTED]", main: "[REDACTED]" };
      continue;
    }
    out[k] = redact(v, k);
  }
  return out;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: redactString(err.message),
      stack: err.stack ? redactString(err.stack) : undefined,
    };
  }
  return { value: redact(err) };
}

class Logger {
  private sink: string | null = null;
  private bootBuffer: string[] = [];
  // MVP aşamasında debug her zaman açık — sorunlar çözüldükçe env'e bağlanacak.
  private debugEnabled = process.env.MYCL_DEBUG !== "0";

  /** Erken sink: process boot'ta ~/.mycl/trace.log */
  async setSinkHome(): Promise<void> {
    const dir = globalConfigDir();
    await mkdir(dir, { recursive: true });
    this.sink = join(dir, "trace.log");
    await this.flushBoot();
  }

  /** Proje açıldığında <projectRoot>/.mycl/trace.log'a rotate. */
  async rotateForProject(projectRoot: string): Promise<void> {
    const dir = join(projectRoot, ".mycl");
    await mkdir(dir, { recursive: true });
    this.sink = join(dir, "trace.log");
    this.info("logger", "rotated to project trace.log", { path: this.sink });
  }

  private formatEntry(
    level: LogLevel,
    module: string,
    msg: string,
    data?: unknown,
  ): string {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      module,
      msg: redactString(msg),
    };
    if (data !== undefined) entry.data = redact(data);
    return JSON.stringify(entry) + "\n";
  }

  private write(line: string): void {
    if (!this.sink) {
      this.bootBuffer.push(line);
      return;
    }
    // Fire-and-forget; hata stderr'a düşer (sink yazma bug'ı log'a yazılamaz).
    appendFile(this.sink, line, { encoding: "utf-8" }).catch((err) => {
      process.stderr.write(
        `[logger] append failed (${this.sink}): ${String(err)}\n`,
      );
    });
  }

  private async flushBoot(): Promise<void> {
    if (this.bootBuffer.length === 0 || !this.sink) return;
    const fh = await openFile(this.sink, "a");
    try {
      for (const line of this.bootBuffer) await fh.write(line);
    } finally {
      await fh.close();
    }
    this.bootBuffer = [];
  }

  debug(module: string, msg: string, data?: unknown): void {
    if (!this.debugEnabled) return;
    this.write(this.formatEntry("debug", module, msg, data));
  }
  info(module: string, msg: string, data?: unknown): void {
    this.write(this.formatEntry("info", module, msg, data));
  }
  warn(module: string, msg: string, data?: unknown): void {
    this.write(this.formatEntry("warn", module, msg, data));
  }
  error(module: string, msg: string, err?: unknown): void {
    const data = err !== undefined ? serializeError(err) : undefined;
    this.write(this.formatEntry("error", module, msg, data));
  }

  /** Mevcut sink path — debug için. */
  getSinkPath(): string | null {
    return this.sink;
  }
}

export const log = new Logger();

// Helper: dirname yer alıyor diye eslint'ten kaçar.
export const _dirname = dirname;
