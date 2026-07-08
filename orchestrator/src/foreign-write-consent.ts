// foreign-write-consent — MyCL, ENTEGRE (foreign) bir projede YABANCI kodu OTONOM olarak değiştirmeden önce
// (Faz 9 risk-fix dispatch gibi kullanıcının doğrudan istemediği yazımlar) kullanıcıdan onay ister. YZLLM 2026-07-08.
//
// NEDEN (keşif bulgusu): `dispatchRiskFixes` oto-cevaptan BAĞIMSIZ çalışıyor + `behavior-consent-gate` foreign'de
// erken-return ediyor → bugün foreign kod onaysız değişebiliyor (mahkemenin UNSAFE kökü). Bu kapı o deliği kapatır.
//
// Desen: behavior-consent-gate.ts AYNEN yansıtılır — pending map + emitConsentAskq (DOĞRUDAN emitAskq; oto-cevap
// allowlist'inden GEÇMEZ, bu karar HER ZAMAN kullanıcıda) + resolver + id-öneki predicate + handleAskqAnswer kancası.
// EDD davranış haritasından (edd/progress) "dokunulan mevcut davranış" özeti gösterilir → kullanıcı bilerek karar verir.
//
// ANTİ-FALSE-SAFE (en kritik kural): "EDD kaydı yok = güvenli" ÇIKARIMI YASAK — birim henüz analiz edilmemiş olabilir.
// unknown/pending/unanalyzable GÖRÜNÜR yapılır + yine de açık onay istenir; hiçbir eksik-veri sessiz oto-onaya dönmez.
// origin!=="foreign" → tüm giriş no-op (items değiştirilmeden döner) → MyCL projelerde byte-aynı davranış.

import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import type { MyclConfig } from "./config.js";
import type { State } from "./types.js";
import { emitAskq, emitChatMessage } from "./ipc.js";
import { translate } from "./translator.js";
import { log } from "./logger.js";
import { readEddProgress, summarizeProgress, type EddUnitRecord } from "./edd/progress.js";
import { buildReverseImportGraph, getAffected, type AffectedModule } from "./fix/dep-graph/index.js";

const CONSENT_ID_PREFIX = "foreign_write_consent_";
const APPLY_ALL = "Hepsini uygula";
const APPLY_SELECTED = "Yalnız seçtiklerim";
const APPLY_NONE = "Hiçbirini (bu tur atla)";
const ITEM_APPLY = "Uygula";
const ITEM_SKIP = "Atla";
/** Onay ekranında birim başına gösterilen azami invariant + item başına azami belgelenmiş birim (gürültü sınırı). */
const MAX_INVARIANTS = 4;
const MAX_DOC_UNITS = 6;

/** MyCL'in otonom olarak yabancı kodu değiştireceği tek bir iş (ör. bir risk-fix). */
export interface ForeignWriteItem {
  /** kararı denetim/loglama + onaylı alt-küme eşlemesi için sabit kimlik. */
  key: string;
  /** kısa kullanıcı-yüzlü özet (fix detayı/risk). */
  label: string;
  /** bu yazımın dokunacağı MUTLAK dosya yolları (best-effort; boş olabilir). */
  seedFiles: string[];
}

export type TouchedCoverage = "documented" | "pending" | "unanalyzable" | "unknown";

export interface TouchedBehavior {
  /** projectRoot'a göre relative birim yolu. */
  unit: string;
  coverage: TouchedCoverage;
  what_it_does?: string;
  invariants?: string[];
  reason?: string;
}

// ── askq makinesi (behavior-consent-gate deseni) ────────────────────────────────────────────────
const pendingConsent = new Map<string, (sel: string) => void>();

function emitConsentAskq(question: string, options: string[]): Promise<string> {
  const id = `${CONSENT_ID_PREFIX}${randomUUID()}`;
  return new Promise<string>((resolve) => {
    pendingConsent.set(id, resolve);
    // DOĞRUDAN emitAskq — oto-cevap allowlist'ine UĞRAMAZ (yabancı-yazma kararı her zaman kullanıcıda).
    emitAskq({ id, question, options });
  });
}

/** index.ts/handleAskqAnswer bir foreign_write_consent_* cevabını buraya yollar. İşlendiyse true. */
export function resolveForeignWriteConsent(id: string, selected: string): boolean {
  const resolve = pendingConsent.get(id);
  if (!resolve) return false;
  pendingConsent.delete(id);
  resolve(selected);
  return true;
}

export function isForeignWriteConsentAskqId(id: string): boolean {
  return id.startsWith(CONSENT_ID_PREFIX);
}

async function trText(config: MyclConfig, en: string): Promise<string> {
  if (!en.trim()) return en;
  try {
    return (await translate(config, en, "en-to-tr")).text;
  } catch {
    return en; // çeviri başarısızsa İngilizce göster: metin yine GÖRÜNÜR (KATI#4 — sessiz kayıp değil)
  }
}

// ── SAF: dokunulan-davranış özeti (EDD haritasından) ────────────────────────────────────────────
/**
 * SAF + test edilebilir: seed (değişecek dosyalar) + affected (bağımlılar) birimlerini EDD kayıtlarıyla eşle →
 * her benzersiz birim için kapsam sınıfı. done+behavior → documented; pending → pending; unanalyzable → +reason;
 * KAYIT YOK → "unknown" (KAPSAM BELİRSİZ, asla düşürülmez — anti-false-safe). Risk'e/kapsama göre değil, önce
 * documented gelecek şekilde sıralı (kullanıcı en bilgili olanları önce görsün).
 */
export function buildTouchedBehaviorSummary(
  byUnit: Map<string, EddUnitRecord>,
  seedRelPaths: string[],
  affected: AffectedModule[],
): TouchedBehavior[] {
  const units = new Set<string>();
  for (const s of seedRelPaths) if (s) units.add(s);
  for (const a of affected) if (a.module) units.add(a.module);

  const out: TouchedBehavior[] = [];
  for (const unit of units) {
    const rec = byUnit.get(unit);
    if (rec?.status === "done" && rec.behavior?.what_it_does) {
      out.push({
        unit,
        coverage: "documented",
        what_it_does: rec.behavior.what_it_does,
        invariants: (rec.behavior.invariants ?? []).slice(0, MAX_INVARIANTS),
      });
    } else if (rec?.status === "pending") {
      out.push({ unit, coverage: "pending" });
    } else if (rec?.status === "unanalyzable") {
      out.push({ unit, coverage: "unanalyzable", reason: rec.reason });
    } else {
      out.push({ unit, coverage: "unknown" }); // kayıt yok — ASLA "güvenli" sayma
    }
  }
  const rank = (c: TouchedCoverage) => (c === "documented" ? 0 : c === "pending" ? 1 : c === "unanalyzable" ? 2 : 3);
  return out.sort((a, b) => rank(a.coverage) - rank(b.coverage) || (a.unit < b.unit ? -1 : 1));
}

/** SAF: özeti kullanıcı mesajına çevir. Belgelenmiş birimler detaylı; belirsizler (pending/unanalyzable/unknown) SAYIYLA
 *  görünür + kapsam-belirsizlik uyarısı (anti-false-safe: gizlenmez). `docWhatTr` = çevrilmiş what_it_does (unit→TR). */
export function formatTouchedForConsent(touched: TouchedBehavior[], docWhatTr: Map<string, string>): string {
  if (touched.length === 0) {
    return "  ⚠️ Dokunulan dosya çıkarılamadı — kapsam belirsiz (mevcut davranışı kesinleştiremedim).";
  }
  const lines: string[] = [];
  const documented = touched.filter((t) => t.coverage === "documented");
  for (const t of documented.slice(0, MAX_DOC_UNITS)) {
    lines.push(`  • ${t.unit}: ${docWhatTr.get(t.unit) ?? t.what_it_does ?? ""}`);
    for (const inv of t.invariants ?? []) lines.push(`      - korunmalı: ${inv}`);
  }
  if (documented.length > MAX_DOC_UNITS) lines.push(`  • …ve ${documented.length - MAX_DOC_UNITS} belgelenmiş birim daha`);
  const uncertain = touched.length - documented.length;
  if (uncertain > 0) {
    lines.push(
      `  ⚠️ ${uncertain} birim analiz-dışı/henüz haritalanmadı → mevcut davranış KESİN değil (kapsam belirsiz; ` +
        "statik import dışı bağımlılık da görünmeyebilir). Emin değilsen atla.",
    );
  }
  return lines.join("\n");
}

// ── kapı ────────────────────────────────────────────────────────────────────────────────────────
function toRel(root: string, abs: string): string {
  const r = isAbsolute(abs) ? relative(root, abs) : abs;
  return r.split(sep).join("/");
}

/**
 * Yabancı-yazma onay kapısı. origin!=="foreign" → items DEĞİŞMEDEN döner (non-foreign parite, byte-aynı). Foreign'de
 * EDD-bilgili BATCH onay ister; ONAYLANAN alt-kümeyi döndürür (boş = tümü atlandı). Best-effort: EDD/graph okunamazsa
 * yine onay ister (kapsam-belirsiz uyarısıyla), ASLA sessiz oto-onaya düşmez. Karar HER ZAMAN kullanıcıda.
 */
// KAPSAM (mahkeme doğrulaması 2026-07-08): şu an YALNIZ "risk-fix" bağlı. gate-autofix (index.ts:5081/5330) ve debug
// oto-uygula (phase-0.ts) ZATEN `autoAnswerSuggested()` ile kapılı → foreign'de false → ULAŞILMAZ (failPhase'e düşer,
// kullanıcı sorulur); bu yüzden onları da buraya sarmak GEREKSİZ (olmayan deliğe kapı = tıkanma). Part A sonrası da
// dangerous-write kategorisi foreign'de kapalı kalır. İleride "consent ile ilerlet" istenirse (B2) source genişler.
export async function runForeignWriteConsentGate(
  state: State,
  config: MyclConfig,
  items: ForeignWriteItem[],
  opts: { source: "risk-fix" },
): Promise<ForeignWriteItem[]> {
  if (state.origin !== "foreign") return items; // MyCL projede kapı yok
  if (items.length === 0) return items;

  const root = state.project_root;
  // EDD haritası + import grafiği (ikisi de fail-soft). Okunamazsa boş → summary "unknown" üretir (belirsiz, oto-onay YOK).
  let byUnit: Map<string, EddUnitRecord>;
  try {
    byUnit = await readEddProgress(root);
  } catch (e) {
    log.warn("foreign-write-consent", "edd-progress okunamadı — kapsam belirsiz olarak sorulur", { error: String(e) });
    byUnit = new Map();
  }
  let graph;
  try {
    graph = await buildReverseImportGraph(root);
  } catch (e) {
    log.warn("foreign-write-consent", "import grafiği kurulamadı — yalnız seed dosyalarla sorulur", { error: String(e) });
    graph = null;
  }

  // Her item için dokunulan-davranış + çevrilmiş metinler.
  const enriched = [] as { item: ForeignWriteItem; touched: TouchedBehavior[]; labelTr: string; docWhatTr: Map<string, string> }[];
  for (const item of items) {
    const seedRel = item.seedFiles.map((f) => toRel(root, f)).filter(Boolean);
    const affected = graph ? getAffected(graph, item.seedFiles.filter(isAbsolute), 2, root) : [];
    const touched = buildTouchedBehaviorSummary(byUnit, seedRel, affected);
    const labelTr = await trText(config, item.label);
    const docWhatTr = new Map<string, string>();
    for (const t of touched.filter((x) => x.coverage === "documented").slice(0, MAX_DOC_UNITS)) {
      if (t.what_it_does) docWhatTr.set(t.unit, await trText(config, t.what_it_does));
    }
    enriched.push({ item, touched, labelTr, docWhatTr });
  }

  void opts; // source şu an yalnız "risk-fix" (tek dal); genişlerse header burada dallanır.
  // Görünür liste (KATI#4: ne onaylayacağı net) — numaralı, dokunulan davranışla.
  const header = `🔐 Entegre mod — MyCL ${items.length} risk düzeltmesiyle VAR OLAN kodunu değiştirmek istiyor. Onayın olmadan dokunmam. Her biri + dokunacağı mevcut davranış:`;
  const blocks = enriched.map(
    (e, i) => `**${i + 1}. ${e.labelTr}**\n${formatTouchedForConsent(e.touched, e.docWhatTr)}`,
  );
  emitChatMessage("system", `${header}\n\n${blocks.join("\n\n")}`);

  // Batch karar.
  const sel = await emitConsentAskq(
    "Bu değişiklikleri uygulayayım mı?",
    [APPLY_ALL, APPLY_SELECTED, APPLY_NONE],
  );
  if (sel === APPLY_ALL) return items;
  if (sel === APPLY_NONE) {
    emitChatMessage("system", "⏭️ Hiçbir değişiklik uygulanmadı — var olan kod korunuyor.");
    return [];
  }
  // "Yalnız seçtiklerim" → item-item (bounded).
  const approved: ForeignWriteItem[] = [];
  for (const e of enriched) {
    const one = await emitConsentAskq(
      `Uygulayayım mı?\n\n**${e.labelTr}**\n${formatTouchedForConsent(e.touched, e.docWhatTr)}`,
      [ITEM_APPLY, ITEM_SKIP],
    );
    if (one === ITEM_APPLY) approved.push(e.item);
  }
  emitChatMessage(
    "system",
    approved.length > 0
      ? `✅ ${approved.length}/${items.length} değişiklik onaylandı; kalanı atlandı (var olan davranış korundu).`
      : "⏭️ Hiçbir değişiklik seçilmedi — var olan kod korunuyor.",
  );
  return approved;
}

/** Caller'ın item üretmesi için: metinden dosya seed'lerini (MUTLAK) çıkar. extractFilePaths sarmalayıcısı. */
export function seedFilesFromText(root: string, text: string, extract: (t: string) => string[]): string[] {
  return extract(text).map((p) => (isAbsolute(p) ? p : join(root, p)));
}

/**
 * BİLGİLENDİRME (onay DEĞİL): kullanıcı zaten bir hata için "nasıl ilerleyelim?" (Çöz/Kaydet/…) sorusuyla KARAR verecek;
 * bu, o düzeltmenin EDD'den dokunacağı BELGELENMİŞ mevcut davranışı gösterir → kullanıcı "Çöz"ü bilerek seçer (foreign,
 * gate-fail). Yalnız BELGELENMİŞ dokunulan davranış varsa döner (aksi undefined → gürültü ekleme; kullanıcı yine askq ile
 * karar verir → "kayıt yok=güvenli" çıkarımı yapılmaz, sadece EK BAĞLAM). Non-foreign / EDD yok → undefined.
 */
export async function describeTouchedForFiles(
  state: State,
  config: MyclConfig,
  relFiles: string[],
): Promise<string | undefined> {
  if (state.origin !== "foreign") return undefined;
  const files = relFiles.filter(Boolean);
  if (files.length === 0) return undefined;
  const root = state.project_root;
  let byUnit: Map<string, EddUnitRecord>;
  try {
    byUnit = await readEddProgress(root);
  } catch (e) {
    log.warn("foreign-write-consent", "describeTouchedForFiles: edd-progress okunamadı — bilgilendirme atlandı", { error: String(e) });
    return undefined;
  }
  if (summarizeProgress(byUnit).done === 0) return undefined; // EDD henüz koşmadı → ek bağlam yok
  let graph;
  try {
    graph = await buildReverseImportGraph(root);
  } catch (e) {
    log.warn("foreign-write-consent", "describeTouchedForFiles: dep-graph kurulamadı — yalnız seed dosyalarla", { error: String(e) });
    graph = null;
  }
  const absSeeds = files.map((r) => join(root, ...r.split("/")));
  const affected = graph ? getAffected(graph, absSeeds, 2, root) : [];
  const touched = buildTouchedBehaviorSummary(byUnit, files, affected);
  const documented = touched.filter((t) => t.coverage === "documented");
  if (documented.length === 0) return undefined; // belgelenmiş dokunulan davranış yok → bağlam ekleme
  const docWhatTr = new Map<string, string>();
  for (const t of documented.slice(0, MAX_DOC_UNITS)) {
    if (t.what_it_does) docWhatTr.set(t.unit, await trText(config, t.what_it_does));
  }
  // Yalnız belgelenmiş olanları göster; ama DÜRÜST ol (KATI#4/anti-false-safe): bu ALT-SINIR (yalnız belgelenmiş +
  // statik-import bağımlılıklar; belgelenmemiş/dinamik bağlar görünmez) → kullanıcı listeyi "tam" sanmasın.
  return (
    "ℹ️ Bu düzeltme var olan şu davranış(lar)a dokunabilir — bilerek karar ver:\n" +
    formatTouchedForConsent(documented, docWhatTr) +
    "\n(Not: bu bilinen/belgelenmiş kısım — tam liste olmayabilir.)"
  );
}

/**
 * B1.1 HASSAS ONAY (yazımdan hemen önce, GERÇEK dosya listesiyle): risk-fix'lerin PARALEL yolu, düzeltmeleri izole
 * kopyada koşup ana ağaca UYGULAMADAN önce GERÇEKTEN değişecek dosyaları bilir (toWrite). B1 kapısı NİYET kapsamıyla
 * (fix detail'inden çıkarım) sordu; bu, "davranış X'i sordum ama Y'yi yazdım" boşluğunu kapatır: kesin dosya listesi +
 * EDD-dokunulan davranışı gösterip son onay ister. `origin!=="foreign"` → true (no-op). Red → false (caller UYGULAMAZ).
 */
export async function confirmForeignWriteFiles(
  state: State,
  config: MyclConfig,
  relFiles: string[],
): Promise<boolean> {
  if (state.origin !== "foreign") return true;
  const files = relFiles.filter(Boolean);
  if (files.length === 0) return true;

  const root = state.project_root;
  let byUnit: Map<string, EddUnitRecord>;
  try {
    byUnit = await readEddProgress(root);
  } catch (e) {
    log.warn("foreign-write-consent", "edd-progress okunamadı (kapsam belirsiz sorulur)", { error: String(e) });
    byUnit = new Map();
  }
  let graph;
  try {
    graph = await buildReverseImportGraph(root);
  } catch (e) {
    log.warn("foreign-write-consent", "import grafiği kurulamadı (B1.1) — yalnız seed dosyalarla sorulur", { error: String(e) });
    graph = null;
  }
  const absSeeds = files.map((r) => join(root, ...r.split("/")));
  const affected = graph ? getAffected(graph, absSeeds, 2, root) : [];
  const touched = buildTouchedBehaviorSummary(byUnit, files, affected);
  const docWhatTr = new Map<string, string>();
  for (const t of touched.filter((x) => x.coverage === "documented").slice(0, MAX_DOC_UNITS)) {
    if (t.what_it_does) docWhatTr.set(t.unit, await trText(config, t.what_it_does));
  }

  emitChatMessage(
    "system",
    `🔐 Entegre mod — risk düzeltmeleri hazır; ana koda UYGULAMADAN ÖNCE kesin dosya listesi (${files.length}):\n` +
      files.map((f) => `• ${f}`).join("\n") +
      `\n\n${formatTouchedForConsent(touched, docWhatTr)}`,
  );
  const sel = await emitConsentAskq("Bu kesin değişiklikleri uygulayayım mı?", ["Uygula", "İptal (uygulama)"]);
  return sel === "Uygula";
}
