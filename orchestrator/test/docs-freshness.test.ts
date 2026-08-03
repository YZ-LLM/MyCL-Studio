// docs-freshness — kullanım kılavuzu bayat mı? (SAF)
//
// KULLANICI ŞARTI (2026-08-03): "KULLANIM KILAVUZU HAZIRLAMASI GEREKİYOR. HER ZAMAN GÜNCEL TUTMALI."
// Eskiden tazeleme yalnız pipeline sonunda tetikleniyordu; üç manuel düğme ve proje açılışı kılavuzu hiç
// tazelemiyordu ve "bayat mı?" diye soran hiçbir mekanizma yoktu.
//
// KUŞKUDA BAYAT SAY: yanlış "taze" demek sessiz bir yalandır; gereksiz tazeleme yalnız biraz maliyettir.

import { describe, expect, it } from "vitest";
import {
  DOCS_SCHEMA_VERSION,
  decideDocsStale,
  buildSourceDigest,
  shortHash,
  type DocsStamp,
} from "../src/docs-freshness.js";

const OUT = { "docs/user-guide.md": "h1", ".mycl/features.md": "h2" };
const stamp = (over: Partial<DocsStamp> = {}): DocsStamp => ({
  schema: DOCS_SCHEMA_VERSION,
  ts: 1,
  head: "abc",
  dirty: false,
  source_digest: "d1",
  unit_count: 10,
  outputs: { ...OUT },
  ...over,
});
const current = (over: Partial<Parameters<typeof decideDocsStale>[0]["current"]> = {}) => ({
  head: "abc",
  dirty: false,
  source_digest: "d1",
  unit_count: 10,
  outputs: { ...OUT } as Record<string, string | null>,
  ...over,
});
const call = (s: DocsStamp | null, c = current()) =>
  decideDocsStale({ stamp: s, current: c, schema: DOCS_SCHEMA_VERSION, maxUnits: 5000 });

describe("decideDocsStale", () => {
  it("damga yoksa bayat (hiç üretilmemiş)", () => {
    expect(call(null)).toMatchObject({ stale: true, reason: "no_stamp" });
  });

  it("aynı commit + temiz ağaç + çıktılar yerinde → TAZE (LLM çağrısı yok)", () => {
    expect(call(stamp())).toMatchObject({ stale: false, reason: "none" });
  });

  it("yeni commit → bayat", () => {
    expect(call(stamp(), current({ head: "def" }))).toMatchObject({ stale: true, reason: "head_moved" });
  });

  it("kirli ağaç + kaynak değişmiş → bayat; kirli ama aynı kaynak → taze", () => {
    expect(call(stamp(), current({ dirty: true, source_digest: "d2" }))).toMatchObject({
      stale: true,
      reason: "source_changed",
    });
    expect(call(stamp(), current({ dirty: true }))).toMatchObject({ stale: false });
  });

  it("git yoksa yalnız kaynak özeti karşılaştırılır", () => {
    const noGit = stamp({ head: undefined });
    expect(call(noGit, current({ head: undefined }))).toMatchObject({ stale: false });
    expect(call(noGit, current({ head: undefined, source_digest: "x" }))).toMatchObject({
      stale: true,
      reason: "source_changed",
    });
  });

  it("kılavuz dosyası silinmişse bayat (elle silme yakalanır)", () => {
    const c = current({ outputs: { ...OUT, "docs/user-guide.md": null } });
    expect(call(stamp(), c)).toMatchObject({ stale: true, reason: "output_missing" });
  });

  it("kılavuz dosyası dışarıdan değiştirilmişse bayat", () => {
    const c = current({ outputs: { ...OUT, "docs/user-guide.md": "elle-degistirildi" } });
    expect(call(stamp(), c)).toMatchObject({ stale: true, reason: "output_modified" });
  });

  it("çıktı formatı sürümü değişince ZORLA tazelenir", () => {
    expect(call(stamp({ schema: 0 }))).toMatchObject({ stale: true, reason: "schema_changed" });
  });

  it("proje çok büyükse özet güvenilmez → YANLIŞ 'taze' DEMEZ", () => {
    const r = decideDocsStale({
      stamp: stamp(),
      current: current({ unit_count: 9000 }),
      schema: DOCS_SCHEMA_VERSION,
      maxUnits: 5000,
    });
    expect(r).toMatchObject({ stale: true, reason: "too_many_units" });
  });
});

describe("buildSourceDigest", () => {
  it("dosya sırasından BAĞIMSIZ (deterministik)", () => {
    const a = buildSourceDigest([
      { path: "b.ts", hash: "2" },
      { path: "a.ts", hash: "1" },
    ]);
    const b = buildSourceDigest([
      { path: "a.ts", hash: "1" },
      { path: "b.ts", hash: "2" },
    ]);
    expect(a.digest).toBe(b.digest);
  });

  it("tek dosya değişince özet değişir", () => {
    const a = buildSourceDigest([{ path: "a.ts", hash: "1" }]);
    const b = buildSourceDigest([{ path: "a.ts", hash: "2" }]);
    expect(a.digest).not.toBe(b.digest);
  });

  it("özetlenemeyen dosya da özete girer (yol) — 'değişmedi' yanılgısı olmaz", () => {
    const a = buildSourceDigest([{ path: "big.bin", skipped: true }]);
    const b = buildSourceDigest([{ path: "other.bin", skipped: true }]);
    expect(a.digest).not.toBe(b.digest);
    expect(a.unhashed).toEqual(["big.bin"]);
  });

  it("dosya eklenince özet değişir (yeni sayfa kılavuza yansımalı)", () => {
    const a = buildSourceDigest([{ path: "a.ts", hash: "1" }]);
    const b = buildSourceDigest([
      { path: "a.ts", hash: "1" },
      { path: "yeni.ts", hash: "9" },
    ]);
    expect(a.digest).not.toBe(b.digest);
  });
});

describe("shortHash", () => {
  it("deterministik ve içerik duyarlı", () => {
    expect(shortHash("abc")).toBe(shortHash("abc"));
    expect(shortHash("abc")).not.toBe(shortHash("abd"));
    expect(shortHash("x")).toHaveLength(16);
  });
});
