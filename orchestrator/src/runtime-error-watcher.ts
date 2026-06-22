// runtime-error-watcher — dev server'ın stdout/stderr stream'lerini okur,
// HTTP 4xx/5xx, runtime exception, Vite proxy error gibi sinyalleri yakalar
// ve `error_folder/mycl_errors.db`'ye RUNTIME_ prefix'li satır olarak yazar.
//
// Amaç: kullanıcı tarayıcıda "Forbidden" gibi bir hata gördüğünde MyCL'in
// bunu canlı görmesi. Static scan eksik kalan yerin tamamlayıcısı.
//
// Sırasıyla:
//   1. readline ile satır satır oku (stdout + stderr ayrı stream).
//   2. White-list filtreler (npm warn, deprecated → skip).
//   3. Regex setleriyle kategori belirle (HTTP, Error/Exception, infra).
//   4. Multi-line stack trace topla (max 30 satır).
//   5. Debounce: aynı (error_code, location) 5sn içinde tekrar → atla.
//   6. EN log line → TR description (10dk cache).
//   7. insertErrors helper ile DB'ye yaz; chat'e toast (rate-limited).
//
// Lifecycle: spawn site'lerinde attach edilir, dev server restart'ta
// detach() çağrılır. Singleton state index.ts level'da değil — caller'lar
// kendi reference'larını tutar.

import { createHash } from "node:crypto";
import { stripAnsi } from "./strip-ansi.js";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { MyclConfig } from "./config.js";
import { insertErrors } from "./errors-db.js";
import { emit, emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { translate } from "./translator.js";

// White-list: bu pattern'lerden HERHANGI birini içeren satır → skip.
const WHITELIST_PATTERNS = [
  /\bnpm\s+warn\b/i,
  /\bdeprecated\b/i,
  /\bpunycode\b/i,
  /\bDeprecationWarning\b/i,
  /^\s*>\s+/, // npm run script echo
  /\bvite\b.*\bv\d/i, // "vite v5.0.0" startup banner
  /webpack compiled/i,
  /watching for file changes/i,
  /ready in \d+/i,
  /^\s*$/, // boş satır
];

// Kategori → regex listesi (öncelik sırası önemli; HTTP en spesifik).
interface CategoryDef {
  readonly key: string;
  readonly patterns: RegExp[];
  /** Match grubu → location string (örn endpoint path veya stack file:line). */
  readonly extractLocation: (m: RegExpMatchArray) => string;
  /** error_code üretmek için kullanılan tip kısaltması. */
  readonly typeCode: string;
}

const CATEGORIES: CategoryDef[] = [
  {
    key: "http",
    patterns: [
      /\b(GET|POST|PUT|DELETE|PATCH)\s+(\S+)\s+\b(4\d\d|5\d\d)\b/i,
      /\bHTTP\/[\d.]+\s+\b(4\d\d|5\d\d)\b.*?\s+(\S+)/i,
    ],
    extractLocation: (m) => {
      // Pattern 1: method, path, code = m[1], m[2], m[3]
      if (m[1] && m[2] && m[3]) return `${m[1].toUpperCase()} ${m[2]}`;
      // Pattern 2: code, path
      return m[2] ?? "unknown";
    },
    typeCode: "HTTP",
  },
  {
    key: "vite",
    patterns: [
      /\b(vite|proxy):\s+(.+?)(?:\s+at\s+(\S+))?$/i,
      /\[vite\].+?error.*?:(.+)/i,
    ],
    extractLocation: (m) => m[3] ?? "vite",
    typeCode: "VITE",
  },
  {
    key: "infra",
    patterns: [/\b(EADDRINUSE|ECONNREFUSED|ENOENT|EACCES|EPERM)\b.*/i],
    extractLocation: (m) => m[1] ?? "infra",
    typeCode: "INFRA",
  },
  {
    key: "exception",
    patterns: [
      /^\s*(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|Exception):\s+(.+)/,
      /\bUnhandledPromiseRejection\b.*/,
    ],
    extractLocation: (m) => (m[1] ?? "exception").slice(0, 80),
    typeCode: "EXC",
  },
];

const STACK_LINE_RE = /^\s+at\s+/;
const DEBOUNCE_MS = 5_000;
const TOAST_DEBOUNCE_MS = 10_000;
const TRANSLATE_CACHE_TTL = 10 * 60 * 1000; // 10 dakika
const STACK_MAX_LINES = 30;

export interface RuntimeErrorWatcher {
  detach(): void;
}

// Modül-seviye singleton: dev server tek instance, watcher da tek. Yeni
// spawn'da eski detach edilir, yeni attach.
let activeWatcher: RuntimeErrorWatcher | null = null;

// Pentest (Faz 17 / 🛡️ buton) sırasında watcher SUSTURULUR: katana/nuclei kasıtlı saldırı yükleri
// (SQLi/JSP/servlet exploit) atar → app 404/500 döner → bunlar GERÇEK runtime bug DEĞİL, beklenen saldırı
// trafiği. Aksi halde her probe translate+toast'a gider → ÇEVİRMEN BOĞULUR + chat flood (CANLI kanıt
// Arcelik_BO 2026-06-22: Faz 17'de 54 çeviri, run sürünüyor + makine ısındı). dast çağrısı try/finally ile sarar.
let pentestActive = false;
export function setPentestActive(v: boolean): void {
  pentestActive = v;
}

/** Singleton helper — eski watcher varsa detach, yeni attach. Spawn site'leri kullanır. */
export function replaceActiveWatcher(opts: AttachOpts): void {
  if (activeWatcher) {
    try {
      activeWatcher.detach();
    } catch (err) {
      log.warn("runtime-error-watcher", "previous detach failed", err);
    }
    activeWatcher = null;
  }
  if (opts.stdout || opts.stderr) {
    activeWatcher = attachRuntimeErrorWatcher(opts);
  }
}

/** Dev server kill edildiğinde watcher'ı kapat. */
export function detachActiveWatcher(): void {
  if (activeWatcher) {
    try {
      activeWatcher.detach();
    } catch (err) {
      log.warn("runtime-error-watcher", "detach failed", err);
    }
    activeWatcher = null;
  }
}

interface PendingEntry {
  line: string;
  category: CategoryDef;
  match: RegExpMatchArray;
  stackLines: string[];
}

interface AttachOpts {
  pid: number;
  stdout: Readable | null;
  stderr: Readable | null;
  projectRoot: string;
  dbPath: string;
  config: MyclConfig;
}

/**
 * Dev server stream'lerine bağlanır, parse loop başlatır. detach() çağrılana
 * kadar yaşar. Aynı child için iki kez attach edilmesin (caller singleton
 * yönetir).
 */
export function attachRuntimeErrorWatcher(opts: AttachOpts): RuntimeErrorWatcher {
  const dbDebounce = new Map<string, number>();
  const toastDebounce = new Map<string, number>();
  const translateCache = new Map<string, { text: string; ts: number }>();
  let pendingEntry: PendingEntry | null = null;
  let detached = false;
  const interfaces: ReadlineInterface[] = [];

  const flushPending = async (): Promise<void> => {
    if (!pendingEntry || detached) return;
    const e = pendingEntry;
    pendingEntry = null;
    await record(e);
  };

  const record = async (e: PendingEntry): Promise<void> => {
    // Pentest sırasında saldırı trafiği = hata DEĞİL → translate/toast/DB hepsini atla (flood + çevirmen-boğulma
    // + makine-ısınma önle). dast bitince setPentestActive(false) ile geri açılır.
    if (pentestActive) return;
    const category = e.category;
    const location = category.extractLocation(e.match).slice(0, 200);
    const hash = createHash("sha1")
      .update(`${category.typeCode}::${location}::${e.line}`)
      .digest("hex")
      .slice(0, 8);
    const errorCode = `RUNTIME_${category.typeCode}_${hash}`;

    // Debounce: aynı (typeCode, location) son 5sn içinde işlendiyse atla.
    // FIX (YZLLM canlı: hata-kataloğu 404 flood'u çevirmeni boğdu): anahtar STABLE olmalı —
    // eski `errorCode::location` line-hash içeriyordu, flood'da her satır (değişen timestamp/
    // detay) farklı hash → dedup baypas → her 404 translate'e gider → boğulma. typeCode+location
    // ile aynı endpoint+method floodu (ör. POST /api/log-error 404) satır-değişse-de tek sayılır →
    // translate/emit/DB BU noktadan ÖNCE kesilir, flood imkânsız.
    const dedupeKey = `${category.typeCode}::${location}`;
    const now = Date.now();
    const lastWrite = dbDebounce.get(dedupeKey);
    if (lastWrite && now - lastWrite < DEBOUNCE_MS) {
      return;
    }
    dbDebounce.set(dedupeKey, now);

    // TR translate — pattern cache (translate spam'i engelle).
    let descriptionTR = e.line;
    const cacheKey = e.line.slice(0, 200);
    const cached = translateCache.get(cacheKey);
    if (cached && now - cached.ts < TRANSLATE_CACHE_TTL) {
      descriptionTR = cached.text;
    } else {
      try {
        descriptionTR = (await translate(opts.config, e.line, "en-to-tr")).text;
        translateCache.set(cacheKey, { text: descriptionTR, ts: now });
      } catch (err) {
        log.warn("runtime-error-watcher", "translate fail (non-fatal)", err);
      }
    }

    const stack = e.stackLines.length > 0 ? e.stackLines.join("\n").slice(0, 2000) : null;

    try {
      await insertErrors(opts.dbPath, [
        {
          ts: now,
          error_code: errorCode,
          location,
          description_tr: descriptionTR,
          stack,
        },
      ]);
    } catch (err) {
      log.warn("runtime-error-watcher", "insertErrors fail", err);
      return;
    }

    emit("runtime_error", {
      ts: now,
      error_code: errorCode,
      location,
      description_tr: descriptionTR,
    });

    // Chat toast — rate-limited (aynı hata 10sn içinde 2. kez gelse atla).
    // v15.10: infra/başlangıç hataları (EADDRINUSE, ECONNREFUSED, ENOENT, EACCES,
    // EPERM) chat'e BASILMAZ — bunlar ortam/başlangıç sorunu (örn. port zaten
    // kullanımda), app runtime bug'ı DEĞİL; "Runtime hata yakalandı" toast'ı
    // yanıltıcı gürültü. Yine de mycl_errors.db + runtime_error event'ine kaydedilir
    // (debug/panel için kaybolmaz) — yalnız chat sessizleşir.
    const lastToast = toastDebounce.get(dedupeKey);
    if (category.typeCode !== "INFRA" && (!lastToast || now - lastToast >= TOAST_DEBOUNCE_MS)) {
      toastDebounce.set(dedupeKey, now);
      emitChatMessage(
        "system",
        `🔴 **Runtime hata yakalandı**: \`${location}\` — ${descriptionTR}`,
      );
    }
  };

  const handleLine = (line: string): void => {
    if (detached) return;
    const trimmed = stripAnsi(line); // ANSI escape strip

    // White-list filter
    for (const wp of WHITELIST_PATTERNS) {
      if (wp.test(trimmed)) {
        // Pending entry varsa kapat (stack devamı değil, gürültü).
        if (pendingEntry && !STACK_LINE_RE.test(trimmed)) {
          void flushPending();
        }
        return;
      }
    }

    // Stack trace devamı?
    if (pendingEntry && STACK_LINE_RE.test(trimmed)) {
      if (pendingEntry.stackLines.length < STACK_MAX_LINES) {
        pendingEntry.stackLines.push(trimmed);
      }
      return;
    }

    // Stack değilse pending entry'i finalize et.
    if (pendingEntry) {
      void flushPending();
    }

    // Yeni kategori match'i ara
    for (const cat of CATEGORIES) {
      for (const pat of cat.patterns) {
        const m = trimmed.match(pat);
        if (m) {
          pendingEntry = {
            line: trimmed.slice(0, 500),
            category: cat,
            match: m,
            stackLines: [],
          };
          return;
        }
      }
    }
  };

  // stdout + stderr ayrı readline interface'leri.
  for (const stream of [opts.stdout, opts.stderr]) {
    if (!stream) continue;
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", handleLine);
    rl.on("close", () => {
      // Stream bittiyse son pending entry'i kapat.
      void flushPending();
    });
    rl.on("error", (err) => {
      log.warn("runtime-error-watcher", "readline error", err);
    });
    interfaces.push(rl);
  }

  log.info("runtime-error-watcher", "attached", {
    pid: opts.pid,
    projectRoot: opts.projectRoot,
    streams: interfaces.length,
  });

  return {
    detach(): void {
      if (detached) return;
      detached = true;
      for (const rl of interfaces) {
        try {
          rl.close();
        } catch (err) {
          log.warn("runtime-error-watcher", "rl close fail", err);
        }
      }
      log.info("runtime-error-watcher", "detached", { pid: opts.pid });
    },
  };
}
