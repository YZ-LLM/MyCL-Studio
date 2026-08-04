// prior-integration — "bu proje daha önce entegre edilmiş mi?" tespiti + sıfırdan başlama kararı.
//
// NEDEN (YZLLM 2026-08-04): "sıfırdan entegrasyon başlattım ama eski referansına gitti." Kopya hedefi
// kaynak yolunun hash'inden deterministik üretilip "hedef varsa re-copy yok" kısa devresine takıldığı
// için ESKİ kopya açılıyor ve eski iş kuyruğu sürülüyordu.
//
// TÜM testler geçici dizinde koşar (baseDir enjekte edilir) — gerçek "MyCL Projeler" klasörüne ve
// kullanıcının projelerine DOKUNULMAZ.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  copyHashFor,
  copyPathForGeneration,
  copyProjectToAccessible,
  isUnderMyclProjeler,
  myclProjelerDir,
  parseCopyDirName,
  plannedCopyPath,
} from "../src/onboarding/copy-to-accessible.js";
import {
  decideIntegrationRestart,
  findPriorIntegrations,
  type PriorCopy,
} from "../src/onboarding/prior-integration.js";

let tmp = "";
let baseDir = "";
let src = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mycl-prior-"));
  baseDir = join(tmp, "MyCL Projeler");
  src = join(tmp, "kaynak-proje");
  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(join(src, "index.js"), "console.log(1);\n");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Sahte bir kopya klasörü kur (belirli kuşak + istenen .mycl içeriği). */
async function makeCopy(
  origin: string,
  generation: number,
  opts?: { onboarded?: boolean; tasks?: Array<{ id: string; status: string }> },
): Promise<string> {
  const dir = copyPathForGeneration(origin, generation, baseDir);
  await fs.mkdir(join(dir, ".mycl"), { recursive: true });
  await fs.writeFile(join(dir, ".mycl", "copied-from.json"), JSON.stringify({ origin, generation }));
  if (opts?.onboarded) {
    await fs.writeFile(join(dir, ".mycl", "onboarded.json"), JSON.stringify({ at: 1 }));
  }
  if (opts?.tasks) {
    await fs.writeFile(
      join(dir, ".mycl", "task-queue.jsonl"),
      opts.tasks.map((t) => JSON.stringify(t)).join("\n") + "\n",
    );
  }
  return dir;
}

describe("saf ad matematiği", () => {
  it("aynı kaynak → aynı yol; farklı kaynak (aynı klasör adı) → farklı yol", () => {
    expect(plannedCopyPath("/a/app", baseDir)).toBe(plannedCopyPath("/a/app/", baseDir));
    expect(plannedCopyPath("/a/app", baseDir)).not.toBe(plannedCopyPath("/b/app", baseDir));
  });

  it("1. kuşak eski şemayı KORUR (geriye uyum), sonrakiler -rN alır", () => {
    const g1 = copyPathForGeneration("/a/app", 1, baseDir);
    expect(basename(g1)).toBe(`app-${copyHashFor("/a/app")}`);
    expect(basename(copyPathForGeneration("/a/app", 3, baseDir))).toBe(`app-${copyHashFor("/a/app")}-r3`);
  });

  it("parseCopyDirName gidiş dönüş", () => {
    const h = copyHashFor("/a/app");
    expect(parseCopyDirName(`app-${h}`)).toEqual({ base: "app", hash: h, generation: 1 });
    expect(parseCopyDirName(`app-${h}-r4`)).toEqual({ base: "app", hash: h, generation: 4 });
    expect(parseCopyDirName("rastgele-klasor")).toBeNull();
  });

  it("isUnderMyclProjeler yeni -rN adlarında da çalışır", () => {
    // Kök dizin PLATFORMA göre değişir (macOS /Users/Shared, Linux /var/tmp) → sabit yol yazma:
    // yerelde geçen, CI'da düşen bir test olur (2026-08-04'te tam bunu yaşadı).
    expect(isUnderMyclProjeler(join(myclProjelerDir(), "app-abcdef12-r2"))).toBe(true);
    expect(isUnderMyclProjeler(join(myclProjelerDir(), "app-abcdef12"))).toBe(true);
  });
});

describe("copyProjectToAccessible", () => {
  it("varsayılan: hedef varsa RE-COPY YOK (kullanıcı işi korunur) — bugünkü davranış", async () => {
    const first = await copyProjectToAccessible(src, { baseDir });
    await fs.writeFile(join(first, "kullanici-isi.txt"), "elle eklendi");
    const second = await copyProjectToAccessible(src, { baseDir });
    expect(second).toBe(first);
    await expect(fs.access(join(second, "kullanici-isi.txt"))).resolves.toBeUndefined();
  });

  it("fresh: YENİ kuşak açar, eskisini SİLMEZ", async () => {
    const first = await copyProjectToAccessible(src, { baseDir });
    const second = await copyProjectToAccessible(src, { baseDir, fresh: true });
    expect(second).not.toBe(first);
    expect(basename(second)).toMatch(/-r2$/);
    await expect(fs.access(first)).resolves.toBeUndefined(); // eski kopya duruyor
  });

  // KULLANICININ ASIL ŞARTI: "önceki kopyanın işleri gelmez bu sayede iş listesine."
  it("fresh kopya BOŞ iş listesiyle doğar — KAYNAKTA iş listesi olsa bile (.mycl kopyalanmaz)", async () => {
    // Kaynağın kendisi yerinde entegre edilmiş olabilir → .mycl + dolu kuyruk taşır.
    await fs.mkdir(join(src, ".mycl"), { recursive: true });
    await fs.writeFile(join(src, ".mycl", "task-queue.jsonl"), '{"id":"t1","status":"pending"}\n');
    const first = await copyProjectToAccessible(src, { baseDir });
    await fs.mkdir(join(first, ".mycl"), { recursive: true });
    await fs.writeFile(join(first, ".mycl", "task-queue.jsonl"), '{"id":"t9","status":"pending"}\n');

    const second = await copyProjectToAccessible(src, { baseDir, fresh: true });
    await expect(fs.access(join(second, ".mycl", "task-queue.jsonl"))).rejects.toThrow();
    await expect(fs.access(join(second, "index.js"))).resolves.toBeUndefined(); // kaynak kodu GELDİ
    // Eski kopyanın işleri yerinde duruyor (silinmedi, yalnız taşınmadı).
    const prior = await findPriorIntegrations(second, baseDir);
    expect(prior.copies.find((c) => c.path === first)?.pendingTasks).toBe(1);
  });

  it("soy bağı kaydedilir (origin + generation + previous_copy)", async () => {
    await copyProjectToAccessible(src, { baseDir });
    const second = await copyProjectToAccessible(src, { baseDir, fresh: true });
    const meta = JSON.parse(await fs.readFile(join(second, ".mycl", "copied-from.json"), "utf-8"));
    expect(meta.origin).toBe(src);
    expect(meta.generation).toBe(2);
    expect(meta.previous_copy).toBe(copyPathForGeneration(src, 1, baseDir));
    expect(meta.fresh_start).toBe(true);
  });
});

describe("findPriorIntegrations", () => {
  it("ORİJİNAL seçildi + kopya var → kopya bulunur (kullanıcının yaşadığı durum)", async () => {
    const copy = await makeCopy(src, 1, { onboarded: true, tasks: [{ id: "t1", status: "pending" }] });
    const prior = await findPriorIntegrations(src, baseDir);
    expect(prior.selectedIsCopy).toBe(false);
    expect(prior.source).toBe(src);
    expect(prior.copies.map((c) => c.path)).toEqual([copy]);
    expect(prior.copies[0]?.onboarded).toBe(true);
    expect(prior.copies[0]?.pendingTasks).toBe(1);
  });

  it("ORİJİNAL seçildi + kopya YOK → boş", async () => {
    const prior = await findPriorIntegrations(src, baseDir);
    expect(prior.copies).toEqual([]);
  });

  it("KOPYA seçildi → gerçek kaynak origin'den okunur, kendisi 'başka kopya' sayılmaz", async () => {
    const g1 = await makeCopy(src, 1);
    const g2 = await makeCopy(src, 2);
    const prior = await findPriorIntegrations(g2, baseDir);
    expect(prior.selectedIsCopy).toBe(true);
    expect(prior.source).toBe(src);
    expect(prior.copies.map((c) => c.path)).toEqual([g1]); // kendisi listede YOK
  });

  it("en yeni kuşak başta sıralanır", async () => {
    await makeCopy(src, 1);
    await makeCopy(src, 2);
    await makeCopy(src, 3);
    const prior = await findPriorIntegrations(src, baseDir);
    expect(prior.copies.map((c) => c.generation)).toEqual([3, 2, 1]);
  });

  it("YANLIŞ PROJE KORUMASI: hash aynı ama origin farklıysa eşleşmez", async () => {
    const dir = copyPathForGeneration(src, 1, baseDir);
    await fs.mkdir(join(dir, ".mycl"), { recursive: true });
    // Aynı klasör adı ama BAŞKA bir kaynağın kopyası olduğunu söylüyor → ikinci kanıt tutmuyor.
    await fs.writeFile(join(dir, ".mycl", "copied-from.json"), JSON.stringify({ origin: "/baska/proje" }));
    const prior = await findPriorIntegrations(src, baseDir);
    expect(prior.copies).toEqual([]);
  });

  it("bozuk task-queue.jsonl sayımı PATLATMAZ", async () => {
    const dir = await makeCopy(src, 1);
    await fs.writeFile(join(dir, ".mycl", "task-queue.jsonl"), "bu json degil\n{yarim\n");
    const prior = await findPriorIntegrations(src, baseDir);
    expect(prior.copies[0]?.pendingTasks).toBe(0);
  });

  it("aynı iş için son durum sayılır (tamamlanan iş bekleyen sayılmaz)", async () => {
    await makeCopy(src, 1, {
      tasks: [
        { id: "t1", status: "pending" },
        { id: "t1", status: "done" },
        { id: "t2", status: "pending" },
      ],
    });
    const prior = await findPriorIntegrations(src, baseDir);
    expect(prior.copies[0]?.pendingTasks).toBe(1);
  });

  it("'MyCL Projeler' klasörü hiç yoksa patlamaz", async () => {
    const prior = await findPriorIntegrations(src, join(tmp, "hic-yok"));
    expect(prior.copies).toEqual([]);
  });
});

describe("decideIntegrationRestart (saf karar tablosu)", () => {
  const copy = (): PriorCopy => ({ path: "/x", generation: 1, onboarded: true, pendingTasks: 2 });
  const none = { selectedIsCopy: false, copies: [] as PriorCopy[] };
  const some = { selectedIsCopy: false, copies: [copy()] };

  it("integrate DEĞİLSE asla sorulmaz (son projeler listesinden açmak)", () => {
    expect(
      decideIntegrationRestart({
        integrate: false,
        prior: some,
        alreadyOnboardedInPlace: true,
        neverAsk: false,
      }),
    ).toBe("proceed");
  });

  it("önceki entegrasyon yoksa sorulmaz (ilk entegrasyon akışı değişmez)", () => {
    expect(
      decideIntegrationRestart({
        integrate: true,
        prior: none,
        alreadyOnboardedInPlace: false,
        neverAsk: false,
      }),
    ).toBe("proceed");
  });

  it("önceki kopya varsa SORULUR", () => {
    expect(
      decideIntegrationRestart({
        integrate: true,
        prior: some,
        alreadyOnboardedInPlace: false,
        neverAsk: false,
      }),
    ).toBe("ask");
  });

  it("yerinde entegre edilmiş proje de sorulur (kopya olmasa bile)", () => {
    expect(
      decideIntegrationRestart({
        integrate: true,
        prior: none,
        alreadyOnboardedInPlace: true,
        neverAsk: false,
      }),
    ).toBe("ask");
  });

  it("'hiçbir şey sorma' modunda sorulmaz → devam (yeni kimlik+disk otomatik yaratılmaz)", () => {
    expect(
      decideIntegrationRestart({
        integrate: true,
        prior: some,
        alreadyOnboardedInPlace: true,
        neverAsk: true,
      }),
    ).toBe("proceed");
  });

  it("verilmiş karar tek atışlık uygulanır", () => {
    const base = { integrate: true, prior: some, alreadyOnboardedInPlace: true, neverAsk: false };
    expect(decideIntegrationRestart({ ...base, decided: "fresh" })).toBe("fresh");
    expect(decideIntegrationRestart({ ...base, decided: "resume" })).toBe("proceed");
  });
});
