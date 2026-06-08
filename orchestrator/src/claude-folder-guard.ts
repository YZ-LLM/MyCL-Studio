// claude-folder-guard — macOS: spawn ettiğimiz `claude`'un başlangıç klasör-taramasını
// (Downloads/Documents/Desktop/Music/Pictures/Movies) bir OS sandbox'ıyla engelle → bu klasör
// okuması syscall'da düşer, TCC sorulmadan → macOS izin penceresi ("İndirilenler'e erişmek
// istiyor") ÇIKMAZ. claude bu klasörlere MyCL işi için erişmez; geri kalan her şey (~/.claude
// auth, proje, ağ, /tmp) açık (`allow default`).
//
// YALNIZ read-only claude çağrılarında kullanılır (Bash tool'u OLMAYAN). Bash-kullanan çağrıyı
// sarmak, claude'un kendi iç Bash-sandbox'ıyla nesting çakışması yaratabilir → onlar sarılmaz
// (cli-run usesBash auto-tespiti). Çapraz-platform: yalnız darwin; Linux/diğer → no-op (TCC yok).

import { homedir } from "node:os";

/** TCC penceresi çıkaran korumalı kullanıcı klasörleri (claude'un MyCL işi için ihtiyacı yok). */
const GUARDED_DIRS = [
  "Downloads",
  "Documents",
  "Desktop",
  "Music",
  "Pictures",
  "Movies",
] as const;

/** Seatbelt profili: her şeye izin ver, korumalı kullanıcı klasörlerini OKUMAYI reddet. */
export function buildSeatbeltProfile(home: string): string {
  const denies = GUARDED_DIRS.map((d) => `(subpath "${home}/${d}")`).join(" ");
  return `(version 1)\n(allow default)\n(deny file-read* ${denies})`;
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
