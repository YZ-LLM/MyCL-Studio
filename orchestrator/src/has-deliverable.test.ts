import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasDeliverable } from "./phase-1-codebase-probe.js";

// hasDeliverable = boş-build guard'ının (onTaskMaybeComplete + emitVerificationSummary) çekirdek sinyali.
// GERÇEK dosya YOKSA false → görev 'done' değil 'dropped' damgalanmalı (sahte-tamamlanma önleme). Bu testler o sinyali kilitler.
describe("hasDeliverable — boş-build sinyali (sahte-tamamlanma guard'ı)", () => {
  it("boş build (yalnız .mycl + node_modules + devs) → false", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "hd-empty-"));
    try {
      await fs.mkdir(join(dir, ".mycl"), { recursive: true }); // MyCL metadata (nokta-dizin)
      await fs.writeFile(join(dir, ".mycl", "spec.md"), "spec");
      await fs.mkdir(join(dir, "node_modules"), { recursive: true }); // NON_DELIVERABLE_TOP
      await fs.mkdir(join(dir, "devs"), { recursive: true });
      expect(await hasDeliverable(dir)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("gerçek uygulama dosyası (app.js) → true", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "hd-app-"));
    try {
      await fs.mkdir(join(dir, ".mycl"), { recursive: true });
      await fs.writeFile(join(dir, "app.js"), "console.log(1);");
      expect(await hasDeliverable(dir)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("meşru dot-dizin deliverable'ı (.github/workflows CI) → true (yanlış-drop önleme)", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "hd-gh-"));
    try {
      await fs.mkdir(join(dir, ".mycl"), { recursive: true });
      await fs.mkdir(join(dir, ".github", "workflows"), { recursive: true });
      await fs.writeFile(join(dir, ".github", "workflows", "ci.yml"), "name: ci");
      expect(await hasDeliverable(dir)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("git-hook config (.husky) → true", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "hd-husky-"));
    try {
      await fs.mkdir(join(dir, ".husky"), { recursive: true });
      await fs.writeFile(join(dir, ".husky", "pre-commit"), "npm test");
      expect(await hasDeliverable(dir)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("DAR-EDGE (dokümante): yalnız gevşek dot-dosya (.env/.gitignore, dizinsiz) → false — nadir, yeniden gönderilebilir", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "hd-dot-"));
    try {
      await fs.writeFile(join(dir, ".env"), "X=1");
      await fs.writeFile(join(dir, ".gitignore"), "node_modules");
      expect(await hasDeliverable(dir)).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("okunamayan kök → true (fail-open: guard atlanır, mevcut davranış)", async () => {
    expect(await hasDeliverable(join(tmpdir(), "hd-does-not-exist-xyz-12345"))).toBe(true);
  });

  it("stack-bağımsız: manifest/framework varsaymaz (main.py tek başına deliverable)", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "hd-py-"));
    try {
      await fs.writeFile(join(dir, "main.py"), "print(1)");
      expect(await hasDeliverable(dir)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
