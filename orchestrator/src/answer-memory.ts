// answer-memory — kullanıcının TEKRARLAYAN sorulara verdiği cevabı KALICI hatırlar (append-only NDJSON).
//
// Yer: <project_root>/.mycl/answer-memory.jsonl
// Amaç (YZLLM 2026-07-03): aynı soru (aynı hata-imzası / faz-kapsamı) yeniden gelince MyCL baştan
// sormak yerine önceki cevabı hatırlar → "aynı cevabı kullanayım mı?" 3 kademeli merdiven:
//   Kademe 1 (ilk kez)      → tam soru sorulur, cevap buraya yazılır (reuseApproved=false).
//   Kademe 2 (yine)         → "geçen sefer X demiştin, aynısını kullanayım mı?" — Evet → şimdi uygula + reuseApproved=true.
//   Kademe 3 (yine, onaylı) → hiç sorma, kayıtlı cevabı oto-uygula + GÖRÜNÜR bildir.
// Hassas sorular (blocking/güvenlik) sensitive=true → Kademe 3 sessiz-oto YOK (hep Kademe 2 görünür onayı).
//
// Bu, KARAR HAFIZASI'nın (autoSolveSig/priorSolutions) TERSİ amaçlıdır: o "denenmiş çözümü TEKRAR ÖNERME";
// bu "kullanıcının SEÇTİĞİ cevabı yeniden UYGULA". Ayrı, tek amaçlı dosya (iki mantık karışmaz).
//
// audit.ts append-only desenini birebir yansıtır: O_APPEND atomic satır yazımı; okuma bozuk satırı atlar,
// dosya yoksa []. SON SATIR KAZANIR: aynı key için en son yazılan kayıt geçerlidir (güncelleme = yeni satır
// eklemek; eski satır kalabilir). Manuel sıfırlama: `.mycl/answer-memory.jsonl` ilgili satır(lar)ı sil
// (accepted-findings.jsonl ile aynı operatör alışkanlığı — geri alınabilir).

import { promises as fs } from "node:fs";
import { open as openSync } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  OPT_QUEUE,
  OPT_REANALYZE,
  OPT_ACCEPT_CONTINUE,
  OPT_ACCEPT_PERMANENT,
  OPT_STOP_MANUAL,
  OPT_SOLVE,
} from "./error-analysis.js";

const MYCL_DIR = ".mycl";
const ANSWER_MEMORY_FILE = "answer-memory.jsonl";

// Kademe 2 onay askq'sının sabit etiketleri (index.ts handleAskqAnswer BİREBİR bunlarla eşleşir → tek kaynak).
export const REUSE_YES = "Evet, aynı cevabı kullan";
export const REUSE_NO = "Hayır, yeniden karar vereyim";

export type AnswerKind = "fixed" | "solution";

export interface AnswerMemoryRecord {
  ts: number;
  /** Soru ailesi ("gate-error" | "phase-scope" | ...). Anahtar uzayı zaten ayrık; scope tanı/UI içindir. */
  scope: string;
  /** Kararlı mantıksal-soru anahtarı (gate-error: failSignature "faz:normalize-hata"; phase-scope: sıralı set). */
  key: string;
  /** Sorunun ait olduğu faz (tanı/filtre; -1 = faz-dışı). */
  phase: number;
  /** Kullanıcının SEÇTİĞİ cevap metni, AYNEN — yeniden-uygulamada bunu göndeririz (seçenek yeniden-ifade edilse de). */
  answer: string;
  /** Sabit etiket mi (OPT_ önekli / onay etiketi) yoksa LLM üretimi serbest çözüm yönü mü. */
  answerKind: AnswerKind;
  /** true → Kademe 3 sessiz-oto YASAK (güvenlik/blocking); hep Kademe 2 görünür onayında kalır. */
  sensitive: boolean;
  /** Kademe 2 "Evet"te true olur → sonraki tekrarda oto-uygulanır. */
  reuseApproved: boolean;
  /** Bu anahtar kaç kez yanıtlandı (tanı/telemetri). */
  occurrences: number;
}

// index.ts/handleAskqAnswer ile BİREBİR eşleşen sabit etiketler → "fixed" sınıfı (LLM çözümleri "solution").
const FIXED_LABELS = new Set<string>([
  OPT_QUEUE,
  OPT_REANALYZE,
  OPT_ACCEPT_CONTINUE,
  OPT_ACCEPT_PERMANENT,
  OPT_STOP_MANUAL,
  OPT_SOLVE,
]);

/** SAF: cevabı sınıfla — sabit etiketse "fixed", değilse "solution". */
export function classifyAnswer(answer: string): AnswerKind {
  return FIXED_LABELS.has(answer.trim()) ? "fixed" : "solution";
}

function memoryPath(projectRoot: string): string {
  return join(projectRoot, MYCL_DIR, ANSWER_MEMORY_FILE);
}

/** Tek kayıt append eder (O_APPEND atomic; audit deseni). */
export async function appendAnswerMemory(
  projectRoot: string,
  rec: AnswerMemoryRecord,
): Promise<void> {
  const line = JSON.stringify(rec) + "\n";
  const p = memoryPath(projectRoot);
  await fs.mkdir(dirname(p), { recursive: true });
  const fh = await openSync(p, "a");
  try {
    await fh.write(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** answer-memory.jsonl'i okur (bozuk satır atlanır). Dosya yoksa []. */
export async function readAnswerMemory(projectRoot: string): Promise<AnswerMemoryRecord[]> {
  const p = memoryPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: AnswerMemoryRecord[] = [];
  for (const line of raw.split("\n").filter((l) => l.trim())) {
    try {
      out.push(JSON.parse(line) as AnswerMemoryRecord);
    } catch (err) {
      console.error(`[answer-memory] bad line skipped: ${line.slice(0, 100)} (${err})`);
    }
  }
  return out;
}

/** SAF: kayıt dizisinden bir anahtarın EN SON (son-satır-kazanır) kaydını döndür; yoksa null. Test edilebilir. */
export function latestAnswerFor(
  records: AnswerMemoryRecord[],
  key: string,
): AnswerMemoryRecord | null {
  let found: AnswerMemoryRecord | null = null;
  for (const r of records) {
    if (r.key === key) found = r; // son eşleşen kazanır
  }
  return found;
}

/** Oku + bir anahtarın en son kaydını çöz (yoksa null = ilk kez). */
export async function recallAnswer(
  projectRoot: string,
  key: string,
): Promise<AnswerMemoryRecord | null> {
  const records = await readAnswerMemory(projectRoot);
  return latestAnswerFor(records, key);
}

/** TAZE cevap kaydı (Kademe 1, veya Kademe 2 "Hayır" güncellemesi). reuseApproved=false; occurrences=prev+1. */
export async function recordAnswer(
  projectRoot: string,
  args: {
    key: string;
    phase: number;
    answer: string;
    answerKind: AnswerKind;
    scope: string;
    sensitive: boolean;
  },
): Promise<void> {
  // Okuma hatası YUTULMAZ (KATI #4): recallAnswer dosya yoksa null döner (throw etmez); yalnız
  // gerçek disk/izin hatasında throw eder → propagate edip çağıranın logged-catch'ine düşer
  // (index.ts recordAnswer(...).catch(log.warn)). Sessizce prev=null'a düşüp yanlış occurrences yazmaz.
  const prev = await recallAnswer(projectRoot, args.key);
  await appendAnswerMemory(projectRoot, {
    ts: Date.now(),
    scope: args.scope,
    key: args.key,
    phase: args.phase,
    answer: args.answer,
    answerKind: args.answerKind,
    sensitive: args.sensitive,
    reuseApproved: false,
    occurrences: (prev?.occurrences ?? 0) + 1,
  });
}

/**
 * Kademe 2 "Evet": anahtarı reuseApproved=true olarak işaretle (son kaydın cevabını/alanlarını koruyarak yeni
 * satır ekler). Kayıt yoksa no-op (savunmacı). occurrences +1.
 */
export async function markReuseApproved(projectRoot: string, key: string): Promise<void> {
  const prev = await recallAnswer(projectRoot, key);
  if (!prev) return;
  await appendAnswerMemory(projectRoot, {
    ...prev,
    ts: Date.now(),
    reuseApproved: true,
    occurrences: prev.occurrences + 1,
  });
}
