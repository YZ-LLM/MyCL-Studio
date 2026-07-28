// dependency-audit — 🛡️ Full Security butonu için STACK-BAĞIMSIZ bağımlılık zafiyet taraması.
//
// Profilin 'security' komutunu koşar (node-npm: `npm audit --audit-level=high`, python: `pip-audit`,
// go: `govulncheck`, rust: `cargo audit` ...). Her araç KENDİ eşiğinde zafiyet varsa NON-ZERO çıkar →
// exit kodu stack-bağımsız "temiz mi" sinyalidir; tool/severity ayrıntısı profilde, burada hardcode YOK.
// Sonuç DAST (aktif pentest) ile birleştirilir → buton tek "Full Security" hükmü verir.

import { spawn } from "node:child_process";
import { loadProfile, resolveCommand } from "./profile-loader.js";
import { safeEnv } from "./safe-env.js";
import type { State } from "./types.js";

const AUDIT_TIMEOUT_MS = 120_000;

export interface DependencyAuditResult {
  /** Tarama gerçekten çalıştı mı (stack + profil 'security' komutu var mı). */
  ran: boolean;
  /** Komutun eşiği üstünde zafiyet YOK mu (exit 0). ran=false ise true (cezalandırma yok). */
  clean: boolean;
  /** Çalıştırılan komut (rapor için). */
  tool: string;
  /** Son ~2KB çıktı (rapor için). */
  output: string;
  /** Çalıştırılamadı/timeout sebebi. */
  error?: string;
}

/**
 * Bağımlılık zafiyet taraması. ASLA throw etmez (DAST gibi fail-soft). Çalışan app
 * gerekmez (statik bağımlılık taraması) → DAST'tan bağımsız, paralel koşulabilir.
 */
export async function runDependencyAudit(state: State): Promise<DependencyAuditResult> {
  if (!state.stack || state.stack === "unknown") {
    return { ran: false, clean: true, tool: "", output: "", error: "stack bilinmiyor" };
  }
  const profile = await loadProfile(state.stack);
  const rawCmd = resolveCommand(profile, "security");
  if (!rawCmd) {
    return { ran: false, clean: true, tool: "", output: "", error: "profilde 'security' komutu yok" };
  }
  // Full Security butonu THOROUGH (YZLLM "medium VE high"): npm-audit eşiğini medium'a indir.
  // STACK-BAĞIMSIZ: yalnız `--audit-level=high` taşıyan komutu etkiler; pip-audit/govulncheck/
  // cargo-audit zaten eşiksiz tüm severity'leri raporlar (değişmez). npm-hardcode DEĞİL — jenerik.
  const cmd = rawCmd.replace(/--audit-level[ =]high/i, "--audit-level=moderate");
  return await new Promise<DependencyAuditResult>((resolve) => {
    let out = "";
    let settled = false;
    const finish = (clean: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ran: true, clean, tool: cmd, output: out.trim(), error });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, {
        cwd: state.project_root,
        shell: true,
        env: { ...safeEnv(), LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ran: true, clean: false, tool: cmd, output: "", error: (e as Error).message });
      return;
    }
    const cap = (b: Buffer) => {
      out = (out + b.toString("utf8")).slice(-2000);
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* zaten ölmüş */
      }
      finish(false, "timeout"); // doğrulanamadı → conservative: temiz DEME
    }, AUDIT_TIMEOUT_MS);
    child.on("error", (e) => finish(false, e.message));
    // Exit 0 = eşik altı (temiz); non-zero = eşik üstü zafiyet (her araç kendi --audit-level'ı).
    child.on("close", (code) => finish(code === 0));
  });
}

/** SAF: audit sonucunu tek satır TR rapora çevir (butonun birleşik özetine girer). */
export function dependencyAuditLine(r: DependencyAuditResult): string {
  if (!r.ran) return `• Bağımlılık taraması: atlandı (${r.error ?? "uygulanamaz"})`;
  if (r.error === "timeout") return `• Bağımlılık taraması (${r.tool}): ⏱ zaman aşımı — temiz doğrulanamadı`;
  if (r.clean) return `• Bağımlılık taraması (${r.tool}): ✅ eşik-üstü zafiyet yok`;
  return `• Bağımlılık taraması (${r.tool}): ⚠️ eşik-üstü seviye zafiyet VAR — güncelle/düzelt`;
}
