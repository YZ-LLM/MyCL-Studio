// module-parallel/dispatch — paralel codegen DISPATCH motoru (gated + fail-closed).
//
// Akış: gate (independence) → her modül için izole git worktree → worker'ları PARALEL koş →
// hepsi başarılıysa disjoint değişiklikleri ana ağaca SERİ entegre et → worktree'leri temizle.
// Her aşama FAIL-CLOSED: gate/worktree/worker/entegrasyon hatası → temizle + caller SERİ yapsın.
// `runWorker` ENJEKTE edilir → motor mock worker + gerçek git fixture ile uçtan uca test edilebilir;
// gerçek worker (worktree'de scoped codegen) ayrı + opt-in wire'lanır (bu ortamda doğrulanamaz).

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createWorktree, removeWorktree, getChangedFiles } from "../git.js";
import { log } from "../logger.js";
import { shouldParallelize, pathWithin, type ModuleScope } from "./independence.js";

/** Bir paralel modül: ayrık kapsam + worker'a verilecek görev. */
export interface ModuleWork extends ModuleScope {
  /** Worker'ın bu worktree'de ne yazacağı (görev metni). */
  brief: string;
}

/** Bir modülü izole worktree'de çalıştıran fonksiyon. Gerçek = scoped codegen; test = mock. */
export type RunWorker = (
  module: ModuleWork,
  worktreePath: string,
) => Promise<{ ok: boolean; error?: string }>;

export interface ParallelOutcome {
  /** false → gate geçmedi, caller SERİ yapmalı. */
  parallel: boolean;
  reason: string;
  /** parallel=true iken: tüm worker'lar başarılı + entegrasyon temiz mi? false → caller seri fallback. */
  ok?: boolean;
  /** Entegre edilen göreli dosya yolları (ok=true iken). */
  integratedFiles?: string[];
  /** Başarısızlık/çakışma detayları (ok=false iken). */
  failures?: string[];
}

/**
 * Worktree'lerdeki disjoint değişiklikleri ana ağaca kopyalar. Defense-in-depth: her dosya modülün
 * KAPSAMINDA olmalı (değilse fail) ve İKİ modül aynı dosyaya dokunmamış olmalı (değilse fail). SAF mantık +
 * dosya kopyası. ok=false → hiçbir şey kalıcı yapılmamalı (caller seri fallback).
 */
async function integrateWorktrees(
  projectRoot: string,
  wts: Array<{ module: ModuleWork; path: string }>,
): Promise<{ ok: boolean; files: string[]; reason: string; conflicts?: string[] }> {
  const claimed = new Map<string, string>(); // dosya → modül id
  const toCopy: Array<{ file: string; from: string }> = [];
  for (const w of wts) {
    const changed = await getChangedFiles(w.path); // göreli, .mycl/error_folder hariç
    for (const f of changed) {
      if (!w.module.scope_paths.some((p) => pathWithin(f, p))) {
        return { ok: false, files: [], reason: `kapsam-dışı yazım: "${w.module.id}" → ${f}`, conflicts: [f] };
      }
      const prev = claimed.get(f);
      if (prev) {
        return { ok: false, files: [], reason: `çakışan dosya: ${f} (${prev} + ${w.module.id})`, conflicts: [f] };
      }
      claimed.set(f, w.module.id);
      toCopy.push({ file: f, from: join(w.path, f) });
    }
  }
  // Tüm kontroller temiz → ana ağaca kopyala (yollar disjoint → çakışmasız).
  for (const c of toCopy) {
    const dest = join(projectRoot, c.file);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(c.from, dest);
  }
  return { ok: true, files: toCopy.map((c) => c.file), reason: "entegre" };
}

/**
 * ≥2 ayrık modülü izole worktree'lerde PARALEL koşar + disjoint sonuçları seri entegre eder.
 * Gate geçmezse {parallel:false} (caller seri). Worker/worktree/entegrasyon hatası → temizle +
 * {parallel:true, ok:false} (caller seri fallback). FAIL-CLOSED — seri varsayılan asla bozulmaz.
 */
export async function runParallelModules(
  projectRoot: string,
  modules: ModuleWork[],
  opts: { enabled: boolean },
  runWorker: RunWorker,
): Promise<ParallelOutcome> {
  const gate = shouldParallelize(modules, opts);
  if (!gate.parallel) return { parallel: false, reason: gate.reason };

  // 1) İzole worktree'ler
  const wts: Array<{ module: ModuleWork; path: string }> = [];
  const cleanup = async (): Promise<void> => {
    for (const w of wts) await removeWorktree(projectRoot, w.path);
  };
  for (const m of modules) {
    const wt = await createWorktree(projectRoot, m.id);
    if (!wt) {
      await cleanup();
      return { parallel: false, reason: `worktree kurulamadı (${m.id}) → seri` };
    }
    wts.push({ module: m, path: wt.path });
  }

  // 2) Worker'ları PARALEL koş (her biri kendi worktree'sinde)
  const results = await Promise.allSettled(wts.map((w) => runWorker(w.module, w.path)));
  const failures: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") failures.push(`${wts[i].module.id}: ${String(r.reason)}`);
    else if (!r.value.ok) failures.push(`${wts[i].module.id}: ${r.value.error ?? "fail"}`);
  });
  if (failures.length > 0) {
    await cleanup();
    log.warn("module-parallel", "worker hatası → seri fallback", { failures });
    return { parallel: true, ok: false, reason: "worker hatası → seri fallback", failures };
  }

  // 3) Disjoint entegrasyon
  const integration = await integrateWorktrees(projectRoot, wts);
  await cleanup();
  if (!integration.ok) {
    log.warn("module-parallel", "entegrasyon başarısız → seri fallback", { reason: integration.reason });
    return { parallel: true, ok: false, reason: integration.reason, failures: integration.conflicts };
  }
  return {
    parallel: true,
    ok: true,
    reason: `${modules.length} modül paralel + entegre (${integration.files.length} dosya)`,
    integratedFiles: integration.files,
  };
}
