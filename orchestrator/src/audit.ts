// audit — append-only NDJSON audit log.
//
// Yer: <project_root>/.mycl/audit.log
// Format: her satır bir JSON AuditEvent. POSIX append (O_APPEND) atomic'tir
// satır boyutlarında — concurrent writer'lar bile iç içe geçmez (POSIX
// PIPE_BUF garantisi içinde).
//
// Kurallar (ADR-010):
// - Yalnızca MyCL orchestrator + bridge yazar; Claude doğrudan yazmaz.
// - Event isimleri ASCII safe (TR karakter yok).
// - caller alanı zorunlu — kim yazdığını belgelemek için.

import { promises as fs } from "node:fs";
import { open as openSync } from "node:fs/promises";
import { join, dirname } from "node:path";
import { enrichRecord } from "./record-context.js";
import type { AuditEvent, DecisionRecord } from "./types.js";

const AUDIT_FILE = "audit.log";
const DECISIONS_FILE = "decisions.jsonl";
const MYCL_DIR = ".mycl";

const ASCII_RE = /^[\x20-\x7E]+$/;

export class AuditError extends Error {
  override readonly name = "AuditError";
}

/**
 * Spec.md beklenirken bulunamadığında atılır. Caller faz controller'ı bunu
 * yakalayıp emitError + return fail yapmalı — sessizce boş context'le devam
 * etmek YASAK (fallback yok).
 */
export class SpecMissingError extends Error {
  override readonly name = "SpecMissingError";
}

/**
 * Spec.md'de istenen bölüm bulunamadığında atılır.
 */
export class SpecSectionMissingError extends Error {
  override readonly name = "SpecSectionMissingError";
}

function auditPath(projectRoot: string): string {
  return join(projectRoot, MYCL_DIR, AUDIT_FILE);
}

/**
 * Tek event append eder. ASCII validation + atomic line write (O_APPEND).
 */
export async function appendAudit(
  projectRoot: string,
  event: AuditEvent,
): Promise<void> {
  if (!ASCII_RE.test(event.event)) {
    throw new AuditError(
      `event name must be ASCII safe: ${JSON.stringify(event.event)}`,
    );
  }
  // v15.6: metadata enrichment (`_schema_v`, `_session`, `_iter`, `_phase`,
  // `_record_ts`) — dataset/replay için sabit anchor alanları.
  const enriched = enrichRecord(event, 1);
  const line = JSON.stringify(enriched) + "\n";
  const p = auditPath(projectRoot);
  await fs.mkdir(dirname(p), { recursive: true });
  // O_APPEND mode'da yazılan her satır POSIX append guarantee'sinden
  // faydalanır (PIPE_BUF altında atomic).
  const fh = await openSync(p, "a");
  try {
    await fh.write(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * ADR karar kaydı append eder (`.mycl/decisions.jsonl`). appendAudit ile aynı
 * atomic O_APPEND deseni; enrichRecord YOK (ADR kendi sabit şemasını taşır).
 * Karar veren fazlar (Brief/Spec/DB) onay anında çağırır.
 */
export async function appendDecision(
  projectRoot: string,
  rec: DecisionRecord,
): Promise<void> {
  const line = JSON.stringify(rec) + "\n";
  const p = join(projectRoot, MYCL_DIR, DECISIONS_FILE);
  await fs.mkdir(dirname(p), { recursive: true });
  const fh = await openSync(p, "a");
  try {
    await fh.write(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** decisions.jsonl'i okur (bozuk satır atlanır). Dosya yoksa []. */
export async function readDecisions(
  projectRoot: string,
): Promise<DecisionRecord[]> {
  const p = join(projectRoot, MYCL_DIR, DECISIONS_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AuditError(`decisions read failed: ${String(err)}`);
  }
  const out: DecisionRecord[] = [];
  for (const line of raw.split("\n").filter((l) => l.trim())) {
    try {
      out.push(JSON.parse(line) as DecisionRecord);
    } catch (err) {
      console.error(`[decisions] bad line skipped: ${line.slice(0, 100)} (${err})`);
    }
  }
  return out;
}

/**
 * Pipeline en az bir kez son fazı (Faz 17) tamamladı mı? Audit log'da
 * `phase-17-complete` event'i varsa true. Kullanıcı yeni mesaj yazınca
 * handleUserMessage bunu kontrol eder; true ise yeni iterasyon başlatır.
 * Backward compat: eski state'lerde `phase-20-complete` event'i kalmış
 * olabilir (v15.3 öncesi); o da pipeline tamamlandı sayılır.
 */
export async function wasPipelineCompleted(
  projectRoot: string,
): Promise<boolean> {
  const events = await readAuditLog(projectRoot);
  return events.some(
    (e) => e.event === "phase-17-complete" || e.event === "phase-20-complete",
  );
}

/**
 * Belirli bir fazın audit kayıtlarını kısa bir özete dönüştürür — qa-askq
 * fazlarına (Faz 9, 19) context enjeksiyonu için. Çıktı plain-text,
 * Claude'a system prompt içinde verilir.
 *
 * Format:
 *   Audit for phase N (M events, last K):
 *   - event1 (caller=...) detail
 *   - event2 ...
 *   Aggregate: green=X red=Y
 */
export async function summarizeAuditForPhase(
  projectRoot: string,
  phase: AuditEvent["phase"],
  maxEvents = 30,
): Promise<string> {
  const all = await readAuditLog(projectRoot);
  const events = all.filter((e) => e.phase === phase);
  if (events.length === 0) {
    return `Audit for phase ${phase}: (no events).`;
  }
  const recent = events.slice(-maxEvents);
  const lines = recent.map((e) => {
    const detail = e.detail ? ` ${e.detail.slice(0, 120)}` : "";
    return `- ${e.event} (caller=${e.caller})${detail}`;
  });
  // Faz 8 için yeşil/kırmızı toplamı ek bilgidir; başka fazlarda da yararsız değil.
  const greens = events.filter((e) => e.event === "tdd-green").length;
  const reds = events.filter((e) => e.event === "tdd-red").length;
  const aggregate =
    greens + reds > 0 ? `\nAggregate: green=${greens} red=${reds}` : "";
  return `Audit for phase ${phase} (${events.length} events, last ${recent.length}):\n${lines.join("\n")}${aggregate}`;
}

/**
 * Spec.md'den belirli bir başlık altındaki bölümü çıkarır. qa-askq fazlarına
 * (Faz 6 AC, Faz 9 Risks) context enjeksiyonu için.
 *
 * Fallback YASAK:
 *   - Spec.md dosya yoksa → `SpecMissingError` throw.
 *   - Diğer fs error (permission) → `AuditError` throw.
 *   - Heading bulunamazsa → `SpecSectionMissingError` throw.
 *
 * Caller catch edip emitError + return fail yapmalı — sessizce boş string
 * dönmek hata gizler.
 *
 * Section regex: `## Heading` ile başlayan satırdan bir sonraki `## ` veya
 * EOF'a kadar — section gövdesi.
 */
export async function extractSpecSection(
  projectRoot: string,
  heading: string,
): Promise<string> {
  const specPath = join(projectRoot, MYCL_DIR, "spec.md");
  let raw: string;
  try {
    raw = await fs.readFile(specPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SpecMissingError(`spec.md not found at ${specPath}`);
    }
    throw new AuditError(`spec.md read failed: ${String(err)}`);
  }
  const lines = raw.split("\n");
  const start = lines.findIndex(
    (l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`,
  );
  if (start < 0) {
    throw new SpecSectionMissingError(
      `section "## ${heading}" not found in spec.md`,
    );
  }
  const rest = lines.slice(start + 1);
  const endRel = rest.findIndex((l) => /^## /.test(l));
  const body = endRel < 0 ? rest : rest.slice(0, endRel);
  return body.join("\n").trim();
}

/**
 * v15.7 (2026-05-25): Sadece audit'in SON N event'ini okur. Büyük projelerde
 * audit.log MB seviyesine çıkar (100+ iterasyon → 2-5 MB); caller'ların çoğu
 * sadece son birkaç event'e ihtiyaç duyar. Bu helper full read yerine tail
 * okur → ~5K input token + disk I/O tasarrufu/agent call.
 *
 * Boyut < 100 KB ise full read fallback (tail logic overkill). Büyükse:
 * fs.open + offset-based read; ilk partial line drop (tail rastgele yerden
 * başlayabilir).
 *
 * **DİKKAT — bu fonksiyonu KULLANMA YERLERİ:**
 * - `wasPipelineCompleted` (tarihte herhangi bir phase-17-complete arıyor; tail
 *   yetmez) — readAuditLog kullansın.
 * - Per-iteration check eden caller'lar — full audit gerekli.
 *
 * Kullanılabilir yerler:
 * - Agent context build (son 10 event inject ediliyor, 100 tail bol bol yeter)
 * - Phase gate evaluation (sadece o phase'in event'leri lazım)
 * - detectInterruptedPhase1 (son iteration-N-start aramak için)
 */
export async function readAuditLogTail(
  projectRoot: string,
  maxLines = 500,
): Promise<AuditEvent[]> {
  const p = auditPath(projectRoot);
  let stats;
  try {
    stats = await fs.stat(p);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AuditError(`audit stat failed: ${String(err)}`);
  }
  const FULL_READ_THRESHOLD = 100 * 1024; // < 100 KB → fallback full
  if (stats.size <= FULL_READ_THRESHOLD) {
    const all = await readAuditLog(projectRoot);
    return all.slice(-maxLines);
  }
  // Tail read: son ~maxLines * 250 byte (heuristic, audit event ~200 byte ort.)
  const tailBytes = Math.min(stats.size, maxLines * 250);
  const fh = await fs.open(p, "r");
  try {
    const buf = Buffer.alloc(tailBytes);
    await fh.read(buf, 0, tailBytes, stats.size - tailBytes);
    const raw = buf.toString("utf-8");
    // İlk partial satırı drop — tail offset rastgele yerden başlamış olabilir
    const firstNewline = raw.indexOf("\n");
    const usable = firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw;
    const lines = usable.split("\n").filter((l) => l.trim());
    const events: AuditEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {
        // bozuk satır skip (full read'deki davranışla tutarlı)
      }
    }
    return events.slice(-maxLines);
  } finally {
    await fh.close();
  }
}

/**
 * Tüm audit history'sini okur. Bozuk satırlar atlanır (warn'a düşer).
 */
export async function readAuditLog(projectRoot: string): Promise<AuditEvent[]> {
  const p = auditPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AuditError(`audit read failed: ${String(err)}`);
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const events: AuditEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch (err) {
      console.error(`[audit] bad line skipped: ${line.slice(0, 100)} (${err})`);
    }
  }
  return events;
}
