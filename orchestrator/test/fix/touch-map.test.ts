// fix/touch-map — D5 dokunuş haritası testleri (gerçek temp proje).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { buildTouchpointSummary } from "../../src/fix/touch-map.js";

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf-8");
}

describe("fix/touch-map · buildTouchpointSummary", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-tm-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("dokunulan dosyayı + blast-radius'unu gösterir", async () => {
    await write(root, "src/hub.ts", "export const h = 1;\n");
    for (const n of ["a", "b"]) {
      await write(root, `src/${n}.ts`, "import { h } from './hub';\n");
    }
    const plan = "Edit src/hub.ts to fix the null guard at the top.";
    const summary = await buildTouchpointSummary(root, plan);
    expect(summary).toContain("Dokunuş haritası");
    expect(summary).toContain("src/hub.ts");
    expect(summary).toContain("etkiler"); // blast-radius bölümü
    expect(summary).toContain("src/a.ts");
    expect(summary).toContain("src/b.ts");
  });

  it("plan'da dosya yoksa null", async () => {
    const summary = await buildTouchpointSummary(root, "Just rethink the approach, no specific files.");
    expect(summary).toBeNull();
  });

  it("grafik kurulamasa bile dokunulan dosyaları listeler (graceful)", async () => {
    // Hiç kaynak dosya yok → graph available:false → sadece dokunuş listesi.
    const summary = await buildTouchpointSummary(root, "Change config in src/settings.ts");
    expect(summary).toContain("src/settings.ts");
    expect(summary).not.toContain("etkiler");
  });
});
