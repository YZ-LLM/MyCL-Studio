import { describe, expect, it } from "vitest";
import { resolveConfigDir } from "../src/paths.js";

// resolveConfigDir PURE — platform/env/home/legacyExists parametreleriyle.
// Host platformdan bağımsız (path.win32/posix param'a göre seçilir).

describe("paths · resolveConfigDir", () => {
  const macHome = "/Users/umit";
  const linuxHome = "/home/umit";
  const winHome = "C:\\Users\\umit";

  describe("MYCL_HOME override (en yüksek öncelik)", () => {
    it("MYCL_HOME her platformda her şeyin önünde", () => {
      expect(
        resolveConfigDir({
          platform: "darwin",
          env: { MYCL_HOME: "/custom/mycl" },
          home: macHome,
          legacyExists: true, // legacy var ama override kazanır
        }),
      ).toBe("/custom/mycl");
      expect(
        resolveConfigDir({
          platform: "win32",
          env: { MYCL_HOME: "D:\\mycl", APPDATA: "C:\\AppData" },
          home: winHome,
          legacyExists: false,
        }),
      ).toBe("D:\\mycl");
    });

    it("boş/whitespace MYCL_HOME yok sayılır", () => {
      expect(
        resolveConfigDir({
          platform: "linux",
          env: { MYCL_HOME: "   " },
          home: linuxHome,
          legacyExists: false,
        }),
      ).toBe("/home/umit/.config/mycl");
    });
  });

  describe("migration guard (eski ~/.mycl varsa)", () => {
    it("legacy ~/.mycl varsa platform-bağımsız onu kullan (orphan etme)", () => {
      // Linux'ta normalde ~/.config/mycl olurdu ama legacy varsa ~/.mycl
      expect(
        resolveConfigDir({
          platform: "linux",
          env: {},
          home: linuxHome,
          legacyExists: true,
        }),
      ).toBe("/home/umit/.mycl");
      // Windows'ta normalde %APPDATA%\MyCL ama legacy varsa ~/.mycl
      expect(
        resolveConfigDir({
          platform: "win32",
          env: { APPDATA: "C:\\Users\\umit\\AppData\\Roaming" },
          home: winHome,
          legacyExists: true,
        }),
      ).toBe("C:\\Users\\umit\\.mycl");
    });
  });

  describe("platform varsayılanı (fresh kurulum, legacy yok)", () => {
    it("macOS → ~/.mycl", () => {
      expect(
        resolveConfigDir({
          platform: "darwin",
          env: {},
          home: macHome,
          legacyExists: false,
        }),
      ).toBe("/Users/umit/.mycl");
    });

    it("Windows → %APPDATA%\\MyCL", () => {
      expect(
        resolveConfigDir({
          platform: "win32",
          env: { APPDATA: "C:\\Users\\umit\\AppData\\Roaming" },
          home: winHome,
          legacyExists: false,
        }),
      ).toBe("C:\\Users\\umit\\AppData\\Roaming\\MyCL");
    });

    it("Windows + APPDATA yoksa → ~/.mycl fallback", () => {
      expect(
        resolveConfigDir({
          platform: "win32",
          env: {},
          home: winHome,
          legacyExists: false,
        }),
      ).toBe("C:\\Users\\umit\\.mycl");
    });

    it("Linux + XDG_CONFIG_HOME → $XDG/mycl", () => {
      expect(
        resolveConfigDir({
          platform: "linux",
          env: { XDG_CONFIG_HOME: "/home/umit/.xdgconfig" },
          home: linuxHome,
          legacyExists: false,
        }),
      ).toBe("/home/umit/.xdgconfig/mycl");
    });

    it("Linux + XDG yoksa → ~/.config/mycl", () => {
      expect(
        resolveConfigDir({
          platform: "linux",
          env: {},
          home: linuxHome,
          legacyExists: false,
        }),
      ).toBe("/home/umit/.config/mycl");
    });

    it("bilinmeyen POSIX platform (freebsd) → ~/.config/mycl", () => {
      expect(
        resolveConfigDir({
          platform: "freebsd" as NodeJS.Platform,
          env: {},
          home: linuxHome,
          legacyExists: false,
        }),
      ).toBe("/home/umit/.config/mycl");
    });
  });
});
