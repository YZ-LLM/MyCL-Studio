// orchestrator-agent — main conversational shell agent (v15.5).
//
// User talebi: "MyCL paneli daha akıllı yapmak için orkestrator bir ajan
// kullanmak gerekiyor. Görevi, kullanıcı ile MyCL Studio arasında doğru
// iletişimi kurmak ve kullanıcının MyCL Studio'dan aldığı verimi artırmak.
// Ana modelde ne seçili ise onu kullansın."
//
// Mimari: handleUserMessage agent'ı ÖNCE dener; agent error/timeout/
// fallback_to_classifier → klasik Haiku classifier devreye girer. Bu sayede:
//   - Agent'ı pasifize etmek için sadece orchestrator API key boş bırakmak
//     yeterli.
//   - Production'da agent fail ederse user kesintisiz çalışmaya devam eder.
//
// Tool loop: max 8 turn (Read/Grep/Bash safe-list ile araştır → decide_action
// ile son karar). Tool_choice="any" ile model her turda en az bir tool çağırır;
// decide_action çağrıldığında loop sonlanır.

import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { runTurn, type ApiMessage } from "../claude-api.js";
import {
  orchestratorApiKey,
  orchestratorModelId,
  type MyclConfig,
} from "../config.js";
import { emitAgentEvent } from "../ipc.js";
import { VERIFY_BEFORE_CLAIM, DECISION_PRINCIPLES } from "../agent-language.js";
import { log } from "../logger.js";
import { safeEnv } from "../safe-env.js";
import type { State } from "../types.js";
import { buildAgentSystemPrompt } from "./context-builder.js";
import {
  parseAgentDecision,
  type AgentDecision,
} from "./decision.js";
import { AGENT_TOOLS, validateBashCommand } from "./tools.js";
import { detectRecurringTopic } from "../agent-memory/dedup.js";
import { realpathWithinRoot, validatePathForAgent } from "./path-sandbox.js";

const execAsync = promisify(exec);
const MAX_TOOL_TURNS = 8;
const BASH_TIMEOUT_MS = 5_000;

export class OrchestratorAgentError extends Error {
  override readonly name = "OrchestratorAgentError";
}

/**
 * SORU MODU talimatı (YZLLM 2026-06-16): kullanıcı İŞ vermiyor, geçmiş çalışmadan DERS/bilgi
 * soruyor → salt-okunur danışma. Faz/iş TETİKLENMEZ (handler executeAgentDecision çağırmaz —
 * bu prompt yalnızca action='chat' + dolu message_to_user'a yönlendirir; kesin garanti handler'da).
 */
const QUESTION_MODE_INSTRUCTION = `## SORU MODU (salt-okunur danışma — YZLLM 2026-06-16)

Kullanıcı bir İŞ/özellik istemiyor; geçmiş çalışmadan DERS, bilgi veya genel değerlendirme
soruyor. Görevin: \`devs/\` klasörünü (geçmiş iterasyonların iter-spec/page-spec'leri),
\`.mycl/\` dökümanlarını ve gerekirse kodu OKUYARAK soruyu Türkçe, net ve DÜRÜST cevapla.

KURALLAR (mutlak):
- ASLA faz tetikleme / iş başlatma. \`action='chat'\` kullan; \`develop_new_or_iter\`,
  \`run_phase\`, \`debug_triage\`, \`verify_feature\`, \`set_optional_phases\` SEÇME.
- **Faz çalıştırmayı ÖNERME / İMA ETME / TEKLİF ETME bile (YZLLM 2026-06-19 — YASAK).** "Yeni iş
  söylersen Faz 1'den ele alırım/başlatırım", "istersen çalıştırırım", "devam edeyim mi?" gibi
  cümleler YASAK — soru modunda iş/faz başlatma İHTİMALİ YOKTUR. Kullanıcı yeni iş tarif etse bile
  "soru modunu kapatınca bunu yapabilirim" deme; yalnız "soru modundayım, bunu çalıştıramam" de + soruyu yanıtla.
- Cevabını \`message_to_user\` alanına yaz (Türkçe, KANITA dayalı — okuduğun dosyalara dayan,
  uydurma; okumadıysan "elimde veri yok" de).
- **ASIL İÇERİĞİ YAZ — META-cümle DEĞİL.** Kullanıcı liste/trace/özet istediyse, \`message_to_user\`
  içine LİSTENİN/TRACE'İN KENDİSİNİ yaz. "Listeledim / çıkardım / hazırladım" gibi yaptığını
  ANLATAN cümle YASAK — istenen şey sohbette GÖRÜNMEZSE cevap vermemiş sayılırsın. Tek yerin var:
  \`message_to_user\` (başka yere "yazamazsın", dosya üretmezsin — salt-okunursun).
- **OTURUM BAĞLAMI:** Soru metninde "[Bu soru-modu oturumundaki ÖNCEKİ konuşma …]" bloğu varsa onu
  DİKKATE AL — follow-up sorular ("nereye yazdın?", "onu da ver", "neyi kastediyorsun?") o önceki
  konuşmaya gönderme yapar; bağı KOPARMA, baştan tahmin etme.
- Kod YAZMA/DEĞİŞTİRME (zaten salt-okunursun). Yalnız açıkla, ders çıkar, özetle.`;

/**
 * Orkestratör system prompt'unu kur: base agent prompt + (v15.6) recurring-topic
 * dedup notu. SDK (decide_action tool) ve CLI (text-JSON karar) yolları AYNI
 * prompt'u kullanır — tek kaynak, davranış paritesi. (CLI yolu sonuna ayrıca
 * "kararı JSON yaz" override'ı ekler — bkz. cli-orchestrator.ts.)
 *
 * opts.questionMode (YZLLM 2026-06-16): SORU modu — salt-okunur danışma talimatı eklenir.
 */
export async function buildOrchestratorSystemPrompt(
  config: MyclConfig,
  state: State,
  userText: string,
  opts?: { questionMode?: boolean },
): Promise<string> {
  // v15.6: Pre-call recurring topic detection. agent-decisions.jsonl semantic
  // karşılaştırma → 2. confirmation tetikleyici notu sistem prompt'una eklenir.
  const recurring = await detectRecurringTopic(config, state.project_root, userText);
  // Doğru-karar/recall: userText'i geçir → relevance-tabanlı "en ilgili geçmiş" recall.
  let systemPrompt = await buildAgentSystemPrompt(state, config, userText);
  // YZLLM 2026-06-12: orkestratör BEYİN de "önce sessizce kanıtla, sonra konuş" disiplinine uyar — kullanıcıya
  // kanıtlamadığı kök-neden/iddia sunmaz (gözlemlenen yanlış-teşhisin — gerçek testleri okumadan E2BIG demek — önlemi).
  systemPrompt += `\n\n---\n\n${VERIFY_BEFORE_CLAIM}`;
  // Parça 3 (karar-çerçevesi): YZLLM'in karar-ilkeleri (varsayma-yok / no-silent-fallback / kuşkuda-fail-closed
  // / kalite-sabit / correct-by-construction) — ajan "YZLLM gibi" karar versin (tek-seferlik talimat değil).
  systemPrompt += `\n\n---\n\n${DECISION_PRINCIPLES}`;
  if (opts?.questionMode) {
    systemPrompt += `\n\n---\n\n${QUESTION_MODE_INSTRUCTION}`;
  }
  if (recurring.recurring) {
    systemPrompt +=
      `\n\n---\n\n## BU KONU TEKRAR EDİYOR (v15.6 dedup)\n\n` +
      `Current user mesajı geçmiş bir agent kararıyla semantic olarak ` +
      `benzer (score=${recurring.similarity_score}/10).\n` +
      `- Geçmiş topic_slug: \`${recurring.previous_topic_slug}\`\n` +
      `- Geçmiş user_text: "${(recurring.previous_user_text ?? "").slice(0, 200)}"\n\n` +
      `**Karar**: \`save_memory_proposal\` action'ını DÜŞÜN. ` +
      `memory_proposal alanını topic_slug = \`${recurring.previous_topic_slug}\` ` +
      `kullanarak doldur. Hafıza kaydı onaylanırsa SONRASINDA kullanıcının ` +
      `asıl niyetini execute edersin (bir sonraki agent turn'unda).`;
  }
  log.info("orchestrator-agent", "system prompt built", {
    recurring: recurring.recurring,
    user_text_len: userText.length,
  });
  return systemPrompt;
}

export interface OrchestratorAgentDeps {
  config: MyclConfig;
  state: State;
  /** YZLLM 2026-06-16: SORU modu — salt-okunur danışma (faz tetiklenmez, handler garantiler). */
  questionMode?: boolean;
}

export class OrchestratorAgent {
  constructor(private readonly deps: OrchestratorAgentDeps) {}

  /**
   * User mesajını ele al, agent karar versin. Tool loop sırasında Read/Grep/
   * Bash çağrıları yapabilir. Sonunda `decide_action` ile AgentDecision döner.
   *
   * Throw: API hatası, tool execution hatası, MAX_TOOL_TURNS aşımı,
   * decide_action çağrılmadan biten conversation.
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
    const apiKey = orchestratorApiKey(this.deps.config.api_keys);
    const modelId = orchestratorModelId(this.deps.config.selected_models);

    const systemPrompt = await buildOrchestratorSystemPrompt(
      this.deps.config,
      this.deps.state,
      userText,
      { questionMode: this.deps.questionMode },
    );

    log.info("orchestrator-agent", "respond start", {
      model: modelId,
      user_text_len: userText.length,
      current_phase: this.deps.state.current_phase,
    });

    const messages: ApiMessage[] = [
      { role: "user", content: userText },
    ];

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const result = await runTurn(
        this.deps.config,
        apiKey,
        {
          messages,
          system: systemPrompt,
          role: "orchestrator", // ⑤ Sağlayıcı=Z.AI seçiliyse orkestratör turu GLM'e yönlenir

          model: modelId,
          tools: AGENT_TOOLS,
          tool_choice: { type: "any" },
          max_tokens: 4096,
          betas: this.deps.config.claude_code_flags.betas,
        },
        () => {
          // Stream event'leri agent için emit edilmez (UI'da sessiz çalışsın).
          // İleride debug panel için açılabilir.
        },
      );

      // Agent assistant mesajını history'ye ekle
      messages.push({ role: "assistant", content: result.assistantContent });

      if (result.toolUses.length === 0) {
        // Tool çağrılmadan end_turn → ya stop_sequence ya end_turn
        throw new OrchestratorAgentError(
          `agent ended without decide_action (turn ${turn}, stop=${result.stop_reason})`,
        );
      }

      // decide_action çağrısını kontrol et — varsa loop'tan çık
      const decideCall = result.toolUses.find((t) => t.name === "decide_action");
      if (decideCall) {
        log.info("orchestrator-agent", "decide_action received", {
          turn,
          tool_calls_count: result.toolUses.length,
        });
        const decision = parseAgentDecision(decideCall.input);
        // v15.6: frontend "🧠 Orkestrator" modalında görünmesi için decision emit.
        emitAgentEvent({
          sub: "decision",
          turn,
          decision: decision as unknown as Record<string, unknown>,
        });
        return decision;
      }

      // Tool_result block'larını oluştur ve user mesajı olarak history'ye ekle
      const toolResults: Anthropic.MessageParam["content"] = [];
      for (const tu of result.toolUses) {
        // v15.6: her tool_use için event emit — modal'da agent thinking görünür
        emitAgentEvent({
          sub: "tool_use",
          turn,
          tool_name: tu.name,
          tool_input: (tu.input ?? {}) as Record<string, unknown>,
        });
        const resultText = await this.executeTool(tu.name, tu.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: resultText.slice(0, 8000), // 8KB hard cap
          is_error: resultText.startsWith("ERROR:"),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    emitAgentEvent({
      sub: "error",
      error: `MAX_TOOL_TURNS (${MAX_TOOL_TURNS}) aşıldı — decide_action eksik`,
    });
    throw new OrchestratorAgentError(
      `agent reached MAX_TOOL_TURNS (${MAX_TOOL_TURNS}) without decide_action`,
    );
  }

  /**
   * Tool dispatch — Read, Grep, Bash (safe-list). decide_action burada
   * çalışmaz; respond() ana loop'unda yakalanır.
   */
  private async executeTool(
    name: string,
    input: unknown,
  ): Promise<string> {
    try {
      const obj = (input ?? {}) as Record<string, unknown>;
      switch (name) {
        case "Read": {
          const path = String(obj.file_path ?? "");
          if (!path) return "ERROR: file_path missing";
          // v15.6 (2026-05-24): proje izolasyonu — agent başka projeyi okuyamaz
          const v = validatePathForAgent(this.deps.state.project_root, path);
          if (!v.ok) {
            return (
              `ERROR: Read denied — path outside project root ` +
              `(project=${this.deps.state.project_root}, requested=${path}, reason=${v.reason})`
            );
          }
          const content = await fs.readFile(v.resolved, "utf-8");
          // Symlink escape post-check
          if (!(await realpathWithinRoot(this.deps.state.project_root, v.resolved))) {
            return (
              `ERROR: Read denied — symlink target outside project root ` +
              `(project=${this.deps.state.project_root}, requested=${path})`
            );
          }
          return content;
        }
        case "Grep": {
          const pattern = String(obj.pattern ?? "");
          const path = String(obj.path ?? "");
          if (!pattern || !path) return "ERROR: pattern or path missing";
          // v15.6: proje izolasyonu — Grep recursive olduğu için absolute path
          // sandbox dışını taraması kritik risk
          const v = validatePathForAgent(this.deps.state.project_root, path);
          if (!v.ok) {
            return (
              `ERROR: Grep denied — path outside project root ` +
              `(project=${this.deps.state.project_root}, requested=${path}, reason=${v.reason})`
            );
          }
          // -E extended regex, -n line number, -r recursive (-d skip warning)
          const { stdout, stderr } = await execAsync(
            `grep -rEn ${shellEscape(pattern)} ${shellEscape(v.resolved)}`,
            {
              timeout: BASH_TIMEOUT_MS,
              maxBuffer: 1024 * 1024,
              // safe-env (kod-analiz): child'a ANTHROPIC_API_KEY/AWS/GH_TOKEN sızdırma; diğer
              // 7 spawn da bunu uyguluyor (defense-in-depth — validateBashCommand tek savunma olmasın).
              env: { ...safeEnv(), LC_ALL: "C" },
            },
          );
          return stdout || `(no matches)${stderr ? `\nstderr: ${stderr}` : ""}`;
        }
        case "Bash": {
          const cmd = String(obj.command ?? "");
          // v15.6: proje izolasyonu — projectRoot ile path argüman sandbox
          const validation = validateBashCommand(cmd, this.deps.state.project_root);
          if (!validation.ok) {
            return `ERROR: Bash safe-list reject: ${validation.reason}`;
          }
          const { stdout, stderr } = await execAsync(cmd, {
            timeout: BASH_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            cwd: this.deps.state.project_root,
            // safe-env (kod-analiz): child process secret'ları (API key/AWS/token) miras almasın.
            env: { ...safeEnv(), LC_ALL: "C" },
          });
          return stdout + (stderr ? `\nstderr: ${stderr}` : "");
        }
        default:
          return `ERROR: unknown tool: ${name}`;
      }
    } catch (err) {
      return `ERROR: ${String(err)}`;
    }
  }
}

/**
 * Single-quote shell escape — pattern içindeki ' karakterlerini güvenli hale
 * getirir. execAsync command string'i shell tarafından yorumlandığı için
 * pattern injection riski var; bu fonksiyon onu engeller.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
