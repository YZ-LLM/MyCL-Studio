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
import { orchestratorModelId, type MyclConfig } from "../config.js";
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
  "MultiEdit",
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

/** Orkestratör araştırma + karar için yeterli süre (tool turn'leri olabilir). */
const ORCH_TIMEOUT_MS = 180_000;

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
 * Serbest metinden karar JSON'unu çıkar. Önce \`\`\`json fenced blok (sonuncuyu al);
 * yoksa dengeli { … } tarayarak son top-level JSON nesnesini al. Parse edilemezse null.
 */
export function extractDecisionJson(text: string): unknown | null {
  // 1) Fenced blok(lar): ```json … ``` veya ``` … ``` — sonuncuyu dene.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  const fences: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m[1].trim()) fences.push(m[1].trim());
  }
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = tryParse(fences[i]);
    if (parsed !== null) return parsed;
  }
  // 2) Fence yok/parse olmadı — dengeli brace taraması (son geçerli nesneyi al).
  const candidates = scanBalancedObjects(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = tryParse(candidates[i]);
    if (parsed !== null && typeof parsed === "object" && "action" in (parsed as object)) {
      return parsed;
    }
  }
  return null;
}

function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** String içindeki tüm top-level dengeli { … } parçalarını döndürür (string-aware). */
function scanBalancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

export class CliOrchestratorBackend {
  constructor(
    private readonly config: MyclConfig,
    private readonly state: State,
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
        timeoutMs: ORCH_TIMEOUT_MS,
      });
      if (!res.ok) {
        lastErr = res.error ?? "cli run failed";
        log.warn("cli-orchestrator", "cli run not ok", { attempt, error: lastErr });
        continue;
      }
      const json = extractDecisionJson(res.text);
      if (json === null) {
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
