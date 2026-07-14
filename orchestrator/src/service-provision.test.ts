import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectMissingService,
  detectMissingDeps,
  depsDirNeedsInstall,
  salientInstallError,
  isCorruptDepsError,
  safeDepsDirTarget,
  findComposeFile,
} from "./service-provision.js";

// "MyCL eksik olanı tamamlamaya çalışmalı" — app bir servise bağlanamayıp çöktüğünde MyCL o servisi tespit edip
// başlatmayı denemeli. Bu testler TESPİT mantığını kilitler (docker provision'ı entegrasyon; burada saf tespit).
describe("detectMissingService — crash'ten eksik servisi tespit", () => {
  it("ECONNREFUSED :3306 → MySQL", () => {
    const s = detectMissingService("Error: connect ECONNREFUSED 127.0.0.1:3306\n  at ...", "");
    expect(s?.name).toBe("MySQL");
    expect(s?.port).toBe(3306);
  });
  it("ECONNREFUSED :5432 → PostgreSQL", () => {
    expect(detectMissingService("connect ECONNREFUSED ::1:5432", "")?.name).toBe("PostgreSQL");
  });
  it("ECONNREFUSED :27017 → MongoDB", () => {
    expect(detectMissingService("MongoNetworkError: ECONNREFUSED 127.0.0.1:27017", "")?.name).toBe("MongoDB");
  });
  it("ECONNREFUSED :6379 → Redis", () => {
    expect(detectMissingService("Error: Redis connection ECONNREFUSED 127.0.0.1:6379", "")?.name).toBe("Redis");
  });

  it("port okunamayan ECONNREFUSED + package.json'da mysql2 → MySQL (imza tahmini)", () => {
    const s = detectMissingService("Error: connect ECONNREFUSED", '{"dependencies":{"mysql2":"^3.0.0","express":"^4"}}');
    expect(s?.name).toBe("MySQL");
  });

  it("bilinmeyen port → jenerik servis (yine spesifik port ver)", () => {
    const s = detectMissingService("connect ECONNREFUSED 127.0.0.1:8529", "");
    expect(s?.port).toBe(8529);
    expect(s?.name).toContain("8529");
  });

  it("KOD hatası (ECONNREFUSED yok) → null (servis değil; Faz 0 debug'a gider)", () => {
    expect(detectMissingService("TypeError: Cannot read properties of undefined (reading 'x')", "")).toBeNull();
    expect(detectMissingService("SyntaxError: Unexpected token", '{"dependencies":{"mysql2":"^3"}}')).toBeNull();
  });

  it("YANLIŞ-POZİTİF önleme: eski/kurtarılmış ECONNREFUSED + SONRA ölümcül KOD hatası → null (servis değil)", () => {
    const log = "warmup: previously ECONNREFUSED 127.0.0.1:6379, retried, now connected fine.\nApp crashed: TypeError: x is not a function";
    expect(detectMissingService(log, "")).toBeNull();
  });
  it("ölümcül hata GERÇEKTEN bağlantı: erken kod-uyarısı + SON ECONNREFUSED → servis tespit", () => {
    const log = "note: TypeError caught and handled gracefully at boot.\nFATAL: Error: connect ECONNREFUSED 127.0.0.1:3306";
    expect(detectMissingService(log, "")?.name).toBe("MySQL");
  });
  it("boş crash → null", () => {
    expect(detectMissingService("", "")).toBeNull();
  });
});

describe("detectMissingDeps — kurulmamış bağımlılık crash imzası", () => {
  const CAVE_PKG = '{"dependencies":{"express":"^4","mysql2":"^3"}}';
  it("cave gerçek crash: Cannot find module 'express' + package.json'da bildirilmiş → true", () => {
    const log =
      "Error: Cannot find module 'express'\nRequire stack:\n- /proj/app.js\n- /proj/bin/www\n    at Function._resolveFilename";
    expect(detectMissingDeps(log, CAVE_PKG)).toBe(true);
  });
  it("package.json okunamadı (boş) + bare paket → true (güvenli taraf: node_modules hiç yok)", () => {
    expect(detectMissingDeps("Error: Cannot find module 'express'")).toBe(true);
  });
  it("scoped bildirilmiş paket → true", () => {
    expect(detectMissingDeps("Error: Cannot find module '@nestjs/core'", '{"dependencies":{"@nestjs/core":"^10"}}')).toBe(
      true,
    );
  });
  it("YANLIŞ-POZİTİF FIX: './' unutulmuş yerel yol (routes/db) package.json'da YOK → false (install çözmez)", () => {
    // require('routes/db') — bare görünür ama yerel dosya; 'routes' bir bağımlılık değil.
    expect(detectMissingDeps("Error: Cannot find module 'routes/db'", CAVE_PKG)).toBe(false);
  });
  it("YEREL yol typo'su (./routes/db) → false", () => {
    expect(detectMissingDeps("Error: Cannot find module './routes/db'", CAVE_PKG)).toBe(false);
  });
  it("mutlak yol (/abs/path) → false", () => {
    expect(detectMissingDeps("Error: Cannot find module '/opt/app/missing'", CAVE_PKG)).toBe(false);
  });
  it("ESM node ERR_MODULE_NOT_FOUND → true", () => {
    expect(detectMissingDeps("code: 'ERR_MODULE_NOT_FOUND'")).toBe(true);
  });
  it("Python ModuleNotFoundError → true", () => {
    expect(detectMissingDeps("ModuleNotFoundError: No module named 'flask'")).toBe(true);
  });
  it("PHP composer kurulmamış (vendor/autoload — paket-sistemine özgü) → true", () => {
    expect(detectMissingDeps("Fatal error: require(): Failed opening 'vendor/autoload.php'")).toBe(true);
  });
  it("Dart eksik paket (package: şeması) → true", () => {
    expect(detectMissingDeps("Error: Couldn't resolve the package 'http' in 'package:http/http.dart'")).toBe(true);
  });
  it("Go eksik modül → true", () => {
    expect(detectMissingDeps("no required module provides package github.com/foo/bar")).toBe(true);
  });
  it("YANLIŞ-POZİTİF: Ruby/PHP/Rust genel 'dosya bulunamadı' (yerel typo ile ayırt edilemez) → false", () => {
    // Bu imzalar bilinçli ÇIKARILDI (mahkeme): yerel-modül typo'suyla aynı metni verir.
    expect(detectMissingDeps("`require': cannot load such file -- ./config (LoadError)")).toBe(false);
    expect(detectMissingDeps("error[E0433]: use of undeclared crate or module `foo`")).toBe(false);
  });
  it("npx çalıştırılabilir yok → true", () => {
    expect(detectMissingDeps("npm error could not determine executable to run")).toBe(true);
  });
  it("kod hatası (TypeError) deps-eksik DEĞİL → false", () => {
    expect(detectMissingDeps("TypeError: Cannot read properties of undefined (reading 'x')")).toBe(false);
  });
  it("boş crash → false", () => {
    expect(detectMissingDeps("")).toBe(false);
  });
});

describe("depsDirNeedsInstall — PROAKTİF, STACK-BAĞIMSIZ deps kontrolü (crash'ten önce, deps_dir profilden)", () => {
  const mkProj = async (depsDir: string | null, entries: string[] = []): Promise<string> => {
    const dir = await fs.mkdtemp(join(tmpdir(), "deps-"));
    if (depsDir) {
      for (const e of entries) await fs.mkdir(join(dir, depsDir, ...e.split("/")), { recursive: true });
      if (entries.length === 0) await fs.mkdir(join(dir, depsDir), { recursive: true }); // boş dizin oluştur
    }
    return dir;
  };
  it("deps_dir (node_modules) hiç yok → true (kur)", async () => {
    const dir = await mkProj(null);
    try {
      expect(await depsDirNeedsInstall(dir, "node_modules")).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("deps_dir var ama BOŞ (yalnız nokta-girdi .bin) → true (gerçek paket yok)", async () => {
    const dir = await mkProj("node_modules", [".bin"]);
    try {
      expect(await depsDirNeedsInstall(dir, "node_modules")).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("deps_dir gerçek paket içeriyor (express) → false (kurma)", async () => {
    const dir = await mkProj("node_modules", ["express", ".bin"]);
    try {
      expect(await depsDirNeedsInstall(dir, "node_modules")).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("stack-bağımsız: php vendor dizini yok → true", async () => {
    const dir = await mkProj(null);
    try {
      expect(await depsDirNeedsInstall(dir, "vendor")).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("dart .dart_tool gerçek paket içeriyor → false", async () => {
    const dir = await mkProj(".dart_tool", ["package_config.json"]);
    try {
      expect(await depsDirNeedsInstall(dir, ".dart_tool")).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("salientInstallError + isCorruptDepsError — cave GERÇEK npm hatası (ENOTEMPTY)", () => {
  // cave çalıştırıldığında npm'in ürettiği GERÇEK hata (npm debug log'undan — npm çıktısı, cave kaynağı değil).
  const CAVE_NPM_ERR = [
    "npm error code ENOTEMPTY",
    "npm error syscall rename",
    "npm error path /Users/Shared/MyCL Projeler/cave-7ac855d7/node_modules/fsevents",
    "npm error dest /Users/Shared/MyCL Projeler/cave-7ac855d7/node_modules/.fsevents-iRgnoUa7",
    "npm error errno -66",
    "npm error ENOTEMPTY: directory not empty, rename '.../node_modules/fsevents' -> '.../node_modules/.fsevents-iRgnoUa7'",
  ].join("\n");

  // cave'in İKİNCİ (temiz kurulum sonrası) gerçek hatası: puppeteer@5.5.0 postinstall arm64'te Chromium indiremiyor.
  // Eski salientInstallError yalnız "1" gösteriyordu (asıl sebep kayıp). npm debug log'undan (npm çıktısı) alındı.
  const CAVE_PUPPETEER_ERR = [
    "npm error code 1",
    "npm error path /Users/Shared/MyCL Projeler/cave-7ac855d7/node_modules/puppeteer",
    "npm error command failed",
    "npm error command sh -c node install.js",
    "npm error The chromium binary is not available for arm64:",
    "npm error If you are on Ubuntu, you can install with:",
    "npm error  apt-get install chromium-browser",
  ].join("\n");

  it("salientInstallError: kodu (ENOTEMPTY) çıkarır — ham son-200 karakter değil", () => {
    const s = salientInstallError(CAVE_NPM_ERR);
    expect(s).toContain("ENOTEMPTY");
    expect(s).toContain("directory not empty");
  });
  it("salientInstallError: postinstall GERÇEK sebebini + paketi çıkarır (puppeteer arm64) — yalnız '1' değil", () => {
    const s = salientInstallError(CAVE_PUPPETEER_ERR);
    expect(s).toContain("puppeteer"); // hangi paket
    expect(s).toContain("chromium"); // gerçek sebep
    expect(s).toContain("arm64");
    expect(s).not.toBe("1"); // eski yararsız çıktı DEĞİL
  });
  it("isCorruptDepsError: ENOTEMPTY → true (temizle+yeniden kur tetikler)", () => {
    expect(isCorruptDepsError(CAVE_NPM_ERR)).toBe(true);
  });
  it("isCorruptDepsError: EEXIST → true", () => {
    expect(isCorruptDepsError("npm error code EEXIST\nnpm error EEXIST: file already exists")).toBe(true);
  });
  it("isCorruptDepsError: ağ/registry hatası (ETARGET/ENOTFOUND) → false (temizleme YOK)", () => {
    expect(isCorruptDepsError("npm error code ETARGET\nnpm error notarget No matching version")).toBe(false);
    expect(isCorruptDepsError("npm error code ENOTFOUND\nnpm error network request failed")).toBe(false);
  });
  it("salientInstallError: kod yoksa son parçaya düşer (boş değil)", () => {
    expect(salientInstallError("bir şeyler ters gitti, detay yok").length).toBeGreaterThan(0);
  });
  it("safeDepsDirTarget: normal deps_dir'ler güvenli → kök-içi mutlak yol döner", () => {
    for (const d of ["node_modules", "vendor", ".dart_tool", "deps", "node_modules/"]) {
      const t = safeDepsDirTarget("/proj/root", d);
      expect(t).not.toBeNull();
      expect(t!.startsWith("/proj/root/")).toBe(true);
    }
  });
  it("safeDepsDirTarget: FELAKET senaryoları → null (proje kökü ASLA silinmez)", () => {
    // Kritik: "./" ve "././" mahkemenin bulduğu kaçamak — resolve normalize eder → kök → null.
    for (const d of ["", "  ", ".", "./", "././", "..", "/", "/etc", "../..", "a/../..", "node_modules/../..", null, undefined])
      expect(safeDepsDirTarget("/proj/root", d)).toBeNull();
  });
});

describe("findComposeFile", () => {
  it("docker-compose.yml → bulur", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "svc-"));
    try {
      await fs.writeFile(join(dir, "docker-compose.yml"), "services: {}");
      expect(await findComposeFile(dir)).toBe("docker-compose.yml");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("compose.yaml → bulur", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "svc2-"));
    try {
      await fs.writeFile(join(dir, "compose.yaml"), "services: {}");
      expect(await findComposeFile(dir)).toBe("compose.yaml");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("compose yok → null", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "svc3-"));
    try {
      expect(await findComposeFile(dir)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
