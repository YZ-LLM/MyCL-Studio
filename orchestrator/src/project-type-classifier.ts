// project-type-classifier — Phase 2 sonu spec özetinden proje tipini
// (web/api/cli/library/mobile/desktop/ml/game) sınıflandırır.
//
// Haiku (translator role) ile tool_use yapısal output → ProjectType döner.
// Faz 16 (E2E) ve Faz 17 (Load) runner seçimi + Faz 5/7 skip kararı için
// state'e yazılır.
//
// Hata case'i: API fail veya model "unknown" derse → "unknown" dönülür,
// pipeline durmaz. v15.1 confirm askq ile kullanıcı override edebilir.

import Anthropic from "@anthropic-ai/sdk";
import { resolveLlmClient } from "./claude-api.js";
import { extractKindBlock } from "./cli-json.js";
import { runClaudeCli } from "./cli-run.js";
import type { MyclConfig } from "./config.js";
import { isSubscriptionMode } from "./subscription-mode.js";
import { log } from "./logger.js";
import type { ProjectType, UiComplexity } from "./types.js";

const VALID_UI_COMPLEXITY: readonly UiComplexity[] = ["simple", "moderate", "complex"] as const;

const VALID_TYPES: readonly ProjectType[] = [
  "web",
  "api",
  "cli",
  "library",
  "mobile",
  "desktop",
  "ml",
  "game",
  "unknown",
] as const;

const SYSTEM_PROMPT = `You are a project type classifier.
Read the user's intent / enriched spec summary and decide:
1. The project type (one of the categories below)
2. Whether the project needs a persistent database (SQLite/Postgres/Mongo/etc)
3. The UI complexity tier (only meaningful for projects WITH a user interface)

Categories (pick exactly one for project_type):
- web: browser UI application (React/Vue/Svelte/Angular/Next/etc)
- api: backend REST/GraphQL service (Express/FastAPI/Actix/Gin/etc) — no end-user UI
- cli: command-line tool (npm/pip/cargo binary)
- library: SDK / package consumed by other code — no UI, no service
- mobile: iOS/Android app (React Native/Flutter/native)
- desktop: Electron/Tauri/Qt — local UI app
- ml: ML model / training pipeline / inference service
- game: game (Unity/Godot/browser game)
- unknown: cannot determine

has_database guidance:
- true: project stores persistent state (DB schema, migrations, ORM/query layer)
- false: stateless (pure compute, in-memory cache, no migrations, e.g. simple CLI or static SPA)
- If uncertain, lean true (Faz 7 zaten skip-on-missing-spec'i destekler).

ui_complexity guidance (only for UI types — web/desktop/mobile; for non-UI types use "simple"):
- simple: one screen or a few static views; standard form/list/CRUD UI; no real-time or rich client-side
  interaction (e.g. a todo app, a landing page, a basic dashboard)
- moderate: multiple interacting views, client-side routing, non-trivial state management, some custom
  interactions (e.g. a multi-step wizard, a settings-heavy app)
- complex: rich/interactive UI — real-time updates, drag-and-drop, canvas/visualization, collaborative
  editing, heavy animation, or a design-system-level component surface (e.g. a kanban board, a diagram editor)
- If uncertain, lean "moderate" (only "simple" skips the multi-perspective design panel; moderate/complex keep it).

Call classify_project_type with all fields. Do not output any other text.`;

const TOOL_DEF = {
  name: "classify_project_type",
  description: "Submit the project type + database requirement classification.",
  input_schema: {
    type: "object",
    required: ["project_type", "has_database"],
    properties: {
      project_type: {
        type: "string",
        enum: [...VALID_TYPES],
      },
      has_database: {
        type: "boolean",
      },
      ui_complexity: {
        type: "string",
        enum: ["simple", "moderate", "complex"],
      },
    },
  },
};

export class ProjectTypeClassifyError extends Error {
  override readonly name = "ProjectTypeClassifyError";
}

/**
 * Classifier sonucu. v15.2.3 borç: has_database eklendi — Faz 7 (Veritabanı
 * Tasarımı) gate'i için yapısal sinyal. undefined ise heuristic fallback.
 */
export interface ProjectClassification {
  project_type: ProjectType;
  /** undefined olabilir — API fail durumunda fallback'a düşülür. */
  has_database?: boolean;
  /**
   * v15.13 spec gate: UI karmaşıklık seviyesi (yalnız UI tipleri için anlamlı).
   * undefined → fan-out KOŞAR (regresyon-güvenli varsayılan). Faz 5 tasarım
   * paneli gate'i: yalnız "simple" fan-out'u atlar.
   */
  ui_complexity?: UiComplexity;
}

// CLI (abonelik) modunda forced-tool yoktur → ajan tek bir JSON bloğu yazar.
const CLI_JSON_INSTRUCTION = `

## OUTPUT — CLI mode (no tools)
Do NOT call any tool and do NOT investigate. Decide from the summary only. Your
ENTIRE reply must be exactly one JSON block and nothing else:
{"kind":"project_type","project_type":"<one category>","has_database":<true|false>,"ui_complexity":"<simple|moderate|complex>"}`;

/** ui_complexity'i fail-soft çıkarır — geçersiz/eksikse undefined (fan-out KOŞAR). */
function parseUiComplexity(raw: unknown): UiComplexity | undefined {
  return typeof raw === "string" && (VALID_UI_COMPLEXITY as readonly string[]).includes(raw)
    ? (raw as UiComplexity)
    : undefined;
}

/**
 * Abonelik modu sınıflandırma — text-JSON CLI (forced-tool yerine). Çıktıyı
 * extractKindBlock ile parse eder; geçersiz/başarısızsa "unknown" (fail-soft).
 */
async function classifyViaCli(
  config: MyclConfig,
  summary: string,
): Promise<ProjectClassification> {
  const model = config.selected_models.translator;
  try {
    const res = await runClaudeCli({
      systemPrompt: SYSTEM_PROMPT + CLI_JSON_INSTRUCTION,
      userMessage: summary,
      modelId: model,
      cwd: process.cwd(), // sınıflandırma sadece özetten — proje erişimi gerekmez
      timeoutMs: 120_000,
    });
    if (!res.ok) {
      log.warn("project-type-classifier", "cli failed (fail-soft)", { error: res.error });
      return { project_type: "unknown" };
    }
    const block = extractKindBlock(res.text, ["project_type"]);
    if (!block) {
      log.warn("project-type-classifier", "cli: no project_type block (fail-soft)");
      return { project_type: "unknown" };
    }
    const raw = block.project_type;
    const hasDb = typeof block.has_database === "boolean" ? block.has_database : undefined;
    const uiComplexity = parseUiComplexity(block.ui_complexity);
    if (typeof raw === "string" && (VALID_TYPES as readonly string[]).includes(raw)) {
      log.info("project-type-classifier", "classified (cli)", {
        project_type: raw,
        has_database: hasDb,
        ui_complexity: uiComplexity,
      });
      return { project_type: raw as ProjectType, has_database: hasDb, ui_complexity: uiComplexity };
    }
    log.warn("project-type-classifier", "cli: invalid project_type (fail-soft)", { raw });
    return { project_type: "unknown", has_database: hasDb, ui_complexity: uiComplexity };
  } catch (err) {
    log.error("project-type-classifier", "cli threw (fail-soft)", err);
    return { project_type: "unknown" };
  }
}

/**
 * Spec özetinden project_type sınıflandırır. Haiku tool_use'tan döndürdüğü
 * değeri valide eder, geçersizse "unknown" döner (fail-soft). Abonelik modunda
 * text-JSON CLI yoluna (classifyViaCli) düşer.
 */
export async function classifyProjectType(
  config: MyclConfig,
  summary: string,
): Promise<ProjectClassification> {
  if (!summary || summary.trim().length < 5) {
    log.warn("project-type-classifier", "summary too short — unknown");
    return { project_type: "unknown" };
  }
  // v15.10: abonelik modunda da sınıflandır — forced-tool API yerine text-JSON
  // CLI (Faz 0/2/9 ile aynı desen). "unknown"a sessizce düşmek Faz 5/6/7 skip
  // kararını + Faz 16/17 runner seçimini bozuyordu (bkz no-silent-fallback).
  if (isSubscriptionMode(config)) {
    return await classifyViaCli(config, summary);
  }

  // z.ai Aşama 2 ⑤b: Sağlayıcı=Z.AI (main) ise proje-tipi sınıflandırma turu GLM'e gider; claude'da AYNEN korunur.
  const { client, model } = resolveLlmClient(
    config,
    "main",
    config.api_keys.main,
    config.selected_models.translator,
  );
  const startTs = Date.now();

  log.info("project-type-classifier", "request", {
    model,
    summary_len: summary.length,
  });

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      tools: [TOOL_DEF] as Anthropic.Messages.Tool[],
      tool_choice: { type: "tool", name: "classify_project_type" },
      messages: [{ role: "user", content: summary }],
    });

    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "classify_project_type") {
        const input = block.input as {
          project_type?: string;
          has_database?: boolean;
          ui_complexity?: string;
        };
        const raw = input.project_type;
        const hasDb =
          typeof input.has_database === "boolean" ? input.has_database : undefined;
        const uiComplexity = parseUiComplexity(input.ui_complexity);
        if (typeof raw === "string" && (VALID_TYPES as readonly string[]).includes(raw)) {
          log.info("project-type-classifier", "classified", {
            project_type: raw,
            has_database: hasDb,
            ui_complexity: uiComplexity,
            elapsed_ms: Date.now() - startTs,
          });
          return { project_type: raw as ProjectType, has_database: hasDb, ui_complexity: uiComplexity };
        }
        log.warn("project-type-classifier", "invalid output", { raw });
        return { project_type: "unknown", has_database: hasDb, ui_complexity: uiComplexity };
      }
    }
    log.warn("project-type-classifier", "no tool_use in response");
    return { project_type: "unknown" };
  } catch (err) {
    log.error("project-type-classifier", "api failed (fail-soft)", err);
    return { project_type: "unknown" };
  }
}

/**
 * `project_type`'a göre Faz 5 (UI Yapımı) + Faz 6 (UI İnceleme) skip edilmeli
 * mi karar verir. UI'sı olmayan projeler (library/cli/api/ml/game/server-only)
 * için Faz 5/7 atlanır; pipeline Faz 5 → Faz 7'e geçer.
 */
export function shouldSkipUiPhases(projectType: ProjectType): boolean {
  return (
    projectType === "library" ||
    projectType === "cli" ||
    projectType === "api" ||
    projectType === "ml" ||
    projectType === "game"
  );
}
