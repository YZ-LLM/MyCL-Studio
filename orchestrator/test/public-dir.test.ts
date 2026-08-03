// public-dir — hedef projenin statik varlık klasörünü çöz (stack bağımsız).
//
// NEDEN (2026-08-03): kılavuz artık projenin içine de yazılıyor; statik dosyaların gideceği klasör
// stack'e göre değişir (çoğu araçta `public/`, SvelteKit'te `static/`). `guide-shots.ts` içinde
// `public/` HARDCODE edilmişti — stack bağımsızlık kuralının sessiz ihlali (SvelteKit projesinde
// ekran görüntüleri yanlış klasöre yazılıyordu).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePublicDir, resolvePublicDir } from "../src/public-dir.js";
import type { State } from "../src/types.js";

describe("decidePublicDir (SAF)", () => {
  it("var olan klasör kazanır — public önce", () => {
    expect(decidePublicDir({ existing: ["public"] })).toEqual({ rel: "public", source: "existing" });
    expect(decidePublicDir({ existing: ["static"] })).toEqual({ rel: "static", source: "existing" });
    // İkisi de varsa public (yaygın olan) seçilir — deterministik.
    expect(decidePublicDir({ existing: ["static", "public"] }).rel).toBe("public");
  });

  it("hiçbiri yoksa profil bildirimi kullanılır", () => {
    expect(decidePublicDir({ existing: [], fromProfile: "www" })).toEqual({ rel: "www", source: "profile" });
  });

  it("hiçbir bilgi yoksa varsayılan public (oluşturulur)", () => {
    expect(decidePublicDir({ existing: [] })).toEqual({ rel: "public", source: "default" });
  });

  it("var olan klasör profil bildiriminden ÖNCE gelir (gerçeklik > yapılandırma)", () => {
    expect(decidePublicDir({ existing: ["static"], fromProfile: "public" })).toEqual({
      rel: "static",
      source: "existing",
    });
  });
});

describe("resolvePublicDir (gerçek dosya sistemi)", () => {
  let root: string;
  const st = (): State => ({
    current_phase: 5,
    session_id: "t",
    spec_approved: false,
    project_root: root,
    created_at: 0,
    updated_at: 0,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mycl-pub-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("SvelteKit deseni: static/ varsa onu kullanır, public/ OLUŞTURMAZ", async () => {
    await mkdir(join(root, "static"), { recursive: true });
    const r = await resolvePublicDir(st());
    expect(r).toMatchObject({ rel: "static", source: "existing", created: false });
    await expect(stat(join(root, "public"))).rejects.toThrow();
  });

  it("hiçbiri yoksa public/ oluşturulur", async () => {
    const r = await resolvePublicDir(st());
    expect(r).toMatchObject({ rel: "public", source: "default", created: true });
    expect((await stat(join(root, "public"))).isDirectory()).toBe(true);
  });
});
