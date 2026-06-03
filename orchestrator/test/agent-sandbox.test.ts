import { describe, expect, it } from "vitest";
import { buildAgentSandboxSettings } from "../src/agent-sandbox.js";

// buildAgentSandboxSettings SAF — home/homeEntries/policy/projectRoot/ultracode
// param ile enjekte edilir; host home'dan bağımsız. paths.test.ts kalıbı.

const HOME = "/Users/umit";
// Tipik home: korunan kullanıcı verisi + runtime + kullanıcı projeleri karışık.
const ENTRIES = [
  "Music",
  "Pictures",
  "Documents",
  "Desktop",
  "Downloads",
  ".ssh",
  ".aws",
  "adminpanel", // home altındaki bir proje
  "other-project",
  ".claude", // runtime — denylenmez
  ".claude.json", // runtime
  "Library", // runtime (Caches/App Support/keychain)
  ".cache",
  ".npm",
  ".nvm",
];

describe("agent-sandbox · buildAgentSandboxSettings", () => {
  describe("denyRead listesi (katı okuma)", () => {
    const { settings, denyCount } = buildAgentSandboxSettings({
      projectRoot: "/tmp/mycl-validate/shop", // home DIŞINDA → hiçbir home girdisi proje değil
      ultracode: false,
      policy: "enforce",
      home: HOME,
      homeEntries: ENTRIES,
    });
    const sandbox = settings.sandbox as { filesystem: { denyRead: string[] } };
    const denyRead = sandbox.filesystem.denyRead;

    it("korunan kullanıcı verisini reddeder (her biri path + path/**)", () => {
      for (const name of ["Music", "Pictures", "Documents", "Desktop", "Downloads", ".ssh", ".aws"]) {
        expect(denyRead).toContain(`${HOME}/${name}`);
        expect(denyRead).toContain(`${HOME}/${name}/**`);
      }
    });

    it("diğer kullanıcı projelerini de reddeder", () => {
      expect(denyRead).toContain(`${HOME}/adminpanel`);
      expect(denyRead).toContain(`${HOME}/other-project`);
    });

    it("runtime girdilerini ASLA reddetmez (yoksa claude kırılır)", () => {
      for (const rt of [".claude", ".claude.json", "Library", ".cache", ".npm", ".nvm"]) {
        expect(denyRead).not.toContain(`${HOME}/${rt}`);
        expect(denyRead).not.toContain(`${HOME}/${rt}/**`);
      }
    });

    it("denyCount = reddedilen girdi sayısı × 2 (path + glob)", () => {
      // 9 reddedilen girdi (5 medya + .ssh + .aws + 2 proje) × 2.
      expect(denyCount).toBe(9 * 2);
    });
  });

  describe("projectRoot-overlap guard (proje home altındaysa)", () => {
    it("proje girdisinin KENDİSİNİ denylemez (proje okunur kalır)", () => {
      const { settings } = buildAgentSandboxSettings({
        projectRoot: `${HOME}/adminpanel`, // proje home'da bir girdi
        ultracode: false,
        policy: "enforce",
        home: HOME,
        homeEntries: ENTRIES,
      });
      const denyRead = (settings.sandbox as { filesystem: { denyRead: string[] } }).filesystem.denyRead;
      expect(denyRead).not.toContain(`${HOME}/adminpanel`);
      expect(denyRead).not.toContain(`${HOME}/adminpanel/**`);
      // Ama diğerleri yine reddedilir.
      expect(denyRead).toContain(`${HOME}/other-project`);
      expect(denyRead).toContain(`${HOME}/Music`);
    });

    it("proje bir home girdisinin ALT KLASÖRÜ ise o girdiyi denylemez", () => {
      const { settings } = buildAgentSandboxSettings({
        projectRoot: `${HOME}/Documents/work/app`, // Documents altında
        ultracode: false,
        policy: "enforce",
        home: HOME,
        homeEntries: ENTRIES,
      });
      const denyRead = (settings.sandbox as { filesystem: { denyRead: string[] } }).filesystem.denyRead;
      expect(denyRead).not.toContain(`${HOME}/Documents`);
      expect(denyRead).not.toContain(`${HOME}/Documents/**`);
    });
  });

  describe("ultracode merge (mevcut davranış korunur)", () => {
    it("ultracode=true → settings.ultracode:true", () => {
      const { settings } = buildAgentSandboxSettings({
        projectRoot: "/tmp/x",
        ultracode: true,
        policy: "enforce",
        home: HOME,
        homeEntries: ENTRIES,
      });
      expect(settings.ultracode).toBe(true);
    });

    it("ultracode=false → ultracode anahtarı YOK", () => {
      const { settings } = buildAgentSandboxSettings({
        projectRoot: "/tmp/x",
        ultracode: false,
        policy: "enforce",
        home: HOME,
        homeEntries: ENTRIES,
      });
      expect("ultracode" in settings).toBe(false);
    });
  });

  describe("policy modları", () => {
    it("enforce → failIfUnavailable:true (sandbox kurulamazsa fail-closed)", () => {
      const { settings } = buildAgentSandboxSettings({
        projectRoot: "/tmp/x",
        ultracode: false,
        policy: "enforce",
        home: HOME,
        homeEntries: ENTRIES,
      });
      const sandbox = settings.sandbox as { enabled: boolean; allowUnsandboxedCommands: boolean; failIfUnavailable: boolean };
      expect(sandbox.enabled).toBe(true);
      expect(sandbox.allowUnsandboxedCommands).toBe(false);
      expect(sandbox.failIfUnavailable).toBe(true);
    });

    it("warn → failIfUnavailable:false (kilitleme yok)", () => {
      const { settings } = buildAgentSandboxSettings({
        projectRoot: "/tmp/x",
        ultracode: false,
        policy: "warn",
        home: HOME,
        homeEntries: ENTRIES,
      });
      const sandbox = settings.sandbox as { failIfUnavailable: boolean };
      expect(sandbox.failIfUnavailable).toBe(false);
    });

    it("off → sandbox YOK, yalnız ultracode (acil geri-alma)", () => {
      const off = buildAgentSandboxSettings({
        projectRoot: "/tmp/x",
        ultracode: true,
        policy: "off",
        home: HOME,
        homeEntries: ENTRIES,
      });
      expect(off.denyCount).toBe(0);
      expect("sandbox" in off.settings).toBe(false);
      expect(off.settings.ultracode).toBe(true);

      const offNoUltra = buildAgentSandboxSettings({
        projectRoot: "/tmp/x",
        ultracode: false,
        policy: "off",
        home: HOME,
        homeEntries: ENTRIES,
      });
      expect(offNoUltra.settings).toEqual({});
    });
  });

  describe("defense-in-depth: permissions.deny Read() paritesi", () => {
    it("her denyRead girdisi permissions.deny'de Read(/...) olarak da var", () => {
      const { settings } = buildAgentSandboxSettings({
        projectRoot: "/tmp/x",
        ultracode: false,
        policy: "enforce",
        home: HOME,
        homeEntries: ENTRIES,
      });
      const denyRead = (settings.sandbox as { filesystem: { denyRead: string[] } }).filesystem.denyRead;
      const permDeny = (settings.permissions as { deny: string[] }).deny;
      expect(permDeny).toContain(`Read(/${HOME}/Music)`);
      expect(permDeny.length).toBe(denyRead.length);
    });
  });
});
