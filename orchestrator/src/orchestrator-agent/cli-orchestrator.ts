// orchestrator-agent/cli-orchestrator — orkestratör kararı `claude -p` ile (v15.8).
//
// agent_backends.orchestrator = "cli" → karar SDK decide_action tool'u yerine
// `claude` CLI'dan METİN olarak alınır (abonelik, API faturası YOK). `claude -p`
// özel tool desteklemediği için (sadece built-in Read/Edit/Bash…) karar JSON bloğu
// olarak istenir; son metinden çıkarılıp mevcut `parseAgentDecision` ile validate
// edilir. Parse başarısızsa 1 sıkı-nudge retry; yine olmazsa caller (respond.ts)
// SDK'ya düşer (güvenlik ağı — akış kırılmaz).
//
// Araçlar: --allowedTools Read/Grep/Glob/Bash. Orkestratör araştırma için TAM
// Bash yetkisine sahip (SDK yolundaki strict safe-list'ten daha geniş — bilinçli:
// tek-kullanıcılı yerel araçta orkestratörün bash'i kullanıcının kendi bash'iyle
// eşdeğer, gerçek tehdit değil). DÜRÜST NOT: headless `claude -p`'de --allowedTools
// kısıtlamaz, --permission-mode de Bash yazımını engellemez (ampirik doğrulandı) —
// tek güvenilir kaldıraç --disallowedTools. Bu yüzden orkestratör STRICT READ-ONLY
// DEĞİL: Bash redirect ile dosya yazabilir. Yalnız kaza-koruması var: Write/Edit +
// yıkıcı Bash kalıpları (rm/sudo/push/commit/chmod/publish/curl/wget) reddedilir.

import { runClaudeCli } from "../cli-run.js";
import { extractLastJsonObject } from "../cli-json.js";
import { orchestratorModelId, type MyclConfig } from "../config.js";
import { selectEffortForTask } from "../model-catalog.js";
import { emitAgentEvent } from "../ipc.js";
import { log } from "../logger.js";
import type { State } from "../types.js";
import { buildOrchestratorSystemPrompt } from "./agent.js";
import { parseAgentDecision, type AgentDecision } from "./decision.js";

/** Orkestratör araştırma araçları (auto-approve). Bash dahil — tam araştırma yetkisi. */
const ORCH_ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Bash"];

/** Kaza-koruması: Write/Edit + yıkıcı Bash kalıpları reddi (read-only DEĞİL — bkz. başlık notu). */
const ORCH_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash(rm *)",
  "Bash(sudo *)",
  "Bash(git push *)",
  "Bash(git commit *)",
  "Bash(chmod *)",
  "Bash(npm publish *)",
  "Bash(curl *)",
  "Bash(wget *)",
];

/** Orkestratör araştırma + karar için yeterli süre (tool turn'leri olabilir) — IDLE timeout. */
const ORCH_TIMEOUT_MS = 180_000;
/** Hang-timeout (gate-fix #4): wall-clock cap — routing 30dk default'una düşmesin (runaway/sonsuz-thinking). */
const ORCH_WALL_CLOCK_MS = 600_000;

export class CliOrchestratorError extends Error {
  override readonly name = "CliOrchestratorError";
}

/**
 * CLI modu için karar çıktı talimatı — `decide_action` tool'u YOK; karar JSON
 * bloğu olarak istenir. parseAgentDecision ile AYNI alan semantiği.
 */
const DECISION_OUTPUT_INSTRUCTION = `

---

## ÇIKTI FORMATI — KARARINI JSON İLE BİTİR (CLI modu)

Bu modda \`decide_action\` TOOL'U YOKTUR. Araştırmanı (Read/Grep/Bash/Glob) bitirince
**SON çıktın** olarak kararını TEK bir \`\`\`json ... \`\`\` bloğu içinde ver — \`decide_action\`
ile AYNI semantik alanlar:

- \`thinking\` (ZORUNLU): ÖNCE düşün — adım adım muhakemen (Türkçe): hangi sinyalleri gördün (state, önceki iş,
  kullanıcı niyeti), hangi seçenekleri tarttın, neden bu action'a vardın? \`reason\` kısa gerekçedir; \`thinking\`
  düşünme SÜRECİDİR. Kullanıcı bunu "Düşünceler" panelinde görür → her zaman DOLDUR.
- \`action\` (ZORUNLU): "chat" | "ask_clarify" | "run_phase" | "approve_ui" | "revise_ui" |
  "cancel_pipeline" | "resume_pipeline" | "debug_triage" | "develop_new_or_iter" |
  "set_optional_phases" | "answer_askq" | "verify_feature" | "save_memory_proposal" |
  "fallback_to_classifier"
- \`reason\` (ZORUNLU): Türkçe 1-2 cümle gerekçe.
- \`target_phase\`: SADECE action="run_phase" → faz ID (0-17 sayı).
- \`message_to_user\`, \`topic_slug\`: opsiyonel.
- \`optional_phases_to_run\`: SADECE action="set_optional_phases" → {5,6,7,8,9} alt kümesi (sayı dizisi).
- \`askq_answer\`: SADECE action="answer_askq" (aktif askq option label'ı veya freeform).
- \`target_feature\`: SADECE action="verify_feature" (test edilecek özellik, Türkçe).
- \`memory_proposal\`: SADECE action="save_memory_proposal" ({type_suggestion, summary[, scope]}).
- \`clarify_options\`: SADECE action="ask_clarify" → 2-4 SOMUT Türkçe seçenek (string dizisi).
  Riskli/belirsiz bir noktada kullanıcıya net seçenekler sun (jenerik Evet/Hayır yerine
  proaktif-risk seçenekleri). Örn: ["Soft-delete kullan", "Hard-delete kullan", "Vazgeç"].

KURALLAR:
- JSON bloğu çıktının EN SONUNDA olmalı; sonrasında başka metin OLMAMALI.
- Geçerli JSON yaz: çift tırnak, trailing comma YOK, yorum YOK.
- Orkestratör READ-ONLY: dosyaya YAZMA/DÜZENLEME yapma. Sadece oku/araştır + karar ver.`;

const STRICT_NUDGE = `

---

## UYARI: ÖNCEKİ ÇIKTIDA GEÇERLİ JSON KARAR BULUNAMADI
Bu sefer SADECE tek bir \`\`\`json ... \`\`\` bloğu yaz (action + reason zorunlu); başka
hiçbir metin yazma. Geçerli JSON olduğundan emin ol.`;

/**
 * Serbest metinden karar JSON'unu çıkar: "action" taşıyan son top-level nesne
 * (paylaşımlı cli-json.extractLastJsonObject; davranış öncekiyle birebir).
 */
export function extractDecisionJson(text: string): unknown | null {
  return extractLastJsonObject(text, (obj) => "action" in obj);
}

export class CliOrchestratorBackend {
  constructor(
    private readonly config: MyclConfig,
    private readonly state: State,
    /** YZLLM 2026-06-16: SORU modu — salt-okunur danışma talimatı (faz tetiklenmez). */
    private readonly questionMode: boolean = false,
  ) {}

  /**
   * Kullanıcı mesajına CLI ile karar üret. parseAgentDecision validate eder.
   * 2 deneme (2.sinde sıkı-nudge); ikisi de olmazsa CliOrchestratorError fırlatır
   * → caller SDK'ya düşer.
   */
  async respond(userText: string): Promise<AgentDecision> {
    emitAgentEvent({ sub: "started" });
    try {
      return await this.respondInner(userText);
    } finally {
      emitAgentEvent({ sub: "completed" });
    }
  }

  private async respondInner(userText: string): Promise<AgentDecision> {
    const modelId = orchestratorModelId(this.config.selected_models);
    const baseSystem = await buildOrchestratorSystemPrompt(
      this.config,
      this.state,
      userText,
      { questionMode: this.questionMode },
    );
    log.info("cli-orchestrator", "respond start", {
      model: modelId,
      user_text_len: userText.length,
      current_phase: this.state.current_phase,
    });

    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const systemPrompt =
        baseSystem + DECISION_OUTPUT_INSTRUCTION + (attempt > 0 ? STRICT_NUDGE : "");
      const res = await runClaudeCli({
        systemPrompt,
        userMessage: userText,
        modelId,
        cwd: this.state.project_root,
        allowedTools: ORCH_ALLOWED_TOOLS,
        disallowedTools: ORCH_DISALLOWED_TOOLS,
        // Oto-efor (YZLLM): orkestrasyon her turda koşan EN SIK çağrı — high tavanı (Anthropic'in
        // önerilen varsayılanı, kalite tabanı); max/xhigh kısa yönlendirme kararında gereksiz bekletir.
        effort: selectEffortForTask("orchestration", this.config.claude_code_flags.effort),
        timeoutMs: ORCH_TIMEOUT_MS,
        // Hang-timeout (YZLLM gate-fix #4, 2026-06-19): idle 3dk no-output hang'i yakalar; bu wall-clock
        // cap routing'i 30dk default'una düşürmez (runaway/sonsuz-thinking 30→10dk'ya kesilir).
        wallClockMs: ORCH_WALL_CLOCK_MS,
      });
      if (!res.ok) {
        lastErr = res.error ?? "cli run failed";
        log.warn("cli-orchestrator", "cli run not ok", { attempt, error: lastErr });
        continue;
      }
      const json = extractDecisionJson(res.text);
      if (json === null) {
        // YZLLM 2026-06-27: SORU/danışma modunda (questionMode) model JSON yerine DÜZ-METİN yanıt döndürebilir —
        // hatta direktif değerlendirme prompt'u AÇIKÇA "KARAR: BENİMSE" düz-metnini ister (JSON DEĞİL). SDK forced-tool
        // ile JSON garantiler; CLI garantileyemez. questionMode salt-okunur (executeAgentDecision çağrılmaz, faz
        // tetiklenmez) → düz-metin GEÇERLİ bir danışma cevabıdır: chat kararı olarak sar (message_to_user=metin).
        // İki çağıran da (direktif eval + salt-okunur Q&A) message_to_user/reason okur → parite. CANLI KÖK: bu yol
        // olmadan CLI orkestratör "KARAR: BENİMSE" verdi ama "decision json not found" deyip düştü → API→z.ai→hata.
        if (this.questionMode && res.text.trim()) {
          const prose = res.text.trim();
          log.info("cli-orchestrator", "questionMode düz-metin yanıt kabul edildi (JSON yok)", {
            attempt,
            len: prose.length,
          });
          const decision: AgentDecision = {
            action: "chat",
            reason: "CLI orkestratör danışma modunda düz-metin yanıt verdi.",
            message_to_user: prose,
          };
          emitAgentEvent({
            sub: "decision",
            turn: attempt,
            decision: decision as unknown as Record<string, unknown>,
          });
          return decision;
        }
        lastErr = "karar JSON bloğu bulunamadı/parse edilemedi";
        log.warn("cli-orchestrator", "decision json not found", {
          attempt,
          text_tail: res.text.slice(-300),
        });
        continue;
      }
      try {
        const decision = parseAgentDecision(json);
        log.info("cli-orchestrator", "decision parsed", {
          attempt,
          action: decision.action,
        });
        emitAgentEvent({
          sub: "decision",
          turn: attempt,
          decision: decision as unknown as Record<string, unknown>,
        });
        return decision;
      } catch (err) {
        lastErr = `parseAgentDecision: ${String(err)}`;
        log.warn("cli-orchestrator", "decision validation failed", { attempt, error: lastErr });
        continue;
      }
    }
    emitAgentEvent({ sub: "error", error: lastErr });
    throw new CliOrchestratorError(`CLI orkestratör karar veremedi: ${lastErr}`);
  }
}
