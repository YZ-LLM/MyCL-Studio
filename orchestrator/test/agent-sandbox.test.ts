import { describe, expect, it } from "vitest";
import {
  buildAgentSandboxSettings,
  detectSandboxAvailability,
  runtimeAllowFor,
  sandboxGuard,
} from "../src/agent-sandbox.js";

// Saf fonksiyonlar — platform/home/homeEntries/policy enjekte edilir; host'tan
// bağımsız (çapraz-platform). paths.test.ts kalıbı. IPC yan etkisi yok.

const HOME = "/Users/umit";
const LINUX_HOME = "/home/umit";
// Tipik macOS home: korunan veri + runtime + projeler karışık.
const MAC_ENTRIES = [
  "Music", "Pictures", "Documents", "Desktop", "Downloads",
  ".ssh", ".aws", "adminpanel", "other-project",
  ".claude", ".claude.json", "Library", ".cache", ".npm", ".nvm", ".config",
];
const LINUX_ENTRIES = [
  "Music", "Pictures", "Documents", "Downloads",
  ".ssh", "myproject",
  ".claude", ".claude.json", ".config", ".cache", ".npm", ".local",
];

function deny(settings: Record<string, unknown>): string[] {
  return (settings.sandbox as { filesystem?: { denyRead?: string[] } })?.filesystem?.denyRead ?? [];
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

describe("agent-sandbox · buildAgentSandboxSettings · macOS denyRead", () => {
  const { settings, denyCount } = buildAgentSandboxSettings({
    projectRoot: "/tmp/mycl-validate/shop",
    ultracode: false,
    policy: "enforce",
    platform: "darwin",
    home: HOME,
    homeEntries: MAC_ENTRIES,
  });
  const denyRead = deny(settings);

  it("korunan veriyi reddeder; darwin DIR-ONLY (subpath → içerik kapsanır, /** redundant=E2BIG için atlanır)", () => {
    const permDeny = (settings.permissions as { deny?: string[] })?.deny ?? [];
    for (const name of ["Music", "Pictures", "Documents", "Desktop", "Downloads", ".ssh", ".aws"]) {
      expect(denyRead).toContain(`${HOME}/${name}`);
      // darwin: /** REDUNDANT (Seatbelt subpath semantiği — V3 ampirik) → çekirdek denyRead'den çıkarıldı.
      expect(denyRead).not.toContain(`${HOME}/${name}/**`);
      // Prompt-katmanı (defense-in-depth, E2BIG'i etkilemez) HER İKİ formu korur.
      expect(permDeny).toContain(`Read(/${HOME}/${name})`);
      expect(permDeny).toContain(`Read(/${HOME}/${name}/**)`);
    }
  });

  it("diğer kullanıcı projelerini de reddeder", () => {
    expect(denyRead).toContain(`${HOME}/adminpanel`);
    expect(denyRead).toContain(`${HOME}/other-project`);
  });

  it("runtime girdilerini ASLA reddetmez (.config + Library dahil)", () => {
    for (const rt of [".claude", ".claude.json", "Library", ".cache", ".npm", ".nvm", ".config"]) {
      expect(denyRead).not.toContain(`${HOME}/${rt}`);
    }
  });

  it("denyCount = reddedilen girdi (9: 5 medya + .ssh + .aws + 2 proje) — darwin dir-only, /** yok", () => {
    expect(denyCount).toBe(9);
  });
});

describe("agent-sandbox · buildAgentSandboxSettings · Linux", () => {
  it(".config Linux'ta runtime → reddedilmez; Music reddedilir", () => {
    const { settings } = buildAgentSandboxSettings({
      projectRoot: "/srv/app",
      ultracode: false,
      policy: "enforce",
      platform: "linux",
      home: LINUX_HOME,
      homeEntries: LINUX_ENTRIES,
    });
    const denyRead = deny(settings);
    expect(denyRead).not.toContain(`${LINUX_HOME}/.config`);
    expect(denyRead).toContain(`${LINUX_HOME}/Music`);
    expect(denyRead).toContain(`${LINUX_HOME}/myproject`);
  });
});

describe("agent-sandbox · buildAgentSandboxSettings · mac/linux dışı (örn. win32, sandbox yok)", () => {
  const { settings, denyCount } = buildAgentSandboxSettings({
    projectRoot: "C:\\Users\\umit\\proj",
    ultracode: false,
    policy: "enforce",
    platform: "win32",
    home: "C:\\Users\\umit",
    homeEntries: ["Music", "Documents", ".claude", "AppData"],
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

describe("agent-sandbox · projectRoot-overlap guard (path.sep ile)", () => {
  it("proje home girdisinin KENDİSİYSE denylemez", () => {
    const { settings } = buildAgentSandboxSettings({
      projectRoot: `${HOME}/adminpanel`,
      ultracode: false, policy: "enforce", platform: "darwin", home: HOME, homeEntries: MAC_ENTRIES,
    });
    const denyRead = deny(settings);
    expect(denyRead).not.toContain(`${HOME}/adminpanel`);
    expect(denyRead).toContain(`${HOME}/other-project`);
  });

  it("proje bir home girdisinin ALT KLASÖRÜ ise o girdiyi denylemez", () => {
    const { settings } = buildAgentSandboxSettings({
      projectRoot: `${HOME}/Documents/work/app`,
      ultracode: false, policy: "enforce", platform: "darwin", home: HOME, homeEntries: MAC_ENTRIES,
    });
    expect(deny(settings)).not.toContain(`${HOME}/Documents`);
  });

  it("benzer prefix yanlış eşleşmez (Doc vs Documents — sep sınırı)", () => {
    // projectRoot=/Users/umit/Doc, entry=/Users/umit/Documents → startsWith(entry+sep) FALSE
    const { settings } = buildAgentSandboxSettings({
      projectRoot: `${HOME}/Doc`,
      ultracode: false, policy: "enforce", platform: "darwin", home: HOME, homeEntries: MAC_ENTRIES,
    });
    // Documents yine reddedilmeli (proje onun altında değil)
    expect(deny(settings)).toContain(`${HOME}/Documents`);
  });
});

describe("agent-sandbox · ultracode merge + policy modları", () => {
  it("ultracode=true → settings.ultracode:true", () => {
    const { settings } = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: true, policy: "enforce", platform: "darwin", home: HOME, homeEntries: MAC_ENTRIES,
    });
    expect(settings.ultracode).toBe(true);
  });

  it("ultracode=false → ultracode anahtarı YOK", () => {
    const { settings } = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "enforce", platform: "darwin", home: HOME, homeEntries: MAC_ENTRIES,
    });
    expect("ultracode" in settings).toBe(false);
  });

  it("enforce → failIfUnavailable:true; warn → false", () => {
    const e = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "enforce", platform: "darwin", home: HOME, homeEntries: MAC_ENTRIES,
    });
    const w = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "warn", platform: "darwin", home: HOME, homeEntries: MAC_ENTRIES,
    });
    expect((e.settings.sandbox as { failIfUnavailable: boolean }).failIfUnavailable).toBe(true);
    expect((w.settings.sandbox as { failIfUnavailable: boolean }).failIfUnavailable).toBe(false);
    expect((e.settings.sandbox as { enabled: boolean; allowUnsandboxedCommands: boolean }).allowUnsandboxedCommands).toBe(false);
  });

  it("off → sandbox YOK; ultracode korunur / boş", () => {
    const off = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: true, policy: "off", platform: "darwin", home: HOME, homeEntries: MAC_ENTRIES,
    });
    expect(off.denyCount).toBe(0);
    expect("sandbox" in off.settings).toBe(false);
    expect(off.settings.ultracode).toBe(true);

    const offNoUltra = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "off", platform: "darwin", home: HOME, homeEntries: MAC_ENTRIES,
    });
    expect(offNoUltra.settings).toEqual({});
  });
});

describe("agent-sandbox · defense-in-depth: permissions.deny paritesi (macOS)", () => {
  it("her denyRead girdisi permissions.deny'de Read(/...) olarak var", () => {
    const { settings } = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "enforce", platform: "darwin", home: HOME, homeEntries: MAC_ENTRIES,
    });
    const denyRead = deny(settings);
    const permDeny = (settings.permissions as { deny: string[] }).deny;
    expect(permDeny).toContain(`Read(/${HOME}/Music)`);
    expect(permDeny).toContain(`Read(/${HOME}/Music/**)`); // prompt-katmanı HER İKİ formu korur
    // darwin: çekirdek denyRead dir-only (/** redundant, E2BIG için), permDeny iki-form → 2×.
    expect(permDeny.length).toBe(denyRead.length * 2);
  });
});
