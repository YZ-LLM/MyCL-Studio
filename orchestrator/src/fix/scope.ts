// fix/scope — "değişen kapsam" hesabı: git diff ile değişen kaynak dosyalar +
// bağımlılık-grafiği blast-radius'u. Scoped mekanik gate'ler (Faz 10/13/14)
// bunu kullanır → lint/güvenlik/birim-test yalnız değişen koda + onu import
// edenlere koşar. Tamamen deterministik (git + AST grafiği; LLM yok).
//
// Boş kapsam (değişiklik yok / git yok) → available:false → caller tüm-proje
// fallback yapar (asla "temiz" varsayma — false-confidence engeli).

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getChangedFiles } from "../git.js";
import { log } from "../logger.js";
import { buildReverseImportGraph, getAffected } from "./dep-graph/index.js";
import { hasSourceExt } from "./evidence.js";

export interface ChangedScope {
  /** Değişen kaynak dosyalar ∪ blast-radius (projectRoot-relative). */
  files: string[];
  /** Kapsam hesaplanabildi mi (değişiklik vardı). false → tüm-proje fallback. */
  available: boolean;
  /** Diff tabanı (checkpoint ref, varsa) — audit/debug. */
  since?: string;
}

const BLAST_RADIUS_DEPTH = 2;

/**
 * Scope'lanamayan sistem-seviye mekanik fazlar — scoped-touch modunda atlanır
 * (tam taramada/büyük milestone'da koşar). Sadeleştirme(11)/Perf(12)/
 * Entegrasyon(15)/Load(17): doğası gereği tüm-graf/tüm-sistem. Lint(10)/
 * Güvenlik(13)/Birim(14) scoped veya tüm-proje koşmaya devam eder.
 */
export const SCOPED_SKIP_PHASES: ReadonlySet<number> = new Set([11, 12, 15, 17]);

/**
 * Scoped-touch modu mu (değişen kapsama daralt) yoksa full mod mu (greenfield/
 * ilk build → tüm gate'ler tüm-proje)? İterasyon > 1 veya fix checkpoint'i
 * varsa scoped. İlk iterasyon + fix yok → full (büyük milestone).
 */
export function shouldComputeScope(state: {
  iteration_count?: number;
  fix_checkpoint_ref?: string;
}): boolean {
  return (state.iteration_count ?? 1) > 1 || Boolean(state.fix_checkpoint_ref);
}

/**
 * Değişen kapsamı hesapla. `since` (checkpoint ref) verilirse o commit'ten bu
 * yana; yoksa HEAD'den. Kaynak-dışı (package.json, README) ve silinmiş dosyalar
 * elenir; kalan değişenler + onları import edenler (blast-radius) birleşir.
 */
export async function computeChangedScope(
  projectRoot: string,
  since?: string,
): Promise<ChangedScope> {
  let changed: string[] = [];
  try {
    changed = await getChangedFiles(projectRoot, since);
  } catch (err) {
    log.warn("fix/scope", "getChangedFiles failed (non-fatal)", err);
  }

  // Yalnız var-olan kaynak dosyalar (lint/test argümanı olabilir; silinmiş/
  // kaynak-dışı elenir).
  const changedSource = changed.filter(
    (f) => hasSourceExt(f) && existsSync(join(projectRoot, f)),
  );
  if (changedSource.length === 0) {
    return { files: [], available: false, since };
  }

  const all = new Set<string>(changedSource);
  try {
    const graph = await buildReverseImportGraph(projectRoot);
    if (graph.available) {
      const seeds = changedSource.map((f) => (isAbsolute(f) ? f : join(projectRoot, f)));
      for (const a of getAffected(graph, seeds, BLAST_RADIUS_DEPTH, projectRoot)) {
        if (hasSourceExt(a.module)) all.add(a.module);
      }
    }
  } catch (err) {
    log.warn("fix/scope", "blast-radius failed (changed files only)", err);
  }

  return { files: [...all], available: true, since };
}
