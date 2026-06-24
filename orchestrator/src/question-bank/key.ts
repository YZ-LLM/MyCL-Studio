// İkili Soru Bankası — deterministik KEY inşası (saf mantık, Dilim 1).
//
// KEY = checkpoint × stack × artefakt-tipi. Üç eksen de deterministik:
//   - checkpoint: sabit (örn. "phase-10")
//   - stack: detectStack() çıktısı (FS manifest probing)
//   - artefakt: değişen dosya yolları, profil `artifact_globs`'una karşı
//
// project_type (LLM sınıflandırıcı, 'unknown'a fail-soft) KEY'e ASLA girmez —
// soft kova seçimi = laundering (müfettiş paneli bunu ORİJİNAL tasarımda fatal
// buldu). Eşleşmeyen dosya WIDEST_ARTIFACT'e düşer: kuşkuda en geniş banka →
// OVER-check güvenli, UNDER-check (false-green) tehlikeli.

import { join } from "node:path";
import type { PhaseId, StackId } from "../types.js";
import type { BankKey } from "./types.js";

/** Universal/en-geniş bucket — eşleşmeyen dosyalar buraya düşer (coarsen). */
export const WIDEST_ARTIFACT = "*";

/** Profil artifact_globs alt-kümesi (profile-loader.StackProfile'dan). */
export interface ArtifactGlobSource {
  artifact_globs?: Record<string, string[]>;
}

/**
 * Minik glob → RegExp. Stack-agnostik, yol ayıracı '/'.
 *   `**` (ardından `/`) → herhangi-dizin-derinliği (opsiyonel)
 *   `**`                → her şey (slash dahil)
 *   `*`                 → slash-dışı dizi
 *   `?`                 → tek slash-dışı karakter
 * Brace `{a,b}` DESTEKLENMEZ (minimal; profilde ayrı pattern yaz). Regex'i
 * dışarıdan kullanıcı vermez (profil yazarı) — saf ve test-edilir tutulur.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // ikinci '*'ı yut
        if (glob[i + 1] === "/") {
          i++; // ardından gelen '/'ı da yut
          re += "(?:.*/)?"; // sıfır-veya-çok dizin
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Tek dosya, tek pattern eşleşmesi. */
export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/**
 * Değişen dosya yollarını profil artifact_globs'una göre artefakt-tiplerine
 * ayır. Bir dosya birden çok tipe girebilir (hepsi eklenir). Hiçbir glob'a
 * uymayan dosya WIDEST_ARTIFACT üretir. Profilde artifact_globs yoksa TÜM
 * dosyalar WIDEST'e düşer (coarsen-to-full; under-check'ten kaçın).
 */
export function classifyArtifacts(
  profile: ArtifactGlobSource | null,
  changedFiles: readonly string[],
): Set<string> {
  const types = new Set<string>();
  const globs = profile?.artifact_globs ?? {};
  const entries = Object.entries(globs);
  for (const file of changedFiles) {
    const norm = normalizePath(file);
    let matched = false;
    for (const [type, patterns] of entries) {
      if (patterns.some((p) => matchGlob(p, norm))) {
        types.add(type);
        matched = true;
      }
    }
    if (!matched) types.add(WIDEST_ARTIFACT);
  }
  return types;
}

/** Yol normalleştirme — baştaki "./" ve Windows "\" → "/" (stack-agnostik). */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** PhaseId → checkpoint kimliği. */
export function phaseCheckpointId(phase: PhaseId): string {
  return `phase-${phase}`;
}

/**
 * Bir checkpoint + stack + dokunulan-artefaktlardan uygulanabilir BankKey
 * listesi üret. Her artefakt-tipi için bir key (banka union'ı için). Saf —
 * disk okumaz.
 */
export function bankKeysFor(
  checkpoint: string,
  stack: StackId,
  artifacts: Iterable<string>,
): BankKey[] {
  const keys: BankKey[] = [];
  for (const artifact of new Set(artifacts)) {
    keys.push({ checkpoint, stack, artifact });
  }
  return keys;
}

/** Dosya-adı güvenli artefakt token'ı — WIDEST "*" → "_all". */
export function artifactFileToken(artifact: string): string {
  if (artifact === WIDEST_ARTIFACT) return "_all";
  return artifact.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * KEY → diskteki banka dosya yolu. SAF inşa (LLM seçimi yok):
 * <banksRoot>/<checkpoint>/<stack>/<artifact-token>.json
 */
export function bankKeyToPath(banksRoot: string, key: BankKey): string {
  return join(banksRoot, key.checkpoint, key.stack, `${artifactFileToken(key.artifact)}.json`);
}
