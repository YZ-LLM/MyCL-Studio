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
import { MAIN_AGENT_LANGUAGE_RULE, OVER_ENGINEERING_CONTROL_RULE } from "../agent-language.js";
import { autoBackendPair } from "../cli-rate-limit.js";
import { isApiAccountError } from "../claude-api.js";
import { backendForRole, isAutoMode } from "../config.js";
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
 * CLI backend kapsamındaki codegen fazları (v15.8, abonelik pipeline).
 * phase-5 (UI) + verify-feature + phase-8 (TDD — red/green stream-json
 * tool_result.is_error taşımadığı için MYCL_TEST_RESULT marker self-report'u +
 * phase-8'in MyCL-koşulu deterministik anchor'ı ile çözülür). Faz 0 (report_root_cause)
 * CLI'da phase-0.ts içinde ayrı text-JSON yoluyla ele alınır (createCodegenBackend değil).
 */
const CLI_ELIGIBLE_TAGS = new Set([
  "phase-5",
  "verify-feature",
  "phase-8",
  "parallel-module",
  "gate-autofix",
]);

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
  // v15.11: main ajan yalnız İngilizce yazar (genel kural, CLI+SDK). Çevirmen hariç.
  // v15.14: Over Engineering Kontrolü açıksa gereksiz-mühendislik eleme talimatını da ekle.
  const overEng = opts.config?.features?.over_engineering_control === true;
  opts = {
    ...opts,
    systemPrompt:
      opts.systemPrompt + MAIN_AGENT_LANGUAGE_RULE + (overEng ? OVER_ENGINEERING_CONTROL_RULE : ""),
  };
  const eligible = CLI_ELIGIBLE_TAGS.has(opts.tag);
  // Auto Mode: simetrik çift-yön. CLI-uygun faz + claude varsa CLI↔SDK kesintisiz;
  // CLI-uygun değilse (custom tool) ya da claude yoksa → SDK (görünür not).
  if (isAutoMode(opts.config, "main")) {
    if (!eligible) {
      emitChatMessage(
        "system",
        `ℹ️ Faz "${opts.tag}" custom tool gerektirir → SDK (API) kullanılıyor (Auto Mode; CLI bu fazı yapamaz).`,
      );
      return new CodegenBaseController(opts);
    }
    if (!isClaudeAvailable()) {
      emitChatMessage("system", "ℹ️ Auto Mode: `claude` bulunamadı → SDK (API) kullanılıyor.");
      return new CodegenBaseController(opts);
    }
    return autoBackendPair<CodegenOutcome, CodegenBackend>(
      backendForRole(opts.config, "main"),
      () => new CliCodegenBackend(opts),
      () => new CodegenBaseController(opts),
      isApiAccountError, // qa/production ile parite (mahkeme): kredi/yetki hatasında her iki kanal denenince döngüyü kır
    );
  }
  const flagOn = backendForRole(opts.config, "main") === "cli";
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
        emitError("Kod üretimi: claude bulunamadı (CLI arka ucu)", m);
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
