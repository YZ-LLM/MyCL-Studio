// gitignore-util — .gitignore'a idempotent girdi ekleme (ortak).
//
// errors-db + vite-runtime-injector (ve gelecekteki çağıranlar) aynı mantığı
// paylaşır: bir dizin/kalıp ZATEN (başka bir kalıpla da olsa) ignore'luysa
// tekrar ekleme. Aksi halde her çalıştırmada .gitignore kirlenir ve fix
// checkpoint'i (clean-tree önkoşulu) bozulur — scoped-gate'ler devre dışı kalır.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `entry` kalıbının "tabanı" — sondaki `/`, `/*`, `/**` atılır. Böylece
 * `error_folder/`, `error_folder/*`, `error_folder/**` hepsi `error_folder`'a
 * normalize olur ve aynı dizinin tekrar eklenmesi engellenir. Regex yerine
 * suffix-strip (minimal).
 */
function ignoreBase(s: string): string {
  let t = s.trim();
  for (const suf of ["/**", "/*", "/"]) {
    if (t.endsWith(suf)) {
      t = t.slice(0, -suf.length);
      break;
    }
  }
  return t;
}

/**
 * `.gitignore`'a `entry` ekler — yoksa ve aynı taban başka bir kalıpla zaten
 * kapsanmıyorsa. `.gitignore` hiç yoksa oluşturur. İdempotent: zaten kapsanıyorsa
 * no-op (tree'yi kirletmez). Dönüş: yazıldı mı.
 */
export async function ensureGitignoreEntry(
  projectRoot: string,
  entry: string,
): Promise<boolean> {
  const giPath = join(projectRoot, ".gitignore");
  let current = "";
  try {
    current = await readFile(giPath, "utf-8");
  } catch {
    // .gitignore yok — yeni oluşturulacak
  }
  const target = ignoreBase(entry);
  const lines = current.split("\n").map((l) => l.trim());
  if (target.length > 0 && lines.some((l) => ignoreBase(l) === target)) {
    return false; // zaten (başka kalıpla da olsa) kapsanıyor → no-op
  }
  const next =
    current.length === 0
      ? `${entry}\n`
      : current.endsWith("\n")
        ? `${current}${entry}\n`
        : `${current}\n${entry}\n`;
  await writeFile(giPath, next, "utf-8");
  return true;
}
