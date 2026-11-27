// phase-9-tech-debt — Faz 9 (Risk Review) için teknik borç kontrolü.
//
// Kullanıcı kuralı (2026-06-03): "Faz 9'da teknik borç kontrolü de yapsın" +
// "sadece o iterasyondaki iş için". Yani Faz 8'in per-dosya gate'ini tamamlar:
// Faz 9'da BU İTERASYONDA değişen/oluşturulan ÜRETİM dosyaları deterministik
// taranır (scanTechDebt), bulgular risk-review bağlamına enjekte edilir; ajan
// her birini + semantik borcu (duplikasyon/dead-code/sızan soyutlama) skip/fix/
// rule olarak gezer. ÖNCEDEN var olan proje borcu KAPSAM DIŞI (tüm proje değil).
//
// "Bu iterasyonun işi" = getChangedFiles(root, fix_checkpoint_ref):
//   - fix/iterate: checkpoint ref'inden bu yana (computeChangedScope ile aynı taban).
//   - create: ref yok → HEAD diff + untracked (greenfield'da hepsi yeni).
// Saf çekirdek (scanFiles + render) test edilebilir; IO impure katmanda.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { hasSourceExt } from "./fix/evidence.js";
import { getChangedFiles, isGitRepo } from "./git.js";
import { log } from "./logger.js";
import {
  isTestPath,
  scanTechDebt,
  acceptedFindingKey,
  type TechDebtFinding,
} from "./tech-debt-scanner.js";
import { readAcceptedFindings } from "./audit.js";
import type { State } from "./types.js";

export interface FileTechDebt {
  path: string;
  findings: TechDebtFinding[];
}

export interface IterationTechDebt {
  /** Yalnız bulgusu olan dosyalar (boş array = temiz). */
  files: FileTechDebt[];
  /** Bu iterasyonda taranan tüm üretim kaynak dosyaları (ajanın inceleyebileceği liste). */
  scannedFiles: string[];
  scannedCount: number;
  totalFindings: number;
  /** Diff tabanı (fix_checkpoint_ref) — audit/debug. */
  since?: string;
  /** Değişen prod dosya sayısı tavanı aştı mı (görünür not; sessiz kesme yok). */
  truncated: boolean;
  /** Proje git deposu mu — false ise değişen-dosya kapsamı belirlenemez (dürüst not). */
  gitAvailable: boolean;
}

// Devasa iterasyonda taramayı sınırla — aşımı render'da GÖRÜNÜR not edilir.
export const MAX_SCAN_FILES = 200;

/**
 * SAF: {path, content} girdilerini tarar → IterationTechDebt çekirdeği. IO yok →
 * test edilebilir. `since`/`truncated` caller tarafından doldurulur.
 */
export function scanFiles(
  entries: { path: string; content: string }[],
  acceptedKeys?: ReadonlySet<string>,
): Pick<IterationTechDebt, "files" | "totalFindings"> {
  const files: FileTechDebt[] = [];
  let totalFindings = 0;
  for (const { path, content } of entries) {
    // FIX D (mahkeme 2026-07-01): Faz 8'de KALICI kabul edilmiş bulguları Faz 9 da atlar — yoksa
    // "Faz 8 kabul etti ama Faz 9 yeniden bulur" tutarsızlığı + Faz 9 ajanı gerçek sırrı yanlış-pozitif sanabilir.
    const findings = scanTechDebt(content, path, acceptedKeys);
    if (findings.length > 0) {
      files.push({ path, findings });
      totalFindings += findings.length;
    }
  }
  return { files, totalFindings };
}

/**
 * Faz 8 kalıcı kabul kümesi (`.mycl/accepted-findings.jsonl`, scope tech-debt) → anahtar kümesi. Faz 8 kapısı ve Faz 9
 * toplayıcısı AYNI kümeyi kullanır. Okuma hatası → boş küme (fail-open: normal tara) ama görünür uyarı.
 */
export async function readAcceptedTechDebtKeys(root: string, scope: string): Promise<Set<string>> {
  const accepted = await readAcceptedFindings(root).catch((e) => {
    log.warn(scope, "accepted-findings okunamadı (normal taramaya devam)", String(e));
    return [];
  });
  return new Set(
    accepted
      .filter((a) => a.scope === "tech-debt")
      .map((a) => acceptedFindingKey(a.file, a.category, a.snippet)),
  );
}

/** Faz 8 kapı taramasında tek bulgu (kapı iletisi + denetim kaydı için). `line` 0 = dosya okunamadı. */
export interface GateDebtFinding {
  /** Denetim ve kapı için verilen yol (kayıttaki biçimiyle; çoğunlukla mutlak). */
  path: string;
  line: number;
  category: string;
  excerpt: string;
}

export interface GateTechDebtScan {
  /** Borcu olan (ya da okunamayan) dosyalar — kapı sayısı bunun uzunluğu. */
  debtPaths: string[];
  /** Temiz taranan dosyalar. */
  cleanPaths: string[];
  findings: GateDebtFinding[];
  /** Kalıcı kabul deposuna gidecek bulgular (proje köküne göreli yol; yalnız okunabilen dosyalar). */
  store: { rel: string; findings: TechDebtFinding[] }[];
}

/**
 * Faz 8 kapısının teknik borç taraması (2026-11-28, koşu 31): kapı ANINDA dosyaların o anki içeriği taranır.
 * Eskiden her Write/Edit anında taranıyordu; CLI kipinde gözlemci araç henüz koşmadan çağrıldığı için `Edit`te
 * DÜZENLEMEDEN ÖNCEKİ içerik taranıyor, `Bash` ya da geri almayla değişen dosya hiç yeniden taranmıyordu.
 * Kapsam çağıranda: bu yinelemede Faz 8'de yazılan/düzenlenen üretim dosyaları (Faz 9'un git farkı kapsamı DEĞİL).
 * Silinmiş dosya (ENOENT) atlanır; başka okuma hatası borç sayılır (kuşkuda dahil et). `read` test için enjekte edilir.
 */
export async function scanGateTechDebt(
  root: string,
  paths: string[],
  acceptedKeys: ReadonlySet<string>,
  read: (abs: string) => Promise<string> = (abs) => readFile(abs, "utf-8"),
): Promise<GateTechDebtScan> {
  const out: GateTechDebtScan = { debtPaths: [], cleanPaths: [], findings: [], store: [] };
  const seen = new Set<string>();
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : join(root, p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    // Kabul anahtarı GÖRELİ yol kullanır (Faz 9 getChangedFiles göreli döndürür) — eskisiyle aynı.
    const rel = relative(root, abs);
    let content: string;
    try {
      content = await read(abs);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ENOENT") {
        log.info("phase-8", "deleted file skipped from tech debt", { path: p });
        continue;
      }
      log.warn("phase-8", "dosya okunamadı — tech-debt'te TUTULDU (kuşkuda dahil et)", { path: p, code });
      out.debtPaths.push(p);
      out.findings.push({ path: p, line: 0, category: "unreadable", excerpt: `dosya okunamadı (${code ?? String(e).slice(0, 60)})` });
      continue;
    }
    const findings = scanTechDebt(content, rel, acceptedKeys);
    out.store.push({ rel, findings });
    if (findings.length === 0) {
      out.cleanPaths.push(p);
      continue;
    }
    out.debtPaths.push(p);
    for (const f of findings) out.findings.push({ path: p, line: f.line, category: f.category, excerpt: f.excerpt });
  }
  return out;
}

/** SAF: kapı iletisi ve denetim için bulgu satırı: `yol:satır [kural] `metin``. */
export function formatGateDebtFinding(f: GateDebtFinding): string {
  return f.line > 0 ? `${f.path}:${f.line} [${f.category}] \`${f.excerpt}\`` : `${f.path} [${f.category}] ${f.excerpt}`;
}

/**
 * İmpure: bu iterasyonda değişen üretim dosyalarını bul (getChangedFiles), oku,
 * tara. Test/spec + kaynak-dışı + node_modules + silinmiş dosyalar elenir.
 */
export async function collectIterationTechDebt(state: State): Promise<IterationTechDebt> {
  const root = state.project_root;
  const since = state.fix_checkpoint_ref;

  // Git yoksa "bu iterasyonun değişen dosyaları" belirlenemez → boş değil, DÜRÜST not
  // (sessiz fallback yok). createCheckpoint mid-run commit yapmadığından, git varsa
  // tüm bu-iterasyon işi working tree'de (create: HEAD baseline; fix: checkpoint ref).
  let gitAvailable = false;
  try {
    gitAvailable = await isGitRepo(root);
  } catch {
    gitAvailable = false;
  }
  if (!gitAvailable) {
    return { files: [], scannedFiles: [], scannedCount: 0, totalFindings: 0, since, truncated: false, gitAvailable: false };
  }

  let changed: string[] = [];
  try {
    changed = await getChangedFiles(root, since);
  } catch (err) {
    log.warn("phase-9-tech-debt", "getChangedFiles failed (non-fatal)", err);
  }
  const prod = changed.filter(
    (f) => hasSourceExt(f) && !isTestPath(f) && existsSync(join(root, f)),
  );
  const truncated = prod.length > MAX_SCAN_FILES;
  const toScan = prod.slice(0, MAX_SCAN_FILES);

  const entries: { path: string; content: string }[] = [];
  for (const rel of toScan) {
    try {
      entries.push({ path: rel, content: await readFile(join(root, rel), "utf-8") });
    } catch (err) {
      log.warn("phase-9-tech-debt", "read failed (atlandı)", { rel, err: String(err) });
    }
  }
  // FIX D (mahkeme): Faz 8 ile aynı kabul kümesini kullan (okuma hatası → boş küme, normal tara — fail-open).
  const acceptedKeys = await readAcceptedTechDebtKeys(root, "phase-9-tech-debt");
  const { files, totalFindings } = scanFiles(entries, acceptedKeys);
  return {
    files,
    scannedFiles: entries.map((e) => e.path),
    scannedCount: entries.length,
    totalFindings,
    since,
    truncated,
    gitAvailable: true,
  };
}

/**
 * SAF: deterministik bulguları Faz 9 prompt'una enjekte edilecek markdown'a çevir.
 * {{TECH_DEBT_FINDINGS}} için.
 */
export function renderTechDebtFindings(td: IterationTechDebt): string {
  if (!td.gitAvailable) {
    return "Proje bir git deposu değil → bu iterasyonda değişen dosyalar belirlenemedi; deterministik teknik borç taraması atlandı. Riskleri yalnızca spec + audit + akıl yürütmeyle değerlendir.";
  }
  if (td.scannedCount === 0) {
    return "Bu iterasyonda taranacak değişen üretim dosyası yok (yeni/değişen kaynak bulunamadı).";
  }
  const lines: string[] = [
    `Scanned ${td.scannedCount} changed production file(s) from THIS iteration; ` +
      `${td.totalFindings} deterministic marker(s) found.`,
  ];
  if (td.truncated) {
    lines.push(
      `> NOTE: changed production files exceeded ${MAX_SCAN_FILES}; only the first ${MAX_SCAN_FILES} were scanned.`,
    );
  }
  if (td.files.length === 0) {
    lines.push(
      "No deterministic markers (TODO/FIXME/HACK, prod-mock, hardcoded credential, empty catch, skipped test).",
    );
    return lines.join("\n");
  }
  for (const f of td.files) {
    lines.push(`\n### ${f.path}`);
    for (const x of f.findings) {
      lines.push(`- L${x.line} [${x.category}] ${x.reason} — \`${x.excerpt}\``);
    }
  }
  return lines.join("\n");
}

/**
 * SAF: ajanın semantik borç için İNCELEYEBİLECEĞİ değişen dosya listesi.
 * {{TECH_DEBT_FILES}} için — ajan SADECE bu dosyaları okuyabilir (prompt sınırı).
 */
export function renderChangedFilesList(td: IterationTechDebt): string {
  if (td.scannedFiles.length === 0) return "(none — no changed production files this iteration)";
  return td.scannedFiles.map((f) => `- ${f}`).join("\n");
}
