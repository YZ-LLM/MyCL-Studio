// İkili Soru Bankası — atomic depolama (I/O, Dilim 2).
//
// Banka dosyaları write-temp-then-rename ile yazılır: module-parallel codegen
// worktree'leri aynı KEY'e yarışırsa yarı-yazılmış/pre-review banka asla
// okunmaz (last-writer-wins sessiz overwrite yerine atomic değişim). rename
// aynı dosya-sisteminde atomiktir.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { QuestionBank } from "./types.js";

/** Aynı-process içi temp-adı çakışmasını önleyen sayaç (pid + sayaç benzersiz). */
let tmpCounter = 0;

/**
 * JSON'u atomik yaz: dirname oluştur → temp dosyaya yaz → rename. Okuyucu yalnız
 * tam-yazılmış dosyayı görür (parallel-codegen race'inde yarı-yazım okunmaz).
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await rename(tmp, path);
}

/** JSON oku. Dosya yoksa null. JSON bozuksa throw (sessizce yutma yok). */
export async function readJson<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw) as T;
}

/** Bankayı atomik yaz (writeJsonAtomic'in tipli sarmalı). */
export function writeBankAtomic(path: string, bank: QuestionBank): Promise<void> {
  return writeJsonAtomic(path, bank);
}

/** Bankayı oku. Dosya yoksa null (caller üretime düşer). */
export function readBank(path: string): Promise<QuestionBank | null> {
  return readJson<QuestionBank>(path);
}
