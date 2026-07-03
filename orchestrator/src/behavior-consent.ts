// behavior-consent — "var olan bir davranışı DEĞİŞTİRMEDEN ÖNCE kullanıcıya sor" özelliğinin
// SAF çekirdeği: spec'lerden AC çıkar, iterasyonlar arası davranış farkını hesapla, kararı kalıcı
// tut (append-only NDJSON). YZLLM 2026-07-03.
//
// Amaç (KATI#6 correct-by-construction): MyCL var olan davranışı sessizce değiştirmesin. Faz 8
// kodgen BAŞLAMADAN önce, önceki iterasyonun spec'i ile bunun spec'ini deterministik karşılaştırıp
// DEĞİŞEN/KALDIRILAN davranışları çıkarırız → kapı bunları kullanıcıya sorar (behavior-consent-gate.ts).
//
// Tespit deterministik + LLM'siz + stack bağımsız (KATI#1). AC id'leri her iterasyonda yeniden
// basıldığından (AC1..ACn konumsal) eşleştirme id ile DEĞİL, normalize edilmiş davranış imzası +
// token Jaccard benzerliği ile yapılır. `then` (gözlemlenebilir sonuç) alanına ağırlık verilir:
// kelime değişse bile davranış eşleşmesi bulunur → değişiklik NEW sanılıp sessizce kaçmaz.
//
// Depolama answer-memory.ts desenini yansıtır: O_APPEND atomic satır; bozuk satır atlanır; dosya
// yoksa []; SON SATIR KAZANIR. Manuel sıfırlama: `.mycl/behavior-consent.jsonl` satırını sil.

import { promises as fs } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { formatIterationTs } from "./devs-paths.js";

const MYCL_DIR = ".mycl";
const CONSENT_FILE = "behavior-consent.jsonl";
const PENDING_CHANGES_FILE = "pending-behavior-changes.json";
const SPEC_ARTIFACT_NAME = "iter-spec.md";
const DEVS_DIR = "devs";

// --- Eşiği ayarlanabilir sabitler (sezgisel; testler davranışı sabitler) ---
/** İki AC "aynı davranışı" ele alıyor mu — KARARLI senaryo (statement+given+when) token Jaccard eşiği. */
export const MATCH_MIN = 0.4;
/** `then` alanları bu kadar benzerse, senaryo benzerliği düşük olsa bile eşleşmiş say (kelime kayması ağı). */
export const THEN_MATCH = 0.5;
/** Tek iterasyonda bu kadardan çok değişiklik → neredeyse kesin bozuk-diff → devre kesici (kapıda). */
export const MAX_CONSENT_ASKS = 12;

export interface AcRecord {
  id: string;
  statement: string;
  given?: string;
  when?: string;
  then?: string;
}

export interface BehaviorChange {
  /** Kararlı davranış imzası (CHANGED→güncel, REMOVED→önceki normalize imzası). answer-memory key'i. */
  sig: string;
  kind: "changed" | "removed";
  /** Güncel spec'teki AC id (CHANGED için; ajana "bu AC" demek için). REMOVED'da yok. */
  currentAcId?: string;
  /** İnsan-okur "bugün ne yapıyor" (İngilizce spec içeriği; kapı soruyu kurup translate eder). */
  priorStatement: string;
  /** İnsan-okur "ne olacak" (CHANGED için; REMOVED'da undefined). */
  newStatement?: string;
  /** Çözülen var olan `.feature` yolları (belirsizse boş — asla uydurma). */
  featureFiles: string[];
  /** Çözülen var olan test yolları (belirsizse boş). */
  testFiles: string[];
}

export interface BehaviorChangeSet {
  iteration: number;
  ts: number;
  origin: "mycl" | "foreign";
  /** Boş → hiç soru yok. */
  changes: BehaviorChange[];
}

export type ConsentDecision = "yes" | "no";

export interface BehaviorConsentRecord {
  ts: number;
  iteration: number;
  sig: string;
  decision: ConsentDecision;
  scope: "behavior-consent";
  priorStatement: string;
  featureFiles: string[];
  testFiles: string[];
}

// ============================ SAF: ayrıştırma ============================

/**
 * SAF: spec markdown'ından AC kayıtlarını çıkarır. `specToMarkdown` (phase-4.ts) render
 * sözleşmesiyle senkron: `- **ACn**: statement` + girintili `  - _Given:_/_When:_/_Then:_`.
 * Başlık (`## ...`) görülünce güncel AC sıfırlanır (başka bölümdeki bullet AC'ye sızmaz).
 */
export function parseAcRecords(md: string): AcRecord[] {
  const acRe = /^\s*-\s+\*\*(AC\d+)\*\*:\s*(.*)$/;
  const gwtRe = /^\s*-\s+_(Given|When|Then):_\s*(.*)$/;
  const headingRe = /^#{1,6}\s/;
  const out: AcRecord[] = [];
  let cur: AcRecord | null = null;
  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (headingRe.test(line)) {
      cur = null;
      continue;
    }
    const acM = acRe.exec(line);
    if (acM) {
      cur = { id: acM[1], statement: acM[2].trim() };
      out.push(cur);
      continue;
    }
    const gwtM = gwtRe.exec(line);
    if (gwtM && cur) {
      const kind = gwtM[1].toLowerCase() as "given" | "when" | "then";
      cur[kind] = gwtM[2].trim();
    }
  }
  return out;
}

const STOPWORDS = new Set<string>([
  "the", "a", "an", "is", "are", "to", "of", "and", "or", "in", "on", "for",
  "with", "when", "then", "given", "that", "this", "it", "be", "as", "at",
  "by", "from", "should", "must", "will", "shall",
]);

/** SAF: küçült, harf/rakam dışını boşluğa çevir, boşluğu topla, trim (Unicode-güvenli — TR harfleri dahil). */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fullText(ac: AcRecord): string {
  return [ac.statement, ac.given ?? "", ac.when ?? "", ac.then ?? ""].join(" | ");
}

/** KARARLI senaryo: statement+given+when (then HARİÇ). Eşleştirme buna bakar; `then` değişince
 * senaryo aynı kalır → değişiklik yakalanır (aksi halde `then` farkı benzerliği düşürüp NEW sanılır). */
function ctxText(ac: AcRecord): string {
  return [ac.statement, ac.given ?? "", ac.when ?? ""].join(" | ");
}

/** SAF: bir AC'nin kararlı normalize davranış imzası (statement+given+when+then). Eşitlik/anahtar için. */
export function normalizeBehaviorSig(ac: AcRecord): string {
  return normalizeText(fullText(ac));
}

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of normalizeText(s).split(" ")) {
    if (t && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** SAF: iki token kümesi Jaccard benzerliği [0,1]. İkisi de boşsa 1 (eşit), biri boşsa 0. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function priorPhrase(ac: AcRecord): string {
  return ac.then ? `${ac.statement} (beklenen: ${ac.then})` : ac.statement;
}

/**
 * SAF: önceki ve güncel AC kümelerini karşılaştırıp DAVRANIŞ DEĞİŞİKLİKLERİNİ çıkarır.
 * - NEW (güncel eşi yok)         → asla sorulmaz (yeni davranış, korunacak var olan yok).
 * - CHANGED (eşleşti + farklı)   → sorulur.
 * - REMOVED (önceki eşi yok)     → sorulur (ama olası yeniden-ifade REMOVE_SUPPRESS ile bastırılır).
 * featureFiles/testFiles BOŞ döner; çözüm I/O (resolveBehaviorArtifacts) ayrı adımdır.
 */
export function diffBehaviors(prior: AcRecord[], current: AcRecord[]): BehaviorChange[] {
  const changes: BehaviorChange[] = [];
  const priorTok = prior.map((p) => ({
    ac: p,
    ctx: tokenize(ctxText(p)),
    then: tokenize(p.then ?? ""),
    sig: normalizeBehaviorSig(p),
  }));
  const curTok = current.map((c) => ({
    ac: c,
    ctx: tokenize(ctxText(c)),
    then: tokenize(c.then ?? ""),
  }));

  // GLOBAL en-iyi-önce eşleştirme (greedy-per-current DEĞİL — mahkeme #3, cardinal sin): tüm uygun
  // (güncel, önceki) çiftlerini skorla, ctx (kararlı senaryo kimliği) BİRİNCİL. Böylece bir prior için
  // YENİ bir AC (yüksek thenSim ile) ile DEĞİŞEN bir AC (yüksek ctxSim ile) yarışırsa, ctx'i yüksek olan
  // (gerçek değişen) prior'ı kapar → değişen NEW sanılıp SESSİZCE kaçmaz. thenSim yalnız eşleşme-uygunluğu
  // + kelime-kayması köprüsü (rakip yoksa düşük-ctx/yüksek-then çift yine atanır).
  interface Pair {
    ci: number;
    pi: number;
    ctxSim: number;
    thenSim: number;
  }
  const pairs: Pair[] = [];
  curTok.forEach((c, ci) => {
    priorTok.forEach((p, pi) => {
      const ctxSim = jaccard(c.ctx, p.ctx);
      const thenSim = c.ac.then && p.ac.then ? jaccard(c.then, p.then) : 0;
      if (ctxSim >= MATCH_MIN || thenSim >= THEN_MATCH) pairs.push({ ci, pi, ctxSim, thenSim });
    });
  });
  pairs.sort((a, b) => b.ctxSim - a.ctxSim || b.thenSim - a.thenSim);
  const usedC = new Set<number>();
  const usedP = new Set<number>();
  const matchOf = new Map<number, number>(); // güncel-index → önceki-index
  for (const pr of pairs) {
    if (usedC.has(pr.ci) || usedP.has(pr.pi)) continue;
    usedC.add(pr.ci);
    usedP.add(pr.pi);
    matchOf.set(pr.ci, pr.pi);
  }

  curTok.forEach((c, ci) => {
    const pi = matchOf.get(ci);
    if (pi === undefined) return; // NEW (eşleşen önceki davranış yok) → sorma
    const p = priorTok[pi];
    if (normalizeBehaviorSig(c.ac) === p.sig) return; // aynı davranış (kozmetik dahil) → değişmedi
    changes.push({
      sig: normalizeBehaviorSig(c.ac),
      kind: "changed",
      currentAcId: c.ac.id,
      priorStatement: priorPhrase(p.ac),
      newStatement: priorPhrase(c.ac),
      featureFiles: [],
      testFiles: [],
    });
  });

  // REMOVED: hiçbir güncel AC'nin eşleşmediği önceki davranışlar. Yeniden-ifade edilmiş bir davranış
  // senaryo/then eşleşmesiyle yukarıda "changed" olarak tüketilir, buraya düşmez.
  priorTok.forEach((p, pi) => {
    if (usedP.has(pi)) return;
    changes.push({
      sig: p.sig,
      kind: "removed",
      priorStatement: priorPhrase(p.ac),
      featureFiles: [],
      testFiles: [],
    });
  });

  return changes;
}

// ============================ I/O: önceki spec bulma ============================

/** `devs/` altındaki TÜM `iter-spec.md` dosyalarını gez (birim çözülünce _pending'ten taşınmış olabilir). */
async function findAllIterSpecs(
  projectRoot: string,
): Promise<Array<{ label: string; path: string }>> {
  const results: Array<{ label: string; path: string }> = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // yoksa/erişilemezse sessizce atla (devs/ hiç yoksa dahil)
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name === SPEC_ARTIFACT_NAME) {
        results.push({ label: basename(dir), path: full });
      }
    }
  }
  await walk(join(projectRoot, DEVS_DIR));
  return results;
}

/**
 * Güncel iterasyondan KESİN ÖNCE olan en yeni iter-spec.md'yi bulur. Klasör etiketi
 * "YYYY-MM-DD-HH-MM-SS" sabit genişlikli → sözlüksel sıra = kronolojik sıra. Yoksa null
 * (iterasyon 1 / önceki yok → boş değişiklik kümesi → sıfır soru). `.mycl/spec.md`'e DÜŞMEZ:
 * o çapraz-iterasyon hafızası Faz 4'te güncele tazelenir → güncel-güncel karşılaştırma yanıltır.
 */
export async function findPriorSpecPath(
  projectRoot: string,
  currentIterationTs: number,
): Promise<string | null> {
  const currentLabel = formatIterationTs(currentIterationTs);
  const all = await findAllIterSpecs(projectRoot);
  const older = all.filter((s) => s.label < currentLabel).sort((a, b) => (a.label < b.label ? -1 : 1));
  return older.length > 0 ? older[older.length - 1].path : null;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * MyCL-projesi yolu: güncel spec'i bir önceki iterasyon spec'iyle karşılaştırıp değişiklik kümesi üret.
 * currentSpecMd çağıran tarafından okunur (currentSpecPath). Önceki yoksa → boş küme (sıfır soru).
 */
export async function computeBehaviorChangeSet(args: {
  projectRoot: string;
  iteration: number;
  iterationTs: number;
  currentSpecMd: string;
}): Promise<BehaviorChangeSet> {
  const empty: BehaviorChangeSet = {
    iteration: args.iteration,
    ts: args.iterationTs,
    origin: "mycl",
    changes: [],
  };
  if (args.iteration <= 1) return empty; // iterasyon 1 → her şey yeni, korunacak davranış yok
  const priorPath = await findPriorSpecPath(args.projectRoot, args.iterationTs);
  if (!priorPath) return empty;
  const priorMd = await readFileOrNull(priorPath);
  if (priorMd == null) return empty;
  const changes = diffBehaviors(parseAcRecords(priorMd), parseAcRecords(args.currentSpecMd));
  return { ...empty, changes };
}

// ============================ I/O: pending değişiklik kümesi (geçici) ============================

function pendingChangesPath(projectRoot: string): string {
  return join(projectRoot, MYCL_DIR, PENDING_CHANGES_FILE);
}

export async function writePendingBehaviorChanges(
  projectRoot: string,
  set: BehaviorChangeSet,
): Promise<void> {
  const p = pendingChangesPath(projectRoot);
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(set, null, 2), "utf-8");
}

export async function readPendingBehaviorChanges(
  projectRoot: string,
): Promise<BehaviorChangeSet | null> {
  const raw = await readFileOrNull(pendingChangesPath(projectRoot));
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as BehaviorChangeSet;
  } catch (err) {
    console.error(`[behavior-consent] bad pending-changes file skipped (${err})`);
    return null;
  }
}

// ============================ I/O: onay kaydı deposu (append-only NDJSON) ============================

function consentPath(projectRoot: string): string {
  return join(projectRoot, MYCL_DIR, CONSENT_FILE);
}

/** Tek onay kaydı append eder (O_APPEND atomic; audit deseni). */
export async function appendBehaviorConsent(
  projectRoot: string,
  rec: BehaviorConsentRecord,
): Promise<void> {
  const line = JSON.stringify(rec) + "\n";
  const p = consentPath(projectRoot);
  await fs.mkdir(dirname(p), { recursive: true });
  const fh = await openFile(p, "a");
  try {
    await fh.write(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** behavior-consent.jsonl'i okur (bozuk satır atlanır). Dosya yoksa []. */
export async function readBehaviorConsent(
  projectRoot: string,
): Promise<BehaviorConsentRecord[]> {
  const raw = await readFileOrNull(consentPath(projectRoot));
  if (raw == null) return [];
  const out: BehaviorConsentRecord[] = [];
  for (const line of raw.split("\n").filter((l) => l.trim())) {
    try {
      out.push(JSON.parse(line) as BehaviorConsentRecord);
    } catch (err) {
      console.error(`[behavior-consent] bad line skipped: ${line.slice(0, 100)} (${err})`);
    }
  }
  return out;
}

/** SAF: bir imzanın EN SON (son-satır-kazanır) onay kaydı; yoksa null. */
export function latestConsentFor(
  records: BehaviorConsentRecord[],
  sig: string,
): BehaviorConsentRecord | null {
  let found: BehaviorConsentRecord | null = null;
  for (const r of records) {
    if (r.sig === sig) found = r;
  }
  return found;
}
