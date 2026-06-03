// subscription-mode — saf abonelik (tüm roller CLI) modu tespiti + yan-çağrı atlama.
//
// relevance / conversation-summary / project-type gibi yan-çağrılar ZORLANMIŞ tool
// (tool_choice) kullanır → `claude -p` desteklemez (CLI'a çevrilemez) + best-effort
// (fail → graceful sentinel). Tüm roller "cli" ise (kullanıcı saf abonelik istiyor,
// API kredisi yok) bu çağrıları API'ye SOKMADAN atla → "credit balance" hatası +
// boşa API denemesi olmasın. Pipeline bunlar olmadan çalışır (bağlam zenginleştirme
// kısıtlanır, kalite/akış bozulmaz). Kullanıcı kuralı "hiç sessiz olma": tek-seferlik
// görünür not.

import { backendForRole, type MyclConfig } from "./config.js";
import { emitChatMessage } from "./ipc.js";

/** Tüm ajan rolleri (orchestrator/translator/main) "cli" → saf abonelik modu. */
export function isSubscriptionMode(config: MyclConfig): boolean {
  return (
    backendForRole(config, "orchestrator") === "cli" &&
    backendForRole(config, "translator") === "cli" &&
    backendForRole(config, "main") === "cli"
  );
}

let skipNoticeShown = false;

/** Yan-çağrı abonelik modunda atlanınca bir kez görünür not (spam yok, sessiz değil). */
export function noteSubscriptionSkipOnce(): void {
  if (skipNoticeShown) return;
  skipNoticeShown = true;
  emitChatMessage(
    "system",
    "ℹ️ Abonelik modu: bazı yardımcı sınıflandırmalar (relevance / konuşma özeti) " +
      "atlanıyor — bunlar zorlanmış-tool gerektirir, Claude Code CLI'da çalışmaz (API anahtarı + " +
      "kredi ister). Pipeline bunlarsız da çalışır; yalnızca bağlam zenginleştirmesi kısıtlı. " +
      "(proje-tipi v15.10'dan beri text-JSON CLI ile sınıflandırılır.)",
  );
}
