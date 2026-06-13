// claude-folder-guard — macOS: spawn ettiğimiz `claude`'un başlangıç taramasını TCC-korumalı
// konumlardan (kişisel klasörler + DİĞER uygulamaların verisi + Mail/Takvim/iCloud) bir OS
// sandbox'ıyla engelle → bu okumalar syscall'da düşer, TCC sorulmadan → macOS izin pencereleri
// ("İndirilenler'e / diğer uygulamaların verilerine erişmek istiyor" vb.) ÇIKMAZ. claude bunlara
// MyCL işi için erişmez; geri kalan her şey (~/.claude + ~/.claude.json auth, ~/.mycl, proje, ağ,
// /tmp) açık (`allow default`). EMPİRİK doğrulandı: claude bu liste altında auth+cevap veriyor.
//
// YALNIZ read-only claude çağrılarında kullanılır (Bash tool'u OLMAYAN). Bash-kullanan çağrıyı
// sarmak, claude'un kendi iç Bash-sandbox'ıyla nesting çakışması yaratabilir → onlar sarılmaz
// (cli-run usesBash auto-tespiti). Çapraz-platform: yalnız darwin; Linux/diğer → no-op (TCC yok).

import { homedir } from "node:os";

/**
 * TCC penceresi çıkaran korumalı konumlar ($HOME'a göreli; claude'un MyCL işi için ihtiyacı yok).
 * Kişisel klasörler + "diğer uygulamaların verisi" (Containers/Group Containers/Application Support)
 * + Mail/Takvim/iCloud. NOT: ~/.claude + ~/.claude.json (auth) ve ~/.mycl Library ALTINDA DEĞİL → açık kalır.
 */
const GUARDED_DIRS = [
  "Downloads",
  "Documents",
  "Desktop",
  "Music",
  "Pictures",
  "Movies",
  "Library/Containers",
  "Library/Group Containers",
  "Library/Application Support",
  "Library/Mail",
  "Library/Calendars",
  "Library/Mobile Documents",
] as const;

/**
 * Seatbelt profili: her şeye izin ver, AMA (1) korumalı kullanıcı konumlarını OKUMAYI reddet
 * (least-privilege; folder/diğer-uygulama TCC'sini kaynağında keser) VE (2) `tccd`'ye mach-lookup'ı
 * reddet → claude'un in-process framework'leri (Media Library/Apple Music, Photos) izin SORMAK için
 * TCC'ye ulaşamaz → bu framework-tabanlı pencereler de AÇILAMAZ (dosya-deny onları kesemiyordu).
 * claude coding için ne bu konumlara ne tccd'ye ihtiyaç duyar (her ikisi de empirik doğrulandı).
 */
export function buildSeatbeltProfile(home: string): string {
  const denies = GUARDED_DIRS.map((d) => `(subpath "${home}/${d}")`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* ${denies})`,
    // tccd: TCC izin-broker'ı — reddet → framework'ler izin SORMAK için ona ulaşamaz (pencere açılamaz).
    '(deny mach-lookup (global-name-regex #"^com\\.apple\\.tccd"))',
    // Ümit 2026-06-13: "MyCL Studio Apple Music'e/ortam arşivine erişmek istiyor" penceresi sürüyordu —
    // Media Library / Apple Music / Photos framework'leri tccd dışında KENDİ broker daemon'larına da
    // ulaşıp prompt tetikleyebiliyor. claude coding için bunların HİÇBİRİNE ihtiyacı yok (allow-default
    // altında reddetmek güvenli) → medya/foto daemon mach-lookup'larını da kapat ki bu framework-tabanlı
    // pencereler kaynağında ölsün. (medialibraryd/Apple-Music-amp*/mediaremoted/itunescloudd/foto-daemonlar.)
    '(deny mach-lookup (global-name-regex #"^com\\.apple\\.(medialibraryd|amp([d.]|/)|amsengagementd|mediaremoted|itunescloudd|photoanalysisd|cloudphotod|photolibraryd|mediaanalysisd)"))',
  ].join("\n");
}

export interface FolderGuardOpts {
  platform?: NodeJS.Platform;
  /** Varsayılan: env `MYCL_CLAUDE_FOLDER_GUARD !== "0"` (yani açık). "0" → kapat (escape hatch). */
  enabled?: boolean;
  home?: string;
}

/**
 * READ-ONLY claude komutunu klasör-guard'lı `sandbox-exec` ile sarar.
 * darwin + enabled → `{cmd:"sandbox-exec", args:["-p", profile, bin, ...args]}`; aksi → no-op `{cmd:bin, args}`.
 * Saf: yan etkisi yok, sadece komutu dönüştürür.
 */
export function wrapReadOnlyClaude(
  bin: string,
  args: string[],
  opts: FolderGuardOpts = {},
): { cmd: string; args: string[] } {
  const platform = opts.platform ?? process.platform;
  const enabled = opts.enabled ?? process.env.MYCL_CLAUDE_FOLDER_GUARD !== "0";
  if (platform !== "darwin" || !enabled) return { cmd: bin, args };
  const home = opts.home ?? homedir();
  const profile = buildSeatbeltProfile(home);
  // Absolute yol: paketlenmiş .app'te minimal PATH bare "sandbox-exec"i ENOENT yapabilir.
  return { cmd: "/usr/bin/sandbox-exec", args: ["-p", profile, bin, ...args] };
}

/**
 * Bir claude çağrısı klasör-guard ile sarmalanmalı mı? SAF karar.
 * Kural: açık `folderGuard` override'ı verilmişse onu kullan; verilmemişse Bash tool'u YOKSA sar
 * (read-only çağrı — claude'un iç Bash-sandbox'ıyla nesting çakışması yok), Bash VARSA sarma
 * (nesting riski). Bu fonksiyon cli-run içinde gömülüydü ve test edilmiyordu — ayrıştırıldı ki
 * "tool yoksa sar" kararı ağ (check) tarafından korunabilsin.
 */
export function shouldFolderGuard(opts: {
  allowedTools?: string[];
  folderGuard?: boolean;
}): boolean {
  if (opts.folderGuard !== undefined) return opts.folderGuard;
  const usesBash = (opts.allowedTools ?? []).some((t) => /^Bash\b/.test(t));
  return !usesBash;
}
