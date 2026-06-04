// prototype-cache — baseline allowlist (saf) + snapshot/apply round-trip.
// MYCL_HOME env temp dir'e set edilir → gerçek ~/.mycl KİRLENMEZ (paths.ts:46
// MYCL_HOME override hepsinin önünde). Conservative allowlist'in feature kodunu
// DIŞARIDA bıraktığını (yeni projeleri kirletmez) + greenfield/stack guard'larını kanıtlar.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendAudit } from "../src/audit.js";
import {
  matchesBaseline,
  isStale,
  snapshotPrototype,
  applyPrototype,
  type PrototypeMeta,
} from "../src/prototype-cache.js";
import type { State } from "../src/types.js";

const fakeState = (project_root: string, stack: string, phase = 17): State =>
  ({ project_root, stack, current_phase: phase } as unknown as State);

describe("prototype-cache · matchesBaseline (conservative allowlist)", () => {
  it("baseline dosyaları → true", () => {
    for (const p of [
      "package.json", "tsconfig.json", "vite.config.ts", "eslint.config.js",
      "tailwind.config.ts", ".gitignore", "index.html", "src/main.tsx",
      "src/App.tsx", "src/index.css", "public/logo.svg", "public/img/x.png",
      "pyproject.toml", "Cargo.toml", "jest.config.mjs",
    ]) {
      expect(matchesBaseline(p), `${p} baseline olmalı`).toBe(true);
    }
  });

  it("feature kodu / build çıktısı / vcs → false (prototipe SIZMAZ)", () => {
    for (const p of [
      "src/components/Survey.tsx", "src/api/db.ts", "src/lib/calc.ts",
      "src/pages/Home.tsx", "README.md", "src/foo.test.ts",
      "node_modules/x/index.js", "dist/bundle.js", ".git/config",
      ".mycl/state.json", "target/debug/app", "coverage/lcov.info",
    ]) {
      expect(matchesBaseline(p), `${p} baseline OLMAMALI`).toBe(false);
    }
  });
});

describe("prototype-cache · isStale", () => {
  const meta = (createdAt: number): PrototypeMeta =>
    ({ stack: "node-npm", createdAt, nodeVersion: "v22", fileCount: 5 });
  const DAY = 24 * 60 * 60 * 1000;
  it("taze (1 gün) → false", () => {
    const now = 1_000_000_000_000;
    expect(isStale(meta(now - 1 * DAY), now)).toBe(false);
  });
  it("bayat (31 gün > 30) → true", () => {
    const now = 1_000_000_000_000;
    expect(isStale(meta(now - 31 * DAY), now)).toBe(true);
  });
});

describe("prototype-cache · snapshot + apply round-trip (MYCL_HOME izole)", () => {
  let myclHome: string;
  let src: string;
  let target: string;
  const origHome = process.env.MYCL_HOME;

  beforeEach(async () => {
    myclHome = await mkdtemp(join(tmpdir(), "mycl-cache-"));
    process.env.MYCL_HOME = myclHome;
    src = await mkdtemp(join(tmpdir(), "proto-src-"));
    target = await mkdtemp(join(tmpdir(), "proto-tgt-"));
  });
  afterEach(async () => {
    if (origHome === undefined) delete process.env.MYCL_HOME;
    else process.env.MYCL_HOME = origHome;
    await Promise.all([
      rm(myclHome, { recursive: true, force: true }),
      rm(src, { recursive: true, force: true }),
      rm(target, { recursive: true, force: true }),
    ]).catch(() => {});
  });

  async function seedSourceProject(): Promise<void> {
    // baseline
    await writeFile(join(src, "package.json"), JSON.stringify({ name: "s", dependencies: { vite: "^5" } }));
    await writeFile(join(src, "vite.config.ts"), "export default {}");
    await mkdir(join(src, "src"), { recursive: true });
    await writeFile(join(src, "src", "main.tsx"), "// entry");
    await mkdir(join(src, "public"), { recursive: true });
    await writeFile(join(src, "public", "logo.svg"), "<svg/>");
    // feature (prototipe SIZMAMALI)
    await mkdir(join(src, "src", "components"), { recursive: true });
    await writeFile(join(src, "src", "components", "Survey.tsx"), "// feature");
    await writeFile(join(src, "README.md"), "# proje");
  }

  it("YEŞİL koşu → baseline kaydedilir, feature HARİÇ; apply greenfield'e kopyalar", async () => {
    await seedSourceProject();
    // YEŞİL audit: tamamlandı + gate-fail yok.
    await appendAudit(src, { ts: Date.now(), phase: 17, event: "phase-17-complete", caller: "mycl-orchestrator" });

    await snapshotPrototype(fakeState(src, "node-npm"));

    const cacheDir = join(myclHome, "prototypes", "node-npm");
    expect(existsSync(join(cacheDir, "package.json"))).toBe(true);
    expect(existsSync(join(cacheDir, "vite.config.ts"))).toBe(true);
    expect(existsSync(join(cacheDir, "src", "main.tsx"))).toBe(true);
    expect(existsSync(join(cacheDir, "public", "logo.svg"))).toBe(true);
    // feature SIZMADI:
    expect(existsSync(join(cacheDir, "src", "components", "Survey.tsx"))).toBe(false);
    expect(existsSync(join(cacheDir, "README.md"))).toBe(false);
    // meta yazıldı:
    expect(existsSync(join(myclHome, "prototypes", "node-npm.meta.json"))).toBe(true);
    const meta = JSON.parse(await readFile(join(myclHome, "prototypes", "node-npm.meta.json"), "utf-8"));
    expect(meta.stack).toBe("node-npm");

    // apply: boş (greenfield) target'a kopyalar.
    const applied = await applyPrototype(fakeState(target, "node-npm", 5));
    expect(applied).toBe(true);
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "src", "main.tsx"))).toBe(true);
    expect(existsSync(join(target, "src", "components", "Survey.tsx"))).toBe(false);
  });

  it("YEŞİL DEĞİL (gate-fail var) → snapshot kaydetmez", async () => {
    await seedSourceProject();
    await appendAudit(src, { ts: Date.now(), phase: 17, event: "phase-17-complete", caller: "mycl-orchestrator" });
    await appendAudit(src, { ts: Date.now(), phase: 13, event: "security-fail", caller: "mycl-orchestrator", detail: "csp" });
    await snapshotPrototype(fakeState(src, "node-npm"));
    expect(existsSync(join(myclHome, "prototypes", "node-npm"))).toBe(false);
  });

  it("apply: stack için cache yoksa → false (no-op)", async () => {
    const applied = await applyPrototype(fakeState(target, "rust", 5));
    expect(applied).toBe(false);
  });

  it("apply: stack unknown → false", async () => {
    const applied = await applyPrototype(fakeState(target, "unknown", 5));
    expect(applied).toBe(false);
  });

  it("apply: mevcut (greenfield-olmayan) projeye uygulaMAZ → false", async () => {
    // Önce cache oluştur.
    await seedSourceProject();
    await appendAudit(src, { ts: Date.now(), phase: 17, event: "phase-17-complete", caller: "mycl-orchestrator" });
    await snapshotPrototype(fakeState(src, "node-npm"));
    // target'ı "mevcut proje" yap (kaynak dosyalar + manifest).
    await writeFile(join(target, "package.json"), JSON.stringify({ name: "existing" }));
    await mkdir(join(target, "src"), { recursive: true });
    await writeFile(join(target, "src", "existing.ts"), "export const x = 1;");
    const applied = await applyPrototype(fakeState(target, "node-npm", 5));
    expect(applied).toBe(false);
  });
});
