// runtime-http-server — MyCL'in localhost'ta dinlediği küçük HTTP endpoint'i.
// Kullanıcı projesinin tarayıcı tarafından `POST /__mycl/runtime-error` ile
// gelen JSON payload'ları errors.db'ye yazar. Bu sayede `window.onerror`,
// `unhandledrejection` ve fetch-wrap 4xx/5xx hataları MyCL'e ulaşır.
//
// Port: 9273 (Vite 5173, Next 3000, backend 5000/8000/3001'lerle çakışmaz).
// CORS: localhost'tan gelen tüm origin'lere izin (dev mode).
// Lifecycle: orchestrator boot'ta singleton başlatılır; aktif proje
// değişince activeProjectRoot/dbPath güncellenir. Process exit'te kapatılır.

import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { insertErrors } from "./errors-db.js";
import { emit, emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";

// v15.2 Core: dinamik port. Eski 9273 hardcoded varsayım kalktı.
//   - Default tek-instance kullanım için 9273'ten dene (backward-compat).
//   - Çakışma (EADDRINUSE) → 9274, 9275, ... 9299 aralığını tara.
//   - Tüm aralık dolu ise OS'a (port 0) bırak — ephemeral port.
// `activePort` boot sonrası set edilir; Vite injector buradan okur ve
// kullanıcı projesinin browser script'ine doğru endpoint'i enjekte eder.
const PORT_RANGE_START = 9273;
const PORT_RANGE_END = 9299;
let activePort: number | null = null;
const PATH = "/__mycl/runtime-error";
const DEBOUNCE_MS = 5_000;
const TOAST_DEBOUNCE_MS = 10_000;

interface BindingTarget {
  projectRoot: string;
  dbPath: string;
}

let httpServer: Server | null = null;
let target: BindingTarget | null = null;
const dbDebounce = new Map<string, number>();
const toastDebounce = new Map<string, number>();

/**
 * Şu anki aktif proje için runtime hatalarını DB'ye yazma hedefini ayarlar.
 * Proje değişimi (open_project) sonrası index.ts çağırır.
 */
export function setRuntimeHttpTarget(t: BindingTarget | null): void {
  target = t;
  log.info("runtime-http-server", "target set", { projectRoot: t?.projectRoot ?? null });
}

interface IncomingPayload {
  kind?: string; // "window_error" | "unhandled_rejection" | "fetch_error"
  message?: string;
  source?: string; // url:line:col veya endpoint
  stack?: string;
  status?: number; // fetch error için
  url?: string; // fetch error için
}

/**
 * Aktif olarak bind edilmiş portu döndürür. Server başlatılmadıysa veya
 * port assignment tamamlanmadıysa null. Vite injector + diğer modüller bu
 * fonksiyonu çağırıp doğru endpoint'i template'e enjekte eder.
 */
export function getRuntimeHttpPort(): number | null {
  return activePort;
}

/**
 * Tek bir port'a bind dene; başarılıysa server döner, EADDRINUSE'de null.
 * Diğer error'lar reject olur (caller graceful degrade için yakalar).
 */
function tryListen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onErr = (err: NodeJS.ErrnoException): void => {
      if (err.code === "EADDRINUSE") {
        server.removeListener("listening", onListening);
        resolve(false);
      } else {
        server.removeListener("listening", onListening);
        reject(err);
      }
    };
    const onListening = (): void => {
      server.removeListener("error", onErr);
      resolve(true);
    };
    server.once("error", onErr);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/**
 * HTTP listener'ı başlatır (idempotent). v15.2 Core: dinamik port —
 * 9273'ten 9299'a kadar tara, ilk müsait portu kullan. Tümü doluysa OS-assign
 * (port=0). Listen hatası durumunda log.warn + UI capture devre dışı.
 */
export async function startRuntimeHttpServer(): Promise<void> {
  if (httpServer) {
    log.warn("runtime-http-server", "already started");
    return;
  }
  const server = createServer((req, res) => {
    // CORS preflight — localhost dev mode için izin ver
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }
    if (req.method !== "POST" || req.url !== PATH) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 50_000) {
        // Spam koruması
        req.destroy();
      }
    });
    req.on("end", () => {
      void handleIncoming(body, res);
    });
    req.on("error", (err) => {
      log.warn("runtime-http-server", "req error", err);
    });
  });
  // Port range tara: 9273 → 9299. İlk müsait olana bind. Hepsi doluysa
  // OS-assign (server.listen(0) — ephemeral). Bu sayede aynı makinede
  // birden fazla MyCL Studio instance çakışmaz (v15.2 multi-window hazırlığı).
  let bound = false;
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    try {
      const ok = await tryListen(server, port);
      if (ok) {
        activePort = port;
        bound = true;
        log.info("runtime-http-server", "listening", { port, source: "range" });
        break;
      }
    } catch (err) {
      log.warn(
        "runtime-http-server",
        "listen error (UI capture disabled)",
        err,
      );
      httpServer = null;
      return;
    }
  }
  if (!bound) {
    // QC v15.2 KRITIK fix: tüm aralık dolu → OS-assign ephemeral, ama
    // address() callback'inde set ediliyordu → activePort null kalabiliyordu
    // ve getRuntimeHttpPort 9273 fallback'e düşüyordu. Promise-await ile
    // activePort set olmadan dönmüyoruz.
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: NodeJS.ErrnoException): void => reject(err);
      const onListening = (): void => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          activePort = addr.port;
          log.info("runtime-http-server", "listening", {
            port: addr.port,
            source: "ephemeral",
          });
        }
        server.removeListener("error", onErr);
        resolve();
      };
      server.once("error", onErr);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    }).catch((err) => {
      log.warn(
        "runtime-http-server",
        "ephemeral listen failed (UI capture disabled)",
        err,
      );
    });
  }
  httpServer = server;
}

async function handleIncoming(
  body: string,
  res: import("node:http").ServerResponse,
): Promise<void> {
  try {
    if (!target) {
      // Hedef proje yok — sessizce 204 dön (browser script'i fail etmesin)
      writeCors(res, 204);
      return;
    }
    const payload = parsePayload(body);
    if (!payload) {
      writeCors(res, 400);
      return;
    }

    const kind = payload.kind ?? "unknown";
    const message = (payload.message ?? "").slice(0, 500);
    const source = (payload.source ?? payload.url ?? "browser").slice(0, 200);
    const stack = payload.stack ? String(payload.stack).slice(0, 2000) : null;
    const status = typeof payload.status === "number" ? payload.status : null;

    // Dedupe: aynı (kind, source, message-hash) son 5sn'de geldiyse atla.
    const hash = createHash("sha1")
      .update(`${kind}::${source}::${message}`)
      .digest("hex")
      .slice(0, 8);
    const codePart =
      status !== null
        ? `HTTP_${status}`
        : kind === "unhandled_rejection"
          ? "PROMISE"
          : kind === "window_error"
            ? "EXC"
            : "FETCH";
    const errorCode = `RUNTIME_BROWSER_${codePart}_${hash}`;
    const dedupeKey = `${errorCode}::${source}`;
    const now = Date.now();
    const lastWrite = dbDebounce.get(dedupeKey);
    if (lastWrite && now - lastWrite < DEBOUNCE_MS) {
      writeCors(res, 204);
      return;
    }
    dbDebounce.set(dedupeKey, now);

    // description_tr: TR çeviri yapmıyoruz (translate spam riski). Browser
    // hatalarının mesajı zaten i18n'siz teknik — DB'de orijinal saklıyoruz.
    const description_tr = message || "(no message)";

    try {
      await insertErrors(target.dbPath, [
        {
          ts: now,
          error_code: errorCode,
          location: source,
          description_tr,
          stack,
        },
      ]);
    } catch (err) {
      log.warn("runtime-http-server", "insertErrors fail", err);
      writeCors(res, 500);
      return;
    }

    emit("runtime_error", {
      ts: now,
      error_code: errorCode,
      location: source,
      description_tr,
    });

    const lastToast = toastDebounce.get(dedupeKey);
    if (!lastToast || now - lastToast >= TOAST_DEBOUNCE_MS) {
      toastDebounce.set(dedupeKey, now);
      emitChatMessage(
        "system",
        `🔴 **UI runtime hata**: \`${source}\` — ${description_tr}`,
      );
    }

    writeCors(res, 204);
  } catch (err) {
    log.warn("runtime-http-server", "handle error", err);
    writeCors(res, 500);
  }
}

function parsePayload(body: string): IncomingPayload | null {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as IncomingPayload;
  } catch {
    return null;
  }
}

function writeCors(
  res: import("node:http").ServerResponse,
  status: number,
): void {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ ok: status < 400 }));
}

export function stopRuntimeHttpServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
    activePort = null;
    log.info("runtime-http-server", "stopped");
  }
}
