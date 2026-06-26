// adversarial-test — BAĞIMSIZ düşman-test yazarı (YZLLM 2026-06-12: "güveni kökten sağlamlaştır"). Faz 8'de testi
// YAZAN ile kodu yazan AYNI ajan → taraflı testler (yazdığını test eder, kırmaya çalışmaz). Bu modül AYRI bir ajan
// çağırır: amacı kodu spec'in AC'lerine karşı KIRMAK — edge/sınır/hata-yolu/eşzamanlılık testleri yazıp koşar,
// gerçek bir AC ihlali bulursa bildirir. Bulgular GÖRÜNÜR + audit'lenir (sahte-yeşili bağımsız gözle yakalar).
// Yazdığı testler projede KALIR (kalıcı düşman-kapsam). Sandbox'lı (cli-run --settings); proje-dışına çıkamaz.

import { readFile } from "node:fs/promises";
import { runClaudeCli } from "./cli-run.js";
import { currentSpecPath } from "./devs-paths.js";
import { SUBAGENT_SPAWN_TOOLS } from "./tool-policy.js";
import { backendForRole } from "./config.js";
import { VERIFY_BEFORE_CLAIM } from "./agent-language.js";
import { appendAudit } from "./audit.js";
import { emitChatMessage } from "./ipc.js";
import { log } from "./logger.js";
import type { MyclConfig } from "./config.js";
import type { State } from "./types.js";

export interface AdversarialResult {
  ran: boolean;
  broke?: boolean; // gerçek bir AC ihlali bulundu mu
  failures?: string[];
  note: string;
}

const ADVERSARIAL_SYSTEM = [
  "You are an INDEPENDENT adversarial test engineer — you did NOT write the code under test, and your ONLY goal is",
  "to BREAK it against the acceptance criteria (AC) in the spec. The original tests may be biased (written by the",
  "same agent that wrote the code), so write DIFFERENT tests: edge cases, boundary values, empty/null/huge/unicode",
  "inputs, error/failure paths, authorization bypass attempts, off-by-one, concurrency where relevant.",
  "",
  "Steps: (1) read the spec ACs and the relevant source under test; (2) write a SMALL focused set of adversarial",
  "tests (in the project's existing test framework/dir) targeting the riskiest ACs; (3) RUN them with the project's",
  "test command via Bash; (4) report ONLY genuine AC violations (a test that fails because the CODE is wrong, NOT",
  "because your test is wrong or tests out-of-spec behavior).",
  "",
  'After running, emit EXACTLY ONE JSON object as the LAST thing: {"broke":true|false,"failures":["<AC ref + what concretely broke>"]}.',
  "If everything holds under adversarial testing, broke=false, failures=[]. Keep tests valid and runnable.",
  "",
  VERIFY_BEFORE_CLAIM,
].join("\n");

export function parseAdversarialVerdict(text: string): { broke: boolean; failures: string[] } | null {
  // SON JSON bloğunu al (ajan önce düşünüp sonra verdict basar).
  const matches = [...text.matchAll(/\{[\s\S]*?\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(matches[i][0]) as { broke?: unknown; failures?: unknown };
      if (typeof o.broke === "boolean") {
        return {
          broke: o.broke,
          failures: Array.isArray(o.failures) ? o.failures.filter((x): x is string => typeof x === "string").slice(0, 8) : [],
        };
      }
    } catch {
      /* sonraki adaya geç */
    }
  }
  return null;
}

/**
 * Bağımsız düşman-test yazarı koş. backend=cli → claude (Read/Write/Edit/Bash, sandbox'lı). Spec yoksa/üretemezse
 * ran:false (sessiz). Gerçek AC ihlali bulursa görünür uyarı + `adversarial-test-fail` audit (Faz 9 + kullanıcı ele alır).
 */
export async function runAdversarialTester(state: State, config: MyclConfig): Promise<AdversarialResult> {
  let spec: string;
  try {
    spec = await readFile(currentSpecPath(state), "utf-8");
  } catch {
    return { ran: false, note: "spec yok — düşman testi atlandı" };
  }
  if (backendForRole(config, "main") !== "cli") {
    // API yolu da desteklenir ama düşman-test Write/Bash gerektirir; şimdilik CLI/abonelik yolunda koşar.
    return { ran: false, note: "düşman testi yalnız CLI/abonelik yolunda (Write/Bash gerekir)" };
  }
  emitChatMessage("system", "🧪 Bağımsız düşman testi yazarı — kodu yazan DEĞİL ayrı bir ajan, kodu KIRMAYA çalışan testler yazıp koşuyor…");
  let r: Awaited<ReturnType<typeof runClaudeCli>>;
  try {
    r = await runClaudeCli({
      systemPrompt: ADVERSARIAL_SYSTEM,
      userMessage: `SPEC (acceptance criteria to attack):\n${spec.slice(0, 12000)}\n\nWrite + run adversarial tests now; then emit the JSON verdict.`,
      modelId: config.selected_models.main,
      cwd: state.project_root,
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      disallowedTools: [...SUBAGENT_SPAWN_TOOLS], // test'i KENDİ yazar/koşar; alt-ajan doğurmasın (kaçış + 200+sn donma)
      timeoutMs: 600_000, // YZLLM 2026-06-12: 10 dk idle (çıktı yoksa) — hung'u kurtar; aktif test yazımı/koşumu çıktı akıtır, ölmez
    });
  } catch (e) {
    log.warn("adversarial-test", "çağrı başarısız", e);
    return { ran: false, note: "düşman testi ajanı çalışamadı" };
  }
  if (!r.ok) return { ran: false, note: `düşman testi ajanı hata: ${r.error ?? "?"}` };
  const v = parseAdversarialVerdict(r.text);
  if (!v) return { ran: false, note: "düşman testi verdict'i üretilemedi" };
  if (!v.broke) {
    emitChatMessage("system", "✅ Bağımsız düşman testi: kod saldırı testlerine dayandı — AC ihlali bulunamadı.");
    return { ran: true, broke: false, note: "dayandı" };
  }
  await appendAudit(state.project_root, {
    ts: Date.now(),
    phase: 8,
    event: "adversarial-test-fail",
    caller: "mycl-orchestrator",
    detail: `independent adversarial tester broke ACs: ${v.failures.join(" | ").slice(0, 200)}`,
  });
  emitChatMessage(
    "system",
    "⚠️ Bağımsız düşman testi bir AC ihlali BULDU (kodu yazan ajanın gözden kaçırdığı):\n" +
      v.failures.map((f) => `• ${f}`).join("\n") +
      "\nFaz 9 risk incelemesi + sen bunu ele alın — testler 'geçti' dese de bu durum kapsanmıyor.",
  );
  return { ran: true, broke: true, failures: v.failures, note: "AC ihlali bulundu" };
}
