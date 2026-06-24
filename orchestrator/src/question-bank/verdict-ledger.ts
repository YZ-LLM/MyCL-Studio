// İkili Soru Bankası — insan-override ledger (Dilim 3a).
//
// İnsan bir "Hayır"ı override ederse (kabul/yanlış-check/gerçek-defect), bu
// karar bankanın KENDİ deterministik key-space'inde saklanır:
//   verdicts/<checkpoint>/<stack>/<artifact>.json,  anahtar = check-id × input-hash.
// Exact-hash eşleşme → kararı yeniden-kullan, SORMA. Hash farkı → input
// MADDİ olarak değişti → yeniden sor. experience-layer.ts fuzzy signatureOverlap
// (Jaccard) ASLA kullanılmaz — bu, deterministik gate'e LLM-softluğunu geri sızdırır
// (müfettiş paneli fatal buldu). Kararın yeniden-kullanımı hash ile KANITLANIR.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { artifactFileToken } from "./key.js";
import { readJson, writeJsonAtomic } from "./storage.js";
import type { BankKey } from "./types.js";

/** İnsanın bir "Hayır"a verebileceği karar türleri. */
export type HumanVerdict = "accept-once" | "accept-override" | "check-wrong" | "real-defect";

export interface LedgerEntry {
  check_id: string;
  /** Yanıtlanan input'un content-hash'i (sha256 hex). */
  input_hash: string;
  verdict: HumanVerdict;
  at: number;
  note?: string;
}

export interface VerdictLedger {
  key: BankKey;
  entries: LedgerEntry[];
  version: number;
}

export const LEDGER_SCHEMA_VERSION = 1;

/** Yanıtlanan input'un deterministik content-hash'i. */
export function hashInput(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Boş ledger. */
export function emptyLedger(key: BankKey): VerdictLedger {
  return { key, entries: [], version: LEDGER_SCHEMA_VERSION };
}

/** KEY → diskteki ledger yolu (banka ile aynı deterministik şema). */
export function ledgerPath(ledgerRoot: string, key: BankKey): string {
  return join(ledgerRoot, key.checkpoint, key.stack, `${artifactFileToken(key.artifact)}.json`);
}

/**
 * Bir check + input için kayıtlı insan-kararını ara. Exact (check-id × input-hash)
 * eşleşme → entry; yoksa null (yeniden sor). Fuzzy eşleşme YOK.
 */
export function lookupVerdict(
  ledger: VerdictLedger | null,
  checkId: string,
  input: string,
): LedgerEntry | null {
  if (!ledger) return null;
  const h = hashInput(input);
  return ledger.entries.find((e) => e.check_id === checkId && e.input_hash === h) ?? null;
}

/**
 * Bir kararı kaydet (immutable): aynı (check-id × input-hash) varsa değiştir,
 * yoksa ekle. Yeni ledger döner.
 */
export function recordVerdict(ledger: VerdictLedger, entry: LedgerEntry): VerdictLedger {
  const rest = ledger.entries.filter(
    (e) => !(e.check_id === entry.check_id && e.input_hash === entry.input_hash),
  );
  return { ...ledger, entries: [...rest, entry] };
}

/** Ledger oku (yoksa null). */
export function readLedger(path: string): Promise<VerdictLedger | null> {
  return readJson<VerdictLedger>(path);
}

/** Ledger atomik yaz. */
export function writeLedgerAtomic(path: string, ledger: VerdictLedger): Promise<void> {
  return writeJsonAtomic(path, ledger);
}
