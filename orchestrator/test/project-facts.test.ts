import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectFacts } from "../src/project-facts.js";

describe("buildProjectFacts (Ümit: ajan JS/TS bilsin)", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mycl-facts-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("tsconfig YOK + .jsx → javascript (TS aracı uygulanamaz uyarısı)", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "^5" }, dependencies: { react: "^18" } }));
    await writeFile(join(dir, "src", "App.jsx"), "export default () => null;\n");
    const f = await buildProjectFacts(dir);
    expect(f.language).toBe("javascript");
    expect(f.hasTsconfig).toBe(false);
    expect(f.framework).toBe("vite");
    expect(f.summary).toMatch(/JavaScript project/i);
    expect(f.summary).toMatch(/ts-prune|NOT applicable/i);
  });

  it("tsconfig VAR → typescript", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "tsconfig.json"), "{}");
    await writeFile(join(dir, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5", next: "^14" } }));
    await writeFile(join(dir, "src", "page.tsx"), "export default function P(){return null}\n");
    const f = await buildProjectFacts(dir);
    expect(f.language).toBe("typescript");
    expect(f.hasTsconfig).toBe(true);
    expect(f.framework).toBe("next");
  });
});
