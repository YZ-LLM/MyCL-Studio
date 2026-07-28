// edd/engine — EDD Faz 1 orkestrasyonu. YZLLM 2026-07-07.
//
// TÜM birimleri enumerate et → resume (edd-progress) → pending'leri BATCH-BATCH analiz et → her birimi işaretle
// (done + kaynak-hash + davranış) → "N/N done, K analiz-dışı" raporu → edd-analysis.md TÜRET. Resumable (çökme/
// kapanma → kaldığı yerden), tavansız (batch-batch, tüm-run sınırsız), HER ŞEYİ kapsar (miss nothing: her birim
// bir statü alır; analiz-dışı sessiz atlanmaz). TEK DOĞRULUK KAYNAĞI = progress kayıtları; edd-analysis.md TÜRETİLİR.
//
// Tetik: maybeRunEdd (onboarding marker'ından BAĞIMSIZ, resumable+idempotent+concurrency-guard) — mahkeme blocker fix:
// EDD one-time onboarding'e HAPSOLMAZ; her foreign açılışta pending varsa devam eder.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { MyclConfig } from "../config.js";
import type { State } from "../types.js";
import { listIgnoredUntrackedFiles } from "../git.js";
import { emitChatMessage } from "../ipc.js";
import { log } from "../logger.js";
import { enumerateSourceUnits, type SourceUnit } from "./enumerate.js";
import { safeSourceHash } from "./source-hash.js";
import {
  appendEddUnit,
  patchEddUnit,
  readEddProgress,
  summarizeProgress,
  type EddUnitRecord,
} from "./progress.js";
import { analyzeUnitBatch, type EddBehaviorRecord } from "./analyzer.js";
import { isApiAccountError } from "../claude-api.js";

/**
 * SAF: EDD batch hatası GEÇİCİ sağlayıcı-sınırı mı (rate-limit / kota / kredi)? Öyleyse birim "analiz-dışı" (kalıcı)
 * işaretlenMEZ ve EDD DURUR (fail-fast) — limit/kredi dönünce resume yeniden dener. YZLLM 2026-07-12 canlı-bug:
 * EDD 429'a rağmen 3 saat 65 batch'i tek tek deneyip 408 birimi YANLIŞLIKLA "analysis-failed" (kalıcı) işaretledi.
 */
export function isEddRateLimited(err: unknown): boolean {
  const s = String(err instanceof Error ? err.message : err);
  // NOT: çıplak `429` KULLANMA — kardeş detectCliRateLimit (cli-rate-limit.ts) de bilerek dışlar: bir hata metnindeki
  // satır no ("file.ts:429") veya JSON pozisyonu ("position 429") gerçek analiz-hatasını yanlışlıkla rate-limit sayar
  // (mahkeme 2026-07-12). Gerçek rate-limit mesajları zaten "rate limit"/"rate_limit_error"/"too many requests" içerir.
  return /rate.?limit|rate_limit_error|too many requests|kota|kredi|credit balance/i.test(s) || isApiAccountError(s);
}

/**
 * SAF: progress'te "pending" ama GÜNCEL enumeration'da analyzable-pending OLMAYAN birimleri sınıflar (HAYALET pending).
 * Neden (YZLLM 2026-07-19, canlı cave: `routes/*- Copy.js` yedek dosyaları 13.07'de pending işaretlenip sonra
 * SİLİNDİ): bir birim analiz EDİLMEDEN silinir/binary-too-large/gitignored/secret olursa runEdd döngüsüne giremez
 * (pendingUnits `analyzable && enumeration'da var` ister) VE reconcileEddStaleness yalnız `done` kayıtlarını
 * uzlaştırır → birim SONSUZA pending kalır → EDD hiç "0 pending"e ulaşamaz → her açılışta boşa re-run + yanlış
 * "N kaldı, bir sonraki açılışta devam" vaadi. GENUINE pending (dosya var + analyzable) DOKUNULMAZ.
 *
 * İKİ KATEGORİ (MAHKEME CRITICAL 2026-07-19): (1) nonAnalyzable — enumeration'da VAR ama analyzable:false
 * (stat edildi, silinme kuşkusu YOK) → doğrudan güvenli. (2) notEnumerated — enum'da HİÇ yok; bu "silinmiş"
 * OLABİLİR ama enumerate GEÇİCİ bir I/O hatasında (EMFILE/EACCES → walk sessiz return) var olan dosyayı da
 * kaçırabilir → çağıran bunu safeSourceHash ile DOĞRUDAN teyit etmeli (yalnız ENOENT = silinmiş), yoksa gerçek
 * pending'i kalıcı "silinmiş" damgalar (rate-limit sonrası büyük backlog'ta veri kaybı). Test edilebilir.
 */
export function classifyGhostPending(
  cur: Map<string, EddUnitRecord>,
  units: SourceUnit[],
): { nonAnalyzable: { unit: string; reason: string }[]; notEnumerated: string[] } {
  const enumByUnit = new Map(units.map((u) => [u.unit, u]));
  const nonAnalyzable: { unit: string; reason: string }[] = [];
  const notEnumerated: string[] = [];
  for (const [unit, rec] of cur) {
    if (rec.status !== "pending") continue;
    const eu = enumByUnit.get(unit);
    if (!eu) notEnumerated.push(unit);
    else if (!eu.analyzable) nonAnalyzable.push({ unit, reason: eu.reason ?? "not-analyzable" });
  }
  return { nonAnalyzable, notEnumerated };
}

/** Batch başına birim (küçük → agent bol tur/wall-clock; parse güvenilir; resume granülerliği ince). */
const BATCH_SIZE = 4;
/** İlerleme mesajı + edd-analysis.md render'ı kaç batch'te bir (spam/IO throttle; kısmi kapsam yine canlı kalır). */
const PROGRESS_EVERY = 25;

async function markDone(
  root: string,
  unit: string,
  absOf: Map<string, string>,
  rec: EddBehaviorRecord,
): Promise<void> {
  // safeSourceHash: boyut/silinme güvenli (mahkeme Major — dev dosyayı belleğe almaz) + hata görünür loglu (KATI#4).
  // Dosya analiz SIRASINDA silinmiş/dev-olmuşsa → done YAZMA, unanalyzable işaretle (mahkeme regression: aksi halde
  // done+no-hash → reconcile'da pending → enumerate silineni listelemez → KALICI HAYALET pending). unanalyzable(-after-
  // analysis) sebepleri reconcile'da REVIVE edilebilir (dosya geri gelirse). Geçici okuma hatası (hash yok ama var) →
  // done+no-hash; reconcile onu dosya-var iken pending'e alıp yeniden analiz eder (hayalet değil, dosya listede).
  const h = await safeSourceHash(absOf.get(unit) ?? "");
  if (h.gone) {
    await patchEddUnit(root, unit, { status: "unanalyzable", reason: "deleted-after-analysis" });
    return;
  }
  if (h.tooLarge) {
    await patchEddUnit(root, unit, { status: "unanalyzable", reason: "too-large-after-analysis" });
    return;
  }
  await patchEddUnit(root, unit, {
    status: "done",
    hash: h.hash,
    behavior: {
      what_it_does: rec.what_it_does,
      invariants: rec.invariants,
      side_effects: rec.side_effects,
      dependents_note: rec.dependents_note,
    },
  });
}

/**
 * Bir batch'i işle: analiz et → dönen birimleri done. DÖNMEYEN birimler (parse-fail / poison-pill birim agent'ın
 * bütçesini tüketti) → batch>1 ise TEK TEK yeniden dene (izole); size-1 hâlâ dönmezse unanalyzable(analysis-failed).
 * Böylece bir zehirli birim batch-arkadaşlarını sonsuza bloklamaz (miss-nothing: flag'lenir, sessiz-pending kalmaz).
 * Recursion derinliği 1 (batch → bireyler → unanalyzable) — sonsuz döngü yok.
 */
async function processBatch(
  config: MyclConfig,
  root: string,
  batch: { unit: string }[],
  absOf: Map<string, string>,
): Promise<{ rateLimited: boolean }> {
  let records: EddBehaviorRecord[];
  try {
    records = await analyzeUnitBatch(config, root, batch.map((b) => ({ unit: b.unit, abs: absOf.get(b.unit) ?? "", bytes: 0, analyzable: true })));
  } catch (e) {
    if (isEddRateLimited(e)) {
      // Rate-limit/kota GEÇİCİ (kredi/limit dönünce çalışır) → birimleri "analysis-failed" YAPMA (sahte-kalıcı-fail);
      // pending bırak. Çağıran (runEdd) DURUR → 65 batch boşa denenmez (canlı: 3 saat israf + 408 sahte-fail).
      log.warn("edd/engine", "batch rate-limit/kota → EDD duracak; birimler pending kalır (resume)", { error: String(e).slice(0, 120) });
      return { rateLimited: true };
    }
    log.warn("edd/engine", "batch analiz hatası", { error: String(e), n: batch.length });
    records = [];
  }
  const returned = new Map(records.map((r) => [r.unit, r] as const));
  for (const u of batch) {
    const rec = returned.get(u.unit);
    if (rec) await markDone(root, u.unit, absOf, rec);
  }
  const missed = batch.filter((u) => !returned.has(u.unit));
  if (missed.length === 0) return { rateLimited: false };
  if (batch.length > 1) {
    for (const u of missed) {
      const r = await processBatch(config, root, [u], absOf); // izole retry
      if (r.rateLimited) return { rateLimited: true }; // rate-limit izole-retry'da da fail-fast (yukarı taşı)
    }
  } else {
    // Tek birim izole edildi + hâlâ dönmedi (rate-limit DEĞİL) → analiz-dışı işaretle (sessiz-pending değil; görünür flag).
    await patchEddUnit(root, missed[0].unit, { status: "unanalyzable", reason: "analysis-failed" });
    log.warn("edd/engine", "birim analiz edilemedi (izole+fail) → unanalyzable", { unit: missed[0].unit });
  }
  return { rateLimited: false };
}

/**
 * EDD tam analizi (foreign). Resumable + idempotent: done birimler atlanır, pending'ler analiz edilir. İlerleme +
 * sonuç kullanıcıya GÖRÜNÜR (KATI#4). Tüm çıktı .mycl/ içinde (yabancı kaynağa dokunmaz). maybeRunEdd üzerinden çağrılır.
 */
async function runEdd(config: MyclConfig, state: State): Promise<void> {
  const root = state.project_root;
  const units = await enumerateSourceUnits(root);
  const absOf = new Map(units.map((u) => [u.unit, u.abs] as const));

  // Yeni birimleri (progress'te olmayan) taban-kaydet: analyzable → pending, değilse → unanalyzable (+ sebep).
  const seen = await readEddProgress(root);
  for (const u of units) {
    if (seen.has(u.unit)) continue;
    if (u.analyzable) await appendEddUnit(root, { unit: u.unit, status: "pending", ts: Date.now() });
    else await appendEddUnit(root, { unit: u.unit, status: "unanalyzable", reason: u.reason, ts: Date.now() });
  }

  const cur0 = await readEddProgress(root);
  // HAYALET PENDING uzlaşması (YZLLM 2026-07-19): analiz edilmeden silinen/analiz-dışı olmuş pending birimleri
  // GÖRÜNÜR unanalyzable'a çevir → yoksa EDD sonsuza "N kaldı" der + her açılış boşa re-run eder (canlı cave bug).
  const { nonAnalyzable, notEnumerated } = classifyGhostPending(cur0, units);
  let ghostCount = 0;
  // (1) enumeration'da VAR + analyzable:false → doğrudan güvenli (stat edildi, silinme kuşkusu yok).
  for (const g of nonAnalyzable) {
    await patchEddUnit(root, g.unit, { status: "unanalyzable", reason: g.reason });
    ghostCount++;
  }
  // (2) enum'da YOK → MAHKEME CRITICAL: geçici enum eksikliği (EMFILE/EACCES) gerçek pending'i "silinmiş"
  // sanmasın → safeSourceHash ile DOĞRUDAN teyit; yalnız ENOENT (h.gone) silinmiş sayılır. Diğer hata / dosya
  // var → DOKUNMA (pending kalır, sonraki tur kendi düzelir; kalıcı sessiz veri kaybı yok).
  for (const unit of notEnumerated) {
    const h = await safeSourceHash(join(root, ...unit.split("/")));
    if (h.gone) {
      await patchEddUnit(root, unit, { status: "unanalyzable", reason: "deleted-before-analysis" });
      ghostCount++;
    }
  }
  if (ghostCount > 0) {
    log.info("edd/engine", "hayalet pending → unanalyzable (silinmiş/analiz-dışı olmuş)", { count: ghostCount });
  }
  const cur = ghostCount > 0 ? await readEddProgress(root) : cur0;
  const pendingUnits = units.filter((u) => u.analyzable && cur.get(u.unit)?.status === "pending");
  const initial = summarizeProgress(cur);
  const totalBatches = Math.ceil(pendingUnits.length / BATCH_SIZE);
  emitChatMessage(
    "system",
    `🔎 EDD: projeyi birim-birim analiz ediyorum — ${initial.total} birim, ${pendingUnits.length} kaldı (~${totalBatches} batch; büyük projede uzun sürebilir, kaldığı yerden devam eder). ${initial.done} bitti, ${initial.unanalyzable} analiz-dışı.`,
  );

  let batchNo = 0;
  for (let i = 0; i < pendingUnits.length; i += BATCH_SIZE) {
    const r = await processBatch(config, root, pendingUnits.slice(i, i + BATCH_SIZE), absOf);
    if (r.rateLimited) {
      // FAIL-FAST (YZLLM 2026-07-12 canlı-bug): sağlayıcı rate-limit/kota → 65 batch boşa denenmesin. Kalan birimler
      // PENDING kalır (sahte "analiz-dışı" yok) → limit/kredi dönünce bir sonraki açılışta kaldığı yerden devam. GÖRÜNÜR.
      const pr = await readEddProgress(root);
      const sr = summarizeProgress(pr);
      await renderEddAnalysis(root, pr);
      emitChatMessage(
        "system",
        `⏸️ EDD durduruldu — sağlayıcı sınırına (rate-limit / kota / kredi) ulaşıldı. ${sr.done}/${sr.total} birim ` +
          `analiz edildi; kalan ${sr.pending} birim BEKLEMEDE (sahte "analiz-dışı" işaretlenmedi). Limit/kredi dönünce ` +
          `bir sonraki açılışta kaldığı yerden otomatik devam eder.`,
      );
      return;
    }
    batchNo++;
    // Throttle: her batch değil, ~25 batch'te bir (veya son) → progress + edd-analysis.md render (kısmi kapsam canlı+dürüst).
    if (batchNo % PROGRESS_EVERY === 0 || i + BATCH_SIZE >= pendingUnits.length) {
      const p = await readEddProgress(root);
      const s = summarizeProgress(p);
      await renderEddAnalysis(root, p);
      emitChatMessage("system", `🔎 EDD ilerleme: ${s.done}/${s.total} birim (batch ${batchNo}/${totalBatches}, ${s.pending} kaldı).`);
    }
  }

  const final = await readEddProgress(root);
  const s = summarizeProgress(final);
  await renderEddAnalysis(root, final);
  const unanalyzed = [...final.values()].filter((r) => r.status === "unanalyzable");
  emitChatMessage(
    "system",
    `✅ EDD tamamlandı: ${s.done}/${s.total} birim belgelendi (.mycl/edd-analysis.md)` +
      (s.unanalyzable > 0
        ? `; ${s.unanalyzable} analiz-dışı (${unanalyzed.slice(0, 5).map((r) => `${r.unit}:${r.reason}`).join(", ")}${s.unanalyzable > 5 ? "…" : ""})`
        : "") +
      (s.pending > 0 ? `; ${s.pending} kaldı (bir sonraki açılışta devam).` : "."),
  );
}

/**
 * Faz 4 — bayatlama uzlaşması: done birimin GÜNCEL kaynak-hash'i analiz-anı hash'iyle uyuşmuyorsa (dosya değişmiş) →
 * pending'e döndür (bir sonraki runEdd yeniden analiz eder → taze sözleşme). Dosya SİLİNMİŞSE → unanalyzable("deleted").
 * Böylece bayat sözleşme SESSİZCE kullanılmaz (KATI#4): consumer'lar (Faz 2/3) done'a bakar → pending/unanalyzable birim
 * düşer, tazelenene kadar gösterilmez. Analiz-anı hash'i olmayan (eski) kayıt karşılaştırılamaz → dokunulmaz.
 * NOT: plan "behavior-consent 'yes' → invalidate" der; ama EDD foreign-only + consent kapısı foreign'de erken-return
 * (behavior-consent-gate.ts:207, runBehaviorConsentGate foreign erken-return) → foreign'de consent kararı YOK → bu
 * tetik EDD ile hiç çakışmaz (uygulanamaz, atlanır).
 */
/** reconcile'ın yeniden-analize-açtığı unanalyzable sebepleri (dosya geri gelirse REVIVE edilir; ilk-enumerate binary/too-large DEĞİL). */
const RECONCILE_UNANALYZABLE_REASONS = new Set([
  "deleted-after-analysis",
  "too-large-after-analysis",
  // MAHKEME (2026-07-19) ikincil emniyet ağı: hayalet-pending temizliğinin işaretlediği silinmiş birim dosyası
  // geri gelirse (kopya restore) → pending'e canlan (yeniden analiz). Yanlış-pozitif olsa da kendi kendini düzeltir.
  "deleted-before-analysis",
]);

export async function reconcileEddStaleness(
  root: string,
): Promise<{ invalidated: number; deleted: number; tooLarge: number; revived: number }> {
  const byUnit = await readEddProgress(root);
  // Güncel GERÇEKTEN dışlanan (untracked+ignored) küme — gitignored canlanma için. null = git yok/bilinmiyor → canlanma
  // ATLA (git-down'da "artık ignore değil" ÇIKARIMI yapma; yoksa git kapalıyken tüm gitignored-secret'lar yanlış canlanır).
  const ignoredNow = await listIgnoredUntrackedFiles(root);
  let invalidated = 0;
  let deleted = 0;
  let tooLarge = 0;
  let revived = 0;
  for (const rec of byUnit.values()) {
    const abs = join(root, ...rec.unit.split("/"));

    // Gitignored CANLANMA: dosya artık dışlanmıyorsa (un-ignore + tracked → semgrep artık tarar, EDD de analiz etmeli)
    // yeniden analiz kuyruğuna. Yalnız git KESİN cevap verdiyse (ignoredNow !== null) + dosya normalse. Deleted/too-large
    // canlanma deseninin ikizi (tutarlılık): EDD kapsamı = tarama kapsamı invaryantı zamanla da korunur.
    if (
      rec.status === "unanalyzable" &&
      rec.reason?.startsWith("gitignored") &&
      ignoredNow !== null &&
      !ignoredNow.has(rec.unit)
    ) {
      const h = await safeSourceHash(abs);
      if (!h.gone && !h.tooLarge && h.hash !== undefined) {
        await patchEddUnit(root, rec.unit, { status: "pending" });
        revived++;
      }
      continue;
    }

    // REVIVE (mahkeme minor): reconcile'ın işaretlediği unanalyzable birim dosyası geri geldi/normalleşti → pending
    // (yeniden analiz). Yalnız reconcile-kaynaklı sebepler (ilk-enumerate binary/too-large kalıcıdır, dokunma).
    if (rec.status === "unanalyzable" && rec.reason && RECONCILE_UNANALYZABLE_REASONS.has(rec.reason)) {
      const h = await safeSourceHash(abs);
      if (!h.gone && !h.tooLarge && h.hash !== undefined) {
        await patchEddUnit(root, rec.unit, { status: "pending" });
        revived++;
      }
      continue;
    }

    if (rec.status !== "done") continue;

    // done kaydını GÜNCEL dosya durumuna göre uzlaştır. safeSourceHash ÖNCE (mahkeme regression fix): no-hash done'da
    // bile dosyayı kontrol et → gone/too-large ise unanalyzable (pending'e DÖNDÜRME → enumerate silineni listelemez,
    // KALICI HAYALET pending olur). Yalnız dosya GERÇEKTEN var iken doğrulanamaz/değişmiş done pending'e alınır.
    const h = await safeSourceHash(abs);
    if (h.gone) {
      await patchEddUnit(root, rec.unit, { status: "unanalyzable", reason: "deleted-after-analysis" });
      deleted++;
    } else if (h.tooLarge) {
      // Major (kaynak): analiz sonrası dev dosya → OKUNMADAN unanalyzable (bellek koruması). Küçülürse revive eder.
      await patchEddUnit(root, rec.unit, { status: "unanalyzable", reason: "too-large-after-analysis" });
      tooLarge++;
    } else if (h.hash === undefined) {
      // Dosya VAR ama okunamadı (geçici). Analiz-anı hash'i de yoksa (KATI#4 deliği: doğrulanamaz done) → pending
      // (yeniden analiz; dosya listede → hayalet değil). Analiz-anı hash'i varsa → transient, done bırak, sonraki tur retry.
      if (rec.hash === undefined) {
        await patchEddUnit(root, rec.unit, { status: "pending" });
        invalidated++;
      }
    } else if (rec.hash === undefined || h.hash !== rec.hash) {
      // Doğrulanamaz done (hash yok) VEYA değişmiş → yeniden analiz kuyruğuna (dosya var → hayalet değil).
      await patchEddUnit(root, rec.unit, { status: "pending" });
      invalidated++;
    }
  }
  return { invalidated, deleted, tooLarge, revived };
}

// Aynı proje için eşzamanlı ikinci runEdd'i önle (mahkeme minor: re-open yarışı → çift analiz). In-memory guard.
const _eddRunning = new Set<string>();
// Bayatlık uzlaşması sıklık-sınırı (mahkeme minor): hızlı aç/kapa (Tauri reconnect / dev-loop) TÜM done-korpusu
// yeniden hash'lemesin. Son reconcile ts'i (in-memory, root başına); cooldown içindeyse reconcile atlanır (analiz devam).
const _lastReconcile = new Map<string, number>();
const RECONCILE_COOLDOWN_MS = 60_000;

/**
 * EDD'yi resumable + idempotent tetikle (mahkeme BLOCKER fix): onboarding başarı-marker'ından BAĞIMSIZ. Zaten koşuyorsa
 * no-op (concurrency guard). Tamamlandıysa (kayıt var + pending yok) atla (sessiz — yeni-dosya tazeliği Faz 4). Aksi
 * (hiç koşmadı VEYA pending var) → runEdd (resume). handleOpenProject (HER foreign açılış) + runOnboarding (ilk kez)
 * bunu çağırır → EDD one-time onboarding'e HAPSOLMAZ; kesintide bir sonraki açılışta gerçekten devam eder.
 */
export async function maybeRunEdd(config: MyclConfig, state: State): Promise<void> {
  const root = state.project_root;
  // ATOMİK guard (mahkeme minor — TOCTOU): has-check + add SENKRON (await'ten ÖNCE) → iki eşzamanlı çağrı çift-koşamaz.
  if (_eddRunning.has(root)) return;
  _eddRunning.add(root);
  try {
    // Faz 4: bayat birimleri (kaynak-hash değişti) yeniden-analize AÇ, silinenleri düş — skip-check'ten ÖNCE, ki
    // "tamamlandı (pending===0)" durumunda bile değişmiş birim tespit edilip pending'e dönsün (sessiz bayat kullanım yok).
    // Cooldown (mahkeme minor): son reconcile 60sn içindeyse atla → hızlı reopen tüm korpusu tekrar hash'lemesin.
    const now = Date.now();
    if (now - (_lastReconcile.get(root) ?? 0) >= RECONCILE_COOLDOWN_MS) {
      _lastReconcile.set(root, now);
      try {
        const rc = await reconcileEddStaleness(root);
        if (rc.invalidated || rc.deleted || rc.tooLarge || rc.revived) {
          log.info("edd/engine", "bayatlık uzlaşması → yeniden analiz", rc);
        }
      } catch (e) {
        log.warn("edd/engine", "bayatlık uzlaşması hatası (atlandı — analiz yine de dener)", { error: String(e) });
      }
    }
    let skip = false;
    try {
      const s = summarizeProgress(await readEddProgress(root));
      if (s.total > 0 && s.pending === 0) skip = true; // tamamlandı (bayatlar yukarıda pending'e döndü) → atla
    } catch (e) {
      log.warn("edd/engine", "edd-progress okunamadı (yine de dener)", { error: String(e) });
    }
    if (skip) return;
    await runEdd(config, state);
  } catch (e) {
    log.warn("edd/engine", "runEdd hata (fail-soft — sonraki açılışta devam)", { error: String(e) });
    emitChatMessage(
      "system",
      "⚠️ EDD analizi kesintiye uğradı — bir sonraki açılışta kaldığı yerden devam eder (`.mycl/edd-progress.jsonl`).",
    );
  } finally {
    _eddRunning.delete(root);
  }
}

/** Davranış kayıtlarından (TEK kaynak) edd-analysis.md TÜRET (salt rendering — bağımsız ikinci kaynak değil). */
async function renderEddAnalysis(root: string, progress: Map<string, EddUnitRecord>): Promise<void> {
  const recs = [...progress.values()];
  const done = recs.filter((r) => r.status === "done" && r.behavior).sort((a, b) => (a.unit < b.unit ? -1 : 1));
  const unanalyzable = recs.filter((r) => r.status === "unanalyzable").sort((a, b) => (a.unit < b.unit ? -1 : 1));
  const pending = recs.filter((r) => r.status === "pending");
  const lines: string[] = [
    `# EDD Analiz — mevcut davranış haritası`,
    `> Otomatik üretildi (EDD, entegrasyon-tanımlama). ${done.length}/${recs.length} birim belgelendi` +
      (unanalyzable.length ? `, ${unanalyzable.length} analiz-dışı` : "") +
      (pending.length ? `, ${pending.length} bekliyor` : "") +
      `. Tek doğruluk kaynağı: .mycl/edd-progress.jsonl.`,
    "",
    // Öncelik çerçevesi DOSYADA da sabit (mahkeme Major): ajan notu görmeden dosyayı doğrudan açsa bile "spec kazanır"
    // kaybolmasın — "must preserve" buyurgan başlıkları bu kuralın altında okunur.
    "> **RULE — this document is CONTEXT, not a constraint.** It describes the project's CURRENT behavior so changes " +
      "don't break unrelated features. Preserve the invariants below UNLESS this iteration's spec explicitly requires " +
      "changing them — when the spec and this document conflict, the **SPEC WINS**.",
    "",
  ];
  for (const r of done) {
    const b = r.behavior!;
    lines.push(`## ${r.unit}`);
    if (b.what_it_does) lines.push(b.what_it_does);
    if (b.invariants.length) {
      lines.push("", "**Invariants (preserve unless the spec changes them):**");
      for (const inv of b.invariants) lines.push(`- ${inv}`);
    }
    if (b.side_effects.length) {
      lines.push("", "**Side effects:**");
      for (const se of b.side_effects) lines.push(`- ${se}`);
    }
    if (b.dependents_note) lines.push("", `**Dependents:** ${b.dependents_note}`);
    lines.push("");
  }
  if (unanalyzable.length) {
    lines.push(`## Analiz-dışı birimler (${unanalyzable.length})`);
    for (const r of unanalyzable) lines.push(`- ${r.unit} — ${r.reason ?? "?"}`);
    lines.push("");
  }
  await fs.mkdir(join(root, ".mycl"), { recursive: true });
  await fs.writeFile(join(root, ".mycl", "edd-analysis.md"), lines.join("\n") + "\n", "utf-8");
}
