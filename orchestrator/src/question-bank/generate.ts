// İkili Soru Bankası — üretim çekirdeği (Dilim 4).
//
// Banka eksikse cross-family bir üretici (proposer) aday sorular önerir; HER aday
// slice-2 meta-testinden geçer ve YALNIZ kilitlenebilen (ayırt-edici kanıtlanan)
// sorular bankaya girer (fail-closed). Üretici ENJEKTE edilir → saf test mümkün
// (gerçekte cross-family Sonnet müfettiş; proposer.ts). LLM çıktısı GÜVENİLMEZ →
// coerceQuestions şema-dışını eler (sessizce değil; caller reddedilenleri görür).

import { runMetaTest, type CmdRunner } from "./lock.js";
import { bankKeyToPath } from "./key.js";
import { readBank, writeBankAtomic } from "./storage.js";
import {
  BANK_SCHEMA_VERSION,
  type BankKey,
  type BankQuestion,
  type Fixture,
  type QuestionBank,
} from "./types.js";

/** Üretici: bir KEY için aday sorular öner. Enjekte edilir (test'lenebilir). */
export type QuestionProposer = (key: BankKey) => Promise<BankQuestion[]>;

export interface GenerateResult {
  /** Yalnız kilitlenen (kanıtlanan) sorulardan oluşan banka. */
  bank: QuestionBank;
  locked: BankQuestion[];
  /** Meta-testi geçemeyen adaylar (kanıtlanamadı → bankaya ALINMADI). */
  rejected: { id: string; reason: string }[];
}

/**
 * Aday soruları meta-testten geçir; yalnız kilitlenebilenler banka olur.
 * test-validity'nin fail-OPEN'ının TERSİ: kanıtlanamayan check banka olamaz.
 */
export async function generateBank(opts: {
  key: BankKey;
  propose: QuestionProposer;
  runner: CmdRunner;
  stabilityRuns?: number;
}): Promise<GenerateResult> {
  const candidates = await opts.propose(opts.key);
  const locked: BankQuestion[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const q of candidates) {
    const meta = await runMetaTest(q, opts.runner, { stabilityRuns: opts.stabilityRuns });
    if (meta.lockable) locked.push(q);
    else rejected.push({ id: q.id, reason: meta.reason });
  }
  return {
    bank: { key: opts.key, questions: locked, version: BANK_SCHEMA_VERSION },
    locked,
    rejected,
  };
}

/**
 * Banka varsa oku; yoksa üret + (≥1 kilitli soru varsa) ATOMİK yaz. Hiç kilitli
 * soru yoksa banka YAZILMAZ (boş banka yanlış "banka var" sinyali verirdi;
 * skip_no_bank'tan farksız ama daha dürüst — caller reddedilenleri görür).
 */
export async function ensureBank(opts: {
  banksRoot: string;
  key: BankKey;
  propose: QuestionProposer;
  runner: CmdRunner;
  stabilityRuns?: number;
}): Promise<{
  bank: QuestionBank | null;
  generated: boolean;
  rejected: { id: string; reason: string }[];
}> {
  const path = bankKeyToPath(opts.banksRoot, opts.key);
  const existing = await readBank(path);
  if (existing) return { bank: existing, generated: false, rejected: [] };
  const gen = await generateBank(opts);
  if (gen.locked.length === 0) {
    return { bank: null, generated: false, rejected: gen.rejected };
  }
  await writeBankAtomic(path, gen.bank);
  return { bank: gen.bank, generated: true, rejected: gen.rejected };
}

/**
 * LLM çıktısını güvenli BankQuestion[]'a çevir — şema-dışı/eksik adaylar ELENİR.
 * LLM çıktısı GÜVENİLMEZ; fixtures'siz aday zaten kilitlenemez → erken elenir.
 */
export function coerceQuestions(raw: unknown): BankQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: BankQuestion[] = [];
  for (const item of raw) {
    const q = coerceOne(item);
    if (q) out.push(q);
  }
  return out;
}

function coerceOne(item: unknown): BankQuestion | null {
  if (typeof item !== "object" || item === null) return null;
  const o = item as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    typeof o.text !== "string" ||
    typeof o.real_to_proxy !== "string"
  ) {
    return null;
  }
  const check = o.check as Record<string, unknown> | undefined;
  if (!check || typeof check.cmd !== "string") return null;
  const fixtures = coerceFixtures(o.fixtures);
  if (fixtures.length === 0) return null;
  const inconclusive =
    Array.isArray(check.inconclusive_codes) &&
    check.inconclusive_codes.every((c) => typeof c === "number")
      ? (check.inconclusive_codes as number[])
      : undefined;
  return {
    id: o.id,
    text: o.text,
    real_to_proxy: o.real_to_proxy,
    blocking_class: o.blocking_class === "advisory" ? "advisory" : "blocking",
    check: { cmd: check.cmd, ...(inconclusive ? { inconclusive_codes: inconclusive } : {}) },
    fixtures,
  };
}

function coerceFixtures(raw: unknown): Fixture[] {
  if (!Array.isArray(raw)) return [];
  const out: Fixture[] = [];
  for (const f of raw) {
    if (typeof f !== "object" || f === null) continue;
    const o = f as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    if (o.expect !== "PASS" && o.expect !== "FAIL") continue;
    if (typeof o.files !== "object" || o.files === null) continue;
    const files: Record<string, string> = {};
    let ok = true;
    for (const [k, v] of Object.entries(o.files as Record<string, unknown>)) {
      if (typeof v !== "string") {
        ok = false;
        break;
      }
      files[k] = v;
    }
    if (ok && Object.keys(files).length > 0) {
      out.push({ name: o.name, files, expect: o.expect });
    }
  }
  return out;
}
