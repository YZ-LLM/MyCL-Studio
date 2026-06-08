import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProjectMap,
  formatProjectMap,
  type ProjectMap,
} from "../src/onboarding/project-map.js";

describe("formatProjectMap (saf)", () => {
  it("merkezi modüller varsa harita metni üretir", () => {
    const m: ProjectMap = {
      available: true,
      fileCount: 40,
      central: [
        { file: "src/api/db.ts", importedBy: 12 },
        { file: "src/util/log.ts", importedBy: 7 },
      ],
    };
    const out = formatProjectMap(m);
    expect(out).toContain("Proje haritası");
    expect(out).toContain("src/api/db.ts (12 modül");
    expect(out).toContain("src/util/log.ts (7 modül");
  });

  it("harita yok / boş → '' (gürültü yok)", () => {
    expect(formatProjectMap({ available: false, fileCount: 0, central: [] })).toBe("");
    expect(formatProjectMap({ available: true, fileCount: 5, central: [] })).toBe("");
  });
});

describe("buildProjectMap (smoke — gerçek dosyalar)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mycl-pmap-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("dosya olan projede ProjectMap şekli döner (throw yok)", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "b.ts"), "export const x = 1;\n");
    await writeFile(join(dir, "src", "a.ts"), 'import { x } from "./b.js";\nexport const y = x;\n');
    const m = await buildProjectMap(dir);
    expect(typeof m.available).toBe("boolean");
    expect(Array.isArray(m.central)).toBe(true);
  });
});
