// phase-preconditions / phase-artifacts — "bu faz koşabilir mi?" tek yerden sorulur.
//
// NEDEN (2026-09-17): genel bir önkoşul yapısı yoktu. Diskteki artefakta bakan ÜÇ ayrı ad-hoc
// kontrol vardı ve Faz 7'de hiç kontrol yoktu — spec olmadan da veritabanı tasarımına giriliyordu.
// Dahası artefaktın yeri üç ayrı yerde biliniyordu; ayrıştıkları için mesaj `.mycl/spec.md` derken
// kontrol `devs/_pending/<ts>/iter-spec.md` yapıyordu ve var olan bir dosya yanlış yerde arandı.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { declaredArtifact, artifactExists } from "../src/phase-artifacts.js";
import { checkPreconditions } from "../src/phase-preconditions.js";
import { PHASE_SPECS } from "../src/phase-registry.js";

const TS = 1789492860037; // klasör adı yerel saatten üretilir → testte SABİT yazılmaz
let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mycl-precond-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const faz4 = () => PHASE_SPECS[4]!;
const yaz = async (rel: string, icerik = "# spec\n") => {
  const p = join(root, rel);
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(p, icerik);
};

/**
 * Faz 4 artefaktını ÇÖZÜCÜNÜN söylediği yere yaz.
 * Klasör adı yerel saatten üretiliyor; testte sabit yazmak saat dilimine bağımlılık yaratır
 * (ilk yazımda tam bu oldu: yerel yeşil, CI kırmızı). Yol tek kaynaktan alınır.
 */
const yazSpec = async (icerik = "# spec\n"): Promise<void> => {
  const d = declaredArtifact(faz4(), { project_root: root, iteration_started_at: TS })!;
  await yaz(d.rel, icerik);
};

describe("declaredArtifact — yazıcıyla AYNI yolu çözer", () => {
  it("iterasyon damgası varken devs/_pending altına çözer", () => {
    const d = declaredArtifact(faz4(), { project_root: root, iteration_started_at: TS });
    expect(d?.rel).toContain("devs/_pending/");
    expect(d?.rel).toContain("iter-spec.md");
  });

  it("damga yokken bildirilen yolu kullanır (geriye uyum)", () => {
    const d = declaredArtifact(faz4(), { project_root: root, iteration_started_at: undefined });
    expect(d?.rel).toBe(".mycl/spec.md");
  });

  it("çıktı bildirmeyen faz için null (codegen/qa/mekanik)", () => {
    expect(declaredArtifact(PHASE_SPECS[5]!, { project_root: root, iteration_started_at: TS })).toBeNull();
  });
});

describe("artifactExists — üç durumlu", () => {
  it("dosya varsa 'yes'", async () => {
    await yazSpec();
    expect(await artifactExists(faz4(), { project_root: root, iteration_started_at: TS })).toBe("yes");
  });

  it("dosya yoksa 'no'", async () => {
    expect(await artifactExists(faz4(), { project_root: root, iteration_started_at: TS })).toBe("no");
  });

  it("BOŞ dosya 'no' sayılır — var görünüp içi boş olan çıktı, çıktı değildir", async () => {
    await yazSpec("");
    expect(await artifactExists(faz4(), { project_root: root, iteration_started_at: TS })).toBe("no");
  });

  it("çıktı bildirmeyen faz için 'unknown' — 'yok' İDDİA EDİLMEZ", async () => {
    expect(await artifactExists(PHASE_SPECS[5]!, { project_root: root, iteration_started_at: TS })).toBe("unknown");
  });
});

describe("checkPreconditions", () => {
  const state = () => ({ project_root: root, iteration_started_at: TS });

  it("önkoşul karşılanıyorsa geçer", async () => {
    await yazSpec();
    expect(await checkPreconditions(PHASE_SPECS[5]!, state())).toEqual({ ok: true });
  });

  it("Faz 5: spec yoksa BLOCK ve mesaj GERÇEK yolu söyler", async () => {
    const r = await checkPreconditions(PHASE_SPECS[5]!, state());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("beklenmedik");
    expect(r.severity).toBe("block");
    expect(r.message).toContain("devs/_pending/");
    expect(r.message).not.toContain(".mycl/spec.md"); // yanlış yol söyleyen eski metnin kilidi
  });

  it("Faz 7: spec yoksa WARN — bugüne kadar hiç kontrol yoktu, akış kırılmamalı", async () => {
    const r = await checkPreconditions(PHASE_SPECS[7]!, state());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("beklenmedik");
    expect(r.severity).toBe("warn");
  });

  it("REGRESYON KİLİDİ: önkoşul bildirmeyen faz her zaman geçer", async () => {
    expect(await checkPreconditions(PHASE_SPECS[10]!, state())).toEqual({ ok: true });
    expect(await checkPreconditions(PHASE_SPECS[1]!, state())).toEqual({ ok: true });
  });

  it("Faz 8 de Faz 4 çıktısına bağlı (bugünkü davranışın bildirimsel hali)", async () => {
    const r = await checkPreconditions(PHASE_SPECS[8]!, state());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("beklenmedik");
    expect(r.severity).toBe("block");
  });
});
