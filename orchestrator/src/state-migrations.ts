// state-migrations — state.json şema evrimi için migration framework.
//
// v14'te state şeması örtük olarak büyüdü; her yeni alan loadOrInit'te
// "...defaultState, ...parsed" pattern'iyle "soft-fill" ediliyordu. v15.0'da
// `schema_version` alanı + sürüm bazlı migrator zinciri devreye giriyor.
//
// Çalışma prensibi:
//   1. `loadOrInit` ham state'i okur ve `applyMigrations`'a verir.
//   2. `applyMigrations` `state.schema_version ?? 0` okur.
//   3. CURRENT_SCHEMA_VERSION'a kadar eksik migrator'ları sırayla uygular.
//   4. İlk migration'dan ÖNCE `<state.json>.backup.<ts>` kopyası alınır;
//      migrator hata fırlatırsa state.json el değmemiş kalır.
//   5. Migration sonrası state.json yazılır (loadOrInit kendisi yapar).
//
// Yeni alan eklemek: bir sonraki sürüm için migrator ekle + CURRENT_SCHEMA_VERSION bump.

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";
import { detectStack } from "./intent-router/handlers/command.js";
import type { PhaseId, State } from "./types.js";

/** Mevcut şema versiyonu. Yeni migrator eklendiğinde bump. */
export const CURRENT_SCHEMA_VERSION = 3;

/** Saf migrator imzası — input state'in shallow copy'sini döndürür. */
type Migrator = (state: Partial<State>, projectRoot: string) => Partial<State>;

/**
 * Migrator zinciri — versiyon N'den N+1'e geçişi tanımlar. Migration sırası:
 * key 1'i çalıştırırsan state v0 → v1 olur. Yeni v2 eklemek için key 2 ekle.
 */
const MIGRATORS: Record<number, Migrator> = {
  /**
   * v0 → v1 (2026-05-23): stack + project_type + build_tool + skip_ui_phases
   * + schema_version alanları eklendi. v15.0 stack-bağımsızlık temeli.
   *   - `stack`: `detectStack(projectRoot)` deterministik çalışır.
   *   - `project_type`: "unknown" varsayılan; Phase 2 sonu Haiku ile güncellenecek.
   *   - `build_tool`: undefined kalır; Phase 6 sonrası tespit edilir.
   *   - `skip_ui_phases`: false varsayılan; Phase 2 sonu project_type'a göre güncellenecek.
   */
  1: (state, projectRoot) => ({
    ...state,
    stack: state.stack ?? detectStack(projectRoot),
    project_type: state.project_type ?? "unknown",
    skip_ui_phases: state.skip_ui_phases ?? false,
    schema_version: 1,
  }),
  /**
   * v1 → v2 (2026-05-23): `has_database` field eklendi (v15.2.3 borç C-3).
   * Eski state'lerde undefined kalır → Faz 8 spec.md heuristic fallback'a
   * düşer. Yeni projeler Phase 2 classifier'dan bool değer alır.
   * Migrator no-op (undefined assignment); sadece schema_version bump.
   */
  2: (state) => ({
    ...state,
    schema_version: 2,
  }),
  /**
   * v2 → v3 (2026-05-23): 20 faz → 17 faz daralması. Faz 5 (Desen Eşleme),
   * Faz 19 (Etki İncelemesi), Faz 20 (Doğrulama Raporu) silindi. Kalan fazlar
   * 1-17 olarak ardışık renumber edildi (eski 6→5, 7→6, ..., 18→17).
   * `current_phase` remap:
   *   - 0-4: değişmez
   *   - 5 (silinen Desen Eşleme): 5 (yeni Faz 5 = UI Yapımı) — pipeline ilerlesin
   *   - 6-18: -1 shift
   *   - 19, 20 (silinen): 17 (yeni son faz) — pipeline biter
   */
  3: (state) => {
    const oldPhase = state.current_phase as number | undefined;
    let newPhase: PhaseId | undefined;
    if (oldPhase === undefined) {
      newPhase = undefined;
    } else if (oldPhase >= 0 && oldPhase <= 4) {
      newPhase = oldPhase as PhaseId;
    } else if (oldPhase === 5) {
      newPhase = 5;
    } else if (oldPhase >= 6 && oldPhase <= 18) {
      newPhase = (oldPhase - 1) as PhaseId;
    } else if (oldPhase === 19 || oldPhase === 20) {
      newPhase = 17;
    } else {
      // Geçersiz değer (negatif veya >20) — log + son faza clamp. Silent cast
      // invalid PhaseId bırakmasın; runtime'da yan etkisiz failover.
      log.warn("state-migration", "v3 invalid current_phase, clamping to 17", {
        old_phase: oldPhase,
      });
      newPhase = 17;
    }
    return {
      ...state,
      current_phase: newPhase,
      schema_version: 3,
    };
  },
};

/**
 * Migration backup'ı yaz — `<statePath>.backup.<ts>` kopyası. Migration
 * öncesi ham içerik korunur ki hata olursa kullanıcı eski state'e dönebilsin.
 * IO hatası migrationtotal akışını durdurmaz; log.warn'a düşülür.
 */
async function writeBackup(statePath: string, raw: string): Promise<void> {
  const ts = Date.now();
  const backupPath = `${statePath}.backup.${ts}`;
  try {
    await fs.mkdir(dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, raw, { encoding: "utf-8", mode: 0o600 });
    log.info("state-migration", "backup written", { path: backupPath });
  } catch (err) {
    log.warn("state-migration", "backup write failed (continuing)", err);
  }
}

/**
 * Ham state objesini CURRENT_SCHEMA_VERSION'a kadar migrate eder. State zaten
 * güncelse hiçbir migrator çalışmaz, input olduğu gibi döner.
 *
 * Backup yazımı: yalnızca gerçek migration yapılıyorsa (en az 1 migrator
 * çalışacaksa) `rawJson` ile çağrılır. ENOENT case'inde (yeni state.json
 * yaratılıyorsa) `rawJson` undefined verilir — backup'a gerek yok.
 */
export async function applyMigrations(
  state: Partial<State>,
  projectRoot: string,
  statePath: string,
  rawJson: string | undefined,
): Promise<Partial<State>> {
  const currentVersion = state.schema_version ?? 0;
  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return state;
  }

  // İlk migration'dan önce backup al (rawJson varsa = mevcut dosya).
  if (rawJson !== undefined) {
    await writeBackup(statePath, rawJson);
  }

  let migrated = state;
  for (let v = currentVersion + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
    const migrator = MIGRATORS[v];
    if (!migrator) {
      // QC 2026-05-23 B1: sessiz `continue` data skew bırakırdı. Eksik
      // migrator bug'dır — pipeline'ı durdur. Backup zaten yazılmış (yukarıda).
      throw new Error(
        `Critical: missing migrator for version ${v - 1} → ${v}. ` +
          `MIGRATORS map'inde tanımlı değil; state-migrations.ts kontrol et.`,
      );
    }
    log.info("state-migration", "applying", {
      from: v - 1,
      to: v,
      project_root: projectRoot,
    });
    migrated = migrator(migrated, projectRoot);
  }

  return migrated;
}

/**
 * Belirli bir versiyona kadar migrator'ları döndürür — test için.
 */
export function getMigratorVersions(): number[] {
  return Object.keys(MIGRATORS)
    .map(Number)
    .sort((a, b) => a - b);
}
