// agent-sandbox — main-ajan `claude` alt-süreçlerini açık proje + alt klasörlerine
// hapsetme (güvenlik). Kullanıcı kuralı: "ajan YALNIZ proje + alt klasörlerine
// erişir, başka hiçbir yere değil."
//
// Mekanizma: Claude Code YERLİ sandbox'ı (`--settings`), macOS Seatbelt / Linux
// bubblewrap → çekirdek-zorlamalı:
//   - YAZMA + BASH: cwd/--add-dir (proje) dışına otomatik HAPSEDİLİR (sandbox.enabled).
//   - OKUMA: yerli sandbox'ta read-allowlist anahtarı YOK → home'da runtime + proje
//     DIŞINDA her girdi `denyRead`'e konur (kullanıcı seçimi: katı).
// Runtime (binary/~/.claude/node/Library/tmp) sandbox tarafından otomatik izinli;
// RUNTIME_ALLOW dışındaki home girdileri reddedilir. (canlı `claude -p` ile doğrulandı.)

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SandboxPolicy = "enforce" | "warn" | "off";

// claude/node/sistem RUNTIME — denyRead'e KONULMAZ (yoksa claude kırılır).
// `Library`: claude/node ~/Library/Caches + Application Support kullanır + keychain
// (securityd). Asıl korunan kullanıcı verisi (Music/Pictures/Documents/Desktop/
// Downloads) top-level dizinlerdir → bunlar denylenir. Canlı testte ayarlanır.
const RUNTIME_ALLOW = new Set<string>([
  ".claude",
  ".claude.json",
  ".local",
  "Library",
  ".cache",
  ".npm",
  ".nvm",
  ".bun",
  ".asdf",
]);

let _policy: SandboxPolicy = "enforce";
export function setSandboxPolicy(p: SandboxPolicy): void {
  _policy = p;
}
export function getSandboxPolicy(): SandboxPolicy {
  return _policy;
}

export interface SandboxBuildResult {
  settings: Record<string, unknown>;
  /** denyRead girdisi sayısı (test + log). */
  denyCount: number;
}

/**
 * Saf: home top-level girdilerinden (RUNTIME_ALLOW + proje HARİÇ) denyRead listesi
 * + Claude Code `--settings` nesnesi üret. policy="off" → yalnız ultracode (sandbox yok).
 * Test edilebilir: home/homeEntries/platform enjekte edilir.
 */
export function buildAgentSandboxSettings(params: {
  projectRoot: string;
  ultracode: boolean;
  policy: SandboxPolicy;
  home: string;
  homeEntries: string[];
}): SandboxBuildResult {
  const { projectRoot, ultracode, policy, home, homeEntries } = params;
  const base: Record<string, unknown> = ultracode ? { ultracode: true } : {};
  if (policy === "off") return { settings: base, denyCount: 0 };

  const denyRead: string[] = [];
  for (const name of homeEntries) {
    if (RUNTIME_ALLOW.has(name)) continue;
    const entry = join(home, name);
    // Proje bu girdiyse veya bu girdinin ALTINDAYSA → DENYLEME (proje okunur kalır).
    if (projectRoot === entry || projectRoot.startsWith(`${entry}/`)) continue;
    denyRead.push(entry, `${entry}/**`);
  }
  const settings: Record<string, unknown> = {
    ...base,
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false, // bash kaçış kapısı kapalı
      failIfUnavailable: policy === "enforce", // sandbox kurulamazsa claude fail-closed
      filesystem: { denyRead },
    },
    // Defense-in-depth: Read tool'unu da (prompt katmanı) reddet — `//abs` mutlak yol.
    permissions: { deny: denyRead.map((d) => `Read(/${d})`) },
  };
  return { settings, denyCount: denyRead.length };
}

/**
 * İmpure: home'u oku → settings üret → `["--settings", json]`. policy modülden.
 * 3 buildArgs (cli-run / cli-session / codegen) bunu çağırır (eski --settings{ultracode}
 * dalı yerine). policy="off" → eski davranış (yalnız ultracode).
 */
export function sandboxSettingsArgs(projectRoot: string, ultracode: boolean): string[] {
  if (_policy === "off") {
    return ultracode ? ["--settings", JSON.stringify({ ultracode: true })] : [];
  }
  const home = homedir();
  let homeEntries: string[] = [];
  try {
    homeEntries = readdirSync(home);
  } catch {
    // home okunamadı → denyRead boş; sandbox.enabled yine yazma+bash hapsi sağlar.
  }
  const { settings } = buildAgentSandboxSettings({
    projectRoot,
    ultracode,
    policy: _policy,
    home,
    homeEntries,
  });
  return ["--settings", JSON.stringify(settings)];
}
