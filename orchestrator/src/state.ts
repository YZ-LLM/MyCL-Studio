// state — proje bazlı state.json okuma/yazma.
//
// Yer: <project_root>/.mycl/state.json
// Atomic write: temp dosyaya yaz → fsync → rename. POSIX rename atomic
// olduğu için yarım yazılmış state.json riski yok.

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { detectStack } from "./intent-router/handlers/command.js";
import {
  CURRENT_SCHEMA_VERSION,
  applyMigrations,
} from "./state-migrations.js";
import { LockError, withFileLockRetry } from "./state-lock.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import type { PhaseId, State } from "./types.js";

const STATE_FILE = "state.json";
const MYCL_DIR = ".mycl";

export class StateError extends Error {
  override readonly name = "StateError";
}

function statePath(projectRoot: string): string {
  return join(projectRoot, MYCL_DIR, STATE_FILE);
}

function defaultState(projectRoot: string): State {
  const now = Date.now();
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    stack: detectStack(projectRoot),
    project_type: "unknown",
    skip_ui_phases: false,
    current_phase: 1,
    session_id: randomUUID(),
    spec_approved: false,
    spec_hash: undefined,
    ui_flow_active: false,
    regression_block_active: false,
    tdd_compliance_score: undefined,
    last_write_ts: undefined,
    project_root: projectRoot,
    created_at: now,
    updated_at: now,
  };
}

/**
 * State'i yükler; yoksa default oluşturup yazar.
 *
 * v15.0'da eklendi: eski state'ler `applyMigrations` ile son şemaya çekilir.
 * Migration sonrası state.json yeniden yazılır (save) — bir sonraki açılış
 * doğrudan güncel sürümü okur, migrator zinciri no-op olur.
 */
export async function loadOrInit(projectRoot: string): Promise<State> {
  const p = statePath(projectRoot);
  try {
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<State>;
    const migrated = await applyMigrations(parsed, projectRoot, p, raw);
    const merged = { ...defaultState(projectRoot), ...migrated } as State;
    // Migration gerçekten yapıldıysa (schema_version değiştiyse) save et — bir
    // sonraki yüklemede migrator zinciri no-op olur.
    if ((parsed.schema_version ?? 0) < CURRENT_SCHEMA_VERSION) {
      await save(merged);
    }
    return merged;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const fresh = defaultState(projectRoot);
      await save(fresh);
      return fresh;
    }
    throw new StateError(`state load failed: ${String(err)}`);
  }
}

/**
 * State'i atomik yazar: temp → rename. .mycl/ dizini yoksa oluşturur.
 *
 * v15.2 Core: `withFileLock` ile sarıldı. Multi-instance senaryosunda iki
 * orchestrator aynı projeyi açıp paralel save yaparsa last-write-wins race
 * yerine sırayla yazılır. Lock acquisition timeout 3s; stale lock (process
 * crash) 5s sonra otomatik temizlenir.
 */
export async function save(state: State): Promise<void> {
  const p = statePath(state.project_root);
  await fs.mkdir(dirname(p), { recursive: true });
  try {
    await withFileLockRetry(
      p,
      async () => {
        await saveStateUnlocked(p, state);
      },
      {
        retries: 3,
        delaysMs: [100, 200, 500],
        onRetry: (attempt, total) => {
          log.warn("state", "lock retry", { attempt, total, path: p });
          // İlk retry'da kullanıcıya bilgi ver (sonrakiler spam olmasın).
          if (attempt === 1) {
            emitChatMessage(
              "system",
              "⏳ Proje state yazımı yoğun — yeniden deneniyor...",
            );
          }
        },
      },
    );
  } catch (err) {
    if (err instanceof LockError) {
      log.error("state", "save lock failed after retries", err);
      emitChatMessage(
        "system",
        "⚠️ Proje state yazılamadı. Aynı projeyi başka MyCL Studio penceresinde mi açtın? Tek pencerede çalış.",
      );
    }
    throw err;
  }
}

async function saveStateUnlocked(p: string, state: State): Promise<void> {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const updated: State = { ...state, updated_at: Date.now() };
  const raw = JSON.stringify(updated, null, 2) + "\n";
  await fs.writeFile(tmp, raw, { encoding: "utf-8", mode: 0o600 });
  // fsync — POSIX'te fs.writeFile flush ediyor ama explicit fsync güvence:
  const fd = await fs.open(tmp, "r");
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
  await fs.rename(tmp, p);
}

/**
 * Faz ilerletme — yan etkisiz state.current_phase'i set eder. Çağıran
 * save'i bizzat çağırmalı.
 */
export function advancePhase(state: State, to: PhaseId): State {
  return { ...state, current_phase: to, updated_at: Date.now() };
}
