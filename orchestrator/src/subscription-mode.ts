// subscription-mode — saf abonelik (tüm roller CLI) modu tespiti.
//
// Tüm ajan rolleri "cli" ise kullanıcı saf abonelik istiyor (API kredisi yok).
// Bu modda forced-tool (tool_choice) çağrıları `claude -p`'de çalışmaz; bu yüzden
// yan-sınıflandırmalar (project-type / relevance / konuşma-özeti) API'ye SOKULMAZ —
// ama ARTIK ATLANMAZ: hepsi text-JSON CLI (forced-tool yerine) ile yapılır
// (project-type-classifier.classifyViaCli, relevance/classifier.scoreChunksViaCli,
// conversation-context.generateSummaryViaCli). Yani abonelik = tam parite; bu modül
// yalnızca "hangi backend yolu" kararını verir (routing), bir şeyi devre dışı bırakmaz.
//
// v15.x (2026-06-04): eski "yan-çağrıyı atla + tek-seferlik not" davranışı kaldırıldı
// (relevance/özet text-JSON CLI'ya taşındı) — recall/bağlam zenginleştirme paritesi.

import { backendForRole, type MyclConfig } from "./config.js";

/** Tüm ajan rolleri (orchestrator/translator/main) "cli" → saf abonelik modu. */
export function isSubscriptionMode(config: MyclConfig): boolean {
  return (
    backendForRole(config, "orchestrator") === "cli" &&
    backendForRole(config, "translator") === "cli" &&
    backendForRole(config, "main") === "cli"
  );
}
