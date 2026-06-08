// fix/dep-graph — dil-bağımsız reverse-import grafiği. Dosya başına uygun
// LanguageDependencyAnalyzer ile import'ları çıkar + proje-içi dosyalara çöz →
// forward kenarlar → ters çevir (reverse: dosya → onu import edenler).
//
// `getAffected(graph, seeds)` bir değişikliğin BLAST-RADIUS'unu deterministik
// hesaplar (Faz 0 D2). Model grafiği ÜRETMEZ — yorumlar. Analyzer yoksa /
// dosya yoksa `available:false` → caller kaba `plan_kind`'a graceful düşer.

import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { log } from "../../logger.js";
import type { LanguageDependencyAnalyzer } from "./analyzer.js";
import { createJsTsAnalyzer } from "./js-ts-analyzer.js";
import { createPythonAnalyzer } from "./python-analyzer.js";

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", ".git", ".mycl",
  "error_folder", "__pycache__", "venv", ".venv", "vendor", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".turbo",
]);
const MAX_FILES = 4000;

export type Risk = "high" | "medium" | "low";

export interface AffectedModule {
  /** Etkilenen modül (projectRoot'a göre relative, verilmişse). */
  module: string;
  /** Neden etkilenir — kısa, deterministik. */
  why: string;
  risk: Risk;
}

export interface DependencyGraph {
  /** dosya → onu import eden dosyalar (mutlak yollar). */
  reverse: Map<string, Set<string>>;
  /** dosya → import ettiği proje-içi dosyalar. */
  forward: Map<string, Set<string>>;
  fileCount: number;
  /** Grafik gerçekten kuruldu mu (analyzer + dosya vardı). false → kaba fallback. */
  available: boolean;
}

const EMPTY_GRAPH: DependencyGraph = {
  reverse: new Map(),
  forward: new Map(),
  fileCount: 0,
  available: false,
};

async function buildAnalyzers(): Promise<LanguageDependencyAnalyzer[]> {
  const list: LanguageDependencyAnalyzer[] = [];
  const jsts = await createJsTsAnalyzer();
  if (jsts) list.push(jsts);
  list.push(createPythonAnalyzer());
  return list;
}

function extOf(file: string): string {
  const d = file.lastIndexOf(".");
  return d >= 0 ? file.slice(d) : "";
}

async function collectSourceFiles(
  root: string,
  exts: Set<string>,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(full);
      } else if (e.isFile() && exts.has(extOf(e.name))) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Proje kökünden reverse-import grafiği kurar. Çok dilli (analyzer'ı olan her
 * dil). Hiç analyzer/dosya yoksa `available:false`.
 */
export async function buildReverseImportGraph(
  projectRoot: string,
): Promise<DependencyGraph> {
  const analyzers = await buildAnalyzers();
  if (analyzers.length === 0) return EMPTY_GRAPH;

  const exts = new Set<string>();
  for (const a of analyzers) for (const e of a.extensions) exts.add(e);
  const analyzerFor = (file: string): LanguageDependencyAnalyzer | null => {
    const ext = extOf(file);
    return analyzers.find((a) => a.extensions.includes(ext)) ?? null;
  };

  const files = await collectSourceFiles(projectRoot, exts);
  if (files.length === 0) return EMPTY_GRAPH;
  if (files.length >= MAX_FILES) {
    log.warn("dep-graph", `dosya sınırı ${MAX_FILES} aşıldı — grafik kısmi`, { projectRoot });
  }

  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();

  for (const file of files) {
    const az = analyzerFor(file);
    if (!az) continue;
    let content: string;
    try {
      content = await fs.readFile(file, "utf-8");
    } catch {
      continue;
    }
    const targets = new Set<string>();
    for (const spec of az.extractImports(file, content)) {
      const resolved = az.resolveModule(spec, file, projectRoot);
      if (resolved) targets.add(resolved);
    }
    forward.set(file, targets);
    for (const t of targets) {
      let importers = reverse.get(t);
      if (!importers) {
        importers = new Set();
        reverse.set(t, importers);
      }
      importers.add(file);
    }
  }

  return { reverse, forward, fileCount: files.length, available: true };
}

function isTestFile(p: string): boolean {
  const lower = p.toLowerCase();
  return (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes("__tests__") ||
    lower.includes("_test.") // go: foo_test.go
  );
}

function riskOf(module: string, depth: number, importerCount: number): Risk {
  if (isTestFile(module)) return "low";
  if (depth === 1 && importerCount >= 3) return "high";
  if (depth === 1) return "medium";
  return "low";
}

function riskRank(r: Risk): number {
  return r === "high" ? 3 : r === "medium" ? 2 : 1;
}

/**
 * `seedFiles` (değişecek dosyalar) verildiğinde, onları (dolaylı) import eden
 * modülleri `maxDepth` derinliğe kadar BFS ile döndürür — değişikliğin
 * blast-radius'u. `projectRoot` verilirse modül adları relative gösterilir.
 * Risk deterministik: doğrudan + çok-importer = high, doğrudan = medium,
 * dolaylı / test = low. Risk'e göre sıralı.
 */
export function getAffected(
  graph: DependencyGraph,
  seedFiles: string[],
  maxDepth = 2,
  projectRoot?: string,
): AffectedModule[] {
  if (!graph.available) return [];
  const result = new Map<string, { depth: number; importers: number }>();
  const visited = new Set<string>(seedFiles);
  let frontier = new Set<string>(seedFiles);

  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = new Set<string>();
    for (const f of frontier) {
      const importers = graph.reverse.get(f);
      if (!importers) continue;
      for (const imp of importers) {
        if (visited.has(imp)) continue;
        visited.add(imp);
        next.add(imp);
        if (!result.has(imp)) {
          result.set(imp, { depth, importers: graph.reverse.get(imp)?.size ?? 0 });
        }
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }

  const rel = (p: string): string => (projectRoot ? relative(projectRoot, p) : p);
  return [...result.entries()]
    .map(([module, info]) => ({
      module: rel(module),
      why:
        (info.depth === 1 ? "doğrudan import eder" : `${info.depth}. derece bağımlı`) +
        (info.importers > 0 ? ` (kendisini ${info.importers} modül kullanıyor)` : ""),
      risk: riskOf(module, info.depth, info.importers),
    }))
    .sort((a, b) => riskRank(b.risk) - riskRank(a.risk));
}

/**
 * #3 — getAffected çıktısını fix codegen'inin GÖRECEĞİ metne çevirir: codegen AI bağımlılık
 * blast-radius'unu grep'le yeniden keşfetmek zorunda kalmaz (token tasarrufu + dependent'i
 * gözden kaçırmama). Boşsa "" döner (gürültü yok). SAF — test edilebilir.
 */
export function formatBlastRadius(affected: AffectedModule[], max = 10): string {
  if (!affected || affected.length === 0) return "";
  const top = affected
    .slice(0, max)
    .map((a) => `- ${a.module} (${a.risk}: ${a.why})`)
    .join("\n");
  return `\n\n📊 Bağımlılık etki alanı (Faz 0 deterministik analizi — bu fix'in dokunduğu kök şunları etkiler; dokunurken gözden kaçırma):\n${top}`;
}
