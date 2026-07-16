// maintenance — 🔧 Bakım Turu: bağımlılıkları güncelle + güvenlik tara + gerekiyorsa düzelt + Full Test.
//
// Neden (YZLLM 2026-07-16): "tek komutla bağımlılıkları güncelle, güvenlik açıklarını tara,
// gerekiyorsa düzelt — yapıldıktan sonra tüm projenin test edilmesi gerekir." DAST/Full Test
// butonu deseni: korumalı onay askq → pipeline'sız koşum → TR rapor → bulgular iş kuyruğuna.
//
// Akış: (1) `outdated` SALT-RAPOR (hep koşar — exit-1+çıktı = "güncelleme var", araç hatası değil);
// (2) `update` YALNIZ güvenliyse (git temiz → checkpoint ref = elle geri dönüş çapası; git değilse
// manifest+lock yedeği + duyuru) ve YALNIZ manifest-aralığı içi (profil değeri muhafazakâr);
// (3) bağımlılık audit + SAST paralel; (4) HER ZAMAN Full Test (kullanıcının açık şartı).
// OTO-GERİ-ALMA YOK: güncelleme test kırdıysa rapor + fix işi — checkpoint ref'i raporda
// (sessizce istenen güncellemeyi silmek KATI #4'e aykırı olurdu; kayıt görünür, karar insanda).
//
// Komutlar PROFİLDEN (KATI #1); anahtar yoksa GÖRÜNÜR "bu stack'te desteklenmiyor". ASLA throw etmez.

import { promises as fs } from "node:fs";
import { join, basename } from "node:path";
import { runSuiteProcess } from "./behavior-baseline.js";
import { isMissingCommand, isSpawnEnvFailure } from "./base/mechanical-runner.js";
import { loadProfile, resolveCommand } from "./profile-loader.js";
import { runDependencyAudit, dependencyAuditLine, type DependencyAuditResult } from "./dependency-audit.js";
import { runSemgrepScans, sastLine, type SastResult } from "./sast-scan.js";
import { runFullTest, type FullTestDeps, type FullTestReport } from "./full-test.js";
import { createCheckpoint } from "./git.js";
import { log } from "./logger.js";
import type { State } from "./types.js";

export type MaintenanceSectionId = "outdated" | "update" | "audit" | "sast";

export interface MaintenanceSection {
  id: MaintenanceSectionId;
  label_tr: string;
  /** info = salt bilgi (outdated raporu); skipped GÖRÜNÜR neden taşır. */
  status: "pass" | "fail" | "skipped" | "info";
  detail_tr: string;
}

export interface MaintenanceReport {
  sections: MaintenanceSection[];
  /** Güncelleme öncesi HEAD (git temizken) — elle geri dönüş çapası; yoksa null. */
  checkpointRef: string | null;
  /** Audit kırmızı mı (fix işi gerekir). */
  auditRed: boolean;
  /** SAST bulgu etiketleri (her biri fix işi olur). */
  sastFindings: string[];
  /** Kapanış Full Test raporu (kullanıcının açık şartı — her zaman koşar). */
  fullTest: FullTestReport;
  durationMs: number;
}

/** SAF: çıktı kuyruğunu rapora sığdır. */
function tail(out: string, lines = 12): string {
  const t = out.trim().split("\n").filter(Boolean);
  const cut = t.slice(0, lines).join("\n");
  return t.length > lines ? `${cut}\n… (+${t.length - lines} satır)` : cut;
}

/** Kök dizindeki manifest + lock dosyalarını yedekle (git olmayan proje için geri dönüş kopyası). */
async function backupManifests(projectRoot: string, manifestFiles: readonly string[]): Promise<string | null> {
  try {
    const dir = join(projectRoot, ".mycl", "maintenance-backup", String(Date.now()));
    await fs.mkdir(dir, { recursive: true });
    const rootEntries = await fs.readdir(projectRoot).catch(() => [] as string[]);
    // manifest_files (glob'suz olanlar) + adında "lock" geçen kök dosyalar (paket sisteminden bağımsız sezgi —
    // yedek için fazladan kapsamak zararsız).
    const wanted = new Set<string>([
      ...manifestFiles.filter((m) => !m.includes("*")),
      ...rootEntries.filter((f) => /lock/i.test(f)),
    ]);
    let copied = 0;
    for (const name of wanted) {
      try {
        await fs.copyFile(join(projectRoot, name), join(dir, basename(name)));
        copied++;
      } catch {
        /* dosya yok — normal */
      }
    }
    return copied > 0 ? dir : null;
  } catch (err) {
    log.warn("maintenance", "manifest yedeği alınamadı", { error: String(err) });
    return null;
  }
}

/**
 * IMPURE: Bakım Turu koşumu. ASLA throw etmez; her bölüm izole. `deps` Full Test'e aynen geçer.
 */
export async function runMaintenance(state: State, deps: FullTestDeps): Promise<MaintenanceReport> {
  const t0 = Date.now();
  const sections: MaintenanceSection[] = [];
  let checkpointRef: string | null = null;

  const profile = await loadProfile(state.stack ?? "unknown").catch(() => null);

  // 1) outdated — SALT-RAPOR, her durumda denenir.
  const outdatedCmd = resolveCommand(profile, "outdated");
  if (!outdatedCmd) {
    sections.push({
      id: "outdated",
      label_tr: "Güncel olmayan bağımlılıklar",
      status: "skipped",
      detail_tr: "profilde `outdated` komutu yok — bu stack'te desteklenmiyor",
    });
  } else {
    try {
      const res = await runSuiteProcess(outdatedCmd, state.project_root);
      if (isMissingCommand(res) || isSpawnEnvFailure(res)) {
        sections.push({ id: "outdated", label_tr: "Güncel olmayan bağımlılıklar", status: "skipped", detail_tr: "araç bulunamadı — koşulamadı" });
      } else {
        const out = `${res.stdout}\n${res.stderr}`.trim();
        // exit-1 + çıktı = "güncelleme var" (npm/bundle tasarımı) — araç hatası DEĞİL.
        sections.push({
          id: "outdated",
          label_tr: "Güncel olmayan bağımlılıklar",
          status: "info",
          detail_tr: out.length === 0 ? "hepsi güncel görünüyor" : `\n\`\`\`\n${tail(out)}\n\`\`\``,
        });
      }
    } catch (err) {
      sections.push({ id: "outdated", label_tr: "Güncel olmayan bağımlılıklar", status: "skipped", detail_tr: `beklenmedik hata (${String(err).slice(0, 80)})` });
    }
  }

  // 2) update — yalnız güvenliyse (git temiz → checkpoint; git değilse yedek + duyuru).
  const updateCmd = resolveCommand(profile, "update");
  if (!updateCmd) {
    sections.push({
      id: "update",
      label_tr: "Bağımlılık güncelleme",
      status: "skipped",
      detail_tr: "profilde `update` komutu yok — bu stack'te otomatik güncelleme desteklenmiyor (elle güncelle)",
    });
  } else {
    try {
      const cp = await createCheckpoint(state.project_root);
      let safeToUpdate = false;
      let safetyNote = "";
      if (cp.ok && cp.ref) {
        checkpointRef = cp.ref;
        safeToUpdate = true;
        safetyNote = `geri dönüş çapası: \`git reset --hard ${cp.ref.slice(0, 10)}\``;
      } else if ((cp.reason ?? "").includes("kaydedilmemiş değişiklik")) {
        // Kirli ağaçta bağımlılık YAZMAK riskli → görünür atla; tarama/test devam eder.
        sections.push({
          id: "update",
          label_tr: "Bağımlılık güncelleme",
          status: "skipped",
          detail_tr: "kaydedilmemiş değişiklik var — önce commit/stash et; güncelleme bu tur atlandı",
        });
      } else {
        // git değil / commit yok → manifest+lock yedeği alıp devam (görünür).
        const backupDir = await backupManifests(state.project_root, profile?.manifest_files ?? []);
        safeToUpdate = true;
        safetyNote = backupDir
          ? `git yok — manifest/lock yedeği: \`${backupDir.replace(state.project_root + "/", "")}\``
          : "git yok ve yedek alınamadı — güncelleme yine de koşuyor (görünür risk)";
      }
      if (safeToUpdate) {
        const res = await runSuiteProcess(updateCmd, state.project_root);
        if (isMissingCommand(res) || isSpawnEnvFailure(res)) {
          sections.push({ id: "update", label_tr: "Bağımlılık güncelleme", status: "skipped", detail_tr: "araç bulunamadı — koşulamadı" });
        } else if (res.code === 0) {
          sections.push({ id: "update", label_tr: "Bağımlılık güncelleme", status: "pass", detail_tr: `\`${updateCmd}\` tamam — ${safetyNote}` });
        } else {
          sections.push({
            id: "update",
            label_tr: "Bağımlılık güncelleme",
            status: "fail",
            detail_tr: `\`${updateCmd}\` kırmızı (${safetyNote}): ${tail(`${res.stdout}\n${res.stderr}`, 5)}`,
          });
        }
      }
    } catch (err) {
      sections.push({ id: "update", label_tr: "Bağımlılık güncelleme", status: "skipped", detail_tr: `beklenmedik hata (${String(err).slice(0, 80)})` });
    }
  }

  // 3) Güvenlik taramaları — paralel (Full Security deseni; DAST yok, o ayrı buton).
  let auditRed = false;
  let sastFindings: string[] = [];
  try {
    const [dep, sast]: [DependencyAuditResult, SastResult] = await Promise.all([
      runDependencyAudit(state),
      runSemgrepScans(state),
    ]);
    auditRed = dep.ran && !dep.clean;
    sastFindings = sast.findings;
    sections.push({
      id: "audit",
      label_tr: "Bağımlılık güvenlik taraması",
      status: dep.ran ? (dep.clean ? "pass" : "fail") : "skipped",
      detail_tr: dependencyAuditLine(dep).replace(/^•\s*/, ""),
    });
    sections.push({
      id: "sast",
      label_tr: "Statik güvenlik taraması (SAST)",
      status: sast.clean ? "pass" : "fail",
      detail_tr: sastLine(sast).replace(/^•\s*/, ""),
    });
  } catch (err) {
    sections.push({ id: "audit", label_tr: "Bağımlılık güvenlik taraması", status: "skipped", detail_tr: `beklenmedik hata (${String(err).slice(0, 80)})` });
    sections.push({ id: "sast", label_tr: "Statik güvenlik taraması (SAST)", status: "skipped", detail_tr: "audit hatası nedeniyle koşulamadı" });
  }

  // 4) HER ZAMAN Full Test (kullanıcının açık şartı: bakım sonrası tüm proje test edilir).
  const fullTest = await runFullTest(state, deps);

  return { sections, checkpointRef, auditRed, sastFindings, fullTest, durationMs: Date.now() - t0 };
}

/** SAF: bakım bölümlerini TR rapora çevir (Full Test raporu caller'da ayrıca eklenir). */
export function formatMaintenanceReport(r: MaintenanceReport): string {
  const icon = (s: MaintenanceSection): string =>
    s.status === "pass" ? "✅" : s.status === "fail" ? "❌" : s.status === "info" ? "ℹ️" : "⏭";
  const lines = r.sections.map((s) => `${icon(s)} **${s.label_tr}:** ${s.detail_tr}`);
  const cpLine = r.checkpointRef
    ? `\n↩️ Güncelleme öncesi durum: \`git reset --hard ${r.checkpointRef.slice(0, 10)}\` ile geri dönülebilir.`
    : "";
  return `🔧 **Bakım Turu** (${Math.round(r.durationMs / 1000)}sn)\n\n${lines.join("\n")}${cpLine}`;
}
