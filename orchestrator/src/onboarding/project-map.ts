// onboarding/project-map — YABANCI projeye hakimiyet (MyCL'in yaratmadığı, ilk gördüğü proje).
//
// Felsefe (hafıza: project_onboard_existing_codebase): yabancı projede "neden" yoktur (decisions/handoff yok),
// yalnız KOD + git vardır → hakimiyeti KODDAN türet. Ağır graph DB / paralel "dijital ikiz" YOK (turbogrep dersi);
// mevcut `fix/dep-graph` (reverse-import) ile HAFİF bir harita: "en merkezi modüller = önce buraya bak, dokunursan
// etkisi geniş". Orkestratör recall'ına enjekte edilir → AI ilk turdan projenin iskeletini bilir.

import { relative } from "node:path";
import { buildReverseImportGraph } from "../fix/dep-graph/index.js";

export interface ProjectMap {
  available: boolean;
  /** Grafikteki dosya sayısı (proje büyüklüğü kabası). */
  fileCount: number;
  /** En çok import edilen (merkezi/taşıyıcı) modüller — yabancı projede ilk bakılacak yerler. */
  central: Array<{ file: string; importedBy: number }>;
}

/**
 * Projenin bağımlılık haritasından merkezi modülleri çıkarır (reverse-import sayısına göre). SAF değil
 * (dosya okur) ama deterministik. git/analyzer yoksa available:false (sessiz — onboarding opsiyonel bağlam).
 */
export async function buildProjectMap(projectRoot: string, topN = 12): Promise<ProjectMap> {
  const graph = await buildReverseImportGraph(projectRoot);
  if (!graph.available) return { available: false, fileCount: 0, central: [] };
  const central = [...graph.reverse.entries()]
    .map(([file, importers]) => ({ file: relative(projectRoot, file), importedBy: importers.size }))
    .filter((e) => e.importedBy > 0)
    .sort((a, b) => b.importedBy - a.importedBy)
    .slice(0, topN);
  return { available: true, fileCount: graph.reverse.size, central };
}

// Proje-başına cache: harita oturum içinde sabit (yapı yavaş değişir) → her orkestratör turunda
// yeniden tarama yapma. open_project'te clearProjectMapCache ile sıfırlanır.
const _cache = new Map<string, ProjectMap>();

/** Cache'li harita: ilk çağrı hesaplar (yabancı projeyi tarar), sonrakiler cache. */
export async function getCachedProjectMap(projectRoot: string): Promise<ProjectMap> {
  const hit = _cache.get(projectRoot);
  if (hit) return hit;
  const m = await buildProjectMap(projectRoot);
  _cache.set(projectRoot, m);
  return m;
}

/** Cache'i SADECE okur (hesaplamaz, bloklamaz) — context-builder her turda bunu kullanır. */
export function peekProjectMap(projectRoot: string): ProjectMap | undefined {
  return _cache.get(projectRoot);
}

/** open_project'te çağrılır — proje değişince eski harita kalmasın. */
export function clearProjectMapCache(): void {
  _cache.clear();
}

/** ProjectMap'i orkestratör bağlamına enjekte edilecek metne çevirir. Boşsa "" (gürültü yok). SAF. */
export function formatProjectMap(map: ProjectMap): string {
  if (!map.available || map.central.length === 0) return "";
  const lines = map.central
    .map((c) => `- ${c.file} (${c.importedBy} modül tarafından kullanılıyor)`)
    .join("\n");
  return `### Proje haritası (yabancı koda hakimiyet — en merkezi modüller; dokunurken etkisi geniş)\n${lines}`;
}
