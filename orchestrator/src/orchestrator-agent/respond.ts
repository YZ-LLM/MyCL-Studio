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

import { backendForRole, isAutoMode, type MyclConfig } from "../config.js";
import { isClaudeAvailable } from "../codegen/cli-backend.js";
import { API_LABEL, CLI_LABEL } from "../cli-rate-limit.js";
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
  opts?: { questionMode?: boolean },
): Promise<AgentDecision> {
  // YZLLM 2026-06-16: SORU modu — salt-okunur danışma talimatı tüm backend yollarına geçer
  // (CLI/SDK/Auto pariteli). Faz tetikleme garantisi handler'da (executeAgentDecision çağrılmaz).
  const qm = opts?.questionMode === true;
  // Auto Mode: simetrik çift-yön. Çözülen birincil backend (limit yokken CLI,
  // limitliyse API) denenir; THROW ederse görünür mesajla diğerine geçilir.
  // claude yoksa → SDK (CLI tarafı kullanılamaz).
  if (isAutoMode(config, "orchestrator")) {
    const claudeOk = isClaudeAvailable();
    const tryCli = (): Promise<AgentDecision> =>
      new CliOrchestratorBackend(config, state, qm).respond(userText);
    const trySdk = (): Promise<AgentDecision> =>
      new OrchestratorAgent({ config, state, questionMode: qm }).respond(userText);
    if (!claudeOk) {
      emitChatMessage("system", "ℹ️ Auto Mode: `claude` bulunamadı → API (SDK) kullanılıyor.");
      return trySdk();
    }
    const primaryCli = backendForRole(config, "orchestrator") === "cli";
    const primary = primaryCli ? tryCli : trySdk;
    const secondary = primaryCli ? trySdk : tryCli;
    const fromL = primaryCli ? CLI_LABEL : API_LABEL;
    const toL = primaryCli ? API_LABEL : CLI_LABEL;
    try {
      return await primary();
    } catch (err) {
      log.warn("orchestrator", "auto fallback (symmetric)", { from: fromL, error: String(err).slice(0, 200) });
      emitChatMessage("system", `↪️ ${fromL} başarısız oldu — ${toL} ile kesintisiz yeniden deneniyor (Auto Mode).`);
      return secondary();
    }
  }

  const wantCli = backendForRole(config, "orchestrator") === "cli";

  // Kullanıcı kuralı: HİÇBİR ŞEY SESSİZCE çalışmasın. CLI seçili ama `claude`
  // bulunamıyorsa API'ye SESSİZCE DÜŞME → görünür hata ver + dur.
  if (wantCli && !isClaudeAvailable()) {
    const m =
      "Orkestratör 'Claude Code Aboneliği' (CLI) seçili ama `claude` bulunamadı " +
      "(`~/.local/bin/claude`). API'ye SESSİZCE DÜŞÜLMEDİ. `claude` kur ya da " +
      "Ayarlar → Modeller'den orkestratörü 'API' yap.";
    emitError("Orkestratör: claude bulunamadı (CLI arka ucu)", m);
    emitChatMessage("system", `🔴 ${m}`);
    throw new Error("orchestrator CLI backend kullanılamıyor: claude bulunamadı");
  }

  if (wantCli) {
    // claude var → CLI dene. CLI çalıştı ama karar veremezse (parse/runtime
    // hatası) güvenlik ağı SDK'dır — ama GÖRÜNÜR (sessiz değil): kullanıcı
    // hangi backend'e düşüldüğünü görür.
    try {
      return await new CliOrchestratorBackend(config, state, qm).respond(userText);
    } catch (err) {
      const m = `CLI orkestratör karar veremedi (${String(err).slice(0, 160)}) — bu sefer SDK'ya düşülüyor.`;
      log.warn("orchestrator", "CLI backend başarısız — SDK fallback (görünür)", {
        error: String(err).slice(0, 200),
      });
      emitChatMessage("system", `⚠️ ${m}`);
    }
  }
  return new OrchestratorAgent({ config, state, questionMode: qm }).respond(userText);
}
