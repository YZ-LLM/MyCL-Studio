import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshotBeforeAutofix,
  restoreSnapshot,
  peekRollback,
  disarmRollback,
  pruneProjectBackups,
} from "../src/fix-snapshot.js";

describe("snapshotBeforeAutofix (git yoksa .mycl/backups kopya)", () => {
  let dir: string;
  // MYCL_HOME izole (YZLLM 2026-06-27): snapshotBeforeAutofix yedeği globalConfigDir()'e (~/.mycl/backups) yazar.
  // İzole edilmezse her test koşusu GERÇEK ~/.mycl/backups'a `mycl-snap-*` artifact'ı bırakıyordu (1835 birikmişti).
  let home: string;
  const origHome = process.env.MYCL_HOME;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mycl-snap-"));
    home = await mkdtemp(join(tmpdir(), "mycl-home-"));
    process.env.MYCL_HOME = home;
  });
  afterEach(async () => {
    disarmRollback();
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true }).catch(() => {});
    if (origHome === undefined) delete process.env.MYCL_HOME;
    else process.env.MYCL_HOME = origHome;
  });

  it("git olmayan projede kaynağı yedekler, node_modules'ı HARİÇ tutar", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.js"), "export const x = 1;\n");
    await mkdir(join(dir, "node_modules", "junk"), { recursive: true });
    await writeFile(join(dir, "node_modules", "junk", "big.js"), "x".repeat(1000));
    const snap = await snapshotBeforeAutofix(dir, 1781000000000);
    expect(snap.method).toBe("copy");
    expect(snap.dir).toBeTruthy();
    // kaynak kopyalandı
    const copied = await readFile(join(snap.dir!, "src", "app.js"), "utf8");
    expect(copied).toContain("export const x = 1");
    // node_modules KOPYALANMADI (ağır dizin hariç)
    expect(existsSync(join(snap.dir!, "node_modules"))).toBe(false);
  });

  // YZLLM 2026-06-12 "kullanıcı hiç bir şeyi elle yapmayacak": non-git projede de OTOMATİK geri alma.
  // Round-trip: snapshot → kötü fix (dosyayı boz/sil) → restoreSnapshot → orijinal geri gelmeli.
  it("git olmayan projede restoreSnapshot bozulan/silinen dosyayı geri yükler (elle iş YOK)", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.js"), "export const x = 1;\n");
    await writeFile(join(dir, "keep.txt"), "orig\n");
    const snap = await snapshotBeforeAutofix(dir, 1781000000001);
    expect(snap.method).toBe("copy");
    // Kötü fix simülasyonu: bir dosyayı boz, birini "sil" (içeriğini değiştir).
    await writeFile(join(dir, "src", "app.js"), "BROKEN garbage\n");
    await writeFile(join(dir, "keep.txt"), "corrupted\n");
    // Otomatik geri alma
    const ok = await restoreSnapshot(snap, dir);
    expect(ok).toBe(true);
    expect(await readFile(join(dir, "src", "app.js"), "utf8")).toContain("export const x = 1");
    expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("orig\n");
  });

  // YZLLM 2026-06-12 KRİTİK (#1): ayna-restore — fix'in EKLEDİĞİ dosyalar da silinmeli (baseline drift'in kökü);
  // error_folder (hata kataloğu) ve .mycl KORUNMALI. Eski cp-over yalnız üzerine yazıp eklenenleri bırakıyordu.
  it("ayna-restore eklenen dosyaları siler + error_folder/.mycl korur (baseline drift fix)", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.js"), "orig\n");
    await mkdir(join(dir, "error_folder"), { recursive: true });
    await writeFile(join(dir, "error_folder", "mycl_errors.db"), "catalog\n");
    const snap = await snapshotBeforeAutofix(dir, 1781000000010);
    expect(snap.method).toBe("copy");
    // Fix simülasyonu: YENİ dosya/dizin ekle + mevcut boz + error_folder'a hata ekle.
    await writeFile(join(dir, "src", "added-by-fix.js"), "junk\n");
    await mkdir(join(dir, "src", "utils"), { recursive: true });
    await writeFile(join(dir, "src", "utils", "sanitize.js"), "added module\n");
    await writeFile(join(dir, "src", "app.js"), "BROKEN\n");
    await writeFile(join(dir, "error_folder", "mycl_errors.db"), "catalog+newerror\n");
    // Ayna geri-yükleme
    expect(await restoreSnapshot(snap, dir)).toBe(true);
    // Mevcut dosya geri geldi
    expect(await readFile(join(dir, "src", "app.js"), "utf8")).toBe("orig\n");
    // Fix'in EKLEDİĞİ dosya/dizin SİLİNDİ (drift kaynağı kapandı)
    expect(existsSync(join(dir, "src", "added-by-fix.js"))).toBe(false);
    expect(existsSync(join(dir, "src", "utils"))).toBe(false);
    // error_folder KORUNDU (rollback'te geri ALINMAZ — hata kataloğu sözü)
    expect(existsSync(join(dir, "error_folder", "mycl_errors.db"))).toBe(true);
    expect(await readFile(join(dir, "error_folder", "mycl_errors.db"), "utf8")).toBe("catalog+newerror\n");
  });

  it("peekRollback armed snapshot'ı temizlemeden döner (Faz 8 çift-yedek almasın)", async () => {
    await writeFile(join(dir, "a.js"), "1\n");
    const snap = await snapshotBeforeAutofix(dir, 1781000000002); // arm eder
    const peeked = peekRollback();
    expect(peeked).not.toBeNull();
    expect(peeked!.dir).toBe(snap.dir); // aynı snapshot
    // peek temizlemedi → ikinci peek de aynısını döner
    expect(peekRollback()?.dir).toBe(snap.dir);
  });
});

describe("pruneProjectBackups — proje başına son N yedek (YZLLM 2026-06-27)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mycl-bk-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }).catch(() => {}); });

  async function mk(name: string): Promise<void> {
    await mkdir(join(root, name), { recursive: true });
  }

  it("yalnız EN YENİ 3'ü tutar, eskileri siler (ts'e göre)", async () => {
    for (const ts of [100, 200, 300, 400, 500]) await mk(`projA-autofix-${ts}`);
    const removed = await pruneProjectBackups(root, "projA", 3);
    expect(removed.sort()).toEqual(["projA-autofix-100", "projA-autofix-200"]);
    expect(existsSync(join(root, "projA-autofix-500"))).toBe(true);
    expect(existsSync(join(root, "projA-autofix-400"))).toBe(true);
    expect(existsSync(join(root, "projA-autofix-300"))).toBe(true);
    expect(existsSync(join(root, "projA-autofix-200"))).toBe(false);
    expect(existsSync(join(root, "projA-autofix-100"))).toBe(false);
  });

  it("YALNIZ kendi projesine dokunur — başka proje + alakasız dizinler korunur", async () => {
    for (const ts of [1, 2, 3, 4]) await mk(`projA-autofix-${ts}`);
    await mk("projB-autofix-9");
    await mk("projB-autofix-8");
    await mk("rastgele-dizin");
    await mk("projA-autofix-abc"); // sayısal-olmayan son-ek → projA yedeği SAYILMAZ
    await pruneProjectBackups(root, "projA", 3);
    // projB dokunulmadı
    expect(existsSync(join(root, "projB-autofix-9"))).toBe(true);
    expect(existsSync(join(root, "projB-autofix-8"))).toBe(true);
    expect(existsSync(join(root, "rastgele-dizin"))).toBe(true);
    expect(existsSync(join(root, "projA-autofix-abc"))).toBe(true); // sayısal değil → eşleşmez
    // projA: 4 sayısal yedekten en eskisi (1) silindi, 2/3/4 kaldı
    expect(existsSync(join(root, "projA-autofix-1"))).toBe(false);
    expect(existsSync(join(root, "projA-autofix-4"))).toBe(true);
  });

  it("3 veya daha az yedekte hiçbir şey silmez", async () => {
    await mk("projA-autofix-1");
    await mk("projA-autofix-2");
    const removed = await pruneProjectBackups(root, "projA", 3);
    expect(removed).toEqual([]);
    expect(existsSync(join(root, "projA-autofix-1"))).toBe(true);
  });
});
