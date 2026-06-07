// app — composition root (v15.1 Core).
//
// Orchestrator subprocess boot logic'inin App sınıfına taşınmış hâli.
// Mevcut module-global state (activeState/activeConfig/activeController/
// pendingX) hâlâ index.ts'de duruyor — bunlar v15.1.1'de App instance
// field'larına taşınacak ve constructor injection ile Phase controller'lara
// yönlendirilecek. Şu an sadece boot + stdin loop App.start()'ta.
//
// Plan ref: v15.1 K10-K15 (Clean Architecture katmanlama + DI). Full
// directory restructure (core/controllers/infrastructure/ipc/) ve handler
// ayrımı sonraki minor sprint'lere bölünüyor — refactor risk azaltma
// stratejisi.

import * as readline from "node:readline";
import { emit, emitError } from "./ipc.js";
import { log } from "./logger.js";
import { autoUpdateClaude } from "./claude-updater.js";

/**
 * Inbound IPC mesaj formatı. `data` çoğu handler için `any` (eski runtime
 * davranışı). Strict tipleme handler-level cast'lerde sürdürülüyor; v15.1.1
 * IPC router refactor'unda discriminated union'a geçecek.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IncomingCommand { kind: string; data?: any }

/** App.start()'a inject edilen dış bağımlılıklar. Test'lerde mock'lanabilir. */
export interface AppDeps {
  /** i18n bundle yükleyici (assets/i18n/*.json). */
  loadI18n: () => Promise<void>;
  /** Runtime HTTP server başlatıcı (browser → orchestrator error POST). */
  startRuntimeHttpServer: () => Promise<void>;
  /** Config status emit'i (api keys + models). */
  emitConfigStatus: () => Promise<boolean>;
  /** IPC mesaj dispatcher — index.ts'de handler switch. */
  dispatch: (cmd: IncomingCommand) => Promise<void>;
  /** Tek temizlik+çıkış: dev-server/runtime HTTP/error-watcher kapatıp process.exit — orphan önler. */
  gracefulShutdown: (reason: string) => never;
}

export class App {
  constructor(private readonly deps: AppDeps) {}

  /**
   * Boot sequence + stdin loop. main() bu metodu çağırır.
   * Davranış mevcut main()'le **aynı** — sadece kapsülleme.
   */
  async start(): Promise<void> {
    await log.setSinkHome();

    // v15.8: Global güvenlik ağı. Yakalanmamış reject/exception Node'da default
    // olarak process'i ÖLDÜRÜR → orkestratör sessizce ölür, UI "ready" beklerken
    // donar. Burada logla + UI'a bildir, ama ayakta kal: bir sonraki stdin komutu
    // yine işlenebilsin. (Fire-and-forget boot-resume akışları da burada yakalanır;
    // çağrı yerlerinde ayrıca .catch var — çift güvence.)
    process.on("unhandledRejection", (reason) => {
      log.error("orchestrator", "unhandledRejection (process ayakta tutuldu)", reason);
      try {
        emitError("unhandledRejection", String(reason));
      } catch {
        /* emit bile patlarsa yut — process'i öldürme */
      }
    });
    process.on("uncaughtException", (err) => {
      log.error("orchestrator", "uncaughtException (process ayakta tutuldu)", err);
      try {
        emitError("uncaughtException", String(err));
      } catch {
        /* yut */
      }
    });

    log.info("orchestrator", "boot", {
      pid: process.pid,
      node: process.version,
    });

    try {
      await this.deps.loadI18n();
      log.info("i18n", "bundles loaded");
    } catch (err) {
      log.error("i18n", "load failed", err);
      emitError("i18n load failed", String(err));
      emit("config_status", {
        ready: false,
        reason: "i18n_load_failed",
        detail: String(err),
      });
    }

    try {
      await this.deps.startRuntimeHttpServer();
    } catch (err) {
      log.warn("orchestrator", "runtime http server start failed", err);
    }

    emit("ready", {
      version: "0.1.0-e1",
      pid: process.pid,
      node: process.version,
    });
    void this.deps.emitConfigStatus();
    // v15.13 (Ümit isteği): açılışta claude CLI'yı otomatik güncelle. Non-blocking (boot'u
    // geciktirmez), feature-flag'li (default açık), hata yutulur. Yalnız gerçekten güncellenince
    // görünür mesaj. Sürekli yeni sürüm geldiği için her açılışta güncel kalır.
    void autoUpdateClaude();

    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: IncomingCommand;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        log.error("orchestrator", "bad json from UI", {
          raw: trimmed.slice(0, 200),
          err: String(err),
        });
        emitError("bad json", { raw: trimmed.slice(0, 200), err: String(err) });
        return;
      }
      log.debug("ipc-in", parsed.kind, parsed.data);
      try {
        await this.deps.dispatch(parsed);
      } catch (err) {
        log.error("orchestrator", "dispatch threw", err);
        emitError("dispatch threw", String(err));
      }
    });

    rl.on("close", () => {
      this.deps.gracefulShutdown("stdin-close");
    });
    process.on("SIGTERM", () => {
      this.deps.gracefulShutdown("SIGTERM");
    });
    process.on("SIGINT", () => {
      this.deps.gracefulShutdown("SIGINT");
    });
  }
}
