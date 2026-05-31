// orchestrator-agent/respond — orkestratör backend seam (v15.8).
//
// agent_backends.orchestrator = "cli" + `claude` mevcut → CLI (text-JSON karar);
// CLI karar veremezse SDK'ya dürüst fallback (akış kırılmaz). "api" (default) →
// doğrudan SDK (OrchestratorAgent). index.ts'teki 3 çağrı yeri bunu kullanır
// (boot-check, handleUserMessage, askq re-decide) — tek seam, davranış paritesi.
//
// Döngüsel import yok: agent.ts cli-orchestrator/respond'u import ETMEZ;
// cli-orchestrator agent.ts'ten yalnız buildOrchestratorSystemPrompt alır;
// respond.ts ikisini de import eder.

import { backendForRole, type MyclConfig } from "../config.js";
import { isClaudeAvailable } from "../codegen/cli-backend.js";
import { log } from "../logger.js";
import type { State } from "../types.js";
import { OrchestratorAgent } from "./agent.js";
import { CliOrchestratorBackend } from "./cli-orchestrator.js";
import type { AgentDecision } from "./decision.js";

/**
 * Aktif config'e göre orkestratör kararını üret.
 *
 * CLI koşulları (HEPSİ gerekli): orchestrator rolü "cli" + `claude` erişilebilir.
 * CLI karar veremezse (parse/spawn hatası) SDK'ya düşer — kullanıcı kesintisiz.
 */
export async function respondAsOrchestrator(
  config: MyclConfig,
  state: State,
  userText: string,
): Promise<AgentDecision> {
  const wantCli = backendForRole(config, "orchestrator") === "cli";
  if (wantCli && isClaudeAvailable()) {
    try {
      return await new CliOrchestratorBackend(config, state).respond(userText);
    } catch (err) {
      // Güvenlik ağı: CLI karar veremedi → SDK (decide_action tool). Sessiz
      // değil ama akış kırılmaz — log + SDK devam.
      log.warn("orchestrator", "CLI backend başarısız — SDK fallback", {
        error: String(err).slice(0, 200),
      });
    }
  } else if (wantCli && !isClaudeAvailable()) {
    log.warn("orchestrator", "CLI seçili ama `claude` bulunamadı — SDK", {});
  }
  return new OrchestratorAgent({ config, state }).respond(userText);
}
