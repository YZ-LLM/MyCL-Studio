import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  CURRENT_SCHEMA_VERSION,
  applyMigrations,
  getMigratorVersions,
} from "../src/state-migrations.js";
import { loadOrInit } from "../src/state.js";

describe("state-migrations", () => {
  let projectRoot: string;
  let statePath: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-migration-"));
    statePath = join(projectRoot, ".mycl", "state.json");
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("getMigratorVersions returns versions in ascending order", () => {
    const versions = getMigratorVersions();
    expect(versions.length).toBeGreaterThan(0);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });

  it("applyMigrations no-op when state already at current version", async () => {
    const state = {
      schema_version: CURRENT_SCHEMA_VERSION,
      current_phase: 5 as const,
      stack: "node-npm" as const,
    };
    const result = await applyMigrations(state, projectRoot, statePath, undefined);
    expect(result.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.stack).toBe("node-npm");
  });

  it("applyMigrations adds v15.0 fields when migrating from v0", async () => {
    // Eski state — schema_version yok
    const oldState = {
      current_phase: 7 as const,
      session_id: "test-session",
      spec_approved: true,
      project_root: projectRoot,
      created_at: 1,
      updated_at: 1,
      ui_flow_active: false,
      regression_block_active: false,
    };
    const migrated = await applyMigrations(
      oldState,
      projectRoot,
      statePath,
      undefined, // backup skip (yeni dosya simülasyonu)
    );
    // v2 bump (v15.2.3 has_database eklendi).
    expect(migrated.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.project_type).toBe("unknown");
    expect(migrated.skip_ui_phases).toBe(false);
    // detectStack — boş tmpdir manifest yok → "unknown"
    expect(migrated.stack).toBe("unknown");
    // has_database undefined kalır (v1→v2 migrator default değer atamaz —
    // Phase 2 classifier'dan gelecek; eski state'ler heuristic fallback'e düşer).
    expect(migrated.has_database).toBeUndefined();
    // Mevcut alanlar korunmuş + v3 phase renumber: 7 → 6 (faz 5 silindi, 6+ shift)
    expect(migrated.current_phase).toBe(6);
    expect(migrated.session_id).toBe("test-session");
    expect(migrated.spec_approved).toBe(true);
  });

  it("v3 renumber: phase 5 (deleted Desen Eşleme) maps to new phase 5 (UI Yapımı)", async () => {
    const oldState = {
      current_phase: 5 as const,
      session_id: "test",
      project_root: projectRoot,
      created_at: 1,
      updated_at: 1,
    };
    const migrated = await applyMigrations(oldState, projectRoot, statePath, undefined);
    expect(migrated.current_phase).toBe(5);
  });

  it("v3 renumber: phase 19 (deleted Etki) maps to new phase 17", async () => {
    const oldState = {
      current_phase: 19 as unknown as 17,
      session_id: "test",
      project_root: projectRoot,
      created_at: 1,
      updated_at: 1,
    };
    const migrated = await applyMigrations(oldState, projectRoot, statePath, undefined);
    expect(migrated.current_phase).toBe(17);
  });

  it("v3 renumber: phase 20 (deleted Doğrulama) maps to new phase 17", async () => {
    const oldState = {
      current_phase: 20 as unknown as 17,
      session_id: "test",
      project_root: projectRoot,
      created_at: 1,
      updated_at: 1,
    };
    const migrated = await applyMigrations(oldState, projectRoot, statePath, undefined);
    expect(migrated.current_phase).toBe(17);
  });

  it("v3 renumber: phase 18 (last mechanical) maps to new phase 17", async () => {
    const oldState = {
      current_phase: 18 as unknown as 17,
      session_id: "test",
      project_root: projectRoot,
      created_at: 1,
      updated_at: 1,
    };
    const migrated = await applyMigrations(oldState, projectRoot, statePath, undefined);
    expect(migrated.current_phase).toBe(17);
  });

  it("applyMigrations creates backup when migrating real file", async () => {
    // Önce .mycl dizinini oluştur
    await fs.mkdir(join(projectRoot, ".mycl"), { recursive: true });
    const oldRaw = JSON.stringify({
      current_phase: 5,
      session_id: "old-session",
      project_root: projectRoot,
      created_at: 1,
      updated_at: 1,
    });
    await fs.writeFile(statePath, oldRaw);

    const parsed = JSON.parse(oldRaw);
    await applyMigrations(parsed, projectRoot, statePath, oldRaw);

    // Backup dosyası oluşmuş olmalı
    const files = await fs.readdir(join(projectRoot, ".mycl"));
    const backup = files.find((f: string) => f.startsWith("state.json.backup."));
    expect(backup).toBeDefined();
    const backupContent = await fs.readFile(
      join(projectRoot, ".mycl", backup!),
      "utf-8",
    );
    expect(backupContent).toBe(oldRaw);
  });

  it("applyMigrations throws when migrator missing + backup still written + state.json unchanged", async () => {
    // QC B1/B2 (2026-05-23): missing migrator artık silent skip değil, throw.
    // Recovery için: throw'dan önce backup yazılmış olmalı, state.json el değmemiş.
    await fs.mkdir(join(projectRoot, ".mycl"), { recursive: true });
    // schema_version = -1 → currentVersion = -1 → loop v=0'dan başlar
    // MIGRATORS[0] tanımlı değil (yalnızca [1] var) → throw beklenir
    const raw = JSON.stringify({
      schema_version: -1,
      current_phase: 5,
      session_id: "broken-session",
      project_root: projectRoot,
      created_at: 1,
      updated_at: 1,
    });
    await fs.writeFile(statePath, raw);
    const parsed = JSON.parse(raw);

    await expect(
      applyMigrations(parsed, projectRoot, statePath, raw),
    ).rejects.toThrow(/missing migrator/);

    // Backup yazılmış olmalı (throw'dan önce writeBackup çağrıldı)
    const files = await fs.readdir(join(projectRoot, ".mycl"));
    const backup = files.find((f: string) => f.startsWith("state.json.backup."));
    expect(backup).toBeDefined();
    const backupContent = await fs.readFile(
      join(projectRoot, ".mycl", backup!),
      "utf-8",
    );
    expect(backupContent).toBe(raw);

    // state.json el değmemiş — kullanıcı recovery için orijinali görür
    const stateContent = await fs.readFile(statePath, "utf-8");
    expect(stateContent).toBe(raw);
  });

  it("loadOrInit on legacy state file triggers migration + rewrites", async () => {
    // Eski state.json yaz (schema_version yok)
    await fs.mkdir(join(projectRoot, ".mycl"), { recursive: true });
    const legacyRaw = JSON.stringify({
      current_phase: 3,
      session_id: "legacy-session",
      spec_approved: false,
      ui_flow_active: false,
      regression_block_active: false,
      project_root: projectRoot,
      created_at: 100,
      updated_at: 100,
    });
    await fs.writeFile(statePath, legacyRaw);

    const loaded = await loadOrInit(projectRoot);
    expect(loaded.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(loaded.stack).toBe("unknown");
    expect(loaded.project_type).toBe("unknown");
    expect(loaded.skip_ui_phases).toBe(false);
    // session_id ve current_phase korunmuş
    expect(loaded.session_id).toBe("legacy-session");
    expect(loaded.current_phase).toBe(3);

    // Backup oluşmuş
    const files = await fs.readdir(join(projectRoot, ".mycl"));
    expect(files.some((f: string) => f.startsWith("state.json.backup."))).toBe(true);

    // Yeniden okunduğunda migration tekrar tetiklenmez (no-op)
    const reloaded = await loadOrInit(projectRoot);
    expect(reloaded.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    // İkinci backup oluşmamalı
    const filesAfter = await fs.readdir(join(projectRoot, ".mycl"));
    const backups = filesAfter.filter((f: string) => f.startsWith("state.json.backup."));
    expect(backups.length).toBe(1);
  });
});
