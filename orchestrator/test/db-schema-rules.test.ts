// db-schema-rules — veritabanı şemasının güvenlik/performans kontrolleri (SAF).
//
// KÖK NEDEN (2026-08-03): kullanıcının ürün amacı "veritabanı performanslı ve güvenli tasarlanmış" diyor.
// Faz 7 şema + migration üretiyor ve onay alıyordu, ama üretilenin güvenliğini/performansını doğrulayan
// TEK BİR mekanik kontrol yoktu — yalnız prompt tavsiyesi. Yani iddia doğrulanmıyordu.
//
// YANLIŞ ALARM YASAĞI: yalnız tartışmasız kurallar bulgu üretir; hash'lenmiş parola, index'li yabancı
// anahtar, geri alması olan migration temiz geçmeli.

import { describe, expect, it } from "vitest";
import { analyzeDbFile, analyzeDbSchemas } from "../src/db-schema-rules.js";

const f = (content: string, path = "migrations/001.sql") => ({ path, content });

describe("güvenlik kuralları", () => {
  it("düz metin parola yakalanır", () => {
    const out = analyzeDbFile(f("CREATE TABLE users (\n id SERIAL PRIMARY KEY,\n password TEXT NOT NULL\n);"));
    expect(out.some((x) => x.kind === "plaintext_password")).toBe(true);
  });

  it("YANLIŞ ALARM YOK: hash'lenmiş parola temiz", () => {
    const out = analyzeDbFile(
      f("CREATE TABLE users (\n id SERIAL PRIMARY KEY,\n password_hash TEXT NOT NULL\n);"),
    );
    expect(out.some((x) => x.kind === "plaintext_password")).toBe(false);
  });

  it("gizli alan çeşitleri (token, api_key) de kapsanır", () => {
    for (const col of ["api_key TEXT", "token VARCHAR(64)", "secret TEXT"]) {
      const out = analyzeDbFile(f(`CREATE TABLE t (\n id SERIAL PRIMARY KEY,\n ${col}\n);`));
      expect(out.some((x) => x.kind === "plaintext_password"), col).toBe(true);
    }
  });

  it("birincil anahtarsız tablo yakalanır; anahtarlı temiz", () => {
    expect(
      analyzeDbFile(f("CREATE TABLE logs (\n msg TEXT,\n created_at TIMESTAMP\n);")).some(
        (x) => x.kind === "table_without_pk",
      ),
    ).toBe(true);
    expect(
      analyzeDbFile(f("CREATE TABLE logs (\n id SERIAL PRIMARY KEY,\n msg TEXT\n);")).some(
        (x) => x.kind === "table_without_pk",
      ),
    ).toBe(false);
  });

  it("geri alınamaz yıkıcı migration yakalanır; geri alması olan temiz", () => {
    expect(
      analyzeDbFile(f("DROP TABLE eski_siparisler;")).some((x) => x.kind === "irreversible_migration"),
    ).toBe(true);
    expect(
      analyzeDbFile(f("DROP TABLE eski;\n-- Down\nCREATE TABLE eski (id SERIAL PRIMARY KEY);")).some(
        (x) => x.kind === "irreversible_migration",
      ),
    ).toBe(false);
  });

  it("yorum satırları bulgu üretmez (yanlış alarm yok)", () => {
    const out = analyzeDbFile(f("-- password TEXT burada anlatiliyor\nCREATE TABLE t (id SERIAL PRIMARY KEY);"));
    expect(out.some((x) => x.kind === "plaintext_password")).toBe(false);
  });
});

describe("performans kuralları", () => {
  it("index'siz yabancı anahtar yakalanır", () => {
    const sql =
      "CREATE TABLE users (id SERIAL PRIMARY KEY);\n" +
      "CREATE TABLE orders (\n id SERIAL PRIMARY KEY,\n user_id INTEGER REFERENCES users(id)\n);";
    const out = analyzeDbFile(f(sql));
    expect(out.some((x) => x.kind === "fk_without_index")).toBe(true);
  });

  it("YANLIŞ ALARM YOK: index'i olan yabancı anahtar temiz", () => {
    const sql =
      "CREATE TABLE users (id SERIAL PRIMARY KEY);\n" +
      "CREATE TABLE orders (\n id SERIAL PRIMARY KEY,\n user_id INTEGER REFERENCES users(id)\n);\n" +
      "CREATE INDEX idx_orders_user ON orders(user_id);";
    expect(analyzeDbFile(f(sql)).some((x) => x.kind === "fk_without_index")).toBe(false);
  });
});

describe("Prisma şeması", () => {
  it("@id yoksa birincil anahtar bulgusu", () => {
    const p = "model Log {\n  message String\n  createdAt DateTime\n}";
    expect(
      analyzeDbFile({ path: "prisma/schema.prisma", content: p }).some((x) => x.kind === "table_without_pk"),
    ).toBe(true);
  });

  it("@id varsa temiz", () => {
    const p = "model User {\n  id Int @id @default(autoincrement())\n  email String\n}";
    expect(
      analyzeDbFile({ path: "prisma/schema.prisma", content: p }).some((x) => x.kind === "table_without_pk"),
    ).toBe(false);
  });

  it("ilişki alanında index yoksa performans bulgusu", () => {
    const p =
      "model Order {\n  id Int @id\n  userId Int\n  user User @relation(fields: [userId], references: [id])\n}";
    expect(
      analyzeDbFile({ path: "prisma/schema.prisma", content: p }).some((x) => x.kind === "fk_without_index"),
    ).toBe(true);
  });
});

describe("analyzeDbSchemas", () => {
  it("boyutlara ayırır ve tekrarları tekilleştirir", () => {
    const sql = "CREATE TABLE t (\n secret TEXT\n);";
    const r = analyzeDbSchemas([f(sql, "a.sql"), f(sql, "a.sql")]);
    expect(r.security.length).toBeGreaterThan(0);
    // Aynı dosya + aynı bulgu iki kez sayılmaz.
    expect(new Set(r.security.map((x) => `${x.file}|${x.kind}|${x.detail}`)).size).toBe(r.security.length);
  });

  it("temiz şema hiç bulgu üretmez", () => {
    const sql =
      "CREATE TABLE users (id SERIAL PRIMARY KEY, password_hash TEXT);\n" +
      "CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id));\n" +
      "CREATE INDEX idx_o_u ON orders(user_id);";
    const r = analyzeDbSchemas([f(sql)]);
    expect(r.security).toHaveLength(0);
    expect(r.performance).toHaveLength(0);
  });
});
