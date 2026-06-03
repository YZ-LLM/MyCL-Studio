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
import { join } from "node:path";
import { hasSourceExt } from "./fix/evidence.js";
import { getChangedFiles, isGitRepo } from "./git.js";
import { log } from "./logger.js";
import { isTestPath, scanTechDebt, type TechDebtFinding } from "./tech-debt-scanner.js";
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
): Pick<IterationTechDebt, "files" | "totalFindings"> {
  const files: FileTechDebt[] = [];
  let totalFindings = 0;
  for (const { path, content } of entries) {
    const findings = scanTechDebt(content);
    if (findings.length > 0) {
      files.push({ path, findings });
      totalFindings += findings.length;
    }
  }
  return { files, totalFindings };
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
  const { files, totalFindings } = scanFiles(entries);
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
