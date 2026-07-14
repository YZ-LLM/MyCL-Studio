import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMissingService, detectMissingDeps, findComposeFile } from "./service-provision.js";

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
