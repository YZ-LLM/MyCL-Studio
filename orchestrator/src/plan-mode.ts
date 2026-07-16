// plan-mode — 🗺️ Plan Modu: serbest metni İŞ PLANINA çevir → kullanıcı onaylayınca adımlar kuyruğa.
//
// Neden (YZLLM 2026-07-16): "MyCL'e bir plan modu ekleyelim. Onu seçip yazdıklarımı mükemmel bir
// iş planına çevirsin ve her şeyi onaylarsam iş listesine her bir adımı eklesin ve planı uygulamaya
// başlasın." Composer'da never-ask deseni bir mod pili; AÇIKKEN kullanıcı mesajı normal orkestratör
// kararına GİTMEZ — önce PLANLAYICI (strong model) çalışır, plan sohbete yazılır, korumalı askq ile
// onay istenir (plan_approve_* — never-ask'ta bile AÇIK onay; kullanıcının şartı). Onayda her adım
// kuyruğa `source:"plan"` ile girer ve normal sıralı akış (F4 açıksa paralel kümeleme) devralır.
//
// intake.ts splitTasks deseni (çift backend: CLI/abonelik + API; salt akıl yürütme, yazma yok) —
// tek fark model: plan kalitesi önemli → strong tier. Bozuk çıktı → GÖRÜNÜR hata, HİÇBİR ŞEY
// kuyruğa girmez (plan modu açık bir moddur; sessiz tek-iş fallback'i burada YANLIŞ olurdu — KATI #4).

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { resolveLlmClient } from "./claude-api.js";
import { extractKindBlock } from "./cli-json.js";
import { runClaudeCli } from "./cli-run.js";
import { backendForRole, type MyclConfig } from "./config.js";
import { emitClaudeStream, withClaudeStreamBanner } from "./ipc.js";
import { log } from "./logger.js";
import { selectEffortForTask, selectModelForTask } from "./model-catalog.js";
import { READ_ONLY_DISALLOWED_TOOLS } from "./tool-policy.js";

// ── Mod singleton'ı (never-ask deseni: frontend localStorage'dan boot'ta yeniden gönderir) ──
let _planMode = false;
export function setPlanMode(on: boolean): void {
  _planMode = on;
}
export function isPlanMode(): boolean {
  return _planMode;
}

export interface PlanStep {
  /** Kendi başına yürütülebilir iş metni (TR, en fazla 2 cümle — pipeline Faz 1'e tek başına girer). */
  text: string;
  /** Yürütme sırası = öncelik (1'den başlar). */
  priority: number;
  /** Bu adım neden var / neden bu sırada (kullanıcıya gösterilir). */
  rationale_tr: string;
}

export interface PlanProposal {
  title_tr: string;
  summary_tr: string;
  steps: PlanStep[];
}

const PLAN_PROMPT = `Sen MyCL'in İŞ PLANLAYICISISIN. Kullanıcı bir hedef/istek yazdı; görevin bunu MÜKEMMEL, uygulanabilir bir iş planına çevirmek.

KURALLAR:
1. Planı SIRALI adımlara böl. Her adım TEK BAŞINA yürütülebilir bir iş olmalı — MyCL her adımı ayrı bir geliştirme iterasyonu (Faz 1'den) olarak koşacak. Adım metni EN FAZLA 2 kısa cümle; tek başına anlaşılır olsun (bağlamı adımın içine göm).
2. Adım sayısını İŞE göre seç — küçük hedef 2-3 adım, büyük hedef daha çok. Bölme uğruna bölme YOK: bir uygulamanın çekirdek MVP'si (auth + ana modül gibi ayrılamaz parçalar) TEK adımdır; gerçekten ayrı teslim edilebilir işler ayrı adımdır.
3. Sıralama = bağımlılık sırası: önce temel/altyapı, sonra üzerine kurulanlar. priority alanı bu sırayı taşır (1=ilk).
4. Her adıma 1 cümle rationale_tr yaz: neden var / neden bu sırada.
5. title_tr: planın 3-6 kelimelik adı. summary_tr: 1-2 cümle genel özet.
6. Kullanıcı REVİZYON istediyse (önceki plan + geri bildirim verilir) planı geri bildirime göre güncelle — beğenilen kısımları koru.

ÇIKTI — yalnızca TEK bir JSON bloğu, etrafında başka metin YOK:
\`\`\`json
{"kind":"work_plan","title_tr":"...","summary_tr":"...","steps":[{"text":"...","priority":1,"rationale_tr":"..."}]}
\`\`\`

Kurallar: Geçerli JSON (çift tırnak, trailing comma YOK). Açıklama yazma. En az 1 adım olmalı.`;

const PLAN_USER = (
  userText: string,
  revision?: { previous: PlanProposal; feedback: string },
): string => {
  if (!revision) {
    return `Kullanıcının hedefi:\n"""\n${userText}\n"""\n\nİş planını work_plan JSON bloğu olarak şimdi üret.`;
  }
  return (
    `ÖNCEKİ PLAN (revize edilecek):\n${JSON.stringify(revision.previous, null, 2)}\n\n` +
    `Kullanıcının geri bildirimi:\n"""\n${revision.feedback}\n"""\n\n` +
    `Planı geri bildirime göre güncelle; work_plan JSON bloğu olarak üret.`
  );
};

/** SAF: {kind:work_plan} bloğunu parse + doğrula. Geçersiz/boş-adım → null (caller GÖRÜNÜR hata verir). */
export function parsePlanBlock(raw: string): PlanProposal | null {
  const block = extractKindBlock(raw, ["work_plan"]) as
    | { title_tr?: unknown; summary_tr?: unknown; steps?: unknown }
    | null;
  if (!block || !Array.isArray(block.steps) || block.steps.length === 0) return null;
  const steps: PlanStep[] = [];
  for (const s of block.steps) {
    const rec = s as { text?: unknown; priority?: unknown; rationale_tr?: unknown };
    if (typeof rec.text === "string" && rec.text.trim()) {
      steps.push({
        text: rec.text.trim(),
        priority:
          typeof rec.priority === "number" && rec.priority >= 1 ? Math.floor(rec.priority) : steps.length + 1,
        rationale_tr: typeof rec.rationale_tr === "string" ? rec.rationale_tr.trim() : "",
      });
    }
  }
  if (steps.length === 0) return null;
  return {
    title_tr: typeof block.title_tr === "string" && block.title_tr.trim() ? block.title_tr.trim() : "İş Planı",
    summary_tr: typeof block.summary_tr === "string" ? block.summary_tr.trim() : "",
    steps,
  };
}

/** Backend'e göre (cli/api) planlayıcıyı çalıştır; parse et. Hata → null (caller görünür hata verir). */
export async function generatePlan(
  config: MyclConfig,
  projectRoot: string,
  userText: string,
  revision?: { previous: PlanProposal; feedback: string },
): Promise<PlanProposal | null> {
  // Plan kalitesi belirleyici → STRONG tier (intake'in classification'ından bilinçli fark).
  const model = selectModelForTask("orchestration", config.selected_models.model_tiers).modelId;
  const useCli = backendForRole(config, "orchestrator") === "cli";
  let text: string;
  try {
    if (useCli) {
      const res = await withClaudeStreamBanner(
        { text: "cli-plan-mode", model, cwd: projectRoot },
        () =>
          runClaudeCli({
            systemPrompt: PLAN_PROMPT,
            userMessage: PLAN_USER(userText, revision),
            modelId: model,
            cwd: projectRoot,
            // Salt planlama — yazma/alt-ajan yasak (Read/Grep açık: proje bağlamına bakabilir).
            disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
            effort: selectEffortForTask("orchestration", config.claude_code_flags.effort),
            onText: (t) => emitClaudeStream({ sub: "text", text: t }),
            timeoutMs: 180_000,
          }),
      );
      if (!res.ok) {
        log.error("plan-mode", "planlama (CLI) başarısız", { error: res.error });
        return null;
      }
      text = res.text;
    } else {
      const { client, model: apiModel } = resolveLlmClient(
        config,
        "orchestrator",
        config.api_keys.orchestrator ?? config.api_keys.main,
        model,
        { timeoutMs: 120_000 },
      );
      const response = await client.messages.create({
        model: apiModel,
        max_tokens: 4096,
        system: PLAN_PROMPT,
        messages: [{ role: "user", content: PLAN_USER(userText, revision) }],
      });
      text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }
  } catch (err) {
    log.error("plan-mode", "planlama beklenmedik hata", { error: String(err) });
    return null;
  }
  return parsePlanBlock(text);
}

/** SAF: planı TR sohbet mesajına çevir (onay askq'sunun yanında gösterilir). */
export function formatPlanTR(plan: PlanProposal): string {
  const steps = [...plan.steps]
    .sort((a, b) => a.priority - b.priority)
    .map((s) => `${s.priority}. **${s.text}**${s.rationale_tr ? `\n   _${s.rationale_tr}_` : ""}`)
    .join("\n");
  return (
    `🗺️ **İş Planı: ${plan.title_tr}**\n\n${plan.summary_tr}\n\n${steps}\n\n` +
    `Onaylarsan ${plan.steps.length} adımın her biri iş kuyruğuna eklenir ve sırayla uygulanır.`
  );
}

/** Onaylanan planı kalıcı ize yaz: `.mycl/plans/<ts>.md`. Hata görünür log (non-fatal). */
export async function persistPlan(projectRoot: string, plan: PlanProposal): Promise<string | null> {
  try {
    const dir = join(projectRoot, ".mycl", "plans");
    await fs.mkdir(dir, { recursive: true });
    const p = join(dir, `${Date.now()}.md`);
    const body =
      `# ${plan.title_tr}\n\n${plan.summary_tr}\n\n` +
      [...plan.steps]
        .sort((a, b) => a.priority - b.priority)
        .map((s) => `${s.priority}. ${s.text}${s.rationale_tr ? `\n   - ${s.rationale_tr}` : ""}`)
        .join("\n") +
      "\n";
    await fs.writeFile(p, body, "utf-8");
    return p;
  } catch (err) {
    log.warn("plan-mode", "plan kalıcı ize yazılamadı (non-fatal)", { error: String(err) });
    return null;
  }
}
