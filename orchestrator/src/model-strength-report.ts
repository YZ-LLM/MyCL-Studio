// model-strength-report — "hangi model hangi alanda iyi" raporu (Ümit 2026-06-11). Escalation merdiveninde her
// deneme (başarı/başarısızlık) domain+rung+model olarak kaydedilir; rapor zamanla hangi işin hangi basamakta
// çözüldüğünü gösterir → MyCL gelecekte o domain için DOĞRU basamaktan başlamayı öğrenir + kullanıcı popup'ta görür.
//
// Depolama: ~/.mycl/model-strength.jsonl (NDJSON append — read-modify-write yarışı yok, global/proje-üstü çünkü
// model gücü evrensel). Aggregation + format SAF (test edilebilir); IO ince sarmalayıcı.

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { globalConfigDir } from "./paths.js";
import { buildLadder, rungLabel } from "./escalation.js";
import { log } from "./logger.js";

export interface StrengthRecord {
  /** İş alanı — task kind / faz (codegen, debug, review, ui, spec, ...). */
  domain: string;
  /** "cheap · low" (rungLabel). */
  rung: string;
  /** Çözülen gerçek model id (claude-haiku-4-5 vb.). */
  model: string;
  success: boolean;
  ts: number;
}

export interface RungStat {
  rung: string;
  model: string;
  success: number;
  fail: number;
}
export interface DomainSummary {
  domain: string;
  totalAttempts: number;
  byRung: RungStat[];
  /** En düşük GÜVENİLİR basamak (success>0 ve success>=fail) — bu domain için önerilen başlangıç. */
  recommendedFloor?: string;
}

const LADDER_ORDER: string[] = buildLadder().map(rungLabel);
const rungRank = (label: string): number => {
  const i = LADDER_ORDER.indexOf(label);
  return i < 0 ? 999 : i;
};

/** SAF: ham kayıtları domain→rung özetine indirger + her domain için önerilen başlangıç basamağını bulur. */
export function summarizeStrength(records: StrengthRecord[]): DomainSummary[] {
  const byDomain = new Map<string, Map<string, RungStat>>();
  for (const r of records) {
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, new Map());
    const rungs = byDomain.get(r.domain)!;
    if (!rungs.has(r.rung)) rungs.set(r.rung, { rung: r.rung, model: r.model, success: 0, fail: 0 });
    const stat = rungs.get(r.rung)!;
    if (r.success) stat.success++;
    else stat.fail++;
  }
  const out: DomainSummary[] = [];
  for (const [domain, rungs] of byDomain) {
    const byRung = [...rungs.values()].sort((a, b) => rungRank(a.rung) - rungRank(b.rung));
    const total = byRung.reduce((n, s) => n + s.success + s.fail, 0);
    // Önerilen başlangıç = en DÜŞÜK basamak ki success>0 ve success>=fail (güvenilir biçimde çözüyor).
    const floor = byRung.find((s) => s.success > 0 && s.success >= s.fail);
    out.push({ domain, totalAttempts: total, byRung, recommendedFloor: floor?.rung });
  }
  return out.sort((a, b) => b.totalAttempts - a.totalAttempts);
}

/** SAF: özetleri kullanıcıya gösterilecek Türkçe rapora çevirir (popup içeriği). */
export function formatStrengthReportTR(summaries: DomainSummary[]): string {
  if (summaries.length === 0) {
    return "Henüz veri yok. İşler koştukça hangi modelin hangi alanda iyi olduğunu buraya yazacağım.";
  }
  const lines: string[] = ["# Model Güç Raporu", "", "Hangi iş hangi basamakta çözülüyor (escalation gözlemi):", ""];
  for (const s of summaries) {
    lines.push(`## ${s.domain}  (${s.totalAttempts} deneme)`);
    if (s.recommendedFloor) {
      lines.push(`- ✅ Önerilen başlangıç: **${s.recommendedFloor}** (bu alanda güvenilir biçimde çözen en düşük basamak)`);
    } else {
      lines.push(`- ⚠️ Henüz güvenilir bir basamak yok (veri birikiyor)`);
    }
    for (const r of s.byRung) {
      const total = r.success + r.fail;
      const rate = total > 0 ? Math.round((r.success / total) * 100) : 0;
      lines.push(`  - ${r.rung} (${r.model}): ${r.success}/${total} başarı (%${rate})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function reportPath(): string {
  return join(globalConfigDir(), "model-strength.jsonl");
}

/** Bir denemeyi kaydet (escalation wiring'den çağrılır). Fail-safe: yazılamasa da iş akışını bozmaz. */
export async function recordStrength(rec: Omit<StrengthRecord, "ts">, nowTs: number): Promise<void> {
  try {
    const p = reportPath();
    await mkdir(dirname(p), { recursive: true });
    await appendFile(p, JSON.stringify({ ...rec, ts: nowTs }) + "\n", "utf-8");
  } catch (e) {
    log.warn("model-strength", "record failed (non-fatal)", e);
  }
}

/** Tüm kayıtları oku (bozuk satırları atla). Fail-safe: dosya yoksa boş. */
export async function readStrengthRecords(): Promise<StrengthRecord[]> {
  let raw: string;
  try {
    raw = await readFile(reportPath(), "utf-8");
  } catch {
    return [];
  }
  const records: StrengthRecord[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as StrengthRecord;
      if (o && typeof o.domain === "string" && typeof o.rung === "string") records.push(o);
    } catch {
      // bozuk satır → atla
    }
  }
  return records;
}

/** Popup için: kayıtları oku → özetle → Türkçe formatla. */
export async function buildStrengthReportTR(): Promise<string> {
  const records = await readStrengthRecords();
  return formatStrengthReportTR(summarizeStrength(records));
}
