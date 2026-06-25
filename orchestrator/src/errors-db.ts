// errors-db — proje root'unda `error_folder/mycl_errors.db` SQLite kataloğunu
// idempotent şekilde oluşturur. Yeni MyCL pipeline'ı Phase 4 spec + Phase 8
// TDD ile bu klasörü zaten kuruyor; ama **eski projeler** (pipeline
// güncellemelerinden önce üretilmiş) için Phase 0 Debug Triage başlarken
// burada otomatik kurulum yapılır.
//
// Schema Phase 4/5/9 template'leriyle birebir aynı — Claude ile MyCL'in
// yarattığı tablo çakışmaz. `CREATE TABLE IF NOT EXISTS` idempotent.
//
// SQLite Node dependency'si eklemek yerine sistem `sqlite3` CLI kullanılır:
// macOS/Linux default; Claude'un da kullandığı yol. Windows'ta CLI yoksa
// graceful skip (Phase 0 boş tablo varsayımıyla devam eder).

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ensureGitignoreEntry } from "./gitignore-util.js";
import { log } from "./logger.js";

const FOLDER_NAME = "error_folder";
const DB_NAME = "mycl_errors.db";
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  error_code TEXT NOT NULL,
  location TEXT NOT NULL,
  description_tr TEXT NOT NULL,
  stack TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  solution_tr TEXT
);
`;

// Eski projelerde tablo varsa ama `solution_tr` kolonu yoksa idempotent
// migration. PRAGMA table_info ile kontrol, yoksa ALTER TABLE ADD COLUMN.
const MIGRATION_CHECK_SQL = "SELECT 1 FROM pragma_table_info('errors') WHERE name='solution_tr';";
const MIGRATION_ADD_SOLUTION_SQL = "ALTER TABLE errors ADD COLUMN solution_tr TEXT;";

export interface ErrorRow {
  ts: number;
  error_code: string;
  location: string;
  description_tr: string;
  stack?: string | null;
}

export interface EnsureResult {
  /** Klasör veya DB yeni oluşturuldu mu (UI mesajı bu flag'e bağlı). */
  created: boolean;
  /** Mutlak path: `<projectRoot>/error_folder/mycl_errors.db`. */
  dbPath: string;
}

/**
 * Proje root'unda error catalog kurulumunu garanti eder. Var olan klasör
 * veya tabloyu BOZMAZ (idempotent). Klasör/DB yeni oluşturulduysa
 * `created=true`. .gitignore'a `error_folder/` satırı eklenir (yoksa).
 *
 * sqlite3 CLI yoksa graceful skip: log.warn + created=false + dbPath döner.
 * Caller Phase 0 boş tablo varsayımıyla devam edebilir.
 */
export async function ensureErrorCatalog(
  projectRoot: string,
  opts?: { gitignoreOnlyIfExists?: boolean },
): Promise<EnsureResult> {
  const folderPath = join(projectRoot, FOLDER_NAME);
  const dbPath = join(folderPath, DB_NAME);

  let createdFolder = false;
  try {
    await fs.access(folderPath);
  } catch {
    await fs.mkdir(folderPath, { recursive: true });
    createdFolder = true;
    log.info("errors-db", "folder created", { folderPath });
  }

  let createdDb = false;
  let dbExists = false;
  try {
    await fs.access(dbPath);
    dbExists = true;
  } catch {
    // DB dosyası yok → sqlite3 CLI ile schema kurulur (CREATE IF NOT EXISTS
    // her durumda safe). sqlite3 yoksa graceful skip.
    const ok = await runSqlite(dbPath, SCHEMA_SQL);
    if (!ok) {
      log.warn("errors-db", "sqlite3 CLI unavailable — skip db init", {
        dbPath,
      });
      return { created: createdFolder, dbPath };
    }
    createdDb = true;
    log.info("errors-db", "db schema created", { dbPath });
  }

  // Eski DB için solution_tr migrasyonu: PRAGMA ile kontrol, yoksa ALTER.
  if (dbExists) {
    const hasSolution = await runSqliteQuery(dbPath, MIGRATION_CHECK_SQL);
    if (hasSolution !== null && hasSolution.trim() === "") {
      const migrated = await runSqlite(dbPath, MIGRATION_ADD_SOLUTION_SQL);
      if (migrated) {
        log.info("errors-db", "migrated: solution_tr column added", { dbPath });
      } else {
        log.warn("errors-db", "solution_tr migration failed (non-fatal)", { dbPath });
      }
    }
  }

  // .gitignore append (idempotent). Yabancı-köken projede "varsa ekle" (gitignoreOnlyIfExists) → YENİ
  // .gitignore oluşturmaz (YZLLM onboarding kararı).
  await appendGitignoreEntry(projectRoot, `${FOLDER_NAME}/`, opts?.gitignoreOnlyIfExists);

  return { created: createdFolder || createdDb, dbPath };
}

/**
 * errors tablosuna toplu insert. Her satır için ts/error_code/location/
 * description_tr zorunlu; stack opsiyonel. Inserted ID'leri sırasıyla döner.
 * sqlite3 CLI yoksa boş array. Tek transaction (BEGIN/COMMIT).
 */
export async function insertErrors(dbPath: string, rows: ErrorRow[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const inserts = rows
    .map((r) => {
      const stack = r.stack ?? null;
      return `INSERT INTO errors (ts, error_code, location, description_tr, stack, resolved, solution_tr) VALUES (${r.ts}, ${q(r.error_code)}, ${q(r.location)}, ${q(r.description_tr)}, ${stack === null ? "NULL" : q(stack)}, 0, NULL); SELECT last_insert_rowid();`;
    })
    .join("\n");
  const sql = `BEGIN;\n${inserts}\nCOMMIT;`;
  const out = await runSqliteQuery(dbPath, sql);
  if (out === null) return [];
  const ids = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map((line) => Number(line));
  return ids;
}

/**
 * Hatayı çözümle birlikte resolved=1 işaretler. solution_tr TR çeviri özet.
 * sqlite3 CLI yoksa no-op.
 */
export async function markResolved(
  dbPath: string,
  id: number,
  solution_tr: string,
): Promise<void> {
  const sql = `UPDATE errors SET resolved=1, solution_tr=${q(solution_tr)} WHERE id=${id};`;
  await runSqlite(dbPath, sql);
}

/**
 * Son `sinceMs` ms içinde yakalanan `RUNTIME_` prefix'li çözülmemiş hataları
 * batch olarak resolved=1 yapar. Smoke test 2xx probe başarılı olduğunda
 * çağrılır — fix uygulandı, dev server canlı, sayfa açılıyor → son N saniyedeki
 * runtime hatalar artık tarihsel sayılır.
 *
 * Returns: kaç satır güncellendi (UI bildirimi için).
 */
export async function markRecentRuntimeResolved(
  dbPath: string,
  sinceMs: number,
  solution_tr: string,
): Promise<number> {
  const cutoff = Date.now() - sinceMs;
  // Önce kaç row etkilenecek say (UPDATE row count almak sqlite3 CLI'da
  // dolaylı, ayrı SELECT daha güvenilir).
  const countSql = `SELECT COUNT(*) FROM errors WHERE error_code LIKE 'RUNTIME\\_%' ESCAPE '\\' AND resolved=0 AND ts >= ${cutoff};`;
  const countOut = await runSqliteQuery(dbPath, countSql);
  const count = countOut ? Number(countOut.trim()) : 0;
  if (!Number.isFinite(count) || count === 0) return 0;

  const updateSql = `UPDATE errors SET resolved=1, solution_tr=${q(solution_tr)} WHERE error_code LIKE 'RUNTIME\\_%' ESCAPE '\\' AND resolved=0 AND ts >= ${cutoff};`;
  await runSqlite(dbPath, updateSql);
  return count;
}

export interface RuntimeErrorRow {
  id: number;
  ts: number;
  error_code: string;
  location: string;
  description_tr: string;
  stack: string | null;
}

/**
 * `resolved=0` olan TÜM hataları döner (SCAN_ + RUNTIME_ hepsi). "Hata Ara"
 * butonunda Claude'a tam scan yaptırmadan önce kontrol edilir: açık hata
 * varsa onları doğrudan checklist olarak göster, yeni Claude turn'üne ihtiyaç
 * yok. Kullanıcı resolved=1 işaretledikten sonra (markResolved) kayıt
 * "kapalı" sayılır ve listeden düşer.
 */
export async function selectUnresolvedFindings(
  dbPath: string,
): Promise<RuntimeErrorRow[]> {
  const sql = `SELECT id, ts, error_code, location, description_tr, IFNULL(stack, '') FROM errors WHERE resolved=0 ORDER BY ts DESC LIMIT 50;`;
  const out = await runSqliteQuery(dbPath, sql, SQLITE_FIELD_SEP);
  if (!out) return [];
  const rows: RuntimeErrorRow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // ASCII Unit Separator ile parse — description_tr içinde `|` olsa bile
    // sütun sınırı bozulmaz (US karakteri log'larda görülmez).
    const parts = line.split(SQLITE_FIELD_SEP);
    if (parts.length < 6) continue;
    const id = Number(parts[0]);
    const ts = Number(parts[1]);
    if (!Number.isFinite(id) || !Number.isFinite(ts)) continue;
    rows.push({
      id,
      ts,
      error_code: parts[2],
      location: parts[3],
      description_tr: parts[4],
      stack: parts[5] || null,
    });
  }
  return rows;
}

/**
 * Son `sinceMs` milisaniyede yazılmış `RUNTIME_` prefix'li satırları döner.
 * Scanner bunu PROJECT_CONTEXT'e enjekte edip Claude'a "browser'da gerçek
 * hatalar yaşandı, finding olarak rapor et" diye verir.
 *
 * sqlite3 CLI yoksa veya tablo yoksa boş array.
 */
export async function selectRecentRuntimeErrors(
  dbPath: string,
  sinceMs: number,
): Promise<RuntimeErrorRow[]> {
  const cutoff = Date.now() - sinceMs;
  const sql = `SELECT id, ts, error_code, location, description_tr, IFNULL(stack, '') FROM errors WHERE error_code LIKE 'RUNTIME\\_%' ESCAPE '\\' AND ts >= ${cutoff} ORDER BY ts DESC LIMIT 50;`;
  const out = await runSqliteQuery(dbPath, sql, SQLITE_FIELD_SEP);
  if (!out) return [];
  const rows: RuntimeErrorRow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(SQLITE_FIELD_SEP);
    if (parts.length < 6) continue;
    const id = Number(parts[0]);
    const ts = Number(parts[1]);
    if (!Number.isFinite(id) || !Number.isFinite(ts)) continue;
    rows.push({
      id,
      ts,
      error_code: parts[2],
      location: parts[3],
      description_tr: parts[4],
      stack: parts[5] || null,
    });
  }
  return rows;
}

/** SQLite string literal escape: tek tırnak çiftle. */
function q(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * sqlite3 CLI'a SQL gönderir ve stdout'u toplar (SELECT sonuçları için).
 * Hata veya CLI yokken null döner.
 */
/** Multi-byte separator — description_tr içinde `|` bulunan log satırlarında
 *  sütun parse'ı bozulmasın diye SELECT çıktıları için kullanılır. */
const SQLITE_FIELD_SEP = ""; // ASCII Unit Separator, log içinde olmaz

function runSqliteQuery(
  dbPath: string,
  sql: string,
  separator?: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let stdout = "";
    const finish = (out: string | null): void => {
      if (resolved) return;
      resolved = true;
      resolve(out);
    };
    let child;
    try {
      const args = separator
        ? ["-separator", separator, dbPath]
        : [dbPath];
      child = spawn("sqlite3", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish(null);
      return;
    }
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? stdout : null));
    try {
      child.stdin.write(sql);
      child.stdin.end();
    } catch {
      finish(null);
    }
  });
}

/**
 * sqlite3 CLI'a schema SQL'ini stdin üzerinden gönderir. Process exit 0
 * dönerse true. CLI bulunamazsa veya hata olursa false.
 */
function runSqlite(dbPath: string, sql: string): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (ok: boolean): void => {
      if (resolved) return;
      resolved = true;
      resolve(ok);
    };
    let child;
    try {
      child = spawn("sqlite3", [dbPath], {
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch {
      finish(false);
      return;
    }
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    try {
      child.stdin.write(sql);
      child.stdin.end();
    } catch {
      finish(false);
    }
  });
}

/**
 * Proje root'undaki `.gitignore`'a `entry` ekler — idempotent, ortak util
 * üzerinden (zaten kapsanıyorsa no-op → tree kirlenmez → fix checkpoint korunur).
 * Yazma hatası non-fatal (read-only mount vs.) — ana akış bozulmaz.
 */
async function appendGitignoreEntry(
  projectRoot: string,
  entry: string,
  onlyIfExists?: boolean,
): Promise<void> {
  try {
    const wrote = await ensureGitignoreEntry(projectRoot, entry, { onlyIfExists });
    if (wrote) log.info("errors-db", ".gitignore entry appended", { entry });
  } catch (err) {
    log.warn("errors-db", ".gitignore write failed (non-fatal)", err);
  }
}
