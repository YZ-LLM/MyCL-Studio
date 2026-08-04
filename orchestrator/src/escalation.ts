// escalation — faz model+efor seçimi (tek choke-point: escalatedModelEffort).
//
// YZLLM 2026-06-16 ("merdiven kullanmıcaz"): adaptif MERDİVEN (cheap→balanced→strong, başarısızlıkta tırman)
// KALDIRILDI. Canlı kanıt: E2BIG yanlış-pozitifinde merdiven 3 tur boşa tırmandı. Artık model+efor İŞ-TÜRÜNE
// göre seçilir (config kral; selectModelForTask/selectEffortForTask) — her faz kendi işine uygun modelle TEK
// seferde çalışır, başarısızlıkta model yükseltme YOK (caller normal fail/derin-çözüm akışına düşer).
//
// Saf + deterministik (test edilebilir). Dosya adı tarihsel ("escalation") korundu — çoke-point imzası değişmedi.

import { selectModelForTask, selectEffortForTask, type TaskKind } from "./model-catalog.js";
import type { State } from "./types.js";
import type { MyclConfig } from "./config.js";

/**
 * Faz domain'i → iş-türü (TaskKind). Kalite-kritik fazlar strong tier'a, hafif fazlar balanced'a eşlenir
 * (TASK_RELEVANCE üzerinden). Bilinmeyen domain → "codegen" (strong; kaliteyi riske atmayan güvenli taraf).
 */
const DOMAIN_TO_TASK: Record<string, TaskKind> = {
  intent: "intent", // Faz 1 — niyet/clarify (balanced)
  audit: "review", // Faz 2 — hassasiyet denetimi (strong)
  briefing: "design", // Faz 3 — mühendislik brifingi (strong)
  spec: "spec", // Faz 4 — spec yazımı (strong)
  "ui-codegen": "codegen", // Faz 5 — UI kodu (strong)
  "db-design": "design", // Faz 7 — DB tasarımı (strong)
  "tdd-codegen": "codegen", // Faz 8 — TDD kodu (strong)
  "risk-review": "review", // Faz 9 — risk incelemesi (strong)
};

/**
 * Bir fazın (domain'in) model+eforu — İŞ-TÜRÜNE göre çözülür (YZLLM 2026-06-16, merdiven KALDIRILDI). Tırmanma
 * yok: her faz kendi iş-türüne uygun model+eforla TEK seferde çalışır. config KRAL: tier→model config'ten,
 * efor config'ten. Tek choke-point — fazlar bunu çağırır (imza korundu; _state artık kullanılmıyor).
 */
export function escalatedModelEffort(
  _state: State,
  config: MyclConfig,
  domain: string,
): { modelId: string; modelLabel: string; effort: string; fromCatalog: boolean } {
  const task: TaskKind = DOMAIN_TO_TASK[domain] ?? "codegen";
  const m = selectModelForTask(task, config.selected_models.model_tiers);
  const effort = selectEffortForTask(task, config.claude_code_flags.effort);
  return { modelId: m.modelId, modelLabel: m.label, effort, fromCatalog: m.fromCatalog };
}
