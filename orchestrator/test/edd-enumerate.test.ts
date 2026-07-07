// edd/enumerate — dil-agnostik birim listesi. metin=analyzable, binary/büyük=analyzable:false(+sebep),
// skip-dizin elenir, "miss nothing" (her dosya bir statü alır). İzole test (geçici dizin).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateSourceUnits } from "../src/edd/enumerate.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "edd-enum-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("edd/enumerate · dil-agnostik birim listesi", () => {
  it("metin kod=analyzable; binary=unanalyzable(binary); büyük=too-large; node_modules elenir", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "x"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export const x = 1;\n", "utf-8");
    await writeFile(join(root, "src", "handler.go"), "package main\nfunc main() {}\n", "utf-8"); // dil-agnostik (uzantı hardcode yok)
    await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02])); // null-byte → binary
    await writeFile(join(root, "huge.js"), "x".repeat(300 * 1024), "utf-8"); // >256KB → too-large
    await writeFile(join(root, "node_modules", "x", "dep.js"), "module.exports={}", "utf-8"); // elenmeli

    const units = await enumerateSourceUnits(root);
    const byUnit = new Map(units.map((u) => [u.unit, u] as const));

    expect(byUnit.get("src/app.ts")?.analyzable).toBe(true);
    expect(byUnit.get("src/handler.go")?.analyzable).toBe(true); // Go da birim (dil-agnostik)
    expect(byUnit.get("logo.png")?.analyzable).toBe(false);
    expect(byUnit.get("logo.png")?.reason).toBe("binary");
    expect(byUnit.get("huge.js")?.analyzable).toBe(false);
    expect(byUnit.get("huge.js")?.reason).toContain("too-large");
    // node_modules elendi (miss nothing DEĞİL — kasıtlı skip-dizin)
    expect([...byUnit.keys()].some((k) => k.includes("node_modules"))).toBe(false);
    // her gerçek dosya bir statü aldı (analyzable veya sebepli değil)
    expect(units.every((u) => u.analyzable || !!u.reason)).toBe(true);
  });

  it("analyzable birimler unanalyzable'lardan ÖNCE sıralanır (erken değer)", async () => {
    await writeFile(join(root, "code.ts"), "export const a = 1;", "utf-8");
    await writeFile(join(root, "asset.bin"), Buffer.from([0x00, 0x01]));
    const units = await enumerateSourceUnits(root);
    const iCode = units.findIndex((u) => u.unit === "code.ts");
    const iAsset = units.findIndex((u) => u.unit === "asset.bin");
    expect(iCode).toBeGreaterThanOrEqual(0);
    expect(iAsset).toBeGreaterThanOrEqual(0);
    expect(iCode).toBeLessThan(iAsset); // analyzable önce
  });
});
