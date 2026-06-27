// agent-trace — ajanların TAM aktivite izi (kör nokta kalmasın). Orkestratör + paralel worker'lar + (gerçek)
// Agent Teams müzakeresi. `emitAgentEvent` UI'ya EPHEMERAL gösterir; burası KALICI ize yazar (.mycl/traces/
// agents.jsonl) → oturum sonrası tam inceleme. Non-blocking (iz yazımı asla akışı durdurmaz). O_APPEND atomik →
// eşzamanlı worker yazımları satır-seviyesinde karışmaz.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";

const TRACE_REL = ".mycl/traces/agents.jsonl";

// Aktif proje kökü (open_project'te set edilir). Worker'lar/ipc projeRoot taşımadan iz yazabilsin diye modül-state.
let traceRoot: string | null = null;

/** open_project'te çağrılır — izin yazılacağı proje. null → iz kapalı. */
export function setAgentTraceRoot(root: string | null): void {
  traceRoot = root;
}

export interface AgentTraceRecord {
  ts: number;
  /** Hangi ajan (örn. "Mimari"/modül id). Orkestratörün kendi olaylarında boş olabilir. */
  agent_label?: string;
  /** YZLLM 2026-06-27: takım/grup + faz (Ajan Takımı görünürlüğü; started olayında verilir). */
  agent_group?: string;
  phase?: number;
  sub: "started" | "completed" | "tool_use" | "decision" | "output" | "error";
  turn?: number;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  decision?: Record<string, unknown>;
  text?: string;
  error?: string;
}

/** Bir ajan-olayını kalıcı ize ekler. Kök set değilse / hata → sessiz no-op (gözlemlenebilirlik akışı durmaz). */
export async function traceAgentEvent(rec: AgentTraceRecord): Promise<void> {
  if (!traceRoot) return;
  try {
    const p = join(traceRoot, TRACE_REL);
    await mkdir(dirname(p), { recursive: true });
    await appendFile(p, JSON.stringify(rec) + "\n");
  } catch {
    // iz yazımı asla blocking değil
  }
}

/** İzi okur (inceleme/test). Dosya yoksa / bozuk satır → atlanır. */
export async function readAgentTrace(projectRoot: string): Promise<AgentTraceRecord[]> {
  let raw: string;
  try {
    raw = await readFile(join(projectRoot, TRACE_REL), "utf-8");
  } catch {
    return [];
  }
  const out: AgentTraceRecord[] = [];
  for (const line of raw.split("\n").filter((l) => l.trim())) {
    try {
      out.push(JSON.parse(line) as AgentTraceRecord);
    } catch {
      // bozuk satır atla
    }
  }
  return out;
}
