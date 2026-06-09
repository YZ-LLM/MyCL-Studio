// onboarding/project-map — YABANCI projeye hakimiyet (MyCL'in yaratmadığı, ilk gördüğü proje).
//
// Felsefe (hafıza: project_onboard_existing_codebase): yabancı projede "neden" yoktur (decisions/handoff yok),
// yalnız KOD + git vardır → hakimiyeti KODDAN türet. Ağır graph DB / paralel "dijital ikiz" YOK (turbogrep dersi);
// mevcut `fix/dep-graph` (reverse-import) ile HAFİF bir harita: "en merkezi modüller = önce buraya bak, dokunursan
// etkisi geniş". Orkestratör recall'ına enjekte edilir → AI ilk turdan projenin iskeletini bilir.

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildReverseImportGraph } from "../fix/dep-graph/index.js";
import { getRecentCommits } from "../git.js";

export interface ProjectMap {
  available: boolean;
  /** Grafikteki dosya sayısı (proje büyüklüğü kabası). */
  fileCount: number;
  /** En çok import edilen (merkezi/taşıyıcı) modüller — yabancı projede ilk bakılacak yerler. */
  central: Array<{ file: string; importedBy: number }>;
  /** git-intent: yabancı projede "neden/ne" — README özeti + son commit yönü (hafif, LLM'siz). */
  background: string;
}

/** README + son commit'lerden "proje arka planı" (yabancı koda hakimiyet; deterministik, LLM yok). */
async function buildBackground(projectRoot: string): Promise<string> {
  const parts: string[] = [];
  // README (varsa) — projenin ne olduğu / niyeti.
  for (const name of ["README.md", "readme.md", "README"]) {
    try {
      const txt = (await readFile(join(projectRoot, name), "utf-8")).trim();
      if (txt) {
        parts.push(`README (özet):\n${txt.slice(0, 1200)}`);
        break;
      }
    } catch {
      // yok → sıradaki
    }
  }
  // Son commit'ler — projenin son yönü/aktivitesi.
  try {
    const commits = await getRecentCommits(projectRoot, 12);
    if (commits.length > 0) {
      parts.push(`Son commit'ler (yön):\n${commits.map((c) => `- ${c.subject}`).join("\n")}`);
    }
  } catch {
    // git yok / hata → atla
  }
  return parts.join("\n\n");
}

/**
 * Projenin bağımlılık haritasından merkezi modülleri çıkarır (reverse-import sayısına göre). SAF değil
 * (dosya okur) ama deterministik. git/analyzer yoksa available:false (sessiz — onboarding opsiyonel bağlam).
 */
export async function buildProjectMap(projectRoot: string, topN = 12): Promise<ProjectMap> {
  const background = await buildBackground(projectRoot); // git-intent (README + commit yönü)
  const graph = await buildReverseImportGraph(projectRoot);
  const central = graph.available
    ? [...graph.reverse.entries()]
        .map(([file, importers]) => ({ file: relative(projectRoot, file), importedBy: importers.size }))
        .filter((e) => e.importedBy > 0)
        .sort((a, b) => b.importedBy - a.importedBy)
        .slice(0, topN)
    : [];
  // available: dep-graph YA DA arka plan varsa (kod-yok ama README/git olan projede de hakimiyet sağla).
  return {
    available: graph.available || background.length > 0,
    fileCount: graph.available ? graph.reverse.size : 0,
    central,
    background,
  };
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
  if (!map.available) return "";
  const sections: string[] = [];
  if (map.central.length > 0) {
    const lines = map.central
      .map((c) => `- ${c.file} (${c.importedBy} modül tarafından kullanılıyor)`)
      .join("\n");
    sections.push(
      `### Proje haritası (yabancı koda hakimiyet — en merkezi modüller; dokunurken etkisi geniş)\n${lines}`,
    );
  }
  if (map.background) {
    sections.push(`### Proje arka planı (git-intent — yabancı projede "neden/ne")\n${map.background}`);
  }
  return sections.join("\n\n");
}
