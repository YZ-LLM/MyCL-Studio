// orchestrator-agent/path-sandbox — proje izolasyon enforcement testleri.
//
// Kullanıcı talebi (v15.6 — 2026-05-24): "projeler asla birbirine
// karışmamalıdır". Agent Read/Grep/Bash tool'larında absolute path ile başka
// projeye erişim KOD seviyesinde reddedilmeli.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractPathTokensFromBash,
  isPathWithinRoot,
  realpathWithinRoot,
  validatePathForAgent,
} from "../../src/orchestrator-agent/path-sandbox.js";

describe("path-sandbox · isPathWithinRoot", () => {
  const root = "/Users/u/proj";

  it("root altındaki dosya → true", () => {
    expect(isPathWithinRoot(root, "/Users/u/proj/src/index.ts")).toBe(true);
  });

  it("root'un kendisi → true", () => {
    expect(isPathWithinRoot(root, "/Users/u/proj")).toBe(true);
  });

  it("kardeş dizin → false", () => {
    expect(isPathWithinRoot(root, "/Users/u/otherproj/file.ts")).toBe(false);
  });

  it("..  ile root dışı → false", () => {
    expect(isPathWithinRoot(root, "/Users/u/proj/../other/x")).toBe(false);
  });

  it("adjacent prefix collision → false (proj vs proj-evil)", () => {
    expect(isPathWithinRoot(root, "/Users/u/proj-evil/x")).toBe(false);
  });

  it("trailing slash root normalize", () => {
    expect(isPathWithinRoot("/Users/u/proj/", "/Users/u/proj/x")).toBe(true);
  });

  it("relative path root altında resolve → true", () => {
    expect(isPathWithinRoot(root, "src/index.ts")).toBe(true);
  });

  it("relative .. dışarı çıkarsa → false", () => {
    expect(isPathWithinRoot(root, "../other")).toBe(false);
  });

  it("boş target → false", () => {
    expect(isPathWithinRoot(root, "")).toBe(false);
  });

  it("boş root → false", () => {
    expect(isPathWithinRoot("", "/x")).toBe(false);
  });
});

describe("path-sandbox · validatePathForAgent", () => {
  const root = "/Users/u/proj";

  it("absolute inside → ok + resolved", () => {
    const v = validatePathForAgent(root, "/Users/u/proj/spec.md");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.resolved).toBe("/Users/u/proj/spec.md");
  });

  it("absolute outside → reject", () => {
    const v = validatePathForAgent(root, "/etc/passwd");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("outside project root");
  });

  it("relative resolved inside → ok", () => {
    const v = validatePathForAgent(root, "src/main.ts");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.resolved).toBe("/Users/u/proj/src/main.ts");
  });

  it("relative .. dışarı → reject", () => {
    const v = validatePathForAgent(root, "../../etc/passwd");
    expect(v.ok).toBe(false);
  });

  it("tilde → reject (home erişim yasak)", () => {
    const v = validatePathForAgent(root, "~/.mycl/secrets.json");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("tilde");
  });

  it("boş string → reject", () => {
    const v = validatePathForAgent(root, "");
    expect(v.ok).toBe(false);
  });
});

describe("path-sandbox · extractPathTokensFromBash", () => {
  it("git log → boş (komut adı + flag, path yok)", () => {
    expect(extractPathTokensFromBash("git log")).toEqual([]);
  });

  it("git status → boş", () => {
    expect(extractPathTokensFromBash("git status")).toEqual([]);
  });

  it("cat /etc/passwd → absolute yakalanır", () => {
    expect(extractPathTokensFromBash("cat /etc/passwd")).toEqual(["/etc/passwd"]);
  });

  it("find /Users/x -name '*.ts' → absolute yakalanır, flag yok sayılır", () => {
    expect(extractPathTokensFromBash("find /Users/x -name '*.ts'")).toEqual([
      "/Users/x",
    ]);
  });

  it("cat README.md → boş (relative, flagsız değil ama / ile başlamıyor)", () => {
    expect(extractPathTokensFromBash("cat README.md")).toEqual([]);
  });

  it("cat src/foo.ts → boş (relative)", () => {
    expect(extractPathTokensFromBash("cat src/foo.ts")).toEqual([]);
  });

  it("cat ~/.mycl/secrets.json → tilde yakalanır", () => {
    expect(extractPathTokensFromBash("cat ~/.mycl/secrets.json")).toEqual([
      "~/.mycl/secrets.json",
    ]);
  });

  it("cat ../other/x → parent-traversal yakalanır", () => {
    expect(extractPathTokensFromBash("cat ../other/x")).toEqual(["../other/x"]);
  });

  it("quoted boşluklu path tek token", () => {
    expect(extractPathTokensFromBash("cat '/Users/x/a b.txt'")).toEqual([
      "/Users/x/a b.txt",
    ]);
  });

  it("double-quoted absolute", () => {
    expect(extractPathTokensFromBash('cat "/Users/x/file.txt"')).toEqual([
      "/Users/x/file.txt",
    ]);
  });

  it("boş komut → boş", () => {
    expect(extractPathTokensFromBash("")).toEqual([]);
    expect(extractPathTokensFromBash("   ")).toEqual([]);
  });

  it("birden fazla absolute argüman", () => {
    expect(extractPathTokensFromBash("cat /a /b /c")).toEqual(["/a", "/b", "/c"]);
  });
});

describe("path-sandbox · realpathWithinRoot (symlink escape)", () => {
  let tmpRoot: string;
  let otherProj: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "mycl-sandbox-root-"));
    otherProj = await mkdtemp(join(tmpdir(), "mycl-sandbox-other-"));
    await writeFile(join(otherProj, "secret.txt"), "secret data");
    // Root altında symlink → other/secret.txt
    await symlink(join(otherProj, "secret.txt"), join(tmpRoot, "escape-sym"));
    // Root altında normal dosya
    await writeFile(join(tmpRoot, "ok.txt"), "inside data");
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(otherProj, { recursive: true, force: true });
  });

  it("root altındaki normal dosya → true", async () => {
    expect(await realpathWithinRoot(tmpRoot, join(tmpRoot, "ok.txt"))).toBe(
      true,
    );
  });

  it("symlink ile escape → false", async () => {
    expect(
      await realpathWithinRoot(tmpRoot, join(tmpRoot, "escape-sym")),
    ).toBe(false);
  });

  it("var olmayan dosya (ENOENT) → sync sonuca düşer", async () => {
    expect(await realpathWithinRoot(tmpRoot, join(tmpRoot, "yok.txt"))).toBe(
      true,
    );
    expect(
      await realpathWithinRoot(tmpRoot, "/Users/u/otherproj/yok.txt"),
    ).toBe(false);
  });
});
