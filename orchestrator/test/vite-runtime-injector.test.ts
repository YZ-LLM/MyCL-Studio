import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { ensureViteRuntimeInjection } from "../src/vite-runtime-injector.js";

describe("vite-runtime-injector (v15.2 Core port substitution)", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "mycl-vite-injector-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("skips silently when no vite.config.* present", async () => {
    const result = await ensureViteRuntimeInjection(projectRoot);
    expect(result.injected).toBe(false);
    expect(result.configPath).toBeNull();
  });

  it("substitutes {{MYCL_RUNTIME_PORT}} when copying plugin", async () => {
    // Minimal vite.config.js
    await fs.writeFile(
      join(projectRoot, "vite.config.js"),
      `import { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [] });\n`,
    );

    const result = await ensureViteRuntimeInjection(projectRoot);
    expect(result.injected).toBe(true);

    // Plugin .mycl/runtime-error-plugin.cjs içine kopyalandı; placeholder
    // substitute edildi (runtime port veya 9273 fallback).
    const plugin = await fs.readFile(
      join(projectRoot, ".mycl", "runtime-error-plugin.cjs"),
      "utf-8",
    );
    // Placeholder kalmamalı
    expect(plugin).not.toContain("{{MYCL_RUNTIME_PORT}}");
    // Geçerli port substitute edilmiş olmalı (9273 fallback veya gerçek port)
    expect(plugin).toMatch(/localhost:\d+\/__mycl\/runtime-error/);
  });

  it("idempotent — second call is no-op on config", async () => {
    await fs.writeFile(
      join(projectRoot, "vite.config.js"),
      `import { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [] });\n`,
    );
    const first = await ensureViteRuntimeInjection(projectRoot);
    expect(first.injected).toBe(true);
    const configAfterFirst = await fs.readFile(
      join(projectRoot, "vite.config.js"),
      "utf-8",
    );

    const second = await ensureViteRuntimeInjection(projectRoot);
    expect(second.injected).toBe(true);
    const configAfterSecond = await fs.readFile(
      join(projectRoot, "vite.config.js"),
      "utf-8",
    );
    expect(configAfterSecond).toBe(configAfterFirst);
  });
});
