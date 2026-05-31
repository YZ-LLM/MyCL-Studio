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
import { emitChatMessage } from "../ipc.js";
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
    log.warn("codegen-backend", "CLI flag on but `claude` not found — SDK fallback", {
      tag: opts.tag,
    });
    emitChatMessage(
      "system",
      "ℹ️ Claude Code CLI seçili ama `claude` komutu bulunamadı — dahili SDK'ya dönüldü. (CLI için `claude` kurulu olmalı.)",
    );
  }
  return new CodegenBaseController(opts);
}
