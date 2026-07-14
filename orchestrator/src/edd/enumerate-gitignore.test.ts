import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateSourceUnits } from "./enumerate.js";
import { reconcileEddStaleness } from "./engine.js";
import { appendEddUnit, readEddProgress } from "./progress.js";

// EDD kapsamı = güvenlik tarama kapsamı: gitignore'lu dosya (semgrep de atlar) EDD analiz etmemeli — böylece
// standart-olmayan adlı gitignore'lu sır dosyasının içeriği .mycl notuna sızmaz.
describe("EDD gitignore-farkındalık", () => {
  it("gitignore'lu dosyalar analyzable:false (görünür sebep); tracked dosyalar analyzable:true", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "edd-gi-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      // SECRET_FILE_RE'nin YAKALAMADIĞI standart-olmayan sır dosyaları — yalnız gitignore yakalar:
      await fs.writeFile(join(dir, ".gitignore"), "terraform.tfvars\nlocal.settings.json\nbuild-cache.js\n*.log\n");
      await fs.writeFile(join(dir, "terraform.tfvars"), 'db_password = "s3cr3t"');
      await fs.writeFile(join(dir, "local.settings.json"), '{"ApiKey":"xyz"}');
      await fs.writeFile(join(dir, "build-cache.js"), "module.exports = {};");
      await fs.writeFile(join(dir, "app.js"), "console.log('hi');"); // kaynak (ignore değil)
      // TRACKED ama pattern'e uyan dosya (*.log) — force-add ile commit'li → GERÇEKTEN dışlanmış DEĞİL → analiz EDİLMELİ:
      await fs.writeFile(join(dir, "important.log"), "audit trail behavior");
      execFileSync("git", ["add", "-f", "important.log"], { cwd: dir });
      const units = await enumerateSourceUnits(dir);
      const byUnit = new Map(units.map((u) => [u.unit, u]));

      expect(byUnit.get("terraform.tfvars")?.analyzable).toBe(false);
      expect(byUnit.get("terraform.tfvars")?.reason).toMatch(/gitignored/);
      expect(byUnit.get("local.settings.json")?.analyzable).toBe(false);
      expect(byUnit.get("build-cache.js")?.analyzable).toBe(false);
      expect(byUnit.get("app.js")?.analyzable).toBe(true); // kaynak → analiz edilir
      // Kritik: tracked-ama-pattern-eşleşen dosya OVER-SKIP edilmemeli (semgrep de tarar):
      expect(byUnit.get("important.log")?.analyzable).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("non-git dizinde fail-soft: gitignore filtresi atlanır, dosyalar analyzable kalır", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "edd-nogi-"));
    try {
      await fs.writeFile(join(dir, "app.js"), "console.log('hi');");
      await fs.writeFile(join(dir, "notes.txt"), "hello world");
      const units = await enumerateSourceUnits(dir);
      const byUnit = new Map(units.map((u) => [u.unit, u]));
      // git yok → filtre atlanır; dosyalar (sır-dosyası/binary/too-large değil) analyzable kalır.
      expect(byUnit.get("app.js")?.analyzable).toBe(true);
      expect(byUnit.get("notes.txt")?.analyzable).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// reconcile canlanma: bir dosya gitignore'lu iken unanalyzable işaretlenip SONRA un-ignore + tracked olursa
// (semgrep artık tarar), EDD onu yeniden analize açmalı (deleted/too-large canlanma deseninin ikizi; kapsam=tarama).
describe("EDD gitignored kayıt canlanması (reconcile)", () => {
  it("un-ignore + tracked olan gitignored kayıt pending'e canlanır", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "edd-rev-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      await fs.writeFile(join(dir, "gen.ts"), "export const x = 1;");
      execFileSync("git", ["add", "-f", "gen.ts"], { cwd: dir }); // tracked → artık dışlanmıyor
      await appendEddUnit(dir, { unit: "gen.ts", status: "unanalyzable", reason: "gitignored (test)", ts: 1 });
      const rc = await reconcileEddStaleness(dir);
      expect(rc.revived).toBe(1);
      expect((await readEddProgress(dir)).get("gen.ts")?.status).toBe("pending");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("hâlâ gitignore'lu (untracked+ignored) kayıt canlanmaz", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "edd-rev2-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      await fs.writeFile(join(dir, ".gitignore"), "gen.ts\n");
      await fs.writeFile(join(dir, "gen.ts"), "export const x = 1;"); // untracked + ignored → hâlâ dışlanmış
      await appendEddUnit(dir, { unit: "gen.ts", status: "unanalyzable", reason: "gitignored (test)", ts: 1 });
      const rc = await reconcileEddStaleness(dir);
      expect(rc.revived).toBe(0);
      expect((await readEddProgress(dir)).get("gen.ts")?.status).toBe("unanalyzable");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
