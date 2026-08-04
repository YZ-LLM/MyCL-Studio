// copy-to-accessible — MyCL bir projeyi ajan-sandbox'ı yüzünden OKUYAMADIĞINDA (no-access; tipik: ev ~ altındaki
// proje, macOS Seatbelt nested-profile sorunu), projeyi EV-DIŞI erişilebilir bir klasöre kopyalar → orada
// onboarding/geliştirme YAPILABİLİR. YZLLM kararı (cave5): "erişemediği projeleri 'MyCL Projeler'e kopyalasın".
//
// KONUM ev-DIŞI olmalı (içi olursa aynı sandbox engeli): macOS → /Users/Shared/MyCL Projeler (world-writable,
// ev-dışı, kalıcı); linux → /var/tmp/MyCL Projeler; diğer → os.tmpdir(). Sandbox denyRead=[home] bunları
// kapsamaz → ajan okur. ORİJİNAL DOKUNULMAZ (yalnız kopya).

import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { homedir, platform as osPlatform, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { log } from "../logger.js";

/** Kopyalanmayan (gereksiz/türetilmiş) dizinler — kaynak anlamak için gerekmez, kopyayı küçük tutar. */
const EXCLUDED = new Set([
  "node_modules", ".mycl", "dist", "build", "out", ".next", ".cache", ".turbo",
  "coverage", ".DS_Store", ".venv", "venv", "__pycache__", "target",
]);

/** Ev-DIŞI, erişilebilir, kalıcı "MyCL Projeler" kök dizini (platforma göre). */
export function myclProjelerDir(): string {
  const p = osPlatform();
  if (p === "darwin") return "/Users/Shared/MyCL Projeler";
  if (p === "linux") return "/var/tmp/MyCL Projeler";
  return join(tmpdir(), "MyCL Projeler");
}

/** Bir yol "MyCL Projeler" altında mı? Sonsuz kopya-döngüsünü önlemek için (kopyanın kopyası alınmasın). */
export function isUnderMyclProjeler(root: string): boolean {
  const base = myclProjelerDir();
  return root === base || root.startsWith(`${base}/`);
}

/** Yol ev (~) altında mı? (Bilgi/teşhis amaçlı.) */
export function isUnderHome(root: string): boolean {
  const home = homedir();
  return root === home || root.startsWith(`${home}/`);
}

/** Kaynak yolunun kopya kimliği (klasör adının sonundaki 8 karakterlik parça). SAF. */
export function copyHashFor(srcRoot: string): string {
  return createHash("sha1").update(srcRoot.replace(/\/+$/, "")).digest("hex").slice(0, 8);
}

/**
 * Bir kaynağın N. kuşak kopya YOLU (SAF). 1. kuşak `<ad>-<hash>` (mevcut şema — geriye uyum),
 * sonrakiler `<ad>-<hash>-r2`, `-r3`… YZLLM 2026-08-04: "sıfırdan entegrasyon başlatırsam yeni id ile
 * yeni kopya oluştursun." Sıralı ek bilinçli tercih: zaman damgası deterministik olmadığı için test
 * edilemez ve klasör adından "kaçıncı deneme" okunamazdı. Hash ortak kaldığı için soy bağı korunur.
 */
export function copyPathForGeneration(srcRoot: string, generation: number, baseDir?: string): string {
  const src = srcRoot.replace(/\/+$/, "");
  const name = basename(src) || "proje";
  const suffix = generation <= 1 ? "" : `-r${generation}`;
  return join(baseDir ?? myclProjelerDir(), `${name}-${copyHashFor(src)}${suffix}`);
}

/** Bir kaynağın VARSAYILAN (1. kuşak) kopya yolu — bugünkü `copyProjectToAccessible` hedefi. SAF. */
export function plannedCopyPath(srcRoot: string, baseDir?: string): string {
  return copyPathForGeneration(srcRoot, 1, baseDir);
}

/** Kopya klasör adını parçalarına ayırır (SAF). Uymuyorsa null. */
export function parseCopyDirName(
  dirName: string,
): { base: string; hash: string; generation: number } | null {
  const m = /^(.*)-([0-9a-f]{8})(?:-r(\d+))?$/.exec(dirName);
  if (!m) return null;
  const [, base, hash, gen] = m;
  const generation = gen ? Number(gen) : 1;
  if (!base || !hash || !Number.isFinite(generation) || generation < 1) return null;
  return { base, hash, generation };
}

/**
 * Projeyi ev-DIŞI erişilebilir konuma kopyalar; HEDEF yolu döner. ORİJİNAL DOKUNULMAZ.
 *  - Hedef ZATEN VARSA (önceki kopya, kullanıcı orada geliştirmiş olabilir) → RE-COPY ETMEZ (işini ezmesin);
 *    sadece mevcut kopyanın yolunu döner.
 *  - Yoksa: node_modules/.mycl/build vb. HARİÇ özyinelemeli kopyalar (kaynak + .git korunur → git-arka-plan çalışır).
 * Fail → throw (çağıran no-access escalate'e düşer; sessiz değil).
 */
export async function copyProjectToAccessible(
  srcRoot: string,
  opts?: { fresh?: boolean; baseDir?: string },
): Promise<string> {
  const baseDir = opts?.baseDir ?? myclProjelerDir();
  const src = srcRoot.replace(/\/+$/, "");
  // Hedef adını KAYNAK YOLUNUN hash'iyle benzersizle (mahkeme medium): aynı klasör-adlı farklı projeler
  // (ör. ~/dev/app + ~/work/app) ÇAKIŞMAZ — aksi halde "hedef var → re-copy yok" yanlış kopyayı açardı.
  let dest = plannedCopyPath(src, baseDir);

  // GİZLİLİK (mahkeme HIGH): baseDir SADECE sahibi okusun (0o700). /Users/Shared world-readable + umask 0022 →
  // mkdir 755 yapardı → kopyadaki .env/.git/secret TÜM yerel kullanıcılara açılırdı. mode + chmod (mevcut için).
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
  await fs.chmod(baseDir, 0o700).catch(() => { /* mevcut gevşek izin → sıkılaştırılamadıysa best-effort */ });

  let generation = 1;
  let previousCopy: string | undefined;
  if (opts?.fresh) {
    // SIFIRDAN ENTEGRASYON (YZLLM 2026-08-04): kullanıcı açıkça yeni bir başlangıç istedi → mevcut kopyayı
    // KULLANMA, yeni kuşak aç. Eski kopya SİLİNMEZ (kullanıcı verisi). Kuşak taraması + mkdir ile ATOMİK
    // iddia: iki pencere aynı anda "sıfırdan" derse EEXIST'te kuşak artar, üst üste yazma olmaz.
    for (let gen = 1; gen <= 99; gen++) {
      const candidate = copyPathForGeneration(src, gen, baseDir);
      try {
        await fs.mkdir(candidate, { recursive: false });
        dest = candidate;
        generation = gen;
        if (gen > 1) previousCopy = copyPathForGeneration(src, gen - 1, baseDir);
        break;
      } catch {
        if (gen === 99) throw new Error(`Bu proje için yeni kopya açılamadı (99 kuşak dolu): ${baseDir}`);
      }
    }
  } else {
    // Hedef zaten var mı? Varsa RE-COPY ETME (kullanıcının kopyadaki işini koru) → mevcut yolu dön. (hash sayesinde
    // bu yalnız AYNI kaynak yeniden açılınca olur — yanlış-proje çakışması yok.)
    try {
      await fs.access(dest);
      log.info("copy-to-accessible", "hedef zaten var — re-copy YOK (kullanıcı işi korunur)", { dest });
      return dest;
    } catch {
      // yok → kopyala
    }
  }

  await fs.cp(src, dest, {
    recursive: true,
    errorOnExist: false,
    filter: (p) => !EXCLUDED.has(basename(p)),
  });
  // Kopyanın bağlamı: orijinal yolu işaretle → runOnboarding "bu okunamayan bir projenin kopyası" diyebilsin (UX;
  // re-open'da chat sıfırlandığı için pre-reopen mesajları kaybolur — bu işaret KALICI bağlam verir).
  await fs.mkdir(join(dest, ".mycl"), { recursive: true }).catch(() => {});
  await fs
    .writeFile(
      join(dest, ".mycl", "copied-from.json"),
      // `generation`/`previous_copy`/`fresh_start` GERİYE UYUMLU eklendi: mevcut okuyucu yalnız `origin`
      // alanına bakıyor, eski dosyalarda bu alanlar yok → iki yön de sorunsuz.
      JSON.stringify(
        {
          origin: src,
          at: Date.now(),
          generation,
          ...(previousCopy ? { previous_copy: previousCopy } : {}),
          ...(opts?.fresh ? { fresh_start: true } : {}),
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    )
    .catch(() => {});
  log.info("copy-to-accessible", "proje erişilebilir konuma kopyalandı", {
    srcRoot: src,
    dest,
    generation,
    fresh: !!opts?.fresh,
  });
  return dest;
}
