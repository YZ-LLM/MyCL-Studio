import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Project-scoped Vitest config. What matters here:
//  1. `root` + an inline (empty) PostCSS config stop Vite from walking parent
//     directories looking for a postcss config — that walk hits the sandbox
//     deny on the home dir and crashes the run. We process no CSS in tests.
//  2. The `@/*` path alias mirrors tsconfig so tests import app modules the
//     same way production code does.
//  3. Tests run in forked workers started with --experimental-sqlite so the
//     node:sqlite builtin (the persistence layer) is available without the
//     caller having to set NODE_OPTIONS.
//  4. An in-memory DB + a fixed JWT secret keep tests isolated and hermetic.
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  resolve: {
    alias: { "@": rootDir },
  },
  css: {
    // Inline config → Vite does not search the filesystem for postcss.config.*
    postcss: { plugins: [] },
  },
  test: {
    environment: "node",
    // Collect only Vitest unit/integration tests (*.test.ts). Playwright E2E
    // specs (*.spec.ts, e.g. tests/smoke.spec.ts) import `@playwright/test` and
    // must run ONLY under Playwright (playwright.config.ts, Phase 16); letting
    // Vitest collect them throws "Playwright Test did not expect test()…".
    include: ["tests/**/*.test.ts"],
    globals: false,
    pool: "forks",
    poolOptions: {
      forks: { execArgv: ["--experimental-sqlite"] },
    },
    env: {
      DATABASE_PATH: ":memory:",
      JWT_SECRET: "test-only-jwt-secret-not-used-in-production",
    },
  },
});
