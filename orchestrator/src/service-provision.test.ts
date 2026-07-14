import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMissingService, findComposeFile } from "./service-provision.js";

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
