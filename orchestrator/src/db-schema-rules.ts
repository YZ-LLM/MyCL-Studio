// db-schema-rules — veritabanı şemasının GÜVENLİK ve PERFORMANS kontrolleri (SAF).
//
// KÖK NEDEN (2026-08-03): kullanıcının ürün amacı açıkça "veritabanı performanslı ve güvenli tasarlanmış"
// diyor. Faz 7 şema + migration ÜRETİYOR ve onay alıyor, ama üretilenin güvenliği (düz metin parola,
// birincil anahtarsız tablo, geri alınamaz yıkıcı migration) veya performansı (yabancı anahtarda index
// yokluğu) için TEK BİR mekanik kontrol yoktu — yalnız prompt tavsiyesi vardı. Yani "güvenli ve
// performanslı tasarlandı" iddiasını doğrulayan hiçbir kapı yoktu.
//
// YANLIŞ ALARM YASAĞI (kullanıcının en sert kuralı): yalnız TARTIŞMASIZ kurallar hata verir. Yorumlanabilir
// konular (satır seviyesi erişim, şifreleme stratejisi) yalnız RAPOR — kapıyı düşürmez.
//
// Veritabanı bağımsız: şema METNİ üzerinden çalışır (Postgres/MySQL/SQLite/Prisma), canlı bağlantı istemez.

export type DbFindingKind =
  | "plaintext_password" // parola/gizli alan düz metin saklanıyor görünüyor
  | "table_without_pk" // birincil anahtarsız tablo
  | "irreversible_migration" // yıkıcı migration'ın geri alma karşılığı yok
  | "fk_without_index"; // yabancı anahtar var, index yok (sorgu performansı)

export interface DbFinding {
  kind: DbFindingKind;
  /** "security" → Faz 13 boyutu · "performance" → Faz 12 boyutu. */
  dimension: "security" | "performance";
  /** true → kapıyı düşürür (tartışmasız). false → yalnız rapor (yorumlanabilir). */
  blocking: boolean;
  file: string;
  detail: string;
}

/** Bir şema/migration dosyası (içerik + yol). */
export interface DbSchemaFile {
  path: string;
  content: string;
}

/**
 * BLOKLAYAN eşleşme: sütun adı TAM olarak bir sır alanı (mahkeme bulgusu — alt dize eşleşmesi
 * `password_reset_token`, `password_salt`, `password_updated_at`, `api_key_last_four` gibi MEŞRU
 * sütunları yanlışlıkla blokluyordu; kullanıcının en sert kuralı yanlış alarmı yasaklıyor).
 */
const SECRET_COLUMN_EXACT = new Set([
  "password",
  "passwd",
  "parola",
  "secret",
  "api_key",
  "apikey",
  "token",
  "access_token",
  "refresh_token",
  "private_key",
]);
/** Sır İMASI taşıyan ama kesin olmayan adlar → yalnız RAPOR (kapıyı düşürmez). */
const SECRET_COLUMN_HINTS = ["password", "passwd", "parola", "secret", "api_key", "apikey", "token"];
/** Hash'lendiğini/güvenli olduğunu gösteren adlandırmalar — bunlar düz metin DEĞİLDİR. */
const HASHED_HINTS = [
  "hash", "digest", "encrypted", "bcrypt", "argon", "scrypt", "sha256",
  "salt", "last_four", "masked", "updated_at", "created_at", "expires", "reset",
];

/** Çok dosyalı bağlam: index'ler AYRI migration'da tanımlanmış olabilir (mahkeme bulgusu). */
export interface DbAnalysisContext {
  /** TÜM şema dosyalarının birleşik metni — index araması burada yapılır. */
  allText?: string;
  /** Prisma `datasource.provider` (mysql/postgresql/sqlite…) — MySQL yabancı anahtarı OTOMATİK indexler. */
  prismaProvider?: string;
}

/** SAF: tek dosyayı analiz et. `ctx.allText` verilirse index araması tüm şemada yapılır. */
export function analyzeDbFile(file: DbSchemaFile, ctx: DbAnalysisContext = {}): DbFinding[] {
  const out: DbFinding[] = [];
  const lower = file.content.toLowerCase();
  const isPrisma = file.path.toLowerCase().endsWith(".prisma");
  // Index'ler başka bir migration dosyasında olabilir (Postgres'te CREATE INDEX CONCURRENTLY ayrı
  // migration'da yapılır — resmi öneri). Tek dosyaya bakmak kalıcı yanlış alarm üretiyordu.
  const indexHaystack = ctx.allText ?? file.content;

  // 1) GÜVENLİK — parola/gizli alan düz metin mi? (tartışmasız: "password TEXT" hash imasi yok)
  for (const line of file.content.split("\n")) {
    const l = line.toLowerCase().trim();
    if (l.startsWith("--") || l.startsWith("//") || l.startsWith("#")) continue;
    const hasSecret = SECRET_COLUMN_HINTS.some((h) => l.includes(h));
    if (!hasSecret) continue;
    if (HASHED_HINTS.some((h) => l.includes(h))) continue; // password_hash / password_salt → temiz
    const isTextCol = /\b(text|varchar|char|string)\b/.test(l);
    if (!isTextCol) continue;
    // Sütun adı TAM sır alanı mı? Öyleyse tartışmasız (bloklar); yalnız ima taşıyorsa RAPOR.
    const colName = /^["'`]?(\w+)["'`]?\s/.exec(l)?.[1] ?? "";
    const exact = SECRET_COLUMN_EXACT.has(colName);
    out.push({
      kind: "plaintext_password",
      dimension: "security",
      blocking: exact,
      file: file.path,
      detail: exact
        ? `gizli alan düz metin saklanıyor: ${line.trim().slice(0, 100)}`
        : `gizli alan olabilir, elle bak (bloklamaz): ${line.trim().slice(0, 100)}`,
    });
  }

  // 2) GÜVENLİK/BÜTÜNLÜK — birincil anahtarsız tablo (tartışmasız: satır kimliği yok → güncelleme/silme riskli)
  if (!isPrisma) {
    for (const m of file.content.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?(\w+)["'`]?\s*\(([\s\S]*?)\);/gi)) {
      const [, name, body] = m;
      const b = (body ?? "").toLowerCase();
      // UNIQUE(...) kısıtı satır kimliğini garanti eder → birincil anahtar EŞDEĞERİ (mahkeme bulgusu:
      // surrogate id'siz, kompozit UNIQUE ile tasarlanan ilişki tabloları meşrudur, bloklanmamalı).
      const hasPk = b.includes("primary key") || b.includes("serial primary") || /\bunique\s*\(/.test(b);
      if (!hasPk) {
        out.push({
          kind: "table_without_pk",
          dimension: "security",
          blocking: true,
          file: file.path,
          detail: `"${name}" tablosunda birincil anahtar yok`,
        });
      }
      // 3) PERFORMANS — yabancı anahtar var ama index yok
      for (const fk of b.matchAll(/(\w+)\s+[^,]*references\s+/g)) {
        const col = fk[1];
        if (!col) continue;
        const hasIndex = new RegExp(`create\\s+(unique\\s+)?index[^;]*\\(\\s*["'\`]?${col}`, "i").test(indexHaystack);
        if (!hasIndex && !b.includes(`primary key (${col})`)) {
          out.push({
            kind: "fk_without_index",
            dimension: "performance",
            blocking: true,
            file: file.path,
            detail: `"${name}.${col}" yabancı anahtarında index yok (birleştirme sorguları yavaşlar)`,
          });
        }
      }
    }
  } else {
    // Prisma: model bloklarında @id yoksa birincil anahtar yok.
    for (const m of file.content.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
      const [, name, body] = m;
      const b = body ?? "";
      if (!b.includes("@id") && !b.includes("@@id")) {
        out.push({
          kind: "table_without_pk",
          dimension: "security",
          blocking: true,
          file: file.path,
          detail: `"${name}" modelinde birincil anahtar (@id) yok`,
        });
      }
      // Prisma ilişki alanı + index yoksa performans bulgusu.
      // MySQL/CockroachDB yabancı anahtarı OTOMATİK indexler (InnoDB) → orada bu kural YANLIŞ ALARM olur.
      const autoIndexed = ["mysql", "cockroachdb"].includes((ctx.prismaProvider ?? "").toLowerCase());
      for (const rel of autoIndexed ? [] : b.matchAll(/@relation\(fields:\s*\[(\w+)\]/g)) {
        const col = rel[1];
        if (!col) continue;
        if (!b.includes(`@@index([${col}`) && !b.includes(`@unique`) && !b.includes(`@@unique([${col}`)) {
          out.push({
            kind: "fk_without_index",
            dimension: "performance",
            blocking: true,
            file: file.path,
            detail: `"${name}.${col}" ilişki alanında index yok (@@index önerilir)`,
          });
        }
      }
    }
  }

  // 4) GÜVENLİK — geri alınamaz yıkıcı migration (tartışmasız: veri kaybı geri alınamaz)
  const destructive = /\b(drop\s+table|drop\s+column|truncate)\b/i.test(file.content);
  if (destructive && !isPrisma) {
    const hasDown = /--\s*down\b|^\s*-{2,}\s*rollback/im.test(file.content) || file.path.includes(".down.");
    if (!hasDown) {
      out.push({
        kind: "irreversible_migration",
        dimension: "security",
        blocking: true,
        file: file.path,
        detail: "yıkıcı migration (DROP/TRUNCATE) için geri alma (down) bölümü yok",
      });
    }
  }
  // Not: lower yalnız yukarıdaki hızlı kontroller için — bilinçli sadelik.
  void lower;
  return out;
}

/** SAF: tüm dosyaları analiz et + boyuta göre ayır. */
export function analyzeDbSchemas(files: readonly DbSchemaFile[]): {
  security: DbFinding[];
  performance: DbFinding[];
} {
  const allText = files.map((f) => f.content).join("\n");
  const prismaProvider = /provider\s*=\s*["'](\w+)["']/.exec(
    files.find((f) => f.path.toLowerCase().endsWith(".prisma"))?.content ?? "",
  )?.[1];
  const all = files.flatMap((f) => analyzeDbFile(f, { allText, prismaProvider }));
  // Aynı bulgunun tekrarı (aynı dosya + tür + detay) tekilleştirilir.
  const seen = new Set<string>();
  const uniq = all.filter((f) => {
    const k = `${f.file}|${f.kind}|${f.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    security: uniq.filter((f) => f.dimension === "security"),
    performance: uniq.filter((f) => f.dimension === "performance"),
  };
}
