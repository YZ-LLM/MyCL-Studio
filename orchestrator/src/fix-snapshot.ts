// fix-snapshot — otomatik düzeltmeden ÖNCE geri-alınabilir yedek (YZLLM 2026-06-10: "oto-cevap açıkken durmasın,
// darboğazda devam etsin" → otonom düzeltme GÜVENLİ olmalı). Git deposunda checkpoint (ucuz); git YOKSA kaynak
// ağacını `.mycl/backups/<ts>/`'a kopyalar (node_modules vb. hariç). Yanlış oto-düzeltme geri alınabilir.

import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { isRuntimeProdFile } from "./file-classify.js";
import { createCheckpoint, previewRestoreCheckpoint, restoreCheckpoint } from "./git.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import { globalConfigDir } from "./paths.js";

// Yedeklenmeyen + restore'da SİLİNMEYEN top-level dizinler. node_modules/.git/dist vb. ağır/türetilmiş;
// .mycl (MyCL state) + error_folder (hata kataloğu) BİLEREK korunur — rollback "MyCL state ve hata kataloğu
// korundu" sözünü tutar (YZLLM 2026-06-12: error_folder eklendi — yoksa ayna-restore onu da geri alırdı).
const EXCLUDE_TOP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".mycl",
  "error_folder",
  ".turbo",
  ".cache",
  ".vite",
]);

export interface FixSnapshot {
  method: "git" | "copy" | "none";
  ref?: string;
  dir?: string;
  /** Alınma zamanı (epoch ms) — geri alma iletisi ve denetim satırı hangi yedeğe dönüldüğünü söylesin. Eski kayıtlarda yok. */
  takenAt?: number;
}

/** Proje başına tutulacak kopya-yedek sayısı (YZLLM 2026-06-27). Eskiler budanır → ~/.mycl/backups şişmez. */
const BACKUP_KEEP = 3;

/**
 * SAF-yan-etkili: bir projenin ~/.mycl/backups altındaki `<proje>-autofix-<ts>` kopya-yedeklerinden EN YENİ
 * `keep` taneyi tut, eskileri sil. ts = dizin adındaki epoch son-eki (sayısal sırala, en yeni kalır). Yalnız
 * BU projenin yedeklerine dokunur (prefix + sayısal son-ek eşleşmesi). Fail-soft: hata budanmayı atlar, snapshot'ı
 * bozmaz. Test edilebilir (backupsRoot dışarıdan verilir). */
export async function pruneProjectBackups(
  backupsRoot: string,
  projectName: string,
  keep: number,
  /** Silinmeyecek yedek klasörü (kurulu geri alma noktası): faz başı yedekleri artık nokta kurmadığı için yeni
   *  yedekler sıklaştı; budama düzeltme dizisinin geri dönüş hedefini silmesin (2026-11-27). */
  protectDir?: string,
): Promise<string[]> {
  const removed: string[] = [];
  try {
    const prefix = `${projectName}-autofix-`;
    const entries = await readdir(backupsRoot, { withFileTypes: true }).catch(() => []);
    const mine = entries
      .filter(
        (e) =>
          e.isDirectory() &&
          e.name.startsWith(prefix) &&
          /^\d+$/.test(e.name.slice(prefix.length)),
      )
      .map((e) => ({ name: e.name, ts: Number(e.name.slice(prefix.length)) }))
      .sort((a, b) => b.ts - a.ts); // en yeni önce
    for (const old of mine.slice(Math.max(0, keep))) {
      if (protectDir && join(backupsRoot, old.name) === protectDir) continue;
      await rm(join(backupsRoot, old.name), { recursive: true, force: true }).catch(() => {});
      removed.push(old.name);
    }
  } catch (e) {
    log.warn("fix-snapshot", "eski yedekler budanamadı (non-fatal)", { error: String(e) });
  }
  return removed;
}

/**
 * Kaynak ağacını `destDir`'e kopyalar; EXCLUDE_TOP'taki üst dizinler (node_modules, .git, dist, build,
 * .mycl…) kopyalanmaz. `destDir` projenin DIŞINDA olmalı (`fs.cp` bir dizini kendi altına kopyalayamaz).
 * `snapshotBeforeAutofix`'in kopya adımıdır; Faz 5 rötuşu da "koşu hiçbir kaynak dosyayı değiştirmedi"
 * kanıtı için aynı kopyayı alıp `changedFilesVsSnapshot` ile karşılaştırır (tek dışlama listesi, tek
 * karşılaştırma). Hata fırlatır — çağıran karar verir.
 */
export async function copySourceTree(projectRoot: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await cp(projectRoot, destDir, {
    recursive: true,
    filter: (src: string) => {
      const rel = src.slice(projectRoot.length).replace(/^[/\\]+/, "");
      if (rel === "") return true;
      const top = rel.split(/[/\\]/)[0];
      return !EXCLUDE_TOP.has(top);
    },
  });
}

/**
 * Oto-düzeltme öncesi snapshot. Git temizse git-checkpoint (ref). Değilse kaynak kopyası (.mycl/backups).
 * İkisi de olmazsa görünür uyarı + {none} (düzeltme yine uygulanır ama geri-alma yok — dürüstçe söylenir).
 * `nowTs` dışarıdan verilir (test determinizmi; runtime Date.now()).
 */
export async function snapshotBeforeAutofix(
  projectRoot: string,
  nowTs: number,
  /** `arm: false` → yedek alınır ama geri alma NOKTASI kurulmaz (bkz. snapshotAttemptStart). Varsayılan: kurulur. */
  opts: { arm?: boolean } = {},
): Promise<FixSnapshot> {
  const arm = opts.arm !== false;
  // 1. Git tercih edilir (ucuz, temiz ağaçta).
  const cp1 = await createCheckpoint(projectRoot).catch((e) => {
    // Beklenmedik throw (git durumu okuma/spawn) sessizce {ok:false}'a düşüyordu → yedeğe geçiş NEDENSİZ. Görünür.
    log.warn("fix-snapshot", "git checkpoint alınamadı (yedeğe düşülüyor)", { error: String(e) });
    return { ok: false as const, ref: undefined };
  });
  if (cp1.ok && "ref" in cp1 && cp1.ref) {
    emitChatMessage(
      "system",
      arm
        ? "📌 Snapshot alındı (git) — bu adımda silinen/değişen dosyalar gerekirse geri alınabilir."
        : `📌 Faz başı noktası (git, ${cp1.ref.slice(0, 8)}) — elle geri dönüş içindir; otomatik geri almanın hedefi değildir.`,
    );
    const snap: FixSnapshot = { method: "git", ref: cp1.ref, takenAt: nowTs };
    if (arm) armRollback(snap);
    return snap;
  }
  // 2. Git yok/kirli → kaynak ağacını yedekle. Hedef proje DIŞINDA (~/.mycl/backups) — `fs.cp` bir dizini kendi
  // alt-dizinine kopyalayamaz; ayrıca yedek projeyi kirletmez + proje işlemlerinden etkilenmez.
  try {
    const backupsRoot = join(globalConfigDir(), "backups");
    const projectName = basename(projectRoot);
    const dir = join(backupsRoot, `${projectName}-autofix-${nowTs}`);
    await copySourceTree(projectRoot, dir);
    emitChatMessage(
      "system",
      arm
        ? "📌 Snapshot alındı (`~/.mycl/backups`) — git yok ama kaynak yedeklendi; silinen/yanlış değişen dosya oradan geri alınır."
        : `📌 Faz başı yedeği alındı (\`${dir}\`) — elle geri dönüş içindir; otomatik geri almanın hedefi değildir.`,
    );
    const snap: FixSnapshot = { method: "copy", dir, takenAt: nowTs };
    if (arm) armRollback(snap);
    // YZLLM 2026-06-27: proje başına yalnız son N yedeği tut — eskiler budanır (disk şişmesin). Yeni yedek
    // oluştuktan SONRA budanır → kept-3 her zaman EN YENİ 3'tür (bu koşunun yedeği dahil). Fail-soft.
    // Kurulu geri alma noktasının klasörü budanmaz (2026-11-27).
    await pruneProjectBackups(backupsRoot, projectName, BACKUP_KEEP, _rollback?.dir);
    return snap;
  } catch (e) {
    log.warn("fix-snapshot", "snapshot failed (non-fatal)", e);
    emitChatMessage(
      "system",
      arm && _rollback !== null
        ? `⚠️ Bu adımın yedeği alınamadı — geri alma, dizinin önceki yedeğine dönebilir: ${describeSnapshot(_rollback)}.`
        : "⚠️ Snapshot alınamadı — otomatik düzeltme yine de uygulanacak ama GERİ ALMA yok. Dikkatli ol.",
    );
    // 2026-11-27 (inceleme bulgusu): eskiden burada koşulsuz disarmRollback() vardı — dizinin SONRAKİ bir yedeği
    // alınamayınca dizinin ilk (en temiz) noktası da düşüyordu. Kurulu nokta varsa korunur; yoksa zaten boştur.
    return { method: "none" };
  }
}

/**
 * Düzeltme DIŞI bir faz denemesinin başında yedek (Faz 5, Faz 8). Geri alma NOKTASI KURMAZ.
 *
 * CANLI KANIT (ekransız deneme koşusu 22, 2026-11-27): Faz 8 başında, proje kodsuzken alınan yedek geri alma noktası
 * olarak kuruldu ("ilk kurulan kazanır"); deneme kapıda düştü, nokta kurulu kaldı. Düzeltme yönlendirmesinin aldığı
 * ikinci (kodlu) yedek nokta dolu olduğu için kurulamadı. Düzeltme kipi `peekRollback()` ile kodsuz yedeği aldı:
 * "kırmızı önce" karşılaştırması bütün kaynağı "değişmiş" gördü (koşu 18'de de aynı kök) ve geri alma, ayna geri
 * yüklemesiyle projenin BÜTÜN kaynağını sildi. Artık faz başı yedeği yalnız diskte kalır (elle dönüş için); düzeltme
 * dizisinin geri alma hedefi ve karşılaştırma tabanı, kod yazıldıktan sonra alınan düzeltme yedeğidir.
 */
export async function snapshotAttemptStart(projectRoot: string, nowTs: number): Promise<FixSnapshot> {
  return snapshotBeforeAutofix(projectRoot, nowTs, { arm: false });
}

/**
 * Düzeltme denemesinin yedeği: düzeltme dizisinin kurulu noktası varsa o ("ilk kurulan kazanır" = dizinin en temiz
 * hâli; düzeltme yönlendirmesi bu turda almış olabilir — çift yedek olmasın), yoksa şimdi alınıp kurulur. Faz başı
 * yedekleri nokta kurmadığı için dönen yedek her zaman bir düzeltme yedeğidir.
 */
export async function snapshotForFixAttempt(projectRoot: string, nowTs: number): Promise<FixSnapshot> {
  return peekRollback() ?? (await snapshotBeforeAutofix(projectRoot, nowTs));
}

/** İçerik-karşılaştırmada tam-oku üst sınırı — büyük dosyada boyut-farkına düş (bellek koruması). */
const CHANGED_DIFF_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Copy-snapshot'a göre DEĞİŞEN (eklenen/değişen/silinen) prod-relative dosya yollarını hesapla — git-ref GEREKMEZ.
 * Neden (YZLLM 2026-07-15, cave döngüsü): repro-first muafiyetlerinin change-detection'ı YALNIZ git-ref'ten
 * türüyordu → foreign/copy/non-git projede `checkpointRef=null` → değişen dosya belirlenemeyip muafiyetler atlanıyor
 * → imkansız-repro döngüsü. Bu, copy-yedek ile projeyi İÇERİK-farkıyla karşılaştırır (Bash/sed dahil her aracı
 * yakalar; git parity). `method!=="copy" || !dir` → null (çağıran git yolunu korur). Herhangi bir okuma hatasında
 * (izin/IO) NULL döner (FAIL-SAFE: eksik listeyle "test-only" sanıp repro'yu yanlışlıkla düşürme; repro zorunlu kalır).
 * EXCLUDE_TOP (node_modules/.git/.mycl/dist…) atlanır. SAF-değil (fs). Proje-relative yol döner.
 */
export async function changedFilesVsSnapshot(
  snap: FixSnapshot,
  projectRoot: string,
): Promise<string[] | null> {
  if (snap.method !== "copy" || !snap.dir) return null;
  const backupDir = snap.dir;
  const changed = new Set<string>();
  const isEnoent = (e: unknown): boolean => (e as { code?: string })?.code === "ENOENT";

  const sameContent = async (aPath: string, bPath: string): Promise<boolean> => {
    const [aSt, bSt] = await Promise.all([stat(aPath), stat(bPath)]);
    if (aSt.size !== bSt.size) return false; // boyut farkı → kesin değişti
    // MAHKEME fix (fake-green önleme): aynı-boyut + BÜYÜK dosya içeriği okunmadan "değişmedi" SAYILMAZ (aynı boyutta
    // sabit-genişlik değişiklik — "100"→"200", ">"→"<" — kaçardı → yanlış test-only muafiyeti). İçerik doğrulanamıyorsa
    // "değişti" say (güvenli taraf: repro zorunlu kalır). 8MB+ tek prod kaynak dosyası nadir; false-pozitif zararsız (repro ister).
    if (aSt.size > CHANGED_DIFF_MAX_BYTES) return false;
    const [aBuf, bBuf] = await Promise.all([readFile(aPath), readFile(bPath)]);
    return aBuf.equals(bBuf);
  };

  // backup → project: DEĞİŞEN (içerik) + SİLİNEN. `false` dönerse okuma güvenilmez → caller null.
  const walkBackup = async (relDir: string): Promise<boolean> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(backupDir, relDir), { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (!relDir && EXCLUDE_TOP.has(e.name)) continue;
      const rel = relDir ? join(relDir, e.name) : e.name;
      // MAHKEME fix (symlink under-report): readdir'da symlink isFile()=isDirectory()=false → eskiden sessizce
      // atlanıyordu (retarget/ekle/sil GÖRÜNMEZ → yanlış test-only muafiyeti). "değişti" say (güvenli taraf).
      if (e.isSymbolicLink()) {
        changed.add(rel);
        continue;
      }
      if (e.isDirectory()) {
        if (!(await walkBackup(rel))) return false;
        continue;
      }
      if (!e.isFile()) continue;
      try {
        if (!(await sameContent(join(backupDir, rel), join(projectRoot, rel)))) changed.add(rel);
      } catch (err) {
        if (isEnoent(err)) {
          changed.add(rel); // projede yok → SİLİNDİ
        } else {
          return false; // izin/IO hatası → güvenilmez
        }
      }
    }
    return true;
  };
  // project → backup: EKLENEN (yeni) dosyalar.
  const walkProject = async (relDir: string): Promise<boolean> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(projectRoot, relDir), { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (!relDir && EXCLUDE_TOP.has(e.name)) continue;
      const rel = relDir ? join(relDir, e.name) : e.name;
      // MAHKEME fix (symlink under-report): readdir'da symlink isFile()=isDirectory()=false → eskiden sessizce
      // atlanıyordu (retarget/ekle/sil GÖRÜNMEZ → yanlış test-only muafiyeti). "değişti" say (güvenli taraf).
      if (e.isSymbolicLink()) {
        changed.add(rel);
        continue;
      }
      if (e.isDirectory()) {
        if (!(await walkProject(rel))) return false;
        continue;
      }
      if (!e.isFile()) continue;
      try {
        await stat(join(backupDir, rel));
      } catch (err) {
        if (isEnoent(err)) changed.add(rel); // backup'ta yok → EKLENDİ
        else return false;
      }
    }
    return true;
  };

  if (!(await walkBackup(""))) return null;
  if (!(await walkProject(""))) return null;
  return [...changed];
}

/**
 * YZLLM 2026-06-12 KRİTİK FİX: copy-restore artık GERÇEK AYNA. Eski hali yalnız `cp(backup→proje)` ile üzerine
 * yazıyordu → fix'in EKLEDİĞİ dosyalar (yeni util/test dosyaları) SİLİNMİYORDU → her başarısız fix'in artığı
 * birikiyor, fix-öncesi baseline kırık-sayısı tur tur şişiyordu (gözlemlendi: 20→21→24) + "geri aldım" YALAN
 * oluyordu + regresyon baseline'ı zehirleniyordu. Ayna-restore: (1) backup'ı projeye yaz, (2) projede olup
 * backup'ta OLMAYAN dosyaları SİL (hariç-tutulan top-level dizinler hariç). Sonuç: proje TAM olarak snapshot anı.
 */
async function mirrorRestore(backupDir: string, projectRoot: string): Promise<{ deleted: number; rewritten: number }> {
  // 1. Backup içeriğini projeye yaz — değişen/silinen dosyalar geri gelir.
  await cp(backupDir, projectRoot, { recursive: true, force: true });
  // 2. Projede olup backup'ta OLMAYAN dosyaları sil = fix'in EKLEDİĞİ fazlalık. Hariç-tutulan top-level
  //    dizinlere (node_modules/.git/.mycl/error_folder/dist...) DOKUNMA — bilerek yedeklenmedi/korunuyor.
  const deleted = await removeAddedFiles(projectRoot, backupDir, projectRoot);
  return { deleted, rewritten: (await listFiles(backupDir, "")).length };
}

/**
 * SALT OKUR: `root` altındaki dosyaların göreli yolları (top-level EXCLUDE_TOP ve sembolik bağlar atlanır). Okunamayan
 * dizin atlanır (rapor/emniyet amaçlı; kuşku emniyet tarafında ayrıca ele alınır).
 */
async function listFiles(root: string, relDir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(join(root, relDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!relDir && EXCLUDE_TOP.has(e.name)) continue;
    const rel = relDir ? join(relDir, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** projeRoot altını gez; backup'ta karşılığı OLMAYAN dosya/dizini sil. Top-level EXCLUDE_TOP atlanır (korunur).
 *  Döner: silinen DOSYA sayısı (silinen dizinin içindekiler dahil). */
async function removeAddedFiles(dir: string, backupRoot: string, projectRoot: string): Promise<number> {
  let removed = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code && code !== "ENOENT" && code !== "ENOTDIR") {
      // Dizin VAR ama okunamadı (EACCES/EIO) → bu alt-ağaçtaki fix-eklediği dosyalar SİLİNEMEDİ → restore EKSİK.
      // Sonnet müfettiş düzeltmesi: restoreSnapshot yine true dönüyor → KULLANICIYA görünür uyarı (sessiz-kısmi-restore
      // değil; "temiz" sanılmasın). (Tam çözüm caller'a partial-flag taşımak; en az: görünür kıl.)
      log.error("fix-snapshot", "removeAddedFiles: dizin okunamadı — restore eksik (eklenen dosyalar kaldı)", { dir, code });
      emitChatMessage(
        "system",
        `⚠️ Geri-alma KISMEN eksik — bir dizin okunamadı (${code}), fix'in eklediği bazı dosyalar silinemedi. Repo tam temiz olmayabilir; elle kontrol et.`,
      );
    }
    return removed; // dizin yok/okunamadı → atla
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = relative(projectRoot, full);
    const top = rel.split(/[/\\]/)[0];
    if (EXCLUDE_TOP.has(top)) continue; // yedeklenmemiş/korunan dizin → dokunma
    const inBackup = join(backupRoot, rel);
    // VERİ-KAYBI önleme (sessiz-fallback denetimi): stat'ı errno'ya göre ayır. ENOENT = backup'ta gerçekten
    // yok → fix ekledi → silinebilir. BAŞKA hata (EACCES/EIO) = belirsiz → "yok" sanıp SİLMEK veri-kaybı →
    // güvenli taraf: KORU (dokunma), görünür kıl.
    let existsInBackup: boolean;
    try {
      await stat(inBackup);
      existsInBackup = true;
    } catch (statErr) {
      if ((statErr as { code?: string }).code === "ENOENT") {
        existsInBackup = false;
      } else {
        log.error("fix-snapshot", "stat belirsiz hata — dosya KORUNDU (silinmedi, veri-kaybı önleme)", {
          inBackup,
          code: (statErr as { code?: string }).code,
        });
        continue;
      }
    }
    if (!existsInBackup) {
      // backup'ta yok → fix ekledi → sil (dosya VEYA tüm alt-ağaç).
      // Sayım proje köküne göre (listFiles hariç tutmayı yalnız KÖK düzeyde uygular; alt dizindeki build/ dist/ sayılır).
      const count = e.isDirectory() ? (await listFiles(projectRoot, rel)).length : 1;
      const ok = await rm(full, { recursive: true, force: true }).then(
        () => true,
        (err) => {
          log.warn("fix-snapshot", "mirror: added-file silinemedi (non-fatal)", { full, err });
          return false;
        },
      );
      if (ok) removed += count;
      continue;
    }
    if (e.isDirectory()) removed += await removeAddedFiles(full, backupRoot, projectRoot);
  }
  return removed;
}

/** Geri yüklemenin sonucu — ileti ve `revert-decision-*` denetim satırı hangi yedeğe dönüldüğünü söylesin. */
export interface RestoreReport {
  ok: boolean;
  /** Toplu silme emniyeti geri yüklemeyi YAPMADI (proje olduğu gibi kaldı). */
  refused: boolean;
  /** Dönülen yedek: kopya klasörü ya da `git <ref>`. */
  target: string;
  takenAt?: number;
  /** Silinen dosya sayısı (git: kuru koşuda görülen izlenmeyen yollar). */
  deleted: number;
  /** Geri yazılan dosya sayısı (kopya: yedekteki dosyalar; git: ref'ten farklı izlenen dosyalar). */
  rewritten: number;
}

/** SAF: yedeğin okunur adı + alınma zamanı (ileti/denetim için). */
export function describeSnapshot(snap: FixSnapshot): string {
  const target = snap.method === "git" ? `git ${String(snap.ref ?? "").slice(0, 12)}` : String(snap.dir ?? "");
  const at = snap.takenAt ? new Date(snap.takenAt).toISOString() : "bilinmiyor";
  return `${target} (alınma: ${at})`;
}

/**
 * Toplu silme emniyeti (KESİN denetim, son çare — 2026-11-27, koşu 22): geri yükleme projede BUGÜN var olan çalışan
 * üretim dosyalarının (`isRuntimeProdFile`) HEPSİNİ silecekse YAPILMAZ. Döner: silinecek çalışan üretim dosyaları ve
 * şu an var olanlar; `null` = hesaplanamadı (çağıran kuşkuda geri yüklemez).
 */
async function runtimeFilesLostByRestore(
  snap: FixSnapshot,
  projectRoot: string,
): Promise<{ present: string[]; lost: string[]; restoredRuntime: number } | null> {
  const present = (await listFiles(projectRoot, "")).filter((f) => isRuntimeProdFile(f));
  if (present.length === 0) return { present, lost: [], restoredRuntime: 0 };
  if (snap.method === "copy" && snap.dir) {
    const lost: string[] = [];
    for (const f of present) {
      try {
        await stat(join(snap.dir, f));
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") lost.push(f);
        else return null; // belirsiz → hesaplanamadı
      }
    }
    // Yedek okunamıyorsa (budanmış/izin) listFiles boş döner → "yedekte kod yok" sayılır (kuşkuda geri yüklenmez).
    const restoredRuntime = (await listFiles(snap.dir, "")).filter((f) => isRuntimeProdFile(f)).length;
    return { present, lost, restoredRuntime };
  }
  if (snap.method === "git" && snap.ref) {
    const preview = await previewRestoreCheckpoint(projectRoot, snap.ref);
    if (!preview) return null;
    const lost = present.filter((f) =>
      preview.removed.some((r) => (r.endsWith("/") ? f.startsWith(r) : f === r)),
    );
    const restoredRuntime = preview.atRef.filter((f) => isRuntimeProdFile(f)).length;
    return { present, lost, restoredRuntime };
  }
  return { present, lost: [], restoredRuntime: 0 };
}

/**
 * Bir snapshot'tan projeyi GERİ YÜKLE. git → restoreCheckpoint (checkout+clean, fix'in eklediği dosyalar da gider);
 * copy → AYNA-restore (mirrorRestore): proje tam olarak snapshot anına döner (fix'in eklediği dosyalar dahil temizlenir).
 */
export async function restoreSnapshot(snap: FixSnapshot, projectRoot: string): Promise<boolean> {
  return (await restoreSnapshotWithReport(snap, projectRoot)).ok;
}

/** `restoreSnapshot` + rapor (hangi yedek, kaç dosya silindi/geri yazıldı, emniyet reddetti mi). */
export async function restoreSnapshotWithReport(snap: FixSnapshot, projectRoot: string): Promise<RestoreReport> {
  const report: RestoreReport = {
    ok: false,
    refused: false,
    target: snap.method === "git" ? `git ${String(snap.ref ?? "")}` : String(snap.dir ?? ""),
    takenAt: snap.takenAt,
    deleted: 0,
    rewritten: 0,
  };
  try {
    if (!((snap.method === "git" && snap.ref) || (snap.method === "copy" && snap.dir))) return report;
    // TOPLU SİLME EMNİYETİ (kural 4: görünür hata + dur). Hesaplanamazsa da geri yüklenmez (kuşkuda veri silme).
    // Reddedilir: projedeki çalışan üretim dosyalarının HEPSİ silinecek VE yedek hiç çalışan üretim dosyası geri
    // getirmiyor (koşu 22: kodsuz yedek). Düzeltme dosyaları yeniden adlandırdıysa (yedekte eski adlarıyla kod var)
    // geri yükleme yapılır — eskisi gibi (inceleme bulgusu).
    const loss = await runtimeFilesLostByRestore(snap, projectRoot);
    if (
      !loss ||
      (loss.present.length > 0 && loss.lost.length === loss.present.length && loss.restoredRuntime === 0)
    ) {
      report.refused = true;
      const sample = (loss?.lost ?? []).slice(0, 5).join(", ");
      const what = loss
        ? `projedeki BÜTÜN çalışan üretim dosyalarını (${loss.lost.length} dosya: ${sample}${loss.lost.length > 5 ? ", …" : ""}) silecekti`
        : "projedeki çalışan üretim dosyalarından hangilerini sileceği hesaplanamadı";
      log.error("fix-snapshot", "geri yükleme REDDEDİLDİ — toplu silme emniyeti", { target: report.target, lost: loss?.lost.length ?? null });
      emitChatMessage(
        "system",
        `⛔ Geri alma YAPILMADI: yedeğe dönmek ${what}. Proje olduğu gibi bırakıldı; MyCL geri almadan devam ediyor. ` +
          `Yedek yerinde duruyor: ${describeSnapshot(snap)} (büyük ihtimalle kod yazılmadan önce alınmış). ` +
          "Başarısız düzeltmenin değişikliklerini elle geri almak istersen bu yedeği kullanabilirsin.",
      );
      return report;
    }
    if (snap.method === "git" && snap.ref) {
      const preview = await previewRestoreCheckpoint(projectRoot, snap.ref);
      // Silinen DOSYA sayısı: `git clean -n` izlenmeyen bir dizini tek satırla yazar → içindeki dosyalar sayılır.
      let deleted = 0;
      for (const r of preview?.removed ?? []) {
        deleted += r.endsWith("/") ? (await listFiles(projectRoot, r.replace(/\/+$/, ""))).length : 1;
      }
      report.ok = await restoreCheckpoint(projectRoot, snap.ref);
      report.deleted = deleted;
      report.rewritten = preview?.rewritten.length ?? 0;
      return report;
    }
    const counts = await mirrorRestore(snap.dir as string, projectRoot);
    report.ok = true;
    report.deleted = counts.deleted;
    report.rewritten = counts.rewritten;
    return report;
  } catch (e) {
    log.warn("fix-snapshot", "restore failed", e);
    report.ok = false;
    return report;
  }
}

// ───────── Rollback noktası (YZLLM 2026-06-10: "oto-cevap açıksa ve geri almaktan başka çare yoksa MyCL kendi geri
// alsın"). Bir düzeltme-dizisinin EN TEMİZ hali = ilk fix denemesinden ÖNCEki snapshot (FIRST-wins). Diziyi
// çözen başarı veya yeni kullanıcı turu disarm eder; tükenmede failPhase bunu restore eder. ─────────
let _rollback: FixSnapshot | null = null;

/** İlk-kazanır: dizinin ilk (en temiz) snapshot'ını rollback noktası yap (sonrakiler ezmez — junk birikmesin). */
function armRollback(snap: FixSnapshot): void {
  if (_rollback === null && (snap.method === "git" || snap.method === "copy")) {
    _rollback = snap;
  }
}
/**
 * Düzeltme dizisinin noktasını DIŞARIDAN kur (ilk kurulan kazanır). Düzeltme yönlendirmesi git'te yalnız checkpoint
 * ref'i alıyordu, noktayı kurmuyordu; faz başı noktası kalkınca (2026-11-27) git'li projede tükenmedeki geri almanın
 * hedefi kalmadı → yönlendirmenin checkpoint'i dizinin noktası olarak kurulur (kural 14: yerine geçen mekanizma).
 */
export function armFixSeriesRollback(snap: FixSnapshot): void {
  armRollback(snap);
}
/** Rollback noktasını al + temizle (restore edildikten sonra). */
export function takeRollback(): FixSnapshot | null {
  const r = _rollback;
  _rollback = null;
  return r;
}
/** Rollback noktasını GÖZ AT (temizlemeden) — aynı turda armed bir snapshot başka mekanizmaca (Faz 8 fix
 * rollback'i) ÇİFT yedek almadan yeniden kullanılsın. Yeni kullanıcı turu zaten disarm eder → bayat dönmez. */
export function peekRollback(): FixSnapshot | null {
  return _rollback;
}
/** Dizi çözüldü/yeni tur → rollback noktasını at (bayat restore olmasın). */
export function disarmRollback(): void {
  _rollback = null;
}
