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
  composeStackFingerprint,
  type PrototypeMeta,
} from "../src/prototype-cache.js";
import type { State } from "../src/types.js";

const fakeState = (project_root: string, stack: string, phase = 17): State =>
  ({ project_root, stack, current_phase: phase } as unknown as State);

describe("prototype-cache · composeStackFingerprint (tam-stack klasör adı)", () => {
  it("spec'ten dil + framework ekler (deterministik, base korunur)", () => {
    expect(composeStackFingerprint("node-npm", "A React + TypeScript admin panel")).toBe(
      "node-npm_typescript_react",
    );
    expect(composeStackFingerprint("node-npm", "Angular dashboard")).toBe("node-npm_angular");
  });

  it("Next.js → react + next; Python+Django ayrışır (collision yok)", () => {
    expect(composeStackFingerprint("node-npm", "Built with Next.js")).toBe("node-npm_react_next");
    expect(composeStackFingerprint("python-pip", "Django REST API")).toBe("python-pip_django");
  });

  it("token yoksa yalnız base (geriye-uyumlu) + base sanitize edilir", () => {
    expect(composeStackFingerprint("node-npm", "generic web app")).toBe("node-npm");
    expect(composeStackFingerprint("go", "")).toBe("go");
  });

  it("aynı spec → aynı parmak izi (snapshot=apply eşleşmesi)", () => {
    const spec = "React TypeScript app";
    expect(composeStackFingerprint("node-npm", spec)).toBe(composeStackFingerprint("node-npm", spec));
  });
});

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
  const origProtoDir = process.env.MYCL_PROTOTYPES_DIR;

  beforeEach(async () => {
    myclHome = await mkdtemp(join(tmpdir(), "mycl-cache-"));
    process.env.MYCL_HOME = myclHome;
    // Prototipler artık repo-kökü tabanlı → testte MYCL_PROTOTYPES_DIR ile temp'e yönlendir
    // (gerçek repo prototypes/'ını KİRLETME).
    process.env.MYCL_PROTOTYPES_DIR = join(myclHome, "prototypes");
    src = await mkdtemp(join(tmpdir(), "proto-src-"));
    target = await mkdtemp(join(tmpdir(), "proto-tgt-"));
  });
  afterEach(async () => {
    if (origHome === undefined) delete process.env.MYCL_HOME;
    else process.env.MYCL_HOME = origHome;
    if (origProtoDir === undefined) delete process.env.MYCL_PROTOTYPES_DIR;
    else process.env.MYCL_PROTOTYPES_DIR = origProtoDir;
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

  it("YEŞİL koşu → TAM proje kaydedilir (feature DAHİL); apply greenfield'e komple kopyalar", async () => {
    await seedSourceProject();
    // YEŞİL audit: tamamlandı + gate-fail yok → verdict PASS → TÜM dosyalar (YZLLM 2026-06-22).
    await appendAudit(src, { ts: Date.now(), phase: 17, event: "phase-17-complete", caller: "mycl-orchestrator" });

    await snapshotPrototype(fakeState(src, "node-npm"));

    const cacheDir = join(myclHome, "prototypes", "node-npm");
    expect(existsSync(join(cacheDir, "package.json"))).toBe(true);
    expect(existsSync(join(cacheDir, "vite.config.ts"))).toBe(true);
    expect(existsSync(join(cacheDir, "src", "main.tsx"))).toBe(true);
    expect(existsSync(join(cacheDir, "public", "logo.svg"))).toBe(true);
    // YEŞİL → feature DE DAHİL (tam çalışan proje prototip olur):
    expect(existsSync(join(cacheDir, "src", "components", "Survey.tsx"))).toBe(true);
    expect(existsSync(join(cacheDir, "README.md"))).toBe(true);
    // meta yazıldı:
    expect(existsSync(join(myclHome, "prototypes", "node-npm.meta.json"))).toBe(true);
    const meta = JSON.parse(await readFile(join(myclHome, "prototypes", "node-npm.meta.json"), "utf-8"));
    expect(meta.stack).toBe("node-npm");

    // apply: boş (greenfield) target'a komple kopyalar (full prototip → feature dahil).
    const applied = await applyPrototype(fakeState(target, "node-npm", 5));
    expect(applied).toBe(true);
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "src", "main.tsx"))).toBe(true);
    expect(existsSync(join(target, "src", "components", "Survey.tsx"))).toBe(true);
  });

  it("gate-fail VAR ama TAMAMLANDI → snapshot YİNE kaydedilir (YZLLM: baseline kalite-fail'inden etkilenmez)", async () => {
    await seedSourceProject();
    await appendAudit(src, { ts: Date.now(), phase: 17, event: "phase-17-complete", caller: "mycl-orchestrator" });
    await appendAudit(src, { ts: Date.now(), phase: 13, event: "security-fail", caller: "mycl-orchestrator", detail: "csp" });
    await snapshotPrototype(fakeState(src, "node-npm"));
    expect(existsSync(join(myclHome, "prototypes", "node-npm"))).toBe(true);
  });

  it("TAMAMLANMADI (yarım koşu, completion yok) → snapshot kaydetmez", async () => {
    await seedSourceProject();
    // phase-17-complete YOK → verdict.completed=false → yarım koşu prototip olmaz.
    await appendAudit(src, { ts: Date.now(), phase: 8, event: "phase-8-complete", caller: "mycl-orchestrator" });
    await snapshotPrototype(fakeState(src, "node-npm"));
    expect(existsSync(join(myclHome, "prototypes", "node-npm"))).toBe(false);
  });

  it("force=true → verdict baypas, her durumda kaydeder", async () => {
    await seedSourceProject();
    await snapshotPrototype(fakeState(src, "node-npm"), { force: true });
    expect(existsSync(join(myclHome, "prototypes", "node-npm"))).toBe(true);
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

// Harita akışı bulgusu (2026-11-26): yeşil koşuda projenin TAMAMI prototipe kopyalanıyor, `.env` dahil.
// Prototipler repo içinde durur ve başka projelere kopyalanır → sır dosyaları dışarıda kalmalı.
describe("isSecretFileName — prototipe girmeyen dosyalar", () => {
  it("`.env` ailesi dışarıda, örnek dosyalar içeride", async () => {
    const { isSecretFileName } = await import("../src/prototype-cache.js");
    for (const n of [".env", ".env.local", ".env.production", ".ENV", "server.pem", "tls.key", "cert.p12", "secrets.json", "credentials.json", "id_rsa", "id_ed25519.pub"]) {
      expect(isSecretFileName(n), n).toBe(true);
    }
    for (const n of [".env.example", ".env.sample", ".env.template", "env.ts", "package.json", ".npmrc", "keyboard.ts", "monkey.tsx", "index.html"]) {
      expect(isSecretFileName(n), n).toBe(false);
    }
  });
});
