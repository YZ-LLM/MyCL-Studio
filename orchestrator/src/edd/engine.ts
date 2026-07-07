// edd/engine — EDD Faz 1 orkestrasyonu. YZLLM 2026-07-07.
//
// TÜM birimleri enumerate et → resume (edd-progress) → pending'leri BATCH-BATCH analiz et → her birimi işaretle
// (done + kaynak-hash + davranış) → "N/N done, K analiz-dışı" raporu → edd-analysis.md TÜRET. Resumable (çökme/
// kapanma → kaldığı yerden), tavansız (batch-batch, tüm-run sınırsız), HER ŞEYİ kapsar (miss nothing: her birim
// bir statü alır; analiz-dışı sessiz atlanmaz). TEK DOĞRULUK KAYNAĞI = progress kayıtları; edd-analysis.md TÜRETİLİR.
//
// Tetik: maybeRunEdd (onboarding marker'ından BAĞIMSIZ, resumable+idempotent+concurrency-guard) — mahkeme blocker fix:
// EDD one-time onboarding'e HAPSOLMAZ; her foreign açılışta pending varsa devam eder.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { MyclConfig } from "../config.js";
import type { State } from "../types.js";
import { emitChatMessage } from "../ipc.js";
import { log } from "../logger.js";
import { enumerateSourceUnits } from "./enumerate.js";
import {
  appendEddUnit,
  patchEddUnit,
  readEddProgress,
  summarizeProgress,
  type EddUnitRecord,
} from "./progress.js";
import { analyzeUnitBatch, type EddBehaviorRecord } from "./analyzer.js";

/** Batch başına birim (küçük → agent bol tur/wall-clock; parse güvenilir; resume granülerliği ince). */
const BATCH_SIZE = 4;
/** İlerleme mesajı + edd-analysis.md render'ı kaç batch'te bir (spam/IO throttle; kısmi kapsam yine canlı kalır). */
const PROGRESS_EVERY = 25;

async function fileHash(abs: string): Promise<string | undefined> {
  try {
    return createHash("sha256")
      .update(await fs.readFile(abs))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return undefined;
  }
}

async function markDone(
  root: string,
  unit: string,
  absOf: Map<string, string>,
  rec: EddBehaviorRecord,
): Promise<void> {
  await patchEddUnit(root, unit, {
    status: "done",
    hash: await fileHash(absOf.get(unit) ?? ""),
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
): Promise<void> {
  let records: EddBehaviorRecord[];
  try {
    records = await analyzeUnitBatch(config, root, batch.map((b) => ({ unit: b.unit, abs: absOf.get(b.unit) ?? "", bytes: 0, analyzable: true })));
  } catch (e) {
    log.warn("edd/engine", "batch analiz hatası", { error: String(e), n: batch.length });
    records = [];
  }
  const returned = new Map(records.map((r) => [r.unit, r] as const));
  for (const u of batch) {
    const rec = returned.get(u.unit);
    if (rec) await markDone(root, u.unit, absOf, rec);
  }
  const missed = batch.filter((u) => !returned.has(u.unit));
  if (missed.length === 0) return;
  if (batch.length > 1) {
    for (const u of missed) await processBatch(config, root, [u], absOf); // izole retry
  } else {
    // Tek birim izole edildi + hâlâ dönmedi → analiz-dışı işaretle (sessiz-pending değil; miss-nothing: görünür flag).
    await patchEddUnit(root, missed[0].unit, { status: "unanalyzable", reason: "analysis-failed" });
    log.warn("edd/engine", "birim analiz edilemedi (izole+fail) → unanalyzable", { unit: missed[0].unit });
  }
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

  const cur = await readEddProgress(root);
  const pendingUnits = units.filter((u) => u.analyzable && cur.get(u.unit)?.status === "pending");
  const initial = summarizeProgress(cur);
  const totalBatches = Math.ceil(pendingUnits.length / BATCH_SIZE);
  emitChatMessage(
    "system",
    `🔎 EDD: projeyi birim-birim analiz ediyorum — ${initial.total} birim, ${pendingUnits.length} kaldı (~${totalBatches} batch; büyük projede uzun sürebilir, kaldığı yerden devam eder). ${initial.done} bitti, ${initial.unanalyzable} analiz-dışı.`,
  );

  let batchNo = 0;
  for (let i = 0; i < pendingUnits.length; i += BATCH_SIZE) {
    await processBatch(config, root, pendingUnits.slice(i, i + BATCH_SIZE), absOf);
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

// Aynı proje için eşzamanlı ikinci runEdd'i önle (mahkeme minor: re-open yarışı → çift analiz). In-memory guard.
const _eddRunning = new Set<string>();

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
    let skip = false;
    try {
      const s = summarizeProgress(await readEddProgress(root));
      if (s.total > 0 && s.pending === 0) skip = true; // tamamlandı → atla (yeni-dosya tazeliği Faz 4)
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
  ];
  for (const r of done) {
    const b = r.behavior!;
    lines.push(`## ${r.unit}`);
    if (b.what_it_does) lines.push(b.what_it_does);
    if (b.invariants.length) {
      lines.push("", "**Invariants (must preserve):**");
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
