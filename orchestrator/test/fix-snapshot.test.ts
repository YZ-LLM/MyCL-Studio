import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Görünür iletiler yakalanır (toplu silme emniyeti iletisi sınanır); öteki ipc işlevleri gerçek kalır.
const { emitChatMock } = vi.hoisted(() => ({ emitChatMock: vi.fn() }));
vi.mock("../src/ipc.js", async (orig) => ({
  ...(await orig<typeof import("../src/ipc.js")>()),
  emitChatMessage: emitChatMock,
}));

import {
  snapshotBeforeAutofix,
  snapshotAttemptStart,
  snapshotForFixAttempt,
  restoreSnapshot,
  restoreSnapshotWithReport,
  peekRollback,
  disarmRollback,
  pruneProjectBackups,
  changedFilesVsSnapshot,
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

describe("changedFilesVsSnapshot — git'siz kopya-diff (repro-first muafiyet change-detection)", () => {
  let backup: string;
  let proj: string;
  beforeEach(async () => {
    backup = await mkdtemp(join(tmpdir(), "mycl-bk-"));
    proj = await mkdtemp(join(tmpdir(), "mycl-pr-"));
  });
  afterEach(async () => {
    await rm(backup, { recursive: true, force: true });
    await rm(proj, { recursive: true, force: true });
  });

  it("method!=='copy' → null (çağıran git yolunu korur)", async () => {
    expect(await changedFilesVsSnapshot({ method: "git", ref: "abc" }, proj)).toBeNull();
    expect(await changedFilesVsSnapshot({ method: "none" }, proj)).toBeNull();
    expect(await changedFilesVsSnapshot({ method: "copy" }, proj)).toBeNull(); // dir yok
  });

  it("DEĞİŞEN (içerik) dosyayı yakalar; DEĞİŞMEYENİ değil", async () => {
    await writeFile(join(backup, "package.json"), '{"scripts":{"dev":"node x"}}');
    await writeFile(join(proj, "package.json"), '{"scripts":{"dev":"node x --watch"}}'); // değişti
    await writeFile(join(backup, "app.js"), "const a=1;");
    await writeFile(join(proj, "app.js"), "const a=1;"); // aynı
    const changed = await changedFilesVsSnapshot({ method: "copy", dir: backup }, proj);
    expect(changed).toEqual(["package.json"]);
  });

  it("EKLENEN (projede var, backup'ta yok) + SİLİNEN (backup'ta var, projede yok) yakalar", async () => {
    await writeFile(join(backup, "old.js"), "x"); // silinecek
    await writeFile(join(proj, "new.js"), "y"); // eklendi
    const changed = await changedFilesVsSnapshot({ method: "copy", dir: backup }, proj);
    expect(new Set(changed)).toEqual(new Set(["old.js", "new.js"]));
  });

  it("EXCLUDE_TOP (node_modules) top-level dizinini yok sayar", async () => {
    await mkdir(join(backup, "node_modules"), { recursive: true });
    await writeFile(join(backup, "node_modules", "x.js"), "a");
    await mkdir(join(proj, "node_modules"), { recursive: true });
    await writeFile(join(proj, "node_modules", "x.js"), "DEĞİŞTİ"); // node_modules değişti ama sayılmamalı
    await writeFile(join(backup, "src.js"), "s");
    await writeFile(join(proj, "src.js"), "s");
    const changed = await changedFilesVsSnapshot({ method: "copy", dir: backup }, proj);
    expect(changed).toEqual([]); // yalnız node_modules değişti → yok sayıldı
  });

  it("alt-dizin (nested) değişikliğini proje-relative yol olarak döner", async () => {
    await mkdir(join(backup, "routes"), { recursive: true });
    await writeFile(join(backup, "routes", "db.js"), "old");
    await mkdir(join(proj, "routes"), { recursive: true });
    await writeFile(join(proj, "routes", "db.js"), "new");
    const changed = await changedFilesVsSnapshot({ method: "copy", dir: backup }, proj);
    expect(changed).toEqual([join("routes", "db.js")]);
  });

  it("backup dizini okunamıyorsa → null (FAIL-SAFE: eksik listeyle yanlış muafiyet YOK)", async () => {
    const changed = await changedFilesVsSnapshot({ method: "copy", dir: join(backup, "yok-dizin") }, proj);
    expect(changed).toBeNull();
  });

  it("hiçbir değişiklik yok → [] (boş liste, null DEĞİL)", async () => {
    await writeFile(join(backup, "a.js"), "same");
    await writeFile(join(proj, "a.js"), "same");
    const changed = await changedFilesVsSnapshot({ method: "copy", dir: backup }, proj);
    expect(changed).toEqual([]);
  });

  it("MAHKEME fix: symlink 'değişti' sayılır (under-report yok — görünmez retarget/ekle YOK)", async () => {
    const { symlink } = await import("node:fs/promises");
    await writeFile(join(proj, "target.js"), "t");
    await symlink(join(proj, "target.js"), join(proj, "link.js")); // projede symlink var, backup'ta yok
    await writeFile(join(backup, "target.js"), "t");
    const changed = await changedFilesVsSnapshot({ method: "copy", dir: backup }, proj);
    // link.js symlink → 'changed' say (isProdPath değerlendirmesi çağırana kalır; sessizce atlanmaz).
    expect(changed).toContain("link.js");
  });
});

// CANLI KANIT (ekransız deneme koşusu 22, 2026-11-27; arayüzsüz Node.js, git yok): Faz 8 başında proje kodsuzken alınan
// yedek geri alma noktası kuruldu ("ilk kurulan kazanır"), deneme kapıda düştü ve nokta kurulu kaldı. Düzeltme
// yönlendirmesinin kodlu yedeği kurulamadı; düzeltme kipi kodsuz yedeği aldı, "kırmızı önce" karşılaştırması bütün
// kaynağı "değişmiş" gördü ve geri alma projenin BÜTÜN kaynağını sildi.
describe("deneme yedeği ömrü + toplu silme emniyeti (koşu 22)", () => {
  let dir: string;
  let home: string;
  const origHome = process.env.MYCL_HOME;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mycl-attempt-"));
    home = await mkdtemp(join(tmpdir(), "mycl-home-"));
    process.env.MYCL_HOME = home;
    disarmRollback();
    emitChatMock.mockClear();
  });
  afterEach(async () => {
    disarmRollback();
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true }).catch(() => {});
    if (origHome === undefined) delete process.env.MYCL_HOME;
    else process.env.MYCL_HOME = origHome;
  });

  /** Koşu 22: faz başında kodsuz proje → ilk deneme kodu yazar → kapıda düşer → düzeltme yönlendirmesi yedek alır. */
  async function kosu22() {
    await writeFile(join(dir, ".gitignore"), "node_modules\n");
    const fazBasi = await snapshotAttemptStart(dir, 1795793249095); // düzeltme dışı deneme başı
    expect(fazBasi.method).toBe("copy");
    expect(peekRollback()).toBeNull(); // nokta KURULMADI
    // İlk deneme kodu yazdı ve kapıda düştü (yazılan kod yerinde kaldı).
    await mkdir(join(dir, "bin"), { recursive: true });
    await mkdir(join(dir, "lib"), { recursive: true });
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "bin", "todo.js"), "#!/usr/bin/env node\nrequire('../lib/tasks');\n");
    await writeFile(join(dir, "lib", "tasks.js"), "module.exports = { add() {} };\n");
    await writeFile(join(dir, "tests", "cli.test.js"), "test('a', () => {});\n");
    // Düzeltme yönlendirmesi (index.ts, git yok): yedek alır ve noktayı kurar.
    const yonlendirme = await snapshotBeforeAutofix(dir, 1795794335444);
    // Düzeltme kipi (phase-8.ts): dizinin noktası varsa onu kullanır.
    const duzeltme = await snapshotForFixAttempt(dir, 1795794340000);
    return { fazBasi, yonlendirme, duzeltme };
  }

  it("düzeltme kipinin yedeği ikinci (kodlu) yedektir; yalnız test dosyası değiştiyse liste yalnız onu taşır", async () => {
    const { fazBasi, yonlendirme, duzeltme } = await kosu22();
    expect(duzeltme.dir).toBe(yonlendirme.dir);
    expect(duzeltme.dir).not.toBe(fazBasi.dir);
    // Düzeltme yalnız test dosyasına dokundu.
    await writeFile(join(dir, "tests", "cli.test.js"), "test('a', () => {});\ntest('b', () => {});\n");
    expect(await changedFilesVsSnapshot(duzeltme, dir)).toEqual([join("tests", "cli.test.js")]);
  });

  it("düzeltme geri alınır → ilk denemenin kaynak dosyaları yerinde, düzeltmenin eklediği dosya silinmiş; rapor sayıları", async () => {
    const { duzeltme } = await kosu22();
    await writeFile(join(dir, "lib", "extra.js"), "module.exports = 1;\n"); // düzeltmenin eklediği
    await writeFile(join(dir, "lib", "tasks.js"), "BROKEN\n"); // düzeltmenin bozduğu
    const rep = await restoreSnapshotWithReport(duzeltme, dir);
    expect(rep.ok).toBe(true);
    expect(rep.refused).toBe(false);
    expect(existsSync(join(dir, "bin", "todo.js"))).toBe(true);
    expect(await readFile(join(dir, "lib", "tasks.js"), "utf8")).toBe("module.exports = { add() {} };\n");
    expect(existsSync(join(dir, "lib", "extra.js"))).toBe(false);
    expect(rep.deleted).toBe(1);
    expect(rep.rewritten).toBe(4); // .gitignore + bin/todo.js + lib/tasks.js + tests/cli.test.js
    expect(rep.target).toBe(duzeltme.dir);
    expect(rep.takenAt).toBe(1795794335444);
  });

  it("geri alma projedeki BÜTÜN çalışan üretim dosyalarını silecekse yapılmaz: dosyalar yerinde, görünür hata", async () => {
    const { fazBasi } = await kosu22();
    const rep = await restoreSnapshotWithReport(fazBasi, dir); // kodsuz faz başı yedeğine dönmek
    expect(rep.ok).toBe(false);
    expect(rep.refused).toBe(true);
    expect(existsSync(join(dir, "bin", "todo.js"))).toBe(true);
    expect(existsSync(join(dir, "lib", "tasks.js"))).toBe(true);
    const ileti = emitChatMock.mock.calls.map((c) => String(c[1])).find((t) => t.includes("Geri alma YAPILMADI"));
    expect(ileti, "görünür ret iletisi yok").toBeDefined();
    expect(ileti).toContain(fazBasi.dir!); // yedek nerede
    // Boolean API de reddi başarısızlık olarak döner (tükenmedeki geri alma da korunur).
    expect(await restoreSnapshot(fazBasi, dir)).toBe(false);
    expect(existsSync(join(dir, "bin", "todo.js"))).toBe(true);
  });

  it("REGRESYON: çalışan üretim dosyalarının bir kısmı yedekte varsa geri alma yapılır (eklenenler silinir)", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.js"), "orig\n");
    const snap = await snapshotBeforeAutofix(dir, 1781000000020);
    await writeFile(join(dir, "src", "added.js"), "x\n");
    const rep = await restoreSnapshotWithReport(snap, dir);
    expect(rep.ok).toBe(true);
    expect(existsSync(join(dir, "src", "added.js"))).toBe(false);
  });

  it("REGRESYON (inceleme bulgusu): düzeltme bütün çalışan dosyaları yeniden adlandırdıysa geri alma yapılır (yedekte kod var)", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.js"), "orig\n");
    const snap = await snapshotBeforeAutofix(dir, 1781000000030);
    await rm(join(dir, "src", "app.js"));
    await writeFile(join(dir, "src", "server.js"), "renamed\n"); // projedeki tek çalışan dosya, yedekte yok
    const rep = await restoreSnapshotWithReport(snap, dir);
    expect(rep.refused).toBe(false);
    expect(rep.ok).toBe(true);
    expect(existsSync(join(dir, "src", "app.js"))).toBe(true);
    expect(existsSync(join(dir, "src", "server.js"))).toBe(false);
  });

  it("budama kurulu geri alma noktasının klasörünü silmez", async () => {
    const root = join(home, "backups");
    for (const ts of [1, 2, 3, 4, 5]) await mkdir(join(root, `p-autofix-${ts}`), { recursive: true });
    const removed = await pruneProjectBackups(root, "p", 3, join(root, "p-autofix-1"));
    expect(removed).toEqual(["p-autofix-2"]);
    expect(existsSync(join(root, "p-autofix-1"))).toBe(true);
  });
});
