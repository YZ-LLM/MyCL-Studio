// paths — Platform-aware global config/data directory resolution.
//
// v15.8 (2026-05-30): Cross-platform Stage. Önceden `~/.mycl` her yerde
// `join(homedir(), ".mycl")` ile hardcode'du. `homedir()` zaten cross-platform
// ama `~/.mycl` Windows/Linux'ta idiomatik değil (Windows kullanıcısı
// %APPDATA%, Linux XDG bekler). Bu modül tek otorite:
//
//   - macOS: ~/.mycl (DEĞİŞMEZ — mevcut kullanıcıların config/secrets'ı korunur)
//   - Windows: %APPDATA%\MyCL
//   - Linux/diğer: $XDG_CONFIG_HOME/mycl yoksa ~/.config/mycl
//   - MYCL_HOME env override hepsinin önünde
//   - Migration guard: eski ~/.mycl mevcutsa (herhangi platform) onu kullan —
//     önceki homedir()-tabanlı kurulumları orphan etme.
//
// resolveConfigDir() PURE — fs/process'e dokunmaz, parametrelerle çalışır →
// platform branch'leri host'tan bağımsız unit-test edilebilir. globalConfigDir()
// gerçek process/fs ile wrap eder.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { win32 as pathWin32, posix as pathPosix } from "node:path";

export interface ResolveConfigDirParams {
  platform: NodeJS.Platform;
  env: {
    MYCL_HOME?: string;
    APPDATA?: string;
    XDG_CONFIG_HOME?: string;
  };
  /** homedir() çıktısı — caller'dan enjekte (test için). */
  home: string;
  /** `<home>/.mycl` legacy dizini mevcut mu (migration guard). */
  legacyExists: boolean;
}

/**
 * Global config dizinini saf (side-effect'siz) çöz. Platform param'a göre
 * `path.win32` veya `path.posix` kullanır → host platform'dan bağımsız,
 * deterministik (mac'te bile win32 branch'i doğru üretir).
 */
export function resolveConfigDir(params: ResolveConfigDirParams): string {
  const { platform, env, home, legacyExists } = params;
  const p = platform === "win32" ? pathWin32 : pathPosix;

  // 1. Açık override — her şeyin önünde.
  if (env.MYCL_HOME && env.MYCL_HOME.trim().length > 0) {
    return env.MYCL_HOME;
  }

  // 2. Migration guard — eski ~/.mycl varsa onu kullan (orphan etme).
  if (legacyExists) {
    return p.join(home, ".mycl");
  }

  // 3. Platform varsayılanı (fresh kurulum).
  if (platform === "darwin") {
    return p.join(home, ".mycl");
  }
  if (platform === "win32") {
    return env.APPDATA && env.APPDATA.trim().length > 0
      ? p.join(env.APPDATA, "MyCL")
      : p.join(home, ".mycl");
  }
  // linux + diğer POSIX
  return env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim().length > 0
    ? p.join(env.XDG_CONFIG_HOME, "mycl")
    : p.join(home, ".config", "mycl");
}

/**
 * Gerçek process/fs ile global config dizini. Tüm modüller (config.ts,
 * logger.ts, agent-memory/store.ts, index.ts) bunu kullanır.
 */
export function globalConfigDir(): string {
  const home = homedir();
  const legacy = pathPosix.join(home, ".mycl");
  // Windows'ta legacy check için win32 join — ama existsSync her iki ayraçla
  // da çalışır; basitlik için platforma uygun join.
  const legacyPath =
    process.platform === "win32" ? pathWin32.join(home, ".mycl") : legacy;
  return resolveConfigDir({
    platform: process.platform,
    env: {
      MYCL_HOME: process.env.MYCL_HOME,
      APPDATA: process.env.APPDATA,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    },
    home,
    legacyExists: existsSync(legacyPath),
  });
}

/** Global config dizini altında bir dosya yolu. */
export function globalConfigFile(filename: string): string {
  const p = process.platform === "win32" ? pathWin32 : pathPosix;
  return p.join(globalConfigDir(), filename);
}
