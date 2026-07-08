// edd/grounding — EDD davranış haritasının KOMPAKT (bir-satırlık) genel-bakışı. YZLLM 2026-07-08 (EDD Faz 3).
//
// AMAÇ: Faz 1 (niyet) ve Faz 9 (risk incelemesi) ajanları mevcut davranıştan HABERDAR olsun → iş-listesi-dışı bir
// istek / bir değişiklik var olan davranışa dokunuyorsa daha yerinde netleştirme/karar. Faz 2'den FARKI: bu BREADTH
// (genişlik) zeminidir — birim başına bir-satır "ne yapar" (invariant/side-effect DEĞİL); Faz 2 codegen'e DEPTH verir.
//
// İKİ KANAL (mahkeme Major düzeltmesi): qa-askq fazları (Faz 1/2/9) VARSAYILAN (auto→cli) yapılandırmada Read/Grep/Glob'lu
// koşar (qa-askq-cli-backend.ts:251) → dosya OKUYABİLİR. Bu yüzden zemin: (a) INLINE kompakt özet (Read'siz API yolu da
// bağlam alır) + (b) `.mycl/edd-analysis.md` on-demand pointer (VARSA; "dosya erişimin varsa" koşullu → Read'li CLI ajanı
// tam sözleşmeleri okur, Read'siz API ajanı zararsızca yok sayar). Pointer analysisExists ile guard'lı (KATI#4: var
// olmayan dosyaya yollamaz — Faz 2 codegen-note deseni). Bounded (MAX): büyük projede prompt şişmesin.
//
// BAYATLIK: bir-satırlık "ne yapar" nadiren değişir + bu zemin FARKINDALIK içindir (edit yönlendirmez, Faz 2 öyle) →
// jenerik görünür caveat yeterli (KATI#4: sessiz değil). Silinmiş dosya (var olmayan davranış) listelenmez. Tam
// per-birim invalidasyon Faz 4. Yalnız foreign kökende anlamlı (MyCL projede EDD koşmaz).

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { State } from "../types.js";
import { log } from "../logger.js";
import { readEddProgress, summarizeProgress } from "./progress.js";

/** Inline listelenen azami birim (bir-satırlık → bol; ama prompt bounded kalsın; gerisi "N more" ile görünür). */
const MAX_OVERVIEW_UNITS = 50;
/** Bir-satır özet karakter tavanı (uzun what_it_does prompt'u şişirmesin). */
const ONE_LINER_MAX = 200;

function oneLiner(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > ONE_LINER_MAX ? t.slice(0, ONE_LINER_MAX - 1) + "…" : t;
}

async function fileExists(abs: string): Promise<boolean> {
  return fs.access(abs).then(() => true).catch(() => false);
}

/**
 * Mevcut davranışın KOMPAKT genel-bakışı (foreign). Belgelenmiş (done + what_it_does dolu) birim yoksa undefined. ≤MAX
 * birim bir-satır "ne yapar"; silinmiş dosyalar atlanır (var olmayan davranış basma); kısmi/truncate GÖRÜNÜR. Read'li
 * ajanlar için `.mycl/edd-analysis.md` on-demand pointer (VARSA) — koşullu ("dosya erişimin varsa") + guard'lı.
 */
export async function buildEddGroundingOverview(root: string): Promise<string | undefined> {
  let byUnit;
  try {
    byUnit = await readEddProgress(root);
  } catch (e) {
    log.warn("edd/grounding", "edd-progress okunamadı — zemin yok", { error: String(e) });
    return undefined;
  }
  const s = summarizeProgress(byUnit);
  if (s.done === 0) return undefined;

  const lines: string[] = [];
  let shown = 0;
  let skippedGone = 0; // done ama dosya silinmiş
  let skippedEmpty = 0; // done ama what_it_does boş (analyzer alanı atladı) — bkz notShown hesabı
  for (const rec of byUnit.values()) {
    if (shown >= MAX_OVERVIEW_UNITS) break;
    if (rec.status !== "done") continue;
    if (!rec.behavior?.what_it_does) {
      skippedEmpty++;
      continue;
    }
    // Silinmiş birimi listeleme (var olmayan davranış). Ucuz access (hash okuması değil — bu breadth zemini).
    if (!(await fileExists(join(root, ...rec.unit.split("/"))))) {
      skippedGone++;
      continue;
    }
    lines.push(`- ${rec.unit}: ${oneLiner(rec.behavior.what_it_does)}`);
    shown++;
  }
  if (shown === 0) return undefined;

  // notShown: belgelenmiş ama gösterilmeyen birim. skippedGone + skippedEmpty AYRI düşülür (mahkeme minor: aksi halde
  // boş-what_it_does'lu done birimler s.done'da sayılıp buradan düşülmeyince mesaj şişerdi).
  const notShown = Math.max(0, s.done - shown - skippedGone - skippedEmpty);
  const coverageBits =
    `${s.done}/${s.total} unit documented` +
    (s.pending > 0 ? `, ${s.pending} still pending` : "") +
    (s.unanalyzable > 0 ? `, ${s.unanalyzable} unanalyzable` : "");

  const analysisExists = await fileExists(join(root, ".mycl", "edd-analysis.md"));
  const pointer = analysisExists
    ? "\n\nThe full per-unit contracts (invariants, side-effects) are in `.mycl/edd-analysis.md` — if you have file " +
      "access, read the entries for the units you're reasoning about."
    : "";

  return (
    "\n\n---\n## EXISTING project behavior — overview (EDD)\n" +
    "This is an EXISTING codebase MyCL is extending. Below is a compact map of what it CURRENTLY does " +
    `(${coverageBits}), as documented by EDD's analysis (may predate very recent changes).\n` +
    "Use it as CONTEXT: when the request or a change touches an existing behavior below, account for it / clarify " +
    "carefully rather than assuming a clean slate. This is not a constraint — the spec still drives what changes.\n\n" +
    lines.join("\n") +
    (notShown > 0 ? `\n- …and ${notShown} more unit(s) not shown here.` : "") +
    pointer +
    "\n"
  );
}

/**
 * Foreign köken + EDD analizi varsa kompakt zemin genel-bakışını döndür; değilse undefined (MyCL'de EDD koşmaz → no-op).
 * Best-effort: hata → undefined (bloke etmez; KATI#4 dürüst: loglanır). Faz 1/9 prompt'una eklemek için tek giriş.
 */
export async function eddGroundingForState(state: State): Promise<string | undefined> {
  if (state.origin !== "foreign") return undefined;
  try {
    return await buildEddGroundingOverview(state.project_root);
  } catch (e) {
    log.warn("edd/grounding", "EDD zemini üretilemedi (bloke etmez)", { error: String(e) });
    return undefined;
  }
}
