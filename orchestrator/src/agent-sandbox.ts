// agent-sandbox — main-ajan `claude` alt-süreçlerini açık proje + alt klasörlerine
// hapsetme (güvenlik). Kullanıcı kuralı: "ajan YALNIZ proje + alt klasörlerine
// erişir, başka hiçbir yere değil." + "her zaman çapraz-platform."
//
// Hedef platformlar: macOS + Linux (Windows KAPSAM DIŞI — kullanıcı kararı).
// Mekanizma: Claude Code YERLİ sandbox'ı (`--settings`) — çekirdek-zorlamalı:
//   - macOS: Seatbelt (yerleşik, kurulum yok).
//   - Linux: bubblewrap (`bwrap`) + `socat` (kurulu olmalı).
//   - mac/linux DIŞI platform: DESTEKLENMEZ → enforce'ta spawn-öncesi durdurulur (fail-closed).
// `sandbox.enabled:true` + `allowUnsandboxedCommands:false` → YAZMA+BASH otomatik
// proje-hapsine girer. OKUMA için (yerli sandbox'ta read-allowlist anahtarı YOK)
// home top-level girdileri (runtime + proje HARİÇ) `denyRead` + `permissions.deny`.
//
// İki katmanlı fail-closed: (1) claude'un kendi `failIfUnavailable:true` bayrağı
// sandbox kurulamazsa exit 1 yapar; (2) MyCL spawn-ÖNCESİ `guardSandboxOrWarn` ile
// platform/bağımlılık kontrolü yapıp GÖRÜNÜR Türkçe hata/uyarı verir (sessiz
// fallback yasağı — claude'un teknik çıktısına güvenmeyiz).

import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix as pathPosix } from "node:path";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";

export type SandboxPolicy = "enforce" | "warn" | "off";

// claude/node/sistem RUNTIME — denyRead'e KONULMAZ (yoksa claude kırılır).
// Çapraz-platform: ortak + platforma-özel. Asıl korunan kullanıcı verisi
// (Music/Pictures/Documents/Desktop/Downloads/.ssh/.aws/diğer-projeler) bu
// sette OLMADIĞI için denylenir.
const RUNTIME_ALLOW_COMMON = [
  ".claude", // PRIMARY config (CLAUDE_CONFIG_DIR ?? ~/.claude) — her OS'ta
  ".claude.json", // global config/MCP/auth-state
  ".config", // Linux XDG (~/.config/anthropic SDK + gh/git); mac'te de zararsız
  ".local", // ~/.local/share/claude/versions + ~/.local/bin/claude
  ".cache", // ~/.cache/claude staging + npm/araç cache
  ".npm", // npx/MCP alt-süreç cache
  ".nvm",
  ".bun",
  ".asdf",
];

/** Platforma göre runtime allow-set (denyRead'e konulmayacak home girdileri). */
export function runtimeAllowFor(platform: NodeJS.Platform): Set<string> {
  const s = new Set(RUNTIME_ALLOW_COMMON);
  if (platform === "darwin") s.add("Library"); // Caches/App Support/keychain (securityd)
  // Linux: .config zaten ortak sette. mac/linux dışı: denyRead üretilmez (aşağı).
  return s;
}

let _policy: SandboxPolicy = "enforce";
export function setSandboxPolicy(p: SandboxPolicy): void {
  _policy = p;
}
export function getSandboxPolicy(): SandboxPolicy {
  return _policy;
}

// ───────────────────────── Platform / availability ─────────────────────────

export interface SandboxAvailability {
  available: boolean;
  /** available=false ise neden (Türkçe, kullanıcıya gösterilir). */
  reason?: string;
}

/**
 * SAF: platform + araç varlığı → sandbox kurulabilir mi. Host'tan bağımsız test
 * edilebilir (paths.ts saf-fonksiyon kalıbı). hasBwrap/hasSocat yalnız linux'ta anlamlı.
 */
export function detectSandboxAvailability(params: {
  platform: NodeJS.Platform;
  hasBwrap: boolean;
  hasSocat: boolean;
}): SandboxAvailability {
  const { platform, hasBwrap, hasSocat } = params;
  if (platform === "darwin") return { available: true }; // Seatbelt yerleşik
  if (platform === "linux") {
    if (hasBwrap && hasSocat) return { available: true };
    const missing = [!hasBwrap ? "bubblewrap (bwrap)" : null, !hasSocat ? "socat" : null]
      .filter(Boolean)
      .join(" + ");
    return {
      available: false,
      reason: `${missing} kurulu değil — sandbox başlatılamaz (kur: apt install bubblewrap socat / dnf install bubblewrap socat)`,
    };
  }
  // mac/linux dışı (Windows dahil): Claude Code yerli sandbox'ı çalışmaz → fail-closed.
  return {
    available: false,
    reason: `bu platform (${platform}) desteklenmiyor — sandbox yalnız macOS ve Linux'ta çalışır`,
  };
}

function hasCommand(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let _availabilityCache: SandboxAvailability | undefined;
/** İmpure: process.platform + (linux'ta) bwrap/socat varlığı. Process başına cache'lenir. */
export function sandboxAvailable(): SandboxAvailability {
  if (_availabilityCache) return _availabilityCache;
  const platform = process.platform;
  const linux = platform === "linux";
  _availabilityCache = detectSandboxAvailability({
    platform,
    hasBwrap: linux ? hasCommand("bwrap") : true,
    hasSocat: linux ? hasCommand("socat") : true,
  });
  return _availabilityCache;
}

// ───────────────────────── Spawn-öncesi görünür kapı ─────────────────────────

export interface SandboxGuardDecision {
  /** true → spawn'a devam; false → spawn ETME (enforce + sandbox yok). */
  proceed: boolean;
  /** Kullanıcıya gösterilecek görünür mesaj (sessiz fallback yasağı). */
  message?: { level: "error" | "warning"; text: string };
}

/**
 * SAF: policy + availability → spawn kararı + görünür mesaj.
 *   enforce + yok → proceed:false + error (ajan çalıştırılmaz).
 *   warn    + yok → proceed:true  + warning (hapissiz devam, kullanıcı bilir).
 *   off / available → proceed:true (mesaj yok).
 */
export function sandboxGuard(
  policy: SandboxPolicy,
  availability: SandboxAvailability,
): SandboxGuardDecision {
  if (policy === "off" || availability.available) return { proceed: true };
  if (policy === "enforce") {
    return {
      proceed: false,
      message: {
        level: "error",
        text: `🔒 Sandbox kurulamadı: ${availability.reason}. Politika "enforce" — ajan çalıştırılmadı. (Bağımlılığı kurun ya da ayarlardan agent_sandbox_policy'i "warn"/"off" yapın.)`,
      },
    };
  }
  return {
    proceed: true,
    message: {
      level: "warning",
      text: `⚠️ Sandbox kurulamadı: ${availability.reason}. Ajan dosya/bash HAPSİ OLMADAN çalışıyor (policy="warn").`,
    },
  };
}

let _guardEmitted = false;
/**
 * İmpure spawn-öncesi kapı (3 caller bunu çağırır). Görünür mesajı process başına
 * BİR kez emit eder; her spawn'da kararı döner. false → caller spawn etmemeli.
 */
export function guardSandboxOrWarn(): boolean {
  if (_policy === "off") return true;
  const decision = sandboxGuard(_policy, sandboxAvailable());
  if (decision.message && !_guardEmitted) {
    _guardEmitted = true;
    emitChatMessage(decision.message.level === "error" ? "error" : "system", decision.message.text);
  }
  return decision.proceed;
}

// ───────────────────────── Settings üretimi ─────────────────────────

export interface SandboxBuildResult {
  settings: Record<string, unknown>;
  /** denyRead girdisi sayısı (test + log). */
  denyCount: number;
}

/**
 * SAF: home top-level girdilerinden (runtime + proje HARİÇ) denyRead + Claude Code
 * `--settings` nesnesi üret. platform enjekte edilir (test edilebilir).
 *   - off → yalnız ultracode (sandbox yok).
 *   - win32 → denyRead ÜRETME (Seatbelt/bwrap orada yok, yollar POSIX değil);
 *     sandbox.enabled + failIfUnavailable(=enforce) yine konur (claude exit-1 savunması).
 *   - darwin/linux → POSIX yol mantığı (pathPosix), runtimeAllowFor(platform).
 */
export function buildAgentSandboxSettings(params: {
  projectRoot: string;
  ultracode: boolean;
  policy: SandboxPolicy;
  platform: NodeJS.Platform;
  home: string;
  homeEntries: string[];
}): SandboxBuildResult {
  const { projectRoot, ultracode, policy, platform, home, homeEntries } = params;
  const base: Record<string, unknown> = ultracode ? { ultracode: true } : {};
  if (policy === "off") return { settings: base, denyCount: 0 };

  const failIfUnavailable = policy === "enforce";

  // mac/linux dışı platform: yerli sandbox yok → POSIX-olmayan yollarla anlamsız
  // denyRead üretme. Gerçek fail-closed guardSandboxOrWarn (spawn-öncesi) +
  // claude failIfUnavailable. (Windows kapsam dışı; bu sadece güvenli catch-all.)
  if (platform !== "darwin" && platform !== "linux") {
    return {
      settings: {
        ...base,
        sandbox: { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable },
      },
      denyCount: 0,
    };
  }

  const allow = runtimeAllowFor(platform);
  // İKİ AYRI liste (v15.13, ampirik doğrulama — /tmp testleri):
  //  - denyRead = ÇEKİRDEK sandbox (claude bunu her Bash çağrısında sandbox-exec/bwrap profil
  //    argv'sine çevirir → BÜYÜRSE "spawn E2BIG: argument list too long"). Bu yüzden DARWIN'de
  //    `/**`'i ATLA: Seatbelt subpath semantiği → bir dizini reddetmek İÇERİĞİNİ de reddeder
  //    (V3: dir-only "secret" → "secret/data.txt" engellendi) → `/**` REDUNDANT, atlamak güvenli +
  //    profili ~2x küçültür. Linux (bwrap) subpath semantiği doğrulanmadı → `/**`'i KORU.
  //    DİKKAT: brace-glob `{a,b}` Seatbelt'te GENİŞLEMİYOR (V2: sızdırdı) → glob-compress GÜVENLİ DEĞİL.
  //  - permDeny = prompt-katmanı (defense-in-depth, E2BIG'i ETKİLEMEZ) → her iki formu KORU.
  const denyRead: string[] = [];
  const permDeny: string[] = [];
  for (const name of homeEntries) {
    if (allow.has(name)) continue;
    const entry = pathPosix.join(home, name);
    // Proje bu girdiyse veya ALTINDAYSA → DENYLEME (proje okunur kalır). path.sep
    // ile (hardcoded '/' değil) — POSIX'te '/'; çapraz-platform doğru.
    if (projectRoot === entry || projectRoot.startsWith(entry + pathPosix.sep)) continue;
    if (platform === "darwin") {
      denyRead.push(entry); // subpath → içerik de reddedilir; /** redundant (E2BIG için bırakıldı)
    } else {
      denyRead.push(entry, `${entry}/**`);
    }
    permDeny.push(`Read(/${entry})`, `Read(/${entry}/**)`);
  }
  const settings: Record<string, unknown> = {
    ...base,
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false, // bash kaçış kapısı kapalı
      failIfUnavailable, // sandbox kurulamazsa claude fail-closed (enforce)
      filesystem: { denyRead },
    },
    // Defense-in-depth: Read tool'unu da (prompt katmanı) reddet — `//abs` mutlak yol.
    permissions: { deny: permDeny },
  };
  return { settings, denyCount: denyRead.length };
}

let _readdirWarned = false;
/**
 * İmpure: home'u oku → settings üret → `["--settings", json]`. policy + platform
 * modülden/process'ten. policy="off" → eski davranış (yalnız ultracode).
 * home okunamazsa enforce/warn'da GÖRÜNÜR uyarı (sessiz read-koruma kaybı yasak).
 */
export function sandboxSettingsArgs(projectRoot: string, ultracode: boolean): string[] {
  if (_policy === "off") {
    return ultracode ? ["--settings", JSON.stringify({ ultracode: true })] : [];
  }
  const platform = process.platform;
  const home = homedir();
  let homeEntries: string[] = [];
  let readdirFailed = false;
  if (platform === "darwin" || platform === "linux") {
    try {
      homeEntries = readdirSync(home);
    } catch (err) {
      readdirFailed = true;
      log.warn("agent-sandbox", "home readdir failed — denyRead boş kalacak", { err: String(err) });
    }
  }
  if (readdirFailed && !_readdirWarned) {
    _readdirWarned = true;
    emitChatMessage(
      "error",
      "🔒 Ev dizini okunamadı → ajanın OKUMA koruması (denyRead) üretilemedi. Yazma+bash hapsi sürüyor ama okuma kısıtlaması bu oturumda eksik.",
    );
  }
  const { settings } = buildAgentSandboxSettings({
    projectRoot,
    ultracode,
    policy: _policy,
    platform,
    home,
    homeEntries,
  });
  return ["--settings", JSON.stringify(settings)];
}
