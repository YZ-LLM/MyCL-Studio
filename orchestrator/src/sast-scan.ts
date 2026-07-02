// sast-scan — 🛡️ Full Security butonu için SAST (semgrep) güvenlik + secret taraması.
//
// STACK-AGNOSTİK: semgrep çok-dillidir; proje KÖKÜNÜ tarar (node_modules/.git semgrep'çe
// auto-skip) — Faz 13'ün `src/` varsayımından daha stack-bağımsız. Faz 13 de semgrep koşar
// (extra_scans); buton aynı SAST sınıfını on-demand kapsar. Secret taraması semgrep p/secrets
// iledir (MyCL kararı: gitleaks YERİNE — dil-agnostik, sürüm/scope kırılganlığı yok).
//
// semgrep exit: 0=temiz, 1=bulgu, 2=tool-error/crash (registry fetch hatası vb. → SKIP, ceza yok).

import { spawn } from "node:child_process";
import { safeEnv } from "./safe-env.js";
import { SEMGREP_EXCLUDE_FLAGS } from "./semgrep-excludes.js";
import { ensureSemgrepIgnore } from "./ensure-gate-configs.js";
import type { State } from "./types.js";

const SAST_TIMEOUT_MS = 180_000;
const CONFIGS = [
  { label: "güvenlik (security-audit)", config: "p/security-audit" },
  { label: "OWASP Top-10", config: "p/owasp-top-ten" },
  { label: "secret sızıntısı", config: "p/secrets" },
];

export interface SastResult {
  /** En az bir config gerçekten koştu mu (semgrep var + crash değil). */
  ran: boolean;
  /** Hiç bulgu yok mu (atlananlar cezalandırılmaz). */
  clean: boolean;
  /** Bulgu bulunan config etiketleri. */
  findings: string[];
  /** Tool-error/crash (exit 2) ile atlanan config etiketleri. */
  skipped: string[];
}

type ScanOutcome = "clean" | "findings" | "skip";

function runOne(config: string, cwd: string): Promise<ScanOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const fin = (r: ScanOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // CANLI-BUG (2026-06-22): semgrep ÜRETİLEN build çıktısını (.next/dist/build vendored) tarayıp
      // false-positive üretiyordu. node_modules/.git semgrep'çe auto-skip ama .next vb. DEĞİL → açıkça ele
      // (stack-bağımsız build-dir listesi; phase-registry.ts kod-kalite/güvenlik taramalarıyla aynı set).
      child = spawn(`semgrep --config ${config} . ${SEMGREP_EXCLUDE_FLAGS} --quiet --error --metrics=off`, {
        cwd,
        shell: true,
        env: { ...safeEnv(), LC_ALL: "C" },
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      resolve("skip");
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* zaten ölmüş */
      }
      fin("skip"); // doğrulanamadı → atla (ceza yok; İş 3 araç-zorunluluğunu ayrı ele alır)
    }, SAST_TIMEOUT_MS);
    child.on("error", () => fin("skip")); // semgrep kurulu değil → skip
    child.on("close", (code) =>
      fin(code === 0 ? "clean" : code === 1 ? "findings" : "skip"),
    );
  });
}

/** Birden çok semgrep güvenlik config'ini PARALEL koşar + birleştirir. ASLA throw etmez. */
export async function runSemgrepScans(state: State): Promise<SastResult> {
  // Vendor/minified false-positive önleme (Faz 10/13 ile aynı): `.semgrepignore` yaz (yoksa) → bundles/
  // vendor kodu taranmasın. Var olana dokunmaz; fail-soft.
  await ensureSemgrepIgnore(state.project_root).catch(() => "present" as const);
  const results = await Promise.all(
    CONFIGS.map((c) => runOne(c.config, state.project_root).then((r) => ({ label: c.label, r }))),
  );
  const findings = results.filter((x) => x.r === "findings").map((x) => x.label);
  const skipped = results.filter((x) => x.r === "skip").map((x) => x.label);
  return {
    ran: results.some((x) => x.r !== "skip"),
    clean: findings.length === 0,
    findings,
    skipped,
  };
}

/** SAF: SAST sonucunu tek satır TR rapora çevir (butonun birleşik özetine girer). */
export function sastLine(r: SastResult): string {
  if (!r.ran) return "• SAST (semgrep): atlandı (semgrep yok / hata)";
  if (r.findings.length === 0) {
    return `• SAST (semgrep): ✅ güvenlik + secret bulgusu yok${r.skipped.length ? ` (atlanan: ${r.skipped.join(", ")})` : ""}`;
  }
  return `• SAST (semgrep): ⚠️ bulgu VAR — ${r.findings.join(", ")} (detay Faz 13/audit'te)`;
}
