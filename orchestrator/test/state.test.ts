import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { loadOrInit, save, advancePhase } from "../src/state.js";

describe("state", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-state-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("loadOrInit creates default state on first call", async () => {
    const s = await loadOrInit(projectRoot);
    expect(s.current_phase).toBe(1);
    expect(s.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.project_root).toBe(projectRoot);
    expect(s.spec_approved).toBe(false);
    // Dosya yazıldı mı?
    const raw = await fs.readFile(join(projectRoot, ".mycl/state.json"), "utf-8");
    expect(JSON.parse(raw).current_phase).toBe(1);
  });

  it("loadOrInit reads existing state preserving session_id", async () => {
    const s1 = await loadOrInit(projectRoot);
    const s2 = await loadOrInit(projectRoot);
    expect(s2.session_id).toBe(s1.session_id);
    expect(s2.created_at).toBe(s1.created_at);
  });

  it("save updates updated_at and persists changes", async () => {
    const s = await loadOrInit(projectRoot);
    const advanced = advancePhase(s, 11);
    await save(advanced);
    const reloaded = await loadOrInit(projectRoot);
    expect(reloaded.current_phase).toBe(11);
    expect(reloaded.updated_at).toBeGreaterThanOrEqual(s.updated_at);
  });

  it("advancePhase is pure — does not mutate input", () => {
    const s = {
      current_phase: 1 as const,
      session_id: "x",
      spec_approved: false,
      ui_flow_active: false,
      regression_block_active: false,
      project_root: "/tmp",
      created_at: 1,
      updated_at: 1,
    };
    const next = advancePhase(s, 4);
    expect(next.current_phase).toBe(4);
    expect(s.current_phase).toBe(1);
  });
});
