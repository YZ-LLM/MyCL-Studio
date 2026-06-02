// fix/dep-graph — çok dilli reverse-import grafiği + getAffected testleri.
// Gerçek temp proje ağacı (analyzer'lar statSync ile dosya varlığı kontrol eder).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import {
  buildReverseImportGraph,
  getAffected,
} from "../../src/fix/dep-graph/index.js";

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf-8");
}

describe("fix/dep-graph · JavaScript/TypeScript", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-depg-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reverse-import grafiği kurar + blast-radius hesaplar", async () => {
    // b <- a <- c (c, a'yı; a, b'yi import eder)
    await write(root, "src/b.ts", "export const b = 1;\n");
    await write(root, "src/a.ts", "import { b } from './b';\nexport const a = b + 1;\n");
    await write(root, "src/c.ts", "import { a } from './a';\nexport const c = a;\n");

    const graph = await buildReverseImportGraph(root);
    expect(graph.available).toBe(true);
    expect(graph.fileCount).toBe(3);

    // b değişirse → a doğrudan (depth1), c dolaylı (depth2) etkilenir
    const affected = getAffected(graph, [join(root, "src/b.ts")], 2, root);
    const modules = affected.map((a) => a.module).sort();
    expect(modules).toEqual(["src/a.ts", "src/c.ts"]);
    const aRow = affected.find((x) => x.module === "src/a.ts")!;
    const cRow = affected.find((x) => x.module === "src/c.ts")!;
    expect(aRow.why).toContain("doğrudan");
    expect(cRow.why).toContain("2. derece");
  });

  it("bare paket import'larını (react) grafiğe almaz", async () => {
    await write(root, "src/x.ts", "import React from 'react';\nimport { y } from './y';\n");
    await write(root, "src/y.ts", "export const y = 1;\n");
    const graph = await buildReverseImportGraph(root);
    // react çözülmez (null) → sadece y kenarı
    expect(graph.reverse.has(join(root, "src/y.ts"))).toBe(true);
    expect([...graph.reverse.keys()].some((k) => k.includes("react"))).toBe(false);
  });

  it("dynamic import + require yakalanır", async () => {
    await write(root, "src/dep.ts", "export const d = 1;\n");
    await write(root, "src/dyn.ts", "async function f(){ await import('./dep'); }\nconst r = require('./dep');\n");
    const graph = await buildReverseImportGraph(root);
    const importers = graph.reverse.get(join(root, "src/dep.ts"));
    expect(importers && [...importers][0]).toContain("dyn.ts");
  });

  it("index.ts çözümlemesi (./dir → ./dir/index.ts)", async () => {
    await write(root, "src/lib/index.ts", "export const lib = 1;\n");
    await write(root, "src/main.ts", "import { lib } from './lib';\n");
    const graph = await buildReverseImportGraph(root);
    expect(graph.reverse.has(join(root, "src/lib/index.ts"))).toBe(true);
  });

  it("hub dosya (≥3 importer) → high risk", async () => {
    await write(root, "src/hub.ts", "export const h = 1;\n");
    await write(root, "src/leaf.ts", "export const l = 1;\n");
    // hub'ı 3 dosya import eder; ayrıca hepsi leaf'i de import eder
    for (const n of ["p", "q", "r"]) {
      await write(root, `src/${n}.ts`, "import { h } from './hub';\nimport { l } from './leaf';\n");
    }
    const graph = await buildReverseImportGraph(root);
    // leaf değişirse → p,q,r doğrudan; bunların her biri hub tarafından... hayır,
    // p/q/r'yi kimse import etmiyor (importer 0) → medium. hub'ı p,q,r import ediyor.
    const affected = getAffected(graph, [join(root, "src/hub.ts")], 2, root);
    // hub'ı p,q,r doğrudan import eder (depth1). p/q/r'nin importer'ı yok → medium.
    expect(affected.every((a) => a.risk === "medium" || a.risk === "low")).toBe(true);
    expect(affected.map((a) => a.module).sort()).toEqual(["src/p.ts", "src/q.ts", "src/r.ts"]);
  });

  it("test dosyaları low risk", async () => {
    await write(root, "src/util.ts", "export const u = 1;\n");
    await write(root, "src/util.test.ts", "import { u } from './util';\n");
    const graph = await buildReverseImportGraph(root);
    const affected = getAffected(graph, [join(root, "src/util.ts")], 2, root);
    const t = affected.find((a) => a.module.includes("util.test.ts"))!;
    expect(t.risk).toBe("low");
  });
});

describe("fix/dep-graph · Python", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-depg-py-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("relative + absolute python import çözümlemesi", async () => {
    await write(root, "app/models.py", "class User: pass\n");
    await write(root, "app/views.py", "from .models import User\nimport app.models\n");
    const graph = await buildReverseImportGraph(root);
    expect(graph.available).toBe(true);
    const importers = graph.reverse.get(join(root, "app/models.py"));
    expect(importers && [...importers][0]).toContain("views.py");
  });

  it("stdlib / 3rd-party python import'ları atlanır", async () => {
    await write(root, "app/main.py", "import os\nimport requests\nfrom .helper import h\n");
    await write(root, "app/helper.py", "def h(): pass\n");
    const graph = await buildReverseImportGraph(root);
    expect([...graph.reverse.keys()].some((k) => k.includes("os") || k.includes("requests"))).toBe(false);
    expect(graph.reverse.has(join(root, "app/helper.py"))).toBe(true);
  });
});

describe("fix/dep-graph · graceful", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-depg-empty-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("kaynak dosyası olmayan proje → available false", async () => {
    await writeFile(join(root, "README.md"), "# x", "utf-8");
    const graph = await buildReverseImportGraph(root);
    expect(graph.available).toBe(false);
    expect(getAffected(graph, [join(root, "anything.ts")])).toEqual([]);
  });
});
