// clarify-log — Faz 1/2 netleştirme (clarifying) soru-cevaplarını İTERASYON-KAPSAMLI kalıcı kaydeder.
//
// Amaç (YZLLM 2026-07-03): yarım iterasyon kapat-aç'ta Faz 1/2 clarifying Q&A TEKRAR sorulmasın. Bugün bu Q&A
// yalnız ölü sürecin RAM `messages[]`'inde (qa-askq-controller); resume controller'ı sıfırdan kurup tekrar sorar.
// Burada her cevap kalıcı yazılır → resume'da bu iterasyonun cevapları Faz 1/2 initialUserMessage'ına
// "ZATEN YANITLANDI — tekrar sorma, bunları kullan + devam et" olarak enjekte edilir.
//
// answer-memory'nin reuse-merdiveni UYMAZ (soru dinamik serbest metin, kararlı anahtar yok) → ayrı basit
// append-only NDJSON. Yer: <project_root>/.mycl/clarify-log.jsonl. İzolasyon: iteration alanıyla filtre → yeni
// iterasyonun kendi (boş) kapsamı; eski Q&A sızmaz (açık temizleme gerekmez).

import { promises as fs, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

const MYCL_DIR = ".mycl";
const CLARIFY_FILE = "clarify-log.jsonl";

export interface ClarifyRecord {
  ts: number;
  iteration: number;
  phase: number;
  question: string;
  answer: string;
}

function clarifyPath(projectRoot: string): string {
  return join(projectRoot, MYCL_DIR, CLARIFY_FILE);
}

/**
 * Bir Faz 1/2 clarifying Q&A'yı kalıcı kaydet. SENKRON yazım (mahkeme, YZLLM 2026-07-03): submitAskqAnswer senkron
 * çağırır ve hemen resolver'ı tetikler; async appendFile diske yazılmadan pipeline ilerleyip kapanışta (process.exit)
 * son cevap kaybolabilirdi (tam da Fix B'nin çözdüğü kapat-aç anı). appendFileSync ile dönmeden ÖNCE diske yazılır.
 * fail-soft: çağıran try/catch ile sarar (yazamazsa akış bozulmaz).
 */
export function recordClarify(projectRoot: string, rec: ClarifyRecord): void {
  const p = clarifyPath(projectRoot);
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {
    /* dizin zaten var / oluşturulamadı → appendFileSync yine dener */
  }
  appendFileSync(p, JSON.stringify(rec) + "\n", "utf8");
}

/** Düşen/terkedilmiş işin clarify Q&A'sını temizle (senkron, fail-soft) → sonraki işe SIZMASIN (mahkeme). */
export function clearClarifyLog(projectRoot: string): void {
  try {
    rmSync(clarifyPath(projectRoot), { force: true });
  } catch {
    /* dosya yok / silinemedi → yok say */
  }
}

/** Bu iterasyonun (iteration eşleşen) clarify Q&A'sını yazım sırasıyla döndür (bozuk satır atlanır; dosya yoksa []). */
export async function readClarifyForIteration(
  projectRoot: string,
  iteration: number,
): Promise<ClarifyRecord[]> {
  let content: string;
  try {
    content = await fs.readFile(clarifyPath(projectRoot), "utf8");
  } catch {
    return []; // dosya yok / okunamıyor → boş (geriye uyumlu: enjeksiyon devreye girmez)
  }
  const out: ClarifyRecord[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const rec = JSON.parse(t) as ClarifyRecord;
      if (
        rec &&
        typeof rec.question === "string" &&
        typeof rec.answer === "string" &&
        rec.iteration === iteration
      ) {
        out.push(rec);
      }
    } catch {
      /* bozuk satır atla */
    }
  }
  return out;
}

/**
 * RESUME enjeksiyonu: bu iterasyonun clarify Q&A'sını "ZATEN YANITLANDI — tekrar SORMA, devam et" bloğu olarak
 * formatla (Faz 1/2 initialUserMessage'ına eklenir). Boşsa "" → initialUserMessage bugünküyle aynı (geriye uyumlu).
 * fail-soft: okuma hatası → "".
 */
export async function buildClarifyResumeBlock(projectRoot: string, iteration: number): Promise<string> {
  const recs = await readClarifyForIteration(projectRoot, iteration).catch(() => []);
  if (recs.length === 0) return "";
  const lines = recs.map((r) => `- Q: ${r.question}\n  A: ${r.answer}`).join("\n");
  return (
    "\n\nALREADY ANSWERED THIS ITERATION (the user answered these clarifying questions before an interruption — " +
    "do NOT re-ask them; use these answers and CONTINUE from here — ask only genuinely NEW uncertainties, or conclude):\n" +
    lines
  );
}
