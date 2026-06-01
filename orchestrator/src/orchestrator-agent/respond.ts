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
import { emitChatMessage, emitError } from "../ipc.js";
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

  // Kullanıcı kuralı: HİÇBİR ŞEY SESSİZCE çalışmasın. CLI seçili ama `claude`
  // bulunamıyorsa API'ye SESSİZCE DÜŞME → görünür hata ver + dur.
  if (wantCli && !isClaudeAvailable()) {
    const m =
      "Orkestratör 'Claude Code Aboneliği' (CLI) seçili ama `claude` bulunamadı " +
      "(`~/.local/bin/claude`). API'ye SESSİZCE DÜŞÜLMEDİ. `claude` kur ya da " +
      "Ayarlar → Modeller'den orkestratörü 'API' yap.";
    emitError("orchestrator: claude bulunamadı (CLI backend)", m);
    emitChatMessage("system", `🔴 ${m}`);
    throw new Error("orchestrator CLI backend kullanılamıyor: claude bulunamadı");
  }

  if (wantCli) {
    // claude var → CLI dene. CLI çalıştı ama karar veremezse (parse/runtime
    // hatası) güvenlik ağı SDK'dır — ama GÖRÜNÜR (sessiz değil): kullanıcı
    // hangi backend'e düşüldüğünü görür.
    try {
      return await new CliOrchestratorBackend(config, state).respond(userText);
    } catch (err) {
      const m = `CLI orkestratör karar veremedi (${String(err).slice(0, 160)}) — bu sefer SDK'ya düşülüyor.`;
      log.warn("orchestrator", "CLI backend başarısız — SDK fallback (görünür)", {
        error: String(err).slice(0, 200),
      });
      emitChatMessage("system", `⚠️ ${m}`);
    }
  }
  return new OrchestratorAgent({ config, state }).respond(userText);
}
