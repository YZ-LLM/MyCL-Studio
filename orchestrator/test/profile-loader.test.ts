import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  loadProfile,
  resolveCommand,
  resolveProjectTypeCommand,
  _clearProfileCache,
  _loadProfileFromPath,
} from "../src/profile-loader.js";

describe("profile-loader", () => {
  beforeEach(() => {
    _clearProfileCache();
  });

  it("loadProfile returns null for unknown stack with no profile file", async () => {
    const profile = await loadProfile("unknown");
    // unknown.json kasten yok — detectStack "unknown" döndüğünde profile null.
    expect(profile).toBeNull();
  });

  it("loadProfile reads node-npm.json", async () => {
    const profile = await loadProfile("node-npm");
    expect(profile).not.toBeNull();
    expect(profile!.stack_id).toBe("node-npm");
    expect(profile!.commands.install).toBe("npm install");
    expect(profile!.commands.test).toBe("npm test");
    expect(profile!.commands.lint).toBe("npm run lint");
    expect(profile!.default_port).toBe(5173);
    expect(profile!.build_tool).toBe("vite");
  });

  it("loadProfile reads python-uv.json", async () => {
    const profile = await loadProfile("python-uv");
    expect(profile).not.toBeNull();
    expect(profile!.stack_id).toBe("python-uv");
    expect(profile!.commands.install).toBe("uv sync");
    expect(profile!.commands.test).toBe("uv run pytest");
    expect(profile!.commands.lint).toBe("uv run ruff check .");
    expect(profile!.commands.build).toBeNull();
    expect(profile!.default_port).toBe(8000);
  });

  it("loadProfile caches result — second call no re-read", async () => {
    const p1 = await loadProfile("node-npm");
    const p2 = await loadProfile("node-npm");
    // Aynı referans (Map'ten geliyor)
    expect(p2).toBe(p1);
  });

  it("resolveCommand returns null for null profile", () => {
    expect(resolveCommand(null, "test")).toBeNull();
  });

  it("resolveCommand returns command from profile", async () => {
    const profile = await loadProfile("node-npm");
    expect(resolveCommand(profile, "lint")).toBe("npm run lint");
    expect(resolveCommand(profile, "security")).toBe(
      "npm audit --omit=dev --audit-level=high",
    );
  });

  it("resolveCommand returns null when key not defined", async () => {
    const profile = await loadProfile("python-uv");
    // python-uv.json'da build: null
    expect(resolveCommand(profile, "build")).toBeNull();
    // perf de null
    expect(resolveCommand(profile, "perf")).toBeNull();
  });

  it("resolveProjectTypeCommand: e2e web → Playwright (node-npm)", async () => {
    const profile = await loadProfile("node-npm");
    // v15.7 (2026-05-28): --headed flag eklendi (headed mode garantisi).
    expect(resolveProjectTypeCommand(profile, "e2e", "web")).toBe(
      "npx --no-install playwright test --headed",
    );
  });

  it("resolveProjectTypeCommand: e2e library → null (no runner)", async () => {
    const profile = await loadProfile("node-npm");
    expect(resolveProjectTypeCommand(profile, "e2e", "library")).toBeNull();
  });

  it("resolveProjectTypeCommand: load api → k6 (node-npm)", async () => {
    const profile = await loadProfile("node-npm");
    expect(resolveProjectTypeCommand(profile, "load", "api")).toBe(
      "k6 run loadtest.js",
    );
  });

  it("resolveProjectTypeCommand: load cli → null (fallback default null)", async () => {
    const profile = await loadProfile("node-npm");
    // load_by_project_type cli alanı yok → default → null
    expect(resolveProjectTypeCommand(profile, "load", "cli")).toBeNull();
  });

  it("resolveProjectTypeCommand: python-uv api e2e → hurl (system binary)", async () => {
    const profile = await loadProfile("python-uv");
    // QC B3: hurl uv-managed Python package değil, system binary — uv run kaldırıldı
    expect(resolveProjectTypeCommand(profile, "e2e", "api")).toBe(
      "hurl --test tests/e2e/*.hurl",
    );
  });

  it("resolveProjectTypeCommand: unknown project_type → default fallback", async () => {
    const profile = await loadProfile("node-npm");
    expect(resolveProjectTypeCommand(profile, "e2e", "unknown")).toBe(
      "npm run test:e2e",
    );
  });

  it("resolveProjectTypeCommand: null profile → null", () => {
    expect(resolveProjectTypeCommand(null, "e2e", "web")).toBeNull();
  });
});

describe("profile-loader schema validation (QC B4)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mycl-profile-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFixture(name: string, content: unknown): Promise<string> {
    const path = join(tmpDir, name);
    await fs.writeFile(path, JSON.stringify(content));
    return path;
  }

  it("_loadProfileFromPath returns null for missing file", async () => {
    const result = await _loadProfileFromPath(join(tmpDir, "nope.json"));
    expect(result).toBeNull();
  });

  it("_loadProfileFromPath throws on invalid command type (number)", async () => {
    const path = await writeFixture("broken-cmd.json", {
      stack_id: "test-stack",
      commands: { lint: 123 }, // number — string|null beklenir
    });
    await expect(_loadProfileFromPath(path)).rejects.toThrow(
      /commands\.lint must be string\|null/,
    );
  });

  it("_loadProfileFromPath throws on invalid e2e_by_project_type entry", async () => {
    const path = await writeFixture("broken-e2e.json", {
      stack_id: "test-stack",
      commands: {},
      e2e_by_project_type: { web: 42 }, // number
    });
    await expect(_loadProfileFromPath(path)).rejects.toThrow(
      /e2e_by_project_type\.web must be string\|null/,
    );
  });

  it("_loadProfileFromPath throws when e2e_by_project_type is not an object", async () => {
    const path = await writeFixture("broken-block.json", {
      stack_id: "test-stack",
      commands: {},
      e2e_by_project_type: "not-an-object",
    });
    await expect(_loadProfileFromPath(path)).rejects.toThrow(
      /e2e_by_project_type must be object/,
    );
  });

  it("_loadProfileFromPath throws on missing stack_id", async () => {
    const path = await writeFixture("no-stackid.json", {
      commands: {},
    });
    await expect(_loadProfileFromPath(path)).rejects.toThrow(
      /invalid profile schema/,
    );
  });

  it("_loadProfileFromPath accepts valid profile with mixed string|null commands", async () => {
    const path = await writeFixture("valid.json", {
      stack_id: "test-stack",
      commands: { lint: "echo lint", perf: null, test: "echo test" },
      e2e_by_project_type: { web: "echo e2e", library: null },
    });
    const profile = await _loadProfileFromPath(path);
    expect(profile).not.toBeNull();
    expect(profile!.commands.lint).toBe("echo lint");
    expect(profile!.commands.perf).toBeNull();
  });
});
