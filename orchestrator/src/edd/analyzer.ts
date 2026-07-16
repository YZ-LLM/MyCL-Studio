// edd/analyzer — EDD birim davranış analizi. YZLLM 2026-07-07 (EDD Faz 1).
//
// BACKEND-AWARE = KATI PARİTE (API modu = diğer modlar, fark yok): backendForRole(orchestrator)==="cli" →
// runClaudeCli (abonelik claude); değilse → runTurn agentic loop (claude API).
// İkisi de SALT-OKUNUR (Read/Grep/Glob; Write/Edit/Bash/alt-ajan YASAK — yabancı kaynağa DOKUNMA, kod ÇALIŞTIRMA).
//
// AMAÇ (YZLLM reframe): mevcut davranışı ANLA + belgele. Kod DOĞRU varsayılır — bug ARAMA/düzeltme YOK. Çıktı:
// birim başına davranış-sözleşmesi {ne yapar, invariant'lar, yan-etkiler, bağımlılar}. Bir birim-batch işlenir
// (döngü orkestrasyonu birim-birim resumable — bkz. edd/progress + orkestrasyon modülü).

import Anthropic from "@anthropic-ai/sdk";
import { runTurn, type ApiMessage, type ToolDef } from "../claude-api.js";
import { executeTool, TOOLS_CODEGEN, type ToolContext } from "../tool-handlers.js";
import { runClaudeCli } from "../cli-run.js";
import { extractKindBlock } from "../cli-json.js";
import { PURE_REASONING_DISALLOWED_TOOLS } from "../tool-policy.js";
import { backendForRole, orchestratorApiKey, orchestratorModelId, type MyclConfig } from "../config.js";
import { withClaudeStreamBanner } from "../ipc.js";
import { log } from "../logger.js";
import type { SourceUnit } from "./enumerate.js";
import type { EddBehavior } from "./progress.js";

const READ_TOOLS = ["Read", "Grep", "Glob"];
/** Batch başına SERT wall-clock (batch küçük → bol; runaway koruması). Tüm-run tavansız: batch-batch ilerler. */
const BATCH_WALL_CLOCK_MS = 20 * 60_000;
/** API yolunda batch başına tur tavanı (küçük batch → bol; runaway koruması). */
const API_MAX_TURNS = 80;

/** Birim kimliği + davranış-sözleşmesi (EddBehavior tek tanım progress.ts'te; tech-doc buradan türer). */
export type EddBehaviorRecord = { unit: string } & EddBehavior;

const SYSTEM_PROMPT = `You are EDD (Integration-Driven Define). MyCL is integrating with an EXISTING codebase and must fully UNDERSTAND + DOCUMENT its CURRENT behavior so future changes never break it.

CRITICAL FRAMING: the existing code is assumed CORRECT. Do NOT hunt for bugs, do NOT suggest fixes, do NOT judge quality. Describe what the code DOES, as-is.

For EACH target unit given, use Read/Grep/Glob to read the file (and its imports/callers for context) and capture its OBSERVABLE behavior:
- what_it_does: concretely what this unit does (routes/endpoints/exported functions/components + their effect). 1-4 sentences.
- invariants: rules a future change MUST preserve — input→output contracts, guards, auth/permission checks, ordering, the exact status codes / response shapes / error messages that callers rely on. List the load-bearing ones (not trivia).
- side_effects: DB writes, network/HTTP calls, filesystem, global/shared state, external services, env reads.
- dependents_note: who relies on this unit, if apparent (else omit).
Be concrete + specific to THIS code (name real functions/values). If a unit is pure config/data/docs with no behavior, say so in one short line (empty invariants/side_effects).

SECURITY — never copy secret literals into your output: when a unit hardcodes a secret, API key, password, token, private key, session/signing secret, or connection credential, describe its PRESENCE, kind, and location but write \`<redacted>\` in place of the literal value (e.g. "signs sessions with a hardcoded secret <redacted> (app.js:38)"). Reproduce every OTHER real value normally; redact ONLY secret material. Rationale: your output is written verbatim into MyCL's own notes (.mycl/edd-analysis.md, edd-progress.jsonl) inside the project — copying the literal secret there would duplicate the project's secrets into extra plaintext files (and make security scanners re-flag MyCL's own notes). The behavior contract stays intact without the literal value.

You are READ-ONLY: you cannot write, edit, or run anything. When done, output ONLY one JSON block at the very END and nothing after it:
{"kind":"edd_units","units":[{"unit":"<exact path from the target list>","what_it_does":"...","invariants":["..."],"side_effects":["..."],"dependents_note":"..."}]}
Include EVERY target unit exactly once, using the EXACT unit paths from the list. Do NOT invent units not in the list.`;

function buildUserMessage(units: SourceUnit[]): string {
  const list = units.map((u) => `- ${u.unit}`).join("\n");
  return `TARGET UNITS (analyze each; paths are relative to the project root):\n${list}\n\nRead each unit, then emit the edd_units JSON block covering ALL of them.`;
}

function textOf(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** API yolu: runTurn agentic loop (Read/Grep/Glob executeTool), end_turn'e kadar; final metni döner. */
async function runViaApi(
  config: MyclConfig,
  projectRoot: string,
  model: string,
  sys: string,
  user: string,
): Promise<string> {
  const tools: ToolDef[] = TOOLS_CODEGEN.filter((t) => READ_TOOLS.includes(t.name));
  const ctx: ToolContext = { project_root: projectRoot };
  const messages: ApiMessage[] = [{ role: "user", content: user }];
  const apiKey = orchestratorApiKey(config.api_keys); // rol-key paritesi (orchestrator ?? main) — CLI/error-analysis ile aynı
  const deadline = Date.now() + BATCH_WALL_CLOCK_MS; // CLI wallClockMs ile parite (yavaş model/rate-limit süre patlamasın)
  let lastText = "";
  for (let turn = 0; turn < API_MAX_TURNS; turn++) {
    if (Date.now() > deadline) {
      log.warn("edd/analyzer", "API batch wall-clock tavanı — kesildi (elde olanla döner)", { turn });
      break;
    }
    const r = await runTurn(
      config,
      apiKey,
      { messages, system: sys, model, role: "orchestrator", tools, max_tokens: 8192 },
      () => {},
    );
    messages.push({ role: "assistant", content: r.assistantContent });
    const t = textOf(r.assistantContent);
    if (t.trim()) lastText = t; // JSON blok final turda gelir
    if (r.toolUses.length === 0) break; // end_turn → bitti
    const toolResults: Anthropic.MessageParam["content"] = [];
    for (const tu of r.toolUses) {
      // SALT-OKUNUR SERT ALLOWLIST (mahkeme blocker): EDD GÜVENSİZ yabancı repo içeriğini modele besler → prompt-injection
      // (repo'da gizli "tool_use name=Bash…") Bash/Write/Edit üretebilir. tools listesi
      // yalnız prompt-seviyesi; executeTool çağıranın izin-setini bilmez → BURADA sert reddet (prompt'a değil KODA güven,
      // CLI'deki disallowedTools'un API eşdeğeri). tool-policy.ts dersi: "allowlist kısıt değil, deny gerçek engel".
      if (!READ_TOOLS.includes(tu.name)) {
        log.warn("edd/analyzer", "izinsiz tool reddedildi (salt-okunur EDD)", { tool: tu.name });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `tool '${tu.name}' not permitted — EDD is READ-ONLY (Read/Grep/Glob only).`,
          is_error: true,
        });
        continue;
      }
      const res = await executeTool(tu.name, tu.input as Record<string, unknown>, ctx);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: res.content,
        ...(res.is_error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return lastText;
}

/** Abonelik (CLI) yolu: runClaudeCli, salt-okunur, idle-kill kapalı + batch wall-clock. */
async function runViaCli(projectRoot: string, model: string, sys: string, user: string): Promise<string> {
  const res = await runClaudeCli({
    systemPrompt: sys,
    userMessage: user,
    modelId: model,
    cwd: projectRoot,
    allowedTools: READ_TOOLS,
    disallowedTools: PURE_REASONING_DISALLOWED_TOOLS, // Write/Edit/Bash/alt-ajan YASAK
    timeoutMs: 0, // idle-kill kapalı (uzun sessiz okuma/düşünme öldürülmesin)
    wallClockMs: BATCH_WALL_CLOCK_MS, // batch başına sert tavan (runaway); tüm-run batch-batch tavansız
  });
  if (!res.ok) throw new Error(res.error ?? "cli edd analysis failed");
  return res.text;
}

/**
 * Bir birim-batch'ini analiz et → birim başına davranış kaydı. Backend-aware (KATI parite). Yalnız hedef
 * listedeki birimler kabul (uydurma/dışı atlanır). Parse-fail → boş dizi (caller o birimleri retry/pending bırakır).
 */
export async function analyzeUnitBatch(
  config: MyclConfig,
  projectRoot: string,
  units: SourceUnit[],
): Promise<EddBehaviorRecord[]> {
  if (units.length === 0) return [];
  const model = orchestratorModelId(config.selected_models);
  const user = buildUserMessage(units);
  const useCli = backendForRole(config, "orchestrator") === "cli";
  // Banner sızıntısı fix (2026-07-13): init→stop tek primitifte → EDD bittiğinde/patladığında "Model çalışıyor"
  // BAYAT kalmaz (canlı cave5 bug'ının kökü: edd init yayıp stop/idle yaymıyordu).
  const text = await withClaudeStreamBanner(
    { text: "edd-analyze", model, cwd: projectRoot },
    () =>
      useCli
        ? runViaCli(projectRoot, model, SYSTEM_PROMPT, user)
        : runViaApi(config, projectRoot, model, SYSTEM_PROMPT, user),
  );

  const block = extractKindBlock(text, ["edd_units"]);
  if (!block || !Array.isArray(block.units)) {
    log.warn("edd/analyzer", "edd_units bloğu ayrıştırılamadı (batch pending kalır)", {
      batch: units.length,
      head: text.slice(0, 200),
    });
    return [];
  }
  const valid = new Set(units.map((u) => u.unit));
  const out: EddBehaviorRecord[] = [];
  for (const u of block.units) {
    if (!u || typeof u !== "object") continue;
    const rec = u as Record<string, unknown>;
    if (typeof rec.unit !== "string" || !valid.has(rec.unit)) continue; // hedef-dışı/uydurma birim atla
    out.push({
      unit: rec.unit,
      what_it_does: typeof rec.what_it_does === "string" ? rec.what_it_does : "",
      invariants: Array.isArray(rec.invariants) ? rec.invariants.filter((x): x is string => typeof x === "string") : [],
      side_effects: Array.isArray(rec.side_effects)
        ? rec.side_effects.filter((x): x is string => typeof x === "string")
        : [],
      dependents_note: typeof rec.dependents_note === "string" ? rec.dependents_note : undefined,
    });
  }
  return out;
}
