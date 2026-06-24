// adr — saf mantık + dosya yazımı testleri (parse, hash, numara/tarih koruma, tarihsel-silinmezlik).

import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adrContentHash,
  parseAdrDecisions,
  writeAdrs,
  type AdrDecision,
} from "../src/adr.js";

const D = (over: Partial<AdrDecision> = {}): AdrDecision => ({
  slug: "auth-strategy",
  title: "Authentication strategy",
  status: "accepted",
  context: "needed login",
  options: "session vs jwt",
  decision: "JWT",
  consequences: "stateless",
  ...over,
});

describe("parseAdrDecisions", () => {
  it("geçerli kararı normalize eder", () => {
    const r = parseAdrDecisions([{ slug: "auth-strategy", title: "Auth", decision: "JWT" }]);
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("accepted"); // default
  });

  it("slug/title/decision eksik → atılır (içeriksiz 'tiyatro' önle)", () => {
    expect(parseAdrDecisions([{ slug: "x", title: "T" }])).toEqual([]); // decision yok
    expect(parseAdrDecisions([{ title: "T", decision: "D" }])).toHaveLength(1); // slug title'dan türetilir
  });

  it("bozuk slug kebab-case'e indirgenir", () => {
    const r = parseAdrDecisions([{ slug: "Auth Strategy!", title: "T", decision: "D" }]);
    expect(r[0].slug).toBe("auth-strategy");
  });

  it("aynı slug iki kez → ilki alınır; dizi değilse boş", () => {
    expect(parseAdrDecisions([D(), D({ decision: "session" })])).toHaveLength(1);
    expect(parseAdrDecisions("nope" as unknown)).toEqual([]);
  });
});

describe("adrContentHash", () => {
  it("içerik değişince hash değişir, aynıyken sabit", () => {
    expect(adrContentHash(D())).toBe(adrContentHash(D()));
    expect(adrContentHash(D())).not.toBe(adrContentHash(D({ decision: "session" })));
  });
});

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "adr-test-"));
}

describe("writeAdrs", () => {
  it("ADR-0001 dosyası MADR formatında yazılır", async () => {
    const root = await mkTmp();
    const { written, dir } = await writeAdrs(root, [D()], "2026-06-24");
    expect(written).toBe(1);
    const md = await fs.readFile(join(dir, "ADR-0001-auth-strategy.md"), "utf-8");
    expect(md).toContain("# ADR-0001: Authentication strategy");
    expect(md).toContain("- Date: 2026-06-24");
    expect(md).toContain("## Decision\nJWT");
  });

  it("içerik değişmediyse numara+tarih KORUNUR (ikinci tur)", async () => {
    const root = await mkTmp();
    await writeAdrs(root, [D()], "2026-06-24");
    await writeAdrs(root, [D()], "2026-06-30"); // aynı içerik, farklı 'bugün'
    const md = await fs.readFile(join(root, ".mycl", "decisions", "ADR-0001-auth-strategy.md"), "utf-8");
    expect(md).toContain("- Date: 2026-06-24"); // eski tarih korundu
  });

  it("içerik değişince tarih bugüne çekilir, numara sabit", async () => {
    const root = await mkTmp();
    await writeAdrs(root, [D()], "2026-06-24");
    await writeAdrs(root, [D({ decision: "session cookies" })], "2026-06-30");
    const md = await fs.readFile(join(root, ".mycl", "decisions", "ADR-0001-auth-strategy.md"), "utf-8");
    expect(md).toContain("- Date: 2026-06-30");
    expect(md).toContain("# ADR-0001:"); // numara değişmedi
  });

  it("yeni slug → sıradaki numara; eski karar SİLİNMEZ (tarihsel)", async () => {
    const root = await mkTmp();
    await writeAdrs(root, [D()], "2026-06-24");
    await writeAdrs(root, [D({ slug: "data-store", title: "DB", decision: "Postgres" })], "2026-06-30");
    const files = (await fs.readdir(join(root, ".mycl", "decisions"))).sort();
    expect(files).toEqual(["ADR-0001-auth-strategy.md", "ADR-0002-data-store.md"]);
  });

  it("boş dizi → no-op (written 0)", async () => {
    const root = await mkTmp();
    expect((await writeAdrs(root, [], "2026-06-24")).written).toBe(0);
  });
});
