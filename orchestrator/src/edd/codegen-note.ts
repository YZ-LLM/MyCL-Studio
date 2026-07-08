// edd/codegen-note — EDD davranış haritasını Faz 8 codegen'e enjekte edilecek NOTA çevir. YZLLM 2026-07-08 (EDD Faz 2).
//
// KANITLI BOŞLUK: Faz 8 codegen mevcut proje bilgisinin HİÇBİRİNİ almıyordu (yalnız PROJECT_ROOT + SPEC_PATH,
// phase-8.ts:432) → ajan var olan kodu her iterasyonda sıfırdan keşfediyor, mevcut davranışı bilmeden değiştirip
// kırabiliyor. EDD Faz 1 mevcut davranışı birim-birim belgeledi; bu modül o haritayı codegen'e İKİ kanalla verir:
//   (a) TAM harita on-demand → `.mycl/edd-analysis.md` (codegen dokunacağı birimin sözleşmesini okur; her boyuta ölçeklenir),
//   (b) ANAHTAR birimlerin sözleşmesi INLINE → anında zemin (dosyayı okumasa bile yük-taşıyan invariant'lar bağlamda).
//
// ÇERÇEVE (mahkeme öncelik-uzlaşması): bu BAĞLAM'dır, kısıt değil. Spec bir davranışı değiştirmek istiyorsa SPEC KAZANIR
// (foreign'de aktif consent kararı da EDD "koru"dan üstün — ama foreign'de consent kapısı erken-return, çakışma pratikte yok).
// Correct-by-construction (KATI#6): bilgiyle bozmayı ÖNLE — gate'le sonradan YAKALAMA.
//
// BAYAT KORUMASI (mahkeme Major, KATI#4): tam invalidasyon Faz 4'te. Ama Faz 2'de bile codegen bir dosyayı değiştirince
// o birimin EDD kaydı bayatlar; burada asgari korkuluk = inline seçilen her birimin GÜNCEL hash'ini analiz-anı hash'iyle
// karşılaştır → uyuşmazsa "⚠️ değişmiş, doğrula" işaretle (sessiz bayat kullanım YOK). Silinmiş birim inline edilmez.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { State } from "../types.js";
import { log } from "../logger.js";
import { readEddProgress, summarizeProgress, type EddUnitRecord } from "./progress.js";
import { safeSourceHash } from "./source-hash.js";

/** Inline gömülen anahtar birim sayısı (bounded: initialMessage şişmesin; gerisi on-demand dosyadan). */
const INLINE_TOP_UNITS = 8;
/** Inline birim başına invariant/side-effect satır tavanı (nota gürültü basmasın; kırpma GÖRÜNÜR "+N more" ile). */
const MAX_ITEMS_PER_UNIT = 6;

const ANALYSIS_MD = ".mycl/edd-analysis.md";

/** Bir liste alanını (invariants/side_effects) formatla; MAX_ITEMS üstü GÖRÜNÜR "+N more" ile kırpılır (sessiz değil). */
function formatList(label: string, items: string[], analysisExists: boolean): string[] {
  if (!items.length) return [];
  const lines = [`${label}:`];
  const shown = items.slice(0, MAX_ITEMS_PER_UNIT);
  for (const i of shown) lines.push(`- ${i}`);
  const extra = items.length - shown.length;
  if (extra > 0) {
    lines.push(
      analysisExists
        ? `- …and ${extra} more (see \`${ANALYSIS_MD}\`)`
        : `- …and ${extra} more (full list still being written — check \`${ANALYSIS_MD}\` once available)`,
    );
  }
  return lines;
}

function formatUnitContract(rec: EddUnitRecord, stale: boolean, analysisExists: boolean): string {
  const b = rec.behavior;
  if (!b) return "";
  const lines: string[] = [`### ${rec.unit}`];
  if (stale) {
    lines.push(
      "⚠️ CHANGED since it was last analyzed — the contract below may be outdated; verify against the current file " +
        "before relying on it.",
    );
  }
  if (b.what_it_does) lines.push(b.what_it_does);
  lines.push(...formatList("Invariants to preserve", b.invariants, analysisExists));
  lines.push(...formatList("Side effects", b.side_effects, analysisExists));
  return lines.join("\n");
}

/**
 * Foreign projede Faz 8 codegen'e enjekte edilecek EDD bağlam notunu üret. Belgelenmiş (done) birim yoksa undefined
 * (no-op; EDD henüz koşmadı/ilk batch bitmedi → not basma, sessiz-atlama değil: yoksa yok). ≤N anahtar birimin
 * sözleşmesi inline + tam haritaya (.mycl/edd-analysis.md) on-demand işaret (VARSA) + kısmi-kapsam dürüstlüğü.
 *
 * INLINE SEÇİMİ: readEddProgress Map'i taban-kayıt append sırasında (= EDD analiz anındaki enumerate merkezi-önce
 * sırası) kurar → ilk done birimler ilk-taramada merkezi olanlardır. SINIRLAMA (mahkeme minor, KABUL EDİLDİ, tam
 * çözüm Faz 4/gelecek): sıra TEK bir enumerate anına sabittir; resumable/artımlı koşuda SONRADAN merkezi olan bir
 * dosya kaydını hep sonraki konumda alır → inline top-N'e yükselemez. Bu yüzden not "en merkezi" İDDİA ETMEZ
 * (yalnız "anahtar birimler"); tam kapsam zaten on-demand dosyadadır. Bayat sözleşmeler hash ile işaretlenir.
 */
export async function buildEddCodegenNote(root: string): Promise<string | undefined> {
  let byUnit: Map<string, EddUnitRecord>;
  try {
    byUnit = await readEddProgress(root);
  } catch (e) {
    log.warn("edd/codegen-note", "edd-progress okunamadı — not yok", { error: String(e) });
    return undefined;
  }
  const s = summarizeProgress(byUnit);
  if (s.done === 0) return undefined;

  // edd-analysis.md render'ı throttle'lı (engine: her ~25 batch veya son) → done>0 olsa da büyük projede henüz
  // yazılmamış olabilir. VAR ise on-demand tam-harita işareti ver; YOKSA codegen'i var olmayan dosyaya yollama (KATI#4).
  const analysisExists = await fs
    .access(join(root, ".mycl", "edd-analysis.md"))
    .then(() => true)
    .catch(() => false);

  const inline: string[] = [];
  for (const rec of byUnit.values()) {
    if (inline.length >= INLINE_TOP_UNITS) break;
    if (rec.status !== "done" || !rec.behavior) continue;
    const abs = join(root, ...rec.unit.split("/"));
    const h = await safeSourceHash(abs); // boyut/silinme güvenli (mahkeme Major — dev dosyayı belleğe almaz)
    if (h.gone || h.tooLarge) continue; // silinmiş/dev-olmuş birim → inline etme (var olmayan/anormal davranış basma)
    const stale = rec.hash !== undefined && h.hash !== undefined && h.hash !== rec.hash;
    const block = formatUnitContract(rec, stale, analysisExists);
    if (block) inline.push(block);
  }
  if (inline.length === 0) return undefined;

  const coverage =
    `${s.done}/${s.total} unit documented` +
    (s.pending > 0 ? `, ${s.pending} still pending (analysis continues in the background)` : "") +
    (s.unanalyzable > 0 ? `, ${s.unanalyzable} unanalyzable` : "");

  // On-demand tam-harita talimatı YALNIZ dosya varsa (yoksa codegen'i boş dosyaya yollama).
  const mapPointer = analysisExists
    ? `The full map is in \`${ANALYSIS_MD}\`. BEFORE you modify any EXISTING file, read its entry there to learn ` +
      "the invariants and side-effects its callers rely on.\n\n"
    : "";

  return (
    "\n\n---\n## EXISTING project behavior (EDD — Integration-Driven Define)\n" +
    "This is an EXISTING codebase that MyCL is extending. Its current behavior has been analyzed unit-by-unit " +
    `(${coverage})` +
    (analysisExists ? ` and documented in \`${ANALYSIS_MD}\`.\n\n` : ".\n\n") +
    "RULE — this is CONTEXT, not a constraint: preserve the existing behavior/invariants/side-effects UNLESS this " +
    "iteration's spec explicitly requires changing them. When the spec and this context conflict, the SPEC WINS. " +
    "Just do NOT break an UNRELATED existing behavior as a side effect of your change.\n\n" +
    mapPointer +
    "Key units from the analysis are inlined here for immediate grounding:\n\n" +
    inline.join("\n\n") +
    "\n"
  );
}

/**
 * Foreign köken + EDD analizi varsa `state.pending_edd_context_note`'u kur (Faz 8 codegen KURULMADAN önce, consent
 * kapısından hemen sonra çağrılır). MyCL kökeninde EDD koşmaz → no-op (alan undefined kalır). Best-effort: not
 * üretilemezse alan undefined (bloke ETMEZ — mevcut davranış aynen; KATI#4 dürüst: hata loglanır, sessiz-yutma yok).
 * Her koşuda taze üretilir → önceki iterasyonun notu sızmaz (consent-note deseni).
 */
export async function attachEddCodegenNote(state: State): Promise<void> {
  state.pending_edd_context_note = undefined;
  if (state.origin !== "foreign") return;
  try {
    state.pending_edd_context_note = await buildEddCodegenNote(state.project_root);
  } catch (e) {
    log.warn("edd/codegen-note", "EDD codegen notu üretilemedi (bloke etmez)", { error: String(e) });
  }
}
