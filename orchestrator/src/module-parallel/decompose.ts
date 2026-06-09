// module-parallel/decompose — bir özellik isteğini ≥2 BAĞIMSIZ modüle böler (paralel codegen için).
//
// LLM öneri yapar (hangi modüller, hangi AYRIK kapsam); K1 kapısı (`shouldParallelize`) gerçek ayrıklığı
// DETERMİNİSTİK doğrular → LLM "bağımsız" diye över ama kapıyı kod geçer. Bölemezse/ayrık değilse → null → SERİ.

import { runClaudeCli } from "../cli-run.js";
import { extractKindBlock } from "../cli-json.js";
import type { MyclConfig } from "../config.js";
import { shouldParallelize } from "./independence.js";
import type { ModuleWork } from "./dispatch.js";

const DECOMPOSE_SYSTEM = [
  "You are a PLANNING assistant. Your ONLY job: split a feature request into independent modules.",
  "You MUST NOT write code, create files, run commands, or use ANY tools. Output a PLAN only.",
  "Each module has: a short id, DISJOINT scope_paths (NO two modules share any path or parent dir), a brief.",
  "Split ONLY if the modules are GENUINELY independent (no shared files). If coupled/small/unsure,",
  "return FEWER than 2 modules — serial build is fine, that is an acceptable answer.",
  "Respond with EXACTLY ONE JSON object and NOTHING ELSE — no prose, no code fences, no explanation:",
  '{"kind":"modules","modules":[{"id":"short-id","scope_paths":["src/x/"],"brief":"what to build here"}]}',
].join("\n");

/** LLM yanıtından modülleri ayıklar (SAF): JSON blok + şekil doğrulama. Geçersiz/eksik → atlanır. */
export function parseModulesResponse(text: string): ModuleWork[] {
  const block = extractKindBlock(text, ["modules"]);
  const raw = block?.modules;
  if (!Array.isArray(raw)) return [];
  const out: ModuleWork[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (
      typeof m.id === "string" &&
      Array.isArray(m.scope_paths) &&
      m.scope_paths.every((p) => typeof p === "string") &&
      typeof m.brief === "string"
    ) {
      out.push({ id: m.id, scope_paths: m.scope_paths as string[], brief: m.brief });
    }
  }
  return out;
}

/**
 * Özelliği ≥2 ayrık modüle bölmeyi DENER. LLM öneri → K1 kapısı doğrular. ≥2 GERÇEKTEN ayrık modül varsa
 * ModuleWork[] döner; aksi (bölemedi / ayrık değil / LLM hatası) → null → caller SERİ codegen yapar. FAIL-CLOSED.
 */
export async function proposeModules(
  config: MyclConfig,
  request: string,
  projectRoot: string,
): Promise<ModuleWork[] | null> {
  const res = await runClaudeCli({
    systemPrompt: DECOMPOSE_SYSTEM,
    userMessage: `Plan only — do NOT implement. Split this into independent modules:\n\n${request}`,
    modelId: config.selected_models.main,
    cwd: projectRoot,
    allowedTools: [], // salt akıl yürütme; yazma yok
    disallowedTools: ["Write", "Edit", "Bash", "NotebookEdit"], // belt-and-suspenders: kodlama moduna kaçamasın
  });
  if (!res.ok) return null;
  const modules = parseModulesResponse(res.text);
  const gate = shouldParallelize(modules, { enabled: true });
  return gate.parallel ? modules : null;
}
