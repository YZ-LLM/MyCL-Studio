// fix/scope — "değişen kapsam" hesabı: git diff ile değişen kaynak dosyalar +
// bağımlılık-grafiği blast-radius'u. Scoped mekanik gate'ler (Faz 10/13/14)
// bunu kullanır → lint/güvenlik/birim-test yalnız değişen koda + onu import
// edenlere koşar. Tamamen deterministik (git + AST grafiği; LLM yok).
//
// Ümit 2026-06-12 "yalnız değişen dosyaları denetle": git YOKSA (non-git proje, örn. adminpanel) git diff boş
// dönüyor → eskiden scoped HİÇ uygulanmıyor, gate'ler tüm-projeyi tarayıp ALAKASIZ açık (survey-sanitize) flag'liyordu.
// Çözüm: git boşsa codegen'in AUDIT'e yazdığı dosyalardan (tdd-prod-write/code-edit/ui-file-write) değişen-dosya türet.
// Boş kapsam (değişiklik yok / git+audit ikisi de boş) → available:false → caller tüm-proje fallback (false-confidence engeli).

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getChangedFiles } from "../git.js";
import { readAuditLog } from "../audit.js";
import { log } from "../logger.js";
import { buildReverseImportGraph, getAffected } from "./dep-graph/index.js";
import { hasSourceExt } from "./evidence.js";

// Dosyaya yazan/değiştiren TÜM audit event'leri — hepsinin detail'i file_path.
// EKSİK-kapsam tehlikeli (gate dokunulan dosyayı atlar → false-green), fazla-kapsam
// zararsız (zaten yalnız codegen'in dokunduğu dosyalar, tüm-proje değil) → kuşkuda DAHİL ET.
// Faz 8: tdd-prod-write/tdd-test-write/code-edit · Faz 5: ui-file-write (Write) / ui-tweak-applied (Edit).
const WRITE_EVENTS: ReadonlySet<string> = new Set([
  "tdd-prod-write",
  "tdd-test-write",
  "code-edit",
  "ui-file-write",
  "ui-tweak-applied",
]);

/** Non-git fallback: codegen'in bu iterasyonda yazdığı dosyalar (audit write-event'lerinden). Deterministik. */
async function changedFilesFromAudit(projectRoot: string, sinceTs: number): Promise<string[]> {
  const events = await readAuditLog(projectRoot).catch(() => []);
  const out = new Set<string>();
  for (const e of events) {
    if (e.ts < sinceTs || !e.detail) continue;
    if (WRITE_EVENTS.has(e.event)) {
      // detail = file_path (hepsi). Claude Code tool'ları MUTLAK yol verir → projeye göre
      // relative'e indir (getChangedFiles ile tutarlı); zaten relative ise olduğu gibi kalır.
      const t = e.detail.trim();
      const rel = t.startsWith(projectRoot) ? t.slice(projectRoot.length).replace(/^[/\\]+/, "") : t;
      if (rel) out.add(rel);
    }
  }
  return [...out];
}

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
  iterationStartTs?: number,
): Promise<ChangedScope> {
  let changed: string[] = [];
  try {
    changed = await getChangedFiles(projectRoot, since);
  } catch (err) {
    log.warn("fix/scope", "getChangedFiles failed (non-fatal)", err);
  }
  // Ümit 2026-06-12: git diff boş (non-git proje / git yok) → audit write-event'lerinden değişen dosyaları türet
  // → scoped non-git'te de çalışır ("yalnız değişen dosyaları denetle"; yoksa full → alakasız flag).
  if (changed.length === 0 && iterationStartTs !== undefined) {
    changed = await changedFilesFromAudit(projectRoot, iterationStartTs).catch(() => []);
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
