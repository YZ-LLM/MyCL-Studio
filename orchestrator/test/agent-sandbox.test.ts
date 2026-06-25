import { describe, expect, it } from "vitest";
import {
  buildAgentSandboxSettings,
  detectSandboxAvailability,
  runtimeAllowFor,
  sandboxGuard,
} from "../src/agent-sandbox.js";

// Saf fonksiyonlar — platform/home/policy/projectRoot enjekte edilir; host'tan bağımsız (çapraz-platform).
// paths.test.ts kalıbı. IPC yan etkisi yok.
//
// E2BIG KÖK ÇÖZÜMÜ (YZLLM 2026-06-17): home'u TEK kuralla deny + proje/runtime girdilerini `allowRead` ile
// RE-ALLOW (eski: her home girdisini tek tek denyRead → profil argv'si şişer → "spawn E2BIG"). Güvenlik
// NİYETİ AYNI ve burada KANITLANIR: gizli/korunan girdiler (.ssh/.aws/medya/diğer-projeler) allowRead'de
// ASLA olmaz → home-deny altında kalır → ajan okuyamaz (sızma-yok). Yalnız proje + runtime açılır.

const HOME = "/Users/umit";
const LINUX_HOME = "/home/umit";
// Home'da bulunan tipik GİZLİ/korunan girdiler — bunlar allowRead'de ASLA olmamalı (deny home altında kalmalı).
const SECRET_ENTRIES = [
  "Music", "Pictures", "Documents", "Desktop", "Downloads", ".ssh", ".aws", ".gnupg", "other-project",
];

function deny(settings: Record<string, unknown>): string[] {
  return (settings.sandbox as { filesystem?: { denyRead?: string[] } })?.filesystem?.denyRead ?? [];
}
function allow(settings: Record<string, unknown>): string[] {
  return (settings.sandbox as { filesystem?: { allowRead?: string[] } })?.filesystem?.allowRead ?? [];
}

describe("agent-sandbox · detectSandboxAvailability (çapraz-platform)", () => {
  it("darwin → her zaman available (Seatbelt yerleşik)", () => {
    expect(detectSandboxAvailability({ platform: "darwin", hasBwrap: false, hasSocat: false }))
      .toEqual({ available: true });
  });

  it("linux + bwrap & socat var → available", () => {
    expect(detectSandboxAvailability({ platform: "linux", hasBwrap: true, hasSocat: true }))
      .toEqual({ available: true });
  });

  it("linux + bwrap yok → unavailable + reason bwrap içerir", () => {
    const r = detectSandboxAvailability({ platform: "linux", hasBwrap: false, hasSocat: true });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/bwrap/);
  });

  it("linux + socat yok → unavailable + reason socat içerir", () => {
    const r = detectSandboxAvailability({ platform: "linux", hasBwrap: true, hasSocat: false });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/socat/);
  });

  it("mac/linux dışı (örn. win32) → unavailable + 'desteklenmiyor' (fail-closed catch-all)", () => {
    const r = detectSandboxAvailability({ platform: "win32", hasBwrap: true, hasSocat: true });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/desteklenmiyor|macOS|Linux/);
  });
});

describe("agent-sandbox · sandboxGuard (görünür fail-closed)", () => {
  const unavailable = { available: false, reason: "test sebebi" };

  it("off → proceed, mesaj yok", () => {
    expect(sandboxGuard("off", unavailable)).toEqual({ proceed: true });
  });

  it("available → proceed, mesaj yok (policy farketmez)", () => {
    expect(sandboxGuard("enforce", { available: true })).toEqual({ proceed: true });
    expect(sandboxGuard("warn", { available: true })).toEqual({ proceed: true });
  });

  it("enforce + unavailable → proceed:false + error mesajı", () => {
    const d = sandboxGuard("enforce", unavailable);
    expect(d.proceed).toBe(false);
    expect(d.message?.level).toBe("error");
    expect(d.message?.text).toMatch(/test sebebi/);
  });

  it("warn + unavailable → proceed:true + warning mesajı (hapissiz devam)", () => {
    const d = sandboxGuard("warn", unavailable);
    expect(d.proceed).toBe(true);
    expect(d.message?.level).toBe("warning");
    expect(d.message?.text).toMatch(/HAPSİ OLMADAN|hapsi olmadan/i);
  });
});

describe("agent-sandbox · runtimeAllowFor (platform-aware)", () => {
  it("darwin → Library + .config dahil", () => {
    const s = runtimeAllowFor("darwin");
    expect(s.has("Library")).toBe(true);
    expect(s.has(".config")).toBe(true);
    expect(s.has(".claude")).toBe(true);
  });

  it("linux → .config dahil, Library YOK", () => {
    const s = runtimeAllowFor("linux");
    expect(s.has(".config")).toBe(true);
    expect(s.has("Library")).toBe(false);
  });
});

describe("agent-sandbox · buildAgentSandboxSettings · macOS home-deny + allowRead (E2BIG kök)", () => {
  const PROJ = "/tmp/mycl-validate/shop";
  const { settings, denyCount } = buildAgentSandboxSettings({
    projectRoot: PROJ,
    ultracode: false,
    policy: "enforce",
    platform: "darwin",
    home: HOME,
  });
  const denyRead = deny(settings);
  const allowRead = allow(settings);

  it("denyRead = TEK home kuralı (darwin dir-only — subpath içeriği kapsar, /** redundant=E2BIG için atlanır)", () => {
    expect(denyRead).toEqual([HOME]);
  });

  it("denyCount = 1 (argv küçük kalır → 'spawn E2BIG' biter)", () => {
    expect(denyCount).toBe(1);
  });

  it("proje allowRead'de → deny home'dan RE-ALLOW (ajan kodu okuyabilir)", () => {
    expect(allowRead).toContain(PROJ);
  });

  it("runtime girdileri allowRead'de (.claude/.claude.json/.config/.cache/.npm/Library)", () => {
    for (const rt of [".claude", ".claude.json", ".config", ".cache", ".npm", "Library"]) {
      expect(allowRead).toContain(`${HOME}/${rt}`);
    }
  });

  it("GÜVENLİK — gizli/korunan girdiler allowRead'de DEĞİL → home-deny altında kalır → okunamaz (sızma-yok)", () => {
    for (const s of SECRET_ENTRIES) {
      expect(allowRead).not.toContain(`${HOME}/${s}`);
      expect(allowRead).not.toContain(`${HOME}/${s}/**`);
    }
  });

  it("permissions: home Read-deny + proje/runtime Read-allow; .git/.mycl write-deny korunur", () => {
    const permDeny = (settings.permissions as { deny: string[] }).deny;
    const permAllow = (settings.permissions as { allow: string[] }).allow;
    expect(permDeny).toContain(`Read(/${HOME})`);
    expect(permDeny).toContain(`Read(/${HOME}/**)`);
    expect(permAllow).toContain(`Read(${PROJ}/**)`);
    expect(permAllow).toContain(`Read(${HOME}/.claude/**)`);
    // GÜVENLİK paritesi: gizli girdiler prompt-katmanında da allow EDİLMEZ.
    expect(permAllow).not.toContain(`Read(${HOME}/.ssh/**)`);
    expect(permDeny).toContain("Write(/tmp/mycl-validate/shop/.git/**)");
    expect(permDeny).toContain("Write(/tmp/mycl-validate/shop/.mycl/**)");
    const denyWrite = (settings.sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite;
    expect(denyWrite).toEqual([`${PROJ}/.git`, `${PROJ}/.git/**`, `${PROJ}/.mycl`, `${PROJ}/.mycl/**`]);
  });

  it("ağ: güvenilir paket registry'leri allowedDomains'te (npm install için; ağ default deny-all, keyfi domain hariç)", () => {
    const domains = (settings.sandbox as { allowedDomains?: string[] }).allowedDomains ?? [];
    expect(domains).toContain("registry.npmjs.org");
    expect(domains).toContain("registry.yarnpkg.com");
    expect(domains).not.toContain("*"); // wildcard YOK — whitelist disiplini (keyfi domain deny kalır)
  });

  it("npm/araç cache YAZMA: allowWrite ~/.npm + ~/.cache içerir; auth (.claude/.config) write-DEĞİL", () => {
    const aw = (settings.sandbox as { filesystem: { allowWrite?: string[] } }).filesystem.allowWrite ?? [];
    expect(aw).toContain(`${HOME}/.npm`);
    expect(aw).toContain(`${HOME}/.cache`);
    expect(aw).not.toContain(`${HOME}/.claude`); // auth → write-deny KALIR (ajan auth değiştiremez)
    expect(aw).not.toContain(`${HOME}/.config`);
  });
});

describe("agent-sandbox · buildAgentSandboxSettings · Linux home-deny + allowRead", () => {
  const PROJ = "/srv/app";
  const { settings, denyCount } = buildAgentSandboxSettings({
    projectRoot: PROJ,
    ultracode: false,
    policy: "enforce",
    platform: "linux",
    home: LINUX_HOME,
  });
  const denyRead = deny(settings);
  const allowRead = allow(settings);

  it("linux denyRead = [home, home/**] (bwrap subpath semantiği doğrulanmadı → /** KORUNUR)", () => {
    expect(denyRead).toEqual([LINUX_HOME, `${LINUX_HOME}/**`]);
  });

  it("linux denyCount = 2", () => {
    expect(denyCount).toBe(2);
  });

  it("linux: proje + runtime iki formda allowRead'de; .config dahil, Library YOK (darwin-only)", () => {
    expect(allowRead).toContain(PROJ);
    expect(allowRead).toContain(`${PROJ}/**`);
    expect(allowRead).toContain(`${LINUX_HOME}/.config`);
    expect(allowRead).toContain(`${LINUX_HOME}/.config/**`);
    expect(allowRead).not.toContain(`${LINUX_HOME}/Library`);
  });

  it("linux GÜVENLİK: .ssh/Music allowRead'de değil", () => {
    expect(allowRead).not.toContain(`${LINUX_HOME}/.ssh`);
    expect(allowRead).not.toContain(`${LINUX_HOME}/Music`);
  });
});

describe("agent-sandbox · proje home'un ALTINDA olsa bile allowRead ile re-allow", () => {
  it("derin alt-yol (Documents/work/app): proje allowRead'de ama Documents'in KENDİSİ değil (gerisi kapalı)", () => {
    const PROJ = `${HOME}/Documents/work/app`;
    const { settings } = buildAgentSandboxSettings({
      projectRoot: PROJ, ultracode: false, policy: "enforce", platform: "darwin", home: HOME,
    });
    const allowRead = allow(settings);
    expect(allowRead).toContain(PROJ); // proje yolu açık
    expect(allowRead).not.toContain(`${HOME}/Documents`); // Documents kökü açılmaz → gerisi deny
    expect(deny(settings)).toEqual([HOME]); // home tek-deny değişmez
  });

  // YZLLM cave5: ev-altı projede PROMPT-katmanı broad Read(~/**) deny'i, deny>allow ile projeyi de keser →
  // ajan okuyamaz (/tmp çalışır, ~/proje çalışmaz). Fix: ev-altı projede `~/**` PROMPT-deny'i EKLENMEZ.
  it("EV-ALTI proje (~/cave5): prompt-katmanı Read(~/**) deny'i EKLENMEZ; proje okunur, kernel ev'i korur", () => {
    const PROJ = `${HOME}/cave5`;
    const { settings } = buildAgentSandboxSettings({
      projectRoot: PROJ, ultracode: false, policy: "enforce", platform: "darwin", home: HOME,
    });
    const permDeny = (settings.permissions as { deny: string[] }).deny;
    const permAllow = (settings.permissions as { allow: string[] }).allow;
    expect(permDeny).not.toContain(`Read(/${HOME}/**)`); // broad ~/** prompt-deny YOK (projeyi kesmesin)
    expect(permDeny).toContain(`Read(/${HOME})`); // home dizini listesi yine reddedilir
    expect(permAllow).toContain(`Read(${PROJ}/**)`); // proje okuma izni var
    expect(deny(settings)).toEqual([HOME]); // çekirdek katman ev'i hâlâ korur (tek-deny)
    expect(allow(settings)).toContain(PROJ); // çekirdek katman projeyi re-allow eder
  });

  it("ev-DIŞI proje (/tmp/...): broad Read(~/**) prompt-deny KORUNUR (regresyon yok)", () => {
    const { settings } = buildAgentSandboxSettings({
      projectRoot: "/tmp/mycl-x/app", ultracode: false, policy: "enforce", platform: "darwin", home: HOME,
    });
    const permDeny = (settings.permissions as { deny: string[] }).deny;
    expect(permDeny).toContain(`Read(/${HOME})`);
    expect(permDeny).toContain(`Read(/${HOME}/**)`); // ev-dışı projede broad deny korunur
  });
});

describe("agent-sandbox · buildAgentSandboxSettings · mac/linux dışı (örn. win32, sandbox yok)", () => {
  const { settings, denyCount } = buildAgentSandboxSettings({
    projectRoot: "C:\\Users\\umit\\proj",
    ultracode: false,
    policy: "enforce",
    platform: "win32",
    home: "C:\\Users\\umit",
  });

  it("win32 → denyRead ÜRETME (POSIX-olmayan yol bug'ına girme)", () => {
    expect(denyCount).toBe(0);
    expect("filesystem" in (settings.sandbox as object)).toBe(false);
    expect("permissions" in settings).toBe(false);
  });

  it("win32 → sandbox.enabled + failIfUnavailable korunur (claude exit-1 savunması)", () => {
    const sb = settings.sandbox as { enabled: boolean; failIfUnavailable: boolean };
    expect(sb.enabled).toBe(true);
    expect(sb.failIfUnavailable).toBe(true); // enforce
  });
});

describe("agent-sandbox · ultracode merge + policy modları", () => {
  it("ultracode=true → settings.ultracode:true", () => {
    const { settings } = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: true, policy: "enforce", platform: "darwin", home: HOME,
    });
    expect(settings.ultracode).toBe(true);
  });

  it("ultracode=false → ultracode anahtarı YOK", () => {
    const { settings } = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "enforce", platform: "darwin", home: HOME,
    });
    expect("ultracode" in settings).toBe(false);
  });

  it("enforce → failIfUnavailable:true; warn → false; allowUnsandboxedCommands:false", () => {
    const e = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "enforce", platform: "darwin", home: HOME,
    });
    const w = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "warn", platform: "darwin", home: HOME,
    });
    expect((e.settings.sandbox as { failIfUnavailable: boolean }).failIfUnavailable).toBe(true);
    expect((w.settings.sandbox as { failIfUnavailable: boolean }).failIfUnavailable).toBe(false);
    expect((e.settings.sandbox as { allowUnsandboxedCommands: boolean }).allowUnsandboxedCommands).toBe(false);
  });

  it("off → sandbox YOK; ultracode korunur / boş", () => {
    const off = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: true, policy: "off", platform: "darwin", home: HOME,
    });
    expect(off.denyCount).toBe(0);
    expect("sandbox" in off.settings).toBe(false);
    expect(off.settings.ultracode).toBe(true);

    const offNoUltra = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "off", platform: "darwin", home: HOME,
    });
    expect(offNoUltra.settings).toEqual({});
  });
});
