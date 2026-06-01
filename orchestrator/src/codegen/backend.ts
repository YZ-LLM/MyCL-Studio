// codegen/backend — Codegen backend soyutlaması.
//
// v15.8 (2026-05-30): Main codegen ajanı iki backend ile çalışabilir:
//   - SDK (varsayılan): Anthropic SDK turn-loop (CodegenBaseController) —
//     MyCL'in kendi tool'ları + bash-guard + path-sandbox + turn-bütçesi.
//   - CLI (opt-in, flag): `claude` CLI subprocess (Aşama 3'te eklenir).
//
// Factory `createCodegenBackend(opts)` config flag'ine göre uygun backend'i
// döner. CodegenBaseController zaten `run()`/`abort()` içerdiği için
// CodegenBackend interface'ini yapısal olarak karşılar (ekstra wrapper yok,
// circular import yok — codegen-controller backend'i import ETMEZ).

import {
  CodegenBaseController,
  type CodegenOutcome,
  type CodegenRunOpts,
} from "../base/codegen-controller.js";
import { CliCodegenBackend, isClaudeAvailable } from "./cli-backend.js";
import { backendForRole } from "../config.js";
import { emitChatMessage, emitError } from "../ipc.js";
import { log } from "../logger.js";

export interface CodegenBackend {
  run(): Promise<CodegenOutcome>;
  abort(): void;
  /**
   * doubt-driven eskalasyon cevabını controller'a iletir (SDK backend uygular;
   * CLI backend non-interactive olduğu için sağlamaz — opsiyonel).
   */
  submitAskqAnswer?(askqId: string, selected_tr: string): void;
}

/**
 * CLI backend kapsamındaki codegen fazları (Aşama 4'te genişletilebilir).
 * Phase 8 (TDD tool_result kapısı) + Phase 0 (report_root_cause custom tool)
 * v1'de SDK kalır — stream-json bu ihtiyaçları temiz karşılamıyor.
 */
const CLI_ELIGIBLE_TAGS = new Set(["phase-5", "verify-feature"]);

/**
 * Aktif config'e göre codegen backend'i seç.
 *
 * CLI koşulları (HEPSİ gerekli):
 *   - main rolü backend'i "cli" (Settings → Modeller → main = Claude Code Aboneliği)
 *   - faz CLI kapsamında (phase-5 / verify-feature)
 *   - `claude` binary erişilebilir
 * Aksi halde SDK (dürüst fallback). `claude` yoksa "cli" seçili olsa bile SDK +
 * tek seferlik uyarı.
 */
export function createCodegenBackend(opts: CodegenRunOpts): CodegenBackend {
  const flagOn = backendForRole(opts.config, "main") === "cli";
  const eligible = CLI_ELIGIBLE_TAGS.has(opts.tag);
  if (flagOn && eligible) {
    if (isClaudeAvailable()) {
      log.info("codegen-backend", "using CLI backend", { tag: opts.tag });
      return new CliCodegenBackend(opts);
    }
    // Kullanıcı kuralı: HİÇBİR ŞEY SESSİZCE çalışmasın. Main 'CLI' seçili ama
    // `claude` yoksa SDK'ya (API'ye) SESSİZCE DÜŞME — abonelik kullanıcısında
    // sürpriz fatura/hata olur. Görünür hata ver + fazı fail et.
    const m =
      `Main 'Claude Code Aboneliği' (CLI) seçili ama \`claude\` bulunamadı ` +
      `(\`~/.local/bin/claude\`) — Faz ${opts.tag} çalıştırılamadı. API'ye SESSİZCE ` +
      `DÜŞÜLMEDİ. \`claude\` kur ya da Ayarlar → Modeller'den main'i 'API' yap.`;
    log.warn("codegen-backend", "CLI seçili ama claude yok — görünür fail", { tag: opts.tag });
    return {
      run: async (): Promise<CodegenOutcome> => {
        emitError("codegen: claude bulunamadı (CLI backend)", m);
        emitChatMessage("system", `🔴 ${m}`);
        return { kind: "failed", reason: m };
      },
      abort: () => {},
    };
  }
  // Kullanıcı kuralı: sessiz olma. Main 'CLI' seçili ama bu faz custom tool
  // gerektiriyor (Faz 0 report_root_cause / Faz 8 TDD tool-gate) → `claude -p`
  // bunları desteklemediği için SDK (API) ile çalışır. Kullanıcı, aboneliğin bu
  // fazda DEVREDE OLMADIĞINI görsün (sürpriz API kullanımı/faturası olmasın).
  if (flagOn && !eligible) {
    emitChatMessage(
      "system",
      `ℹ️ Faz "${opts.tag}" custom tool gerektirdiği için Claude Code CLI ile çalışamaz — ` +
        `dahili SDK (Anthropic API) kullanılıyor. Bu faz abonelik kapsamı dışında (API anahtarı + kredi gerekir).`,
    );
  }
  return new CodegenBaseController(opts);
}
