// inspector — "iki bilim insanı" denetim/tartışma çekirdeği (kendi-yeterlilik mekanizması, AŞAMA 1).
//
// Tasarım (project_self_sufficiency_roadmap): orkestratörün ÜSTÜNDE bağımsız bir MÜFETTİŞ.
//   - ÇEŞİTLİLİK: müfettiş FARKLI AİLE modeli (Sonnet) — orkestratör Opus. Aynı-aile ardışık
//     sürüm kör-noktayı paylaşır; çapraz-aile gerçekten farklı ağırlık → farklı kör-nokta.
//   - VANTAJ: müfettiş niyet + yörünge + sonucu görür; orkestratörün GEREKÇESİNİ değil
//     (gerekçeyi görürse onun çerçevesine kayar → "anlaşır" → denetim çöker).
//   - ÇÖZÜM ÖLÇÜTÜ: (1) doğrulanabilir KANIT (müfettiş Read/Grep/Bash ile bizzat doğrular)
//     (2) kanıt kesin değilse İLKELER (3) çözülmez/yüksek-risk/kanıtsız-anlaşma → İNSANA.
//   - "Kazanan" = kanıtı/ilkeyi tutan, ikna eden DEĞİL. İtiraf yalnız düşünce-tükenişinden sonra.
//   - Tartışma TÜRKÇE (translator'sız, insana-yükseltme kayıpsız); protokol talimatı İngilizce.
//
// Bu AŞAMA 1: çekirdek modül (müfettiş-geçişi + sınırlı tartışma + çözüm). Orkestratör
// döngüsüne bağlama (checkpoint hook) + müdahale-seçimi (mekanik taban/asimetrik eşik) +
// tecrübe katmanı + API-paritesi = sonraki aşamalar.

import type Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runClaudeCli } from "./cli-run.js";
import { runReasoning } from "./llm-reasoning.js";
import { runTurn, type ApiMessage } from "./claude-api.js";
import { executeTool, TOOLS_CODEGEN, type ToolContext } from "./tool-handlers.js";
import { READ_ONLY_DISALLOWED_TOOLS } from "./tool-policy.js";
import { modelForTier } from "./model-catalog.js";
import { decideIntervention, type InterventionSignals, type InterventionDecision } from "./inspector-trigger.js";
import { recordLesson, recallLessons, retractLesson, type Lesson } from "./experience-layer.js";
import { backendForRole, claudeKeyForRole, type MyclConfig } from "./config.js";
import { DECISION_PRINCIPLES } from "./agent-language.js";
import { log } from "./logger.js";

/**
 * API-PARİTESİ (Parça 2 kuyruk, YZLLM "API'yi de destekle"): müfettiş runClaudeCli ile `claude` binary'sini
 * sürer (araç-kullanan kanıt-toplama). Abonelik modunda binary login'le çalışır; AMA API-modunda binary
 * login DEĞİL → claudeSpawnEnv Claude anahtarını ENJEKTE ETMEZ → müfettiş auth'suz kalır (fail-closed
 * escalate, değeri kaybolur). Fix: API-modunda Claude anahtarını CLI'ya extraEnv ile geç. Müfettiş BİLEREK
 * Claude (çapraz-aile) → claudeKeyForRole HER ZAMAN Claude anahtarını verir (z.ai değil). Guard backendForRole
 * "api" → abonelik modunda GEÇMEZ (sürpriz API faturası yok). Claude anahtarı yoksa (saf-z.ai/abonelik-yok)
 * → undefined → claudeSpawnEnv (abonelik) ya da fail-closed (çapraz-aile tasarım sınırı: Claude erişimi şart).
 */
export function inspectorClaudeEnv(config: MyclConfig): Record<string, string> | undefined {
  if (backendForRole(config, "main") !== "api") return undefined;
  const key = claudeKeyForRole(config.api_keys, "main")?.trim();
  return key ? { ANTHROPIC_API_KEY: key } : undefined;
}

// Müfettiş SALT-OKUNUR araç seti (kanıt-toplama): Write/Edit YOK (müfettiş yargılar, değiştirmez).
const INSPECTOR_TOOLS = TOOLS_CODEGEN.filter((t) =>
  ["Read", "Grep", "Glob", "Bash"].includes((t as { name: string }).name),
);
const MAX_INSPECTOR_SDK_TURNS = 25; // araç-döngüsü tavanı (runaway-backstop; verdict birkaç turda gelir)
const TOOL_RESULT_CAP = 12_000; // tool_result token-patlamasını önle (codegen deseni)

/** assistant content'ten düz metni çıkar (verdict JSON metni text-block'larda gelir). SAF (test-edilebilir). */
export function extractText(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => (b as { type?: string }).type === "text")
    .map((b) => (b as { text?: string }).text ?? "")
    .join("")
    .trim();
}

/**
 * MÜFETTİŞ TURU — BACKEND-AWARE (tam API-paritesi). CLI/abonelik → `claude` binary (runClaudeCli, salt-okunur
 * tool'lar). API-modu + Claude anahtarı → SDK ARAÇ-DÖNGÜSÜ (binary'siz; runTurn ↔ executeTool ile bizzat
 * Read/Grep/Glob/Bash çalıştırıp kanıt toplar). Her ikisi de Claude/Sonnet (çapraz-aile). Müfettiş YALNIZ
 * yargılar → Write/Edit yok; AskUserQuestion yok (müfettiş insana mahkeme-kanalından gider, tool'la değil).
 */
async function runInspectorTurn(
  config: MyclConfig,
  opts: { systemPrompt: string; userMessage: string; projectRoot: string; modelId: string; effort?: string },
): Promise<{ ok: boolean; text: string; error?: string }> {
  const env = inspectorClaudeEnv(config);
  const apiKey = env?.ANTHROPIC_API_KEY;
  if (apiKey) {
    // API-modu + Claude anahtarı → SDK araç-döngüsü (claude binary gerekmez).
    return runInspectorSdkLoop(config, apiKey, opts);
  }
  // CLI/abonelik → claude binary. env undefined (abonelik) → ambient Claude auth; varsa extraEnv ile Claude key.
  const res = await runClaudeCli({
    systemPrompt: opts.systemPrompt,
    userMessage: opts.userMessage,
    modelId: opts.modelId,
    cwd: opts.projectRoot,
    effort: opts.effort,
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
    extraEnv: env,
  });
  return { ok: res.ok, text: res.text, error: res.error };
}

/** Müfettiş SDK araç-döngüsü: runTurn ↔ executeTool (salt-okunur) loop → final metin (verdict). Fail-closed:
 *  üretemezse/tavan aşılırsa ok:false → caller (parseVerdict yoksa) insana yükseltir. */
async function runInspectorSdkLoop(
  config: MyclConfig,
  apiKey: string,
  opts: { systemPrompt: string; userMessage: string; projectRoot: string; modelId: string; effort?: string },
): Promise<{ ok: boolean; text: string; error?: string }> {
  const ctx: ToolContext = { project_root: opts.projectRoot };
  const messages: ApiMessage[] = [{ role: "user", content: opts.userMessage }];
  let lastText = "";
  for (let turn = 0; turn < MAX_INSPECTOR_SDK_TURNS; turn++) {
    let r;
    try {
      r = await runTurn(
        config,
        apiKey,
        {
          messages,
          system: opts.systemPrompt,
          model: opts.modelId,
          tools: INSPECTOR_TOOLS,
          max_tokens: 8192,
          // CLI tarafında --effort=max iletilir; API/SDK tarafında efor yalnız adaptive-thinking destekleyen
          // modelde output_config'e yansır (Sonnet 4.6 thinkingConfigFor'da almıyorsa efektif no-op — dürüst not).
          effortOverride: opts.effort,
          // role VERİLMEZ + noZaiFallback → çapraz-aile Claude korunur (z.ai'ye yönlenmez VE account-error'da
          // z.ai'ye düşmez → erişilemezse fail-closed escalate; default z.ai key'i olan kullanıcıda bile güvenli).
          noZaiFallback: true,
        },
        () => {},
      );
    } catch (e) {
      return { ok: false, text: lastText, error: String(e) };
    }
    messages.push({ role: "assistant", content: r.assistantContent });
    const turnText = extractText(r.assistantContent);
    if (turnText) lastText = turnText;
    if (r.toolUses.length === 0) {
      // Sonnet müfettiş düzeltmesi: max_tokens'da kesilirse verdict TRUNCATE olabilir → görünür kıl
      // (parseVerdict yine null'da fail-closed escalate eder ama truncate sinyali log'da kaybolmasın).
      if (r.stop_reason === "max_tokens") {
        log.warn("inspector", "SDK turu max_tokens'da kesildi — verdict truncate olabilir (kısmi metin)", { turn });
      }
      return { ok: true, text: lastText }; // model durdu → verdict hazır
    }
    const toolResults: Anthropic.MessageParam["content"] = [];
    for (const tu of r.toolUses) {
      const result = await executeTool(tu.name, tu.input as Record<string, unknown>, ctx).catch((e) => ({
        content: `tool error: ${String(e)}`,
        is_error: true,
      }));
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: String(result.content).slice(0, TOOL_RESULT_CAP),
        is_error: result.is_error,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  log.warn("inspector", "SDK araç-döngüsü tavanı aştı", { turns: MAX_INSPECTOR_SDK_TURNS });
  return { ok: !!lastText.trim(), text: lastText, error: lastText.trim() ? undefined : "müfettiş SDK döngüsü tavanı aştı (verdict yok)" };
}

/** Müfettiş modeli: en iyi SONNET (çapraz-aile çeşitlilik). Orkestratör en iyi Opus'tur. */
export const INSPECTOR_MODEL_DEFAULT = "claude-sonnet-4-6";
/** Tartışma için hard güvenlik-tavanı (mekanik devre-kesici). YZLLM: "başta sınırsız, doğal
 * uzunluğu öğren" → tur sayısını LOGLA (öğren), ama sonsuz-döngü ASLA → yüksek tavan = backstop. */
const MAX_DEBATE_ROUNDS = 10;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Müfettişe verilen bağlam — orkestratörün GEREKÇESİ KASITLI olarak yok (bağımsızlık). */
export interface InspectorContext {
  /** Orijinal kullanıcı niyeti (sapma ölçütü). */
  intent: string;
  /** Yörünge özeti — ne karar verildi / ne yapıldı (audit'ten türetilir). */
  trajectory: string;
  /** Sonuçlar — ne oluştu (dosyalar, gate çıktıları, test sonuçları). */
  outcomes: string;
  /** İncelenen karar/bulgu: orkestratör NE yapıyor/iddia ediyor (gerekçesi DEĞİL). */
  decision: string;
  /** Yüksek-risk mi (güvenlik/veri-kaybı/geri-alınamaz)? → anlaşma bile kanıt/insan ister. */
  highStakes?: boolean;
  projectRoot: string;
  /** RECALL (Parça 2): geçmiş benzer vakalardan dersler — İPUCU (iddia, hakikat değil). Müfettiş bunları
   *  KENDİ kanıtıyla yeniden doğrular (yanlış ders zehirlemesin); bağımsızlığını korur (kör-kabul YOK). */
  priorExperience?: string;
}

/** RECALL dersleri prompt'a uygun tek string'e çevir (güçlü/zayıf etiketli). */
function formatLessonsForPrompt(lessons: Lesson[]): string {
  return lessons
    .map(
      (l, i) =>
        `${i + 1}. [${l.verified ? "güçlü/doğrulanmış" : "zayıf-öneri"}] ${l.principle}\n   (geçmiş sorun: ${l.problem.slice(0, 150)})`,
    )
    .join("\n");
}

export type InspectorStance = "agree" | "flag" | "escalate";

export interface InspectorVerdict {
  stance: InspectorStance;
  /** Türkçe gerekçe (bilim insanı dürüstlüğüyle). */
  reason: string;
  /** Bizzat toplanan doğrulanabilir kanıt (varsa). */
  evidence?: string;
}

export type DebateResolution =
  | "agree" // müfettiş baştan katıldı (yüksek-risk değil)
  | "orchestrator-conceded" // tartışmada orkestratör kanıta teslim oldu → müfettişin yolu
  | "inspector-conceded" // müfettiş kanıta teslim oldu → orkestratörün yolu
  | "escalate"; // çözülmedi / yüksek-risk / kanıtsız → İNSANA

export interface DebateOutcome {
  resolution: DebateResolution;
  rounds: number;
  /** Çözüm-hazır özet (insana giderse: sorun + iki pozisyon + kanıt + ayrışma + istenen karar). */
  summary: string;
  finalVerdict: InspectorVerdict;
}

let cachedProtocol: string | null = null;

/** debate-protocol.md'yi yükle (asset; resources'a eklenmeli — bundle notu). Hata→gömülü minimal. */
async function loadDebateProtocol(): Promise<string> {
  if (cachedProtocol !== null) return cachedProtocol;
  try {
    const p = resolve(__dirname, "..", "..", "assets", "agent-prompts", "debate-protocol.md");
    cachedProtocol = await readFile(p, "utf-8");
  } catch (e) {
    log.warn("inspector", "debate-protocol.md yüklenemedi → gömülü minimal kullanılıyor", {
      error: String(e),
    });
    cachedProtocol = EMBEDDED_PROTOCOL_FALLBACK;
  }
  return cachedProtocol;
}

/** Protokol dosyası okunamazsa (bundle eksikse) çekirdek kurallar yine de uygulansın. */
const EMBEDDED_PROTOCOL_FALLBACK = [
  "You are a scientist seeking truth, not victory.",
  "- Verify by EVIDENCE first (run the test, read the file, reproduce). Evidence — not eloquence — decides.",
  "- If evidence is inconclusive, the project's principles (verify-before-claim, never-assume, quality-first) decide.",
  "- Concede ONLY after exhausting your thinking and finding no remaining valid argument — never to seem agreeable, never out of stubbornness.",
  "- Never assume. State the problem; make sure you are judging the SAME problem.",
  "- High-stakes (security/data-loss/irreversible) or unprovable agreement → escalate to the human.",
].join("\n");

/** Fenced/serbest JSON bloğundan verdict çıkar (forced-tool yok; CLI metin-JSON parite). */
export function parseVerdict(text: string): InspectorVerdict | null {
  // Son `{...}` JSON bloğunu yakala (fenced ```json veya çıplak).
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fences.length > 0 ? fences : [text];
  for (const c of candidates.reverse()) {
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const obj = JSON.parse(c.slice(start, end + 1)) as Record<string, unknown>;
      const stance = String(obj.stance ?? "").toLowerCase();
      if (stance === "agree" || stance === "flag" || stance === "escalate") {
        return {
          stance: stance as InspectorStance,
          reason: String(obj.reason ?? "").trim(),
          evidence: obj.evidence ? String(obj.evidence).trim() : undefined,
        };
      }
    } catch {
      /* sonraki adaya geç */
    }
  }
  return null;
}

/** Müfettiş tek-geçiş: Sonnet, kanıt-toplayan (Read/Grep/Bash), bağımsız vantaj → verdict. */
export async function runInspectorPass(
  config: MyclConfig,
  ctx: InspectorContext,
  priorOrchestratorDefense?: string,
): Promise<InspectorVerdict> {
  const protocol = await loadDebateProtocol();
  const system = [
    protocol,
    "",
    "## YOUR ROLE — THE INSPECTOR (the skeptical scientist)",
    "You are an INDEPENDENT auditor over the orchestrator. You did NOT make this decision and you do",
    "NOT see the orchestrator's private reasoning — only intent, trajectory, outcomes, and the decision.",
    "Judge from your own vantage. GATHER EVIDENCE YOURSELF (read files, run checks) before concluding.",
    "REPRODUCE-FIRST (mandatory before ruling 'flag'/false-positive): do NOT declare a finding a",
    "false-positive from reading alone — first ATTEMPT to reproduce it (run the failing gate/check/command",
    "yourself via Bash, observe the behavior). Use debug as an INVESTIGATION tool: reproduce, isolate,",
    "then judge. Rule 'flag' only if you CANNOT reproduce a real problem, or you PROVED it is a tooling",
    "artifact (framework convention, i18n label, heuristic miss). Record your reproduction attempt in 'evidence'.",
    "",
    "## PROJECT STANDARDS — apply these when judging whether a finding is a REAL issue (not just to your own conduct):",
    DECISION_PRINCIPLES,
    "",
    "Respond in TURKISH. End with EXACTLY one JSON block:",
    '```json',
    '{"stance":"agree|flag|escalate","reason":"<Türkçe>","evidence":"<bizzat topladığın kanıt>"}',
    '```',
    "- agree: karar doğru/güvenli (kanıt/ilke destekliyor).",
    "- flag: karar yanlış/riskli — gerekçe + KANIT ver (sapma, false-positive, varsayım, niyetle çelişki).",
    "- escalate: kanıt kesin değil VEYA yüksek-risk VEYA emin olamıyorsun → insana.",
  ].join("\n");

  const user = [
    `## ORİJİNAL NİYET\n${ctx.intent}`,
    `## YÖRÜNGE (ne yapıldı)\n${ctx.trajectory}`,
    `## SONUÇLAR\n${ctx.outcomes}`,
    `## İNCELENEN KARAR (orkestratör ne yapıyor/iddia ediyor)\n${ctx.decision}`,
    ctx.highStakes ? "## NOT: Bu YÜKSEK-RİSK bir konu (güvenlik/veri/geri-alınamaz)." : "",
    ctx.priorExperience
      ? `## GEÇMİŞ TECRÜBE (benzer vakalar — İDDİA, hakikat DEĞİL)\nBunlar geçmişte verilen kararlar; kör KABUL ETME, kendi kanıtınla DOĞRULA (geçmiş ders YANLIŞ olabilir, zehirlenme). Bağımsızlığını koru:\n${ctx.priorExperience}`
      : "",
    priorOrchestratorDefense
      ? `## ORKESTRATÖRÜN SAVUNMASI (buna karşı kendi vantajından değerlendir; çerçevesini ÖZÜMSEME)\n${priorOrchestratorDefense}`
      : "",
    "Bizzat kanıt topla, sonra sınıfla.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await runInspectorTurn(config, {
    systemPrompt: system,
    userMessage: user,
    projectRoot: ctx.projectRoot,
    modelId: INSPECTOR_MODEL_DEFAULT,
    effort: "max",
  });
  if (!res.ok || !res.text.trim()) {
    // Müfettiş üretemedi → KÖRü körüne "agree" DEME (sessiz-gömme). Kuşkuda insana.
    log.warn("inspector", "müfettiş-geçişi başarısız → escalate (fail-closed)", { error: res.error });
    return { stance: "escalate", reason: "Müfettiş değerlendirmesi üretilemedi → güvenli taraf: insana." };
  }
  const v = parseVerdict(res.text);
  if (!v) {
    log.warn("inspector", "verdict bloğu parse edilemedi → escalate (fail-closed)");
    return { stance: "escalate", reason: "Müfettiş verdict bloğu üretmedi → insana." };
  }
  return v;
}

/** Orkestratör-savunması: müfettişin bayrağına Opus ile yanıt — savun, KANITLA, ya da teslim ol. */
async function runOrchestratorDefense(
  config: MyclConfig,
  ctx: InspectorContext,
  flag: InspectorVerdict,
): Promise<{ text: string; conceded: boolean }> {
  const protocol = await loadDebateProtocol();
  const system = [
    protocol,
    "",
    "## YOUR ROLE — THE ORCHESTRATOR (defending your decision as a scientist)",
    "The inspector flagged your decision. Respond as a scientist: defend with EVIDENCE, or CONCEDE if",
    "the inspector is right. Force your thinking to its limit FIRST; concede ONLY if you genuinely have",
    "no remaining valid argument — never to be agreeable, never out of stubbornness. Respond in TURKISH.",
    "End with EXACTLY one JSON block:",
    '```json',
    '{"conceded":true|false,"reason":"<Türkçe: kanıtınla savun ya da neden teslim olduğun>"}',
    '```',
  ].join("\n");
  const user = [
    `## SENİN KARARIN\n${ctx.decision}`,
    `## MÜFETTİŞİN BAYRAĞI\n${flag.reason}${flag.evidence ? `\n\nKanıtı:\n${flag.evidence}` : ""}`,
    "Kanıtla savun ya da teslim ol.",
  ].join("\n\n");

  const modelId = modelForTier("strong", config.selected_models.model_tiers).id; // orkestratör = en iyi Opus
  const r = await runReasoning(config, {
    systemPrompt: system,
    userMessage: user,
    modelId,
    projectRoot: ctx.projectRoot,
    effort: "max",
  });
  const text = r.ok ? r.text : "";
  const conceded = /"conceded"\s*:\s*true/.test(text);
  return { text, conceded };
}

/**
 * İKİ BİLİM İNSANI tartışması — kullanıcının üst-tasarımı. Müfettiş bağımsız inceler; bayrak
 * kaldırırsa sınırlı tur boyunca orkestratörle KANITLA tartışır; biri gerçekten teslim olur ya da
 * çözülmez/yüksek-risk → insana. "Anlaşma" yüksek-riskte tek başına güvenli sayılmaz.
 */
export async function runScientistsDebate(
  config: MyclConfig,
  ctx: InspectorContext,
): Promise<DebateOutcome> {
  let verdict = await runInspectorPass(config, ctx);
  let rounds = 0;

  // Müfettiş baştan katıldı:
  if (verdict.stance === "agree") {
    if (ctx.highStakes) {
      // Anlaşmak en büyük tehlike: yüksek-riskte kanıtsız anlaşma → yine insana.
      return {
        resolution: "escalate",
        rounds,
        finalVerdict: verdict,
        summary: `Yüksek-risk + müfettiş katıldı ama anlaşma tek başına güvenli değil → insana. Gerekçe: ${verdict.reason}`,
      };
    }
    return { resolution: "agree", rounds, finalVerdict: verdict, summary: verdict.reason };
  }
  if (verdict.stance === "escalate") {
    return { resolution: "escalate", rounds, finalVerdict: verdict, summary: verdict.reason };
  }

  // Müfettiş BAYRAK kaldırdı → sınırlı, kanıt-temelli tartışma.
  while (rounds < MAX_DEBATE_ROUNDS) {
    rounds++;
    const defense = await runOrchestratorDefense(config, ctx, verdict);
    if (defense.conceded) {
      return {
        resolution: "orchestrator-conceded",
        rounds,
        finalVerdict: verdict,
        summary: `Orkestratör kanıta teslim oldu → müfettişin yolu. ${verdict.reason}`,
      };
    }
    // Müfettiş, savunmaya karşı YENİDEN değerlendirir (çerçeveyi özümsemeden).
    verdict = await runInspectorPass(config, ctx, defense.text);
    if (verdict.stance === "agree") {
      return {
        resolution: "inspector-conceded",
        rounds,
        finalVerdict: verdict,
        summary: `Müfettiş kanıta teslim oldu → orkestratörün yolu. ${verdict.reason}`,
      };
    }
    if (verdict.stance === "escalate") {
      return { resolution: "escalate", rounds, finalVerdict: verdict, summary: verdict.reason };
    }
    // hâlâ flag → bir tur daha (kanıt derinleşir).
  }

  // Tavan aşıldı, çözülmedi → insana (mekanik devre-kesici; doğal-uzunluğu LOGLA).
  log.info("inspector", "tartışma tavanı aşıldı → escalate", { rounds });
  return {
    resolution: "escalate",
    rounds,
    finalVerdict: verdict,
    summary: `Tartışma ${rounds} turda çözülmedi → insana. Son müfettiş gerekçesi: ${verdict.reason}`,
  };
}

export interface CheckpointResult {
  /** Müfettiş gerçekten devreye girdi mi (decideIntervention "none" değil mi). */
  acted: boolean;
  decision: InterventionDecision;
  /** "debate" → DebateOutcome; "flag" → tek-geçiş InspectorVerdict; "none" → undefined. */
  outcome?: DebateOutcome | InspectorVerdict;
  /** Yüksek-risk konu mu (güvenlik/veri/geri-alınamaz). mahkemeRuling: yüksek-riskte oto-suppress YOK → insana. */
  highStakes?: boolean;
  /** RECALL'da getirilen dersler (RETRACT için: yeni hüküm bunlara ZIT ise yanlış-ders geri-alınır). */
  recalledLessons?: Lesson[];
}

/**
 * KÖPRÜ: müdahale-seçimi → müfettiş. Orkestratör checkpoint'inden çağrılır (AŞAMA 2/b, flag-arkası).
 * Sinyaller "none" derse müfettiş hiç koşmaz (sus). "flag" → ucuz tek-geçiş; "debate" → tam tartışma.
 */
export async function runInspectorCheckpoint(
  config: MyclConfig,
  ctx: InspectorContext,
  signals: InterventionSignals,
): Promise<CheckpointResult> {
  const decision = decideIntervention(signals);
  if (decision.level === "none") return { acted: false, decision, highStakes: ctx.highStakes };
  if (decision.level === "flag") {
    const verdict = await runInspectorPass(config, ctx);
    return { acted: true, decision, outcome: verdict, highStakes: ctx.highStakes };
  }
  const outcome = await runScientistsDebate(config, ctx);
  return { acted: true, decision, outcome, highStakes: ctx.highStakes };
}

/**
 * Gate-bulgusu incelemesi (AŞAMA 2/c ilk insertion). Bir gate fail olunca, MyCL "düzeltmek" üzere
 * iken müfettiş bulguyu inceler: GERÇEK kod sorunu mu, yoksa false-positive mi (framework-convention /
 * i18n-etiketi / sezgisel-yanlış — Faz 8 i18n & Faz 11 ts-prune stall sınıfı). isGateFix yumuşak
 * sinyali + severity (güvenlik→high) müdahale-seçimini sürer. ŞİMDİLİK gözlem (caller akışı değiştirmez).
 */
export async function inspectGateFinding(
  config: MyclConfig,
  opts: {
    projectRoot: string;
    gateLabel: string;
    errors: string;
    intent?: string;
    /** YAPISAL yüksek-risk sinyali (caller biliyorsa). Faz 13 güvenlik gate'i true geçer → kelime-regex'ine
     *  bağlı kalma (regex XSS/CSRF/SSRF vb. kaçırabilir). Verilmezse aşağıdaki pozitif-regex'e düşülür. */
    highStakes?: boolean;
    /** DÖNGÜ-SINIFI (frozen-goal kanonik örneği): aynı hata `attempts` odaklı oto-düzeltmeye RAĞMEN
     *  sürüyor. Bu, orkestratörün YAPISAL kör-noktası — kendi döngüsünü göremez ("döngüde miyim yoksa
     *  kendimi mi kandırıyorum"). Set edilince isLoop=true → mekanik taban → TAM tartışma (bağımsız
     *  "gerçek sorun nerede / bulgu gerçek mi" araştırması), gate-fix tek-geçişi değil. */
    loop?: { attempts: number },
  },
): Promise<CheckpointResult> {
  // ÖNDEN-ÇÖZ (2026-06-24 sistemik fix): YAPISAL sinyal önce — caller highStakes verdiyse ona güven (Faz 13
  // güvenlik gate'i). Yoksa pozitif-regex'e düş AMA dağarcığı genişlet: dar 7-kelime listesi XSS/CSRF/SSRF/RCE/
  // SQLi/IDOR gibi yaygın güvenlik bulgularını kaçırıp düşük-incelemeye düşürüyordu. highStakes POZİTİF sinyal
  // (true→daha çok inceleme); fazla-eşleşme güvenli yön (asimetrik: kaçırmak pahalı, fazla-alarm ucuz).
  const highStakes =
    opts.highStakes ??
    /güvenlik|security|secret|credential|\bcsp\b|injection|\bauth(entication|orization|n|z)?\b|\bxss\b|\bcsrf\b|\bssrf\b|\brce\b|sqli|sql injection|\bidor\b|\bxxe\b|\bssti\b|deserial|prototype pollution|\btraversal\b|\bcve-|\blfi\b|\brfi\b|command injection|open redirect|vulnerab|\bexploit\b|hardcoded|sanitiz|clickjack|\bcors\b|\bjwt\b|şifre|parola/i.test(
      `${opts.gateLabel} ${opts.errors}`,
    );
  const loop = opts.loop;
  // RECALL (Parça 2): bu sorun-imzasına benzer geçmiş dersleri getir → müfettişe İPUCU olarak ver
  // (RECORD ile aynı imza şeması). recallLessons retracted'i eler + verified'i önceler; best-effort.
  const recalled = await recallLessons(`${opts.gateLabel} ${opts.errors.slice(0, 100)}`).catch(() => []);
  const priorExperience = recalled.length > 0 ? formatLessonsForPrompt(recalled) : undefined;
  const ctx: InspectorContext = {
    intent: opts.intent ?? "Kod-kalite/gate incelemesi — amaç çalışan, kaliteli, sıfır-gerçek-borç kod.",
    trajectory: loop
      ? `"${opts.gateLabel}" hatası ${loop.attempts} odaklı oto-düzeltme denemesine RAĞMEN sürüyor (döngü). ` +
        `Orkestratör muhtemelen YANLIŞ yeri düzeltiyor / olmayan bir sorunu kovalıyor / yanlış sorunu çözüyor — ` +
        `bu, orkestratörün yapısal kör-noktası (kendi döngüsünü göremez).`
      : `"${opts.gateLabel}" gate'i başarısız; MyCL bildirilen bulguları "düzeltmek" üzere.`,
    outcomes: opts.errors.slice(0, 4000),
    decision: loop
      ? `MyCL "${opts.gateLabel}" hatasını ${loop.attempts} kez düzeltmeyi denedi, geçmedi. BAĞIMSIZ araştır: ` +
        `GERÇEK sorun NEREDE (düzenlenen yerde mi, yoksa başka yerde mi)? Bulgu GERÇEK kod sorunu mu, yoksa ` +
        `false-positive mi (framework-convention, i18n-etiketi, sezgisel-tarayıcı yanlışı, ortam farkı)? ` +
        `Bizzat repro-et + dosyaları oku, sonra sınıfla.`
      : `MyCL şu "${opts.gateLabel}" gate bulgularını düzeltecek. Bunlar GERÇEK kod sorunu mu, yoksa false-positive mi (framework-convention export'u, i18n metin-etiketi, sezgisel-tarayıcı yanlışı)? Bizzat dosyaları okuyup DOĞRULA, sonra sınıfla.`,
    highStakes,
    projectRoot: opts.projectRoot,
    priorExperience,
  };
  const signals: InterventionSignals = {
    // ÖNDEN-ÇÖZ (CLAUDE.md #6): mekanik-taban sinyalleri sabit-false değil, KAYNAĞINDAN türetilir.
    // isStuck: gate hatası bir CLI-hang'inden geliyorsa (idle/wall-clock kill → cli-run.ts/cli-session.ts
    // "cli idle timeout"/"cli wall-clock cap" döndürür, lastFailReason'a sızar) → takılma = mekanik taban →
    // tam tartışma. Bu metinler MyCL-özgü (proje çıktısında nadir) → false-pozitif düşük; sonuç yalnız
    // "daha çok inceleme" (asimetrik-maliyet kabul).
    isStuck: /idle timeout|wall-clock cap/i.test(opts.errors),
    // Döngü mekanik tabandır (yargı yok) → tam tartışma. Gate-fix tek-geçişi değil; çünkü 6 deneme
    // başarısız = "düzeltilebilir bulgu" varsayımı çürüdü, derin bağımsız araştırma gerek.
    isLoop: !!loop,
    noProgress: !!loop,
    // highStakesAction: güvenlik/secret/csp/auth bulgusu (highStakes 497'de zaten türetilmiş) →
    // geri-alınamaz/yüksek-risk eşik → mekanik taban → tam tartışma. Tek satır, yeni hesap yok.
    highStakesAction: highStakes,
    isGateFix: true, // yumuşak sinyal: bir bulgu "düzeltilmek" üzere → false-positive riski
    // isNovel (recalled.length===0) BİLİNÇLİ BAĞLANMADI: ders dosyası boşken HER orta-riskli gate-fix novel
    // sayılır → softCount=2 → tek-geçiş flag yerine TAM tartışmaya çıkar (her fix'te iki-model debate). Bu büyük
    // bir varsayılan-davranış değişikliği (dar/zararsız değil) → YZLLM kararına bırakıldı (açık borç, yarım-iş değil).
    severity: highStakes ? "high" : "medium",
  };
  const result = await runInspectorCheckpoint(config, ctx, signals);
  return { ...result, recalledLessons: recalled }; // RETRACT için recall'ı sonuca taşı
}

/** Netleştirme-incelemesi sonucu (mahkeme): orkestratör "emin değilim, insana sorayım" derken
 *  müfettiş insana SORULMALI mı yoksa orkestratör kendi cevabıyla İLERLESİN mi karar verir. */
export interface ClarifyRuling {
  /** true → insana sor (gerçek belirsizlik / tercih / zevk / geri-alınamaz / eksik-bilgi).
   *  false → orkestratör çıkarılabilir cevapla ilerlesin (gereksiz soruyordu). */
  ask: boolean;
  /** ask=false ise: hangi seçenekle ilerlenecek (verilen seçeneklerden biri, birebir). */
  answer?: string;
  /** İnsan-okunur Türkçe gerekçe (chat'e). */
  summary: string;
}

/** Netleştirme verdict'i parse (forced-tool yok; CLI metin-JSON parite). ask=false ama geçersiz/
 *  eksik answer → fail-closed (ask=true): kör "ilerle" yok, kuşkuda insana. */
export function parseClarifyVerdict(text: string, validOptions: string[]): ClarifyRuling | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fences.length > 0 ? fences : [text];
  for (const c of candidates.reverse()) {
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const obj = JSON.parse(c.slice(start, end + 1)) as Record<string, unknown>;
      if (typeof obj.ask !== "boolean") continue;
      const reason = String(obj.reason ?? "").trim();
      if (obj.ask) return { ask: true, summary: reason };
      const answer = String(obj.answer ?? "").trim();
      // Çıkarılan cevap GERÇEKTEN verilen seçeneklerden biri olmalı (model uydurmasın).
      const valid = validOptions.find((o) => o === answer || o.includes(answer) || answer.includes(o));
      if (!answer || !valid) {
        return { ask: true, summary: `Müfettiş "ilerle" dedi ama geçerli bir seçenek vermedi → güvenli taraf: insana. (${reason})` };
      }
      return { ask: false, answer: valid, summary: reason };
    } catch {
      /* sonraki adaya geç */
    }
  }
  return null;
}

/**
 * MAHKEME (netleştirme-sınıfı, YZLLM 2026-06-22 "müfettişle konuşsun, mahkeme kurulsun"): orkestratör
 * "emin değilim, insana sorayım" derken müfettiş BAĞIMSIZ tartar — gerçek belirsizlik mi (tercih/zevk/
 * geri-alınamaz/eksik-bilgi → insana), yoksa orkestratör gereksiz mi soruyor (cevap niyetten/bağlamdan/
 * ilkelerden çıkarılabilir → ilerle). Tek-geçiş (savunulacak işlenmiş karar yok). Fail-closed: müfettiş
 * üretemez/parse edilemez/geçersiz cevap → insana sor. Kör auto-pick DEĞİL → sonsuz-clarify döngüsü yok.
 */
export async function inspectClarify(
  config: MyclConfig,
  opts: { projectRoot: string; intent: string; trajectory: string; question: string; options: string[] },
): Promise<ClarifyRuling> {
  const protocol = await loadDebateProtocol();
  const system = [
    protocol,
    "",
    "## YOUR ROLE — THE INSPECTOR: is this clarification NECESSARY?",
    "The orchestrator is UNCERTAIN and wants to ask the human a clarifying question. Judge INDEPENDENTLY:",
    "is this ambiguity GENUINE — only the human can resolve it: a real preference/taste, an irreversible or",
    "destructive choice, or information truly ABSENT from the intent + project — or is the orchestrator",
    "OVER-ASKING, where the answer is clearly inferable from the user's intent, the project context, or the",
    "project's principles? GATHER EVIDENCE first (read the intent and the project files). BIAS: ask the human",
    "for genuine preference/taste/irreversible choices — never guess those. Say 'proceed' ONLY when the answer",
    "is clearly inferable AND low-risk. When in doubt → ask the human. Respond in TURKISH.",
    "End with EXACTLY one JSON block — either:",
    '```json',
    '{"ask": true, "reason": "<Türkçe: neden gerçek belirsizlik, insana gitmeli>"}',
    '```',
    "or, if the orchestrator is over-asking:",
    '```json',
    '{"ask": false, "answer": "<verilen seçeneklerden biri, BİREBİR>", "reason": "<Türkçe: cevap neden çıkarılabilir + düşük-risk>"}',
    '```',
  ].join("\n");
  const user = [
    `## ORİJİNAL NİYET (kullanıcının mesajı)\n${opts.intent}`,
    `## YÖRÜNGE (orkestratör neden sormak istiyor)\n${opts.trajectory}`,
    `## ORKESTRATÖRÜN SORMAK İSTEDİĞİ\n${opts.question}\n\nSeçenekler: ${opts.options.join(" | ")}`,
    "Bu netleştirme GERÇEKTEN gerekli mi, yoksa orkestratör gereksiz mi soruyor? Bizzat kanıt topla, sonra karar ver.",
  ].join("\n\n");
  const res = await runInspectorTurn(config, {
    systemPrompt: system,
    userMessage: user,
    projectRoot: opts.projectRoot,
    modelId: INSPECTOR_MODEL_DEFAULT,
    effort: "max",
  });
  if (!res.ok || !res.text.trim()) {
    log.warn("inspector", "clarify-incelemesi üretilemedi → ask (fail-closed)", { error: res.error });
    return { ask: true, summary: "Müfettiş değerlendirmesi üretilemedi → güvenli taraf: sana soruyorum." };
  }
  const r = parseClarifyVerdict(res.text, opts.options);
  if (!r) {
    log.warn("inspector", "clarify verdict parse edilemedi → ask (fail-closed)");
    return { ask: true, summary: "Müfettiş geçerli bir verdict üretmedi → güvenli taraf: sana soruyorum." };
  }
  return r;
}

/** CheckpointResult'ı insan-okunur tek satıra çevir (gözlem mesajı için). */
export function formatCheckpoint(r: CheckpointResult): string {
  if (!r.acted || !r.outcome) return `sus (${r.decision.reason})`;
  if ("resolution" in r.outcome) {
    return `tartışma → ${r.outcome.resolution} (${r.outcome.rounds} tur): ${r.outcome.summary}`;
  }
  return `${r.outcome.stance}: ${r.outcome.reason}`;
}

/** Mahkemenin BAĞLAYICI hükmü → caller akışını değiştirir (gözlem değil). */
export type MahkemeAction = "proceed" | "suppress" | "escalate";
export interface MahkemeRuling {
  /** proceed: karar/fix doğru → normal akış. suppress: false-positive KANITLANDI → fix'i uygulama.
   *  escalate: kuşku/yüksek-risk/kanıtsız → İNSANA. */
  action: MahkemeAction;
  /** Mahkeme gerçekten toplandı mı (decideIntervention "none" ise false → caller varsayılan akış). */
  convened: boolean;
  /** İnsan-okunur özet (chat / askq için). */
  summary: string;
}

/**
 * Mahkeme hükmü: CheckpointResult → bağlayıcı eylem. GÜVENLİ eşleme (kullanıcı: "mahkeme şart",
 * orkestratör kutsal): SUPPRESS yalnız TAM-TARTIŞMA sonrası orkestratör-teslim (en güçlü false-positive
 * sinyali — iki bilim insanı da kanıtla hemfikir). Tek-geçiş "flag" (tartışmasız) → ASLA suppress,
 * escalate (insana); kuşku/yüksek-risk/escalate → insana; gerçek bulgu/anlaşma → proceed.
 */
export function mahkemeRuling(r: CheckpointResult): MahkemeRuling {
  if (!r.acted || !r.outcome) {
    return { action: "proceed", convened: false, summary: `sus (${r.decision.reason})` };
  }
  if ("resolution" in r.outcome) {
    const o = r.outcome;
    switch (o.resolution) {
      case "orchestrator-conceded": // tartışma sonrası orkestratör teslim → fix yanlış/false-positive
        // YZLLM kuralı (feedback_gate_findings_never_assume): güvenlik/yüksek-risk ASLA oto-suppress
        // edilmez (sessiz-gömme = beter) → suppress yerine İNSANA. Yalnız düşük-riskte oto-suppress.
        return r.highStakes
          ? { action: "escalate", convened: true, summary: `[yüksek-risk → oto-suppress YOK, insana] ${o.summary}` }
          : { action: "suppress", convened: true, summary: o.summary };
      case "escalate":
        return { action: "escalate", convened: true, summary: o.summary };
      case "agree": // müfettiş baştan katıldı (yüksek-risk değil) → karar doğru
      case "inspector-conceded": // müfettiş teslim → orkestratörün yolu doğru
        return { action: "proceed", convened: true, summary: o.summary };
    }
  }
  // Tek-geçiş verdict (tartışma YOK): agree→proceed; flag/escalate→insana (tartışmasız suppress YOK).
  const v = r.outcome;
  if (v.stance === "agree") return { action: "proceed", convened: true, summary: v.reason };
  return { action: "escalate", convened: true, summary: v.reason };
}

/**
 * TECRÜBE KATMANI — RECORD (Parça 2, project_self_sufficiency_roadmap). Mahkeme bir bulguyu KARARA
 * bağlayınca (suppress/proceed) dersi depola: sorun → KANITLI çözüm → ilke. Sonraki benzer sorunda
 * recall edilir (RECALL artımı; orada YİNE doğrulanır — ders=iddia, hakikat değil). Kurallar:
 *  - YALNIZ kararlı sonuç (convened + suppress/proceed). escalate (insana/çözülmedi) → ders DEĞİL.
 *  - verified = TAM-TARTIŞMA (iki bilim insanı kanıtla hemfikir) → güçlü; tek-geçiş → zayıf öneri.
 *  - Best-effort: ders kaydı ana akışı ASLA bozmaz (recordLesson kendi içinde yutar + loglar).
 */
/** SAF (test-edilebilir): mahkeme sonucundan Lesson kur, ya da kaydedilmeyecekse null. */
export function buildMahkemeLesson(opts: {
  signature: string;
  problem: string;
  result: CheckpointResult;
  ruling: MahkemeRuling;
  ts: number;
}): Lesson | null {
  if (!opts.ruling.convened || opts.ruling.action === "escalate") return null;
  // verified = TAM-TARTIŞMA (DebateOutcome; iki bilim insanı kanıtla hemfikir) → güçlü; tek-geçiş → zayıf.
  const debated = !!opts.result.outcome && "resolution" in opts.result.outcome;
  const principle =
    opts.ruling.action === "suppress"
      ? "Bu bulgu-deseni FALSE-POSITIVE — mahkeme kanıtla doğruladı (fix gereksiz; benzeri için önce false-positive ihtimalini DOĞRULA)."
      : "Bu bulgu-deseni GERÇEK kod sorunu — mahkeme proceed (fix gerekli).";
  return {
    signature: opts.signature,
    problem: opts.problem.slice(0, 400),
    resolution: opts.ruling.summary.slice(0, 500),
    principle,
    verified: debated,
    isFalsePositive: opts.ruling.action === "suppress", // açık alan (principle-regex kırılganlığı yerine)
    ts: opts.ts,
  };
}

/** SAF (test-edilebilir): recall edilen ders, yeni mahkeme hükmüne ZIT mı? false-positive ↔ gerçek
 *  çelişkisi = ders YANLIŞ çıktı (mahkeme kendi taze kanıtıyla aksini buldu) → RETRACT sinyali. */
export function lessonContradictsRuling(lesson: Lesson, ruling: MahkemeRuling): boolean {
  if (!ruling.convened || ruling.action === "escalate") return false;
  // Açık alan (Sonnet müfettiş düzeltmesi); eski derslerde alan yoksa principle-regex'e düş (backward-compat).
  const lessonSaidFalsePositive = lesson.isFalsePositive ?? /FALSE-POSITIVE/.test(lesson.principle);
  const rulingSaysFalsePositive = ruling.action === "suppress";
  return lessonSaidFalsePositive !== rulingSaysFalsePositive;
}

export async function recordMahkemeLesson(opts: {
  signature: string;
  problem: string;
  result: CheckpointResult;
  ruling: MahkemeRuling;
  ts: number;
}): Promise<void> {
  // RETRACT (zehirlenme önleme, Parça 2): mahkeme TAZE kanıtla, recall edilen bir derse ZIT karar verdiyse
  // o ders YANLIŞTI → geri-al (yanlış ders bir daha recall edilip yanıltmasın). Fuzzy-recall exact-record'la
  // örtüşmeyebilir → eski yanlış ders aksi halde kalıcı olurdu; çelişki = en güçlü "yanlış-ders" sinyali.
  for (const old of opts.result.recalledLessons ?? []) {
    if (lessonContradictsRuling(old, opts.ruling)) await retractLesson(old.signature);
  }
  const lesson = buildMahkemeLesson(opts);
  if (lesson) await recordLesson(lesson);
}
