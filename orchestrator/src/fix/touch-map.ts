// fix/touch-map — D5 dokunuş haritası (Ümit: "hangi çözümü seçersem projede
// nerelere dokunur onları söylesin"). Seçilen çözümün plan özetinden dokunacağı
// dosyaları çıkarır + DETERMİNİSTİK bağımlılık grafiğiyle bu dosyaların
// blast-radius'unu hesaplar → "bu dosyaya dokunmak şunları etkiler" + yüksek-
// fanout regresyon uyarısı. Model üretmez; grafik üretir, kullanıcı görür.

import { isAbsolute, join } from "node:path";
import { log } from "../logger.js";
import { buildReverseImportGraph, getAffected } from "./dep-graph/index.js";
import { extractFilePaths } from "./evidence.js";

const MAX_AFFECTED_SHOWN = 8;

/**
 * Seçilen çözümün dokunuş haritasını markdown olarak döndürür. Plan özetinde
 * dosya yoksa null. Grafik kurulamazsa (analyzer/dosya yok) sadece dokunulan
 * dosyalar listelenir (blast-radius olmadan) — graceful.
 */
export async function buildTouchpointSummary(
  projectRoot: string,
  planSummary: string,
): Promise<string | null> {
  const files = extractFilePaths(planSummary);
  if (files.length === 0) return null;

  const touchList = files.map((f) => `- ${f}`).join("\n");
  let radius = "";
  try {
    const graph = await buildReverseImportGraph(projectRoot);
    if (graph.available) {
      const seeds = files.map((p) => (isAbsolute(p) ? p : join(projectRoot, p)));
      const affected = getAffected(graph, seeds, 2, projectRoot);
      if (affected.length > 0) {
        const top = affected
          .slice(0, MAX_AFFECTED_SHOWN)
          .map((a) => `  - ${a.module} — ${a.risk}`)
          .join("\n");
        const highCount = affected.filter((a) => a.risk === "high").length;
        radius =
          `\n\nBu dosyalara dokunmak şunları etkiler (deterministik):\n${top}` +
          (highCount > 0
            ? `\n⚠️ ${highCount} yüksek-fanout modül — regresyon riski yüksek.`
            : "");
      }
    }
  } catch (err) {
    log.warn("fix/touch-map", "grafik kurulamadı (non-fatal)", err);
  }

  return `🗺️ **Dokunuş haritası** — bu çözüm şu dosyalara dokunuyor:\n${touchList}${radius}`;
}
