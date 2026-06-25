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

/**
 * Projeyi ev-DIŞI erişilebilir konuma kopyalar; HEDEF yolu döner. ORİJİNAL DOKUNULMAZ.
 *  - Hedef ZATEN VARSA (önceki kopya, kullanıcı orada geliştirmiş olabilir) → RE-COPY ETMEZ (işini ezmesin);
 *    sadece mevcut kopyanın yolunu döner.
 *  - Yoksa: node_modules/.mycl/build vb. HARİÇ özyinelemeli kopyalar (kaynak + .git korunur → git-arka-plan çalışır).
 * Fail → throw (çağıran no-access escalate'e düşer; sessiz değil).
 */
export async function copyProjectToAccessible(srcRoot: string): Promise<string> {
  const baseDir = myclProjelerDir();
  const src = srcRoot.replace(/\/+$/, "");
  const name = basename(src) || "proje";
  // Hedef adını KAYNAK YOLUNUN hash'iyle benzersizle (mahkeme medium): aynı klasör-adlı farklı projeler
  // (ör. ~/dev/app + ~/work/app) ÇAKIŞMAZ — aksi halde "hedef var → re-copy yok" yanlış kopyayı açardı.
  const hash = createHash("sha1").update(src).digest("hex").slice(0, 8);
  const dest = join(baseDir, `${name}-${hash}`);

  // GİZLİLİK (mahkeme HIGH): baseDir SADECE sahibi okusun (0o700). /Users/Shared world-readable + umask 0022 →
  // mkdir 755 yapardı → kopyadaki .env/.git/secret TÜM yerel kullanıcılara açılırdı. mode + chmod (mevcut için).
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
  await fs.chmod(baseDir, 0o700).catch(() => { /* mevcut gevşek izin → sıkılaştırılamadıysa best-effort */ });

  // Hedef zaten var mı? Varsa RE-COPY ETME (kullanıcının kopyadaki işini koru) → mevcut yolu dön. (hash sayesinde
  // bu yalnız AYNI kaynak yeniden açılınca olur — yanlış-proje çakışması yok.)
  try {
    await fs.access(dest);
    log.info("copy-to-accessible", "hedef zaten var — re-copy YOK (kullanıcı işi korunur)", { dest });
    return dest;
  } catch {
    // yok → kopyala
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
      JSON.stringify({ origin: src, at: Date.now() }, null, 2) + "\n",
      "utf-8",
    )
    .catch(() => {});
  log.info("copy-to-accessible", "proje erişilebilir konuma kopyalandı", { srcRoot: src, dest });
  return dest;
}
