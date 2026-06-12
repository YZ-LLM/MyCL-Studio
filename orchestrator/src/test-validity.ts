// test-validity — MUTASYON PROB'u (Ümit 2026-06-12: "güveni kökten sağlamlaştır"). Faz 8 testleri YEŞİL olduğunda,
// kodu küçük + davranışsal bir mutasyonla boz → testler KIRMIZIYA dönmeli. Dönmüyorsa testler o davranışı GERÇEKTEN
// sınamıyor = sahte-yeşil/zayıf test. Bu, "yeşil"e güvenin asıl panzehiridir: kullanıcı kodu okumadan güvenecekse,
// testlerin gerçekten koruduğunu KANITLAMALIYIZ. Mutasyon GARANTİLİ geri alınır (try/finally) — proje bozulmaz.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runReasoning } from "./llm-reasoning.js";
import { VERIFY_BEFORE_CLAIM } from "./agent-language.js";
import { log } from "./logger.js";
import type { MyclConfig } from "./config.js";

export interface MutationProbeResult {
  checked: boolean; // prob gerçekten koşturuldu mu (dosya+mutasyon bulundu)
  caught?: boolean; // testler mutasyonu yakaladı mı (true=sağlam, false=zayıf testler)
  file?: string;
  note: string;
}

const MUTATE_SYSTEM = [
  "You are a mutation-testing assistant. Given ONE source file, propose exactly ONE single-line change that ALTERS",
  "OBSERVABLE BEHAVIOR — so a CORRECT test suite would now FAIL. Good mutations: flip a boolean/condition, change a",
  "comparison operator, change a returned value/constant, off-by-one a bound. BAD mutations: editing comments, log",
  "strings, formatting, or dead code (those don't change behavior). Pick a line that clearly affects logic.",
  'Output EXACTLY ONE JSON object: {"old_line":"<exact line copied verbatim from the file, incl. indentation>","new_line":"<the mutated line>"}.',
  "old_line MUST appear in the file EXACTLY ONCE, verbatim. Keep syntax valid. No other text.",
  "",
  VERIFY_BEFORE_CLAIM,
].join("\n");

export function parseMutation(text: string): { old_line: string; new_line: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { old_line?: unknown; new_line?: unknown };
    if (typeof o.old_line === "string" && typeof o.new_line === "string" && o.old_line.trim() && o.old_line !== o.new_line) {
      return { old_line: o.old_line, new_line: o.new_line };
    }
  } catch {
    /* bozuk JSON */
  }
  return null;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Mutate edilebilir kaynak dosya seç (test/spec/üretilen dosyaları DIŞLA). */
export function pickCandidate(files: string[]): string | undefined {
  return files.find(
    (f) =>
      /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|rs)$/.test(f) &&
      !/\.(test|spec)\./i.test(f) &&
      !/(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(f) &&
      !/\.d\.ts$/.test(f),
  );
}

/**
 * Mutasyon prob'u: bir değişen kaynak dosyaya davranışsal mutasyon uygula, test komutunu koş, KIRMIZI bekle, GERİ AL.
 * runCmd = test çalıştırıcı (phase-8'in runCmdResult'ı geçilir). Hata-güvenli: her durumda dosyayı eski haline döndürür.
 */
export async function probeTestValidity(opts: {
  config: MyclConfig;
  projectRoot: string;
  testCmd: string;
  candidateFiles: string[];
  runCmd: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}): Promise<MutationProbeResult> {
  const file = pickCandidate(opts.candidateFiles);
  if (!file) return { checked: false, note: "mutate edilebilir kaynak dosya yok (yalnız test/üretilen dosya)" };
  const abs = join(opts.projectRoot, file);
  let orig: string;
  try {
    orig = await readFile(abs, "utf-8");
  } catch {
    return { checked: false, note: "aday dosya okunamadı" };
  }
  let mut: { old_line: string; new_line: string } | null = null;
  try {
    const r = await runReasoning(opts.config, {
      systemPrompt: MUTATE_SYSTEM,
      userMessage: `FILE: ${file}\n\n${orig.slice(0, 9000)}`,
      modelId: opts.config.selected_models.main,
      projectRoot: opts.projectRoot,
      effort: "low",
      maxTokens: 500,
    });
    if (r.ok) mut = parseMutation(r.text);
  } catch (e) {
    log.warn("test-validity", "mutasyon önerisi başarısız", e);
  }
  if (!mut || countOccurrences(orig, mut.old_line) !== 1) {
    return { checked: false, note: "geçerli tek-örnek davranışsal mutasyon üretilemedi (prob atlandı)" };
  }
  // GARANTİLİ revert: mutasyonu uygula → testi koş → her durumda eski içeriği geri yaz.
  try {
    await writeFile(abs, orig.replace(mut.old_line, mut.new_line), "utf-8");
    const res = await opts.runCmd(opts.testCmd);
    const caught = res.code !== 0; // testler FAIL → mutasyonu yakaladı (sağlam)
    return {
      checked: true,
      caught,
      file,
      note: caught
        ? "testler bozulan davranışı yakaladı — koruma gerçek"
        : "testler bozulan davranışı KAÇIRDI — testler zayıf/sahte-yeşil olabilir",
    };
  } catch (e) {
    log.warn("test-validity", "prob koşumu başarısız", e);
    return { checked: false, note: "prob koşulamadı" };
  } finally {
    await writeFile(abs, orig, "utf-8").catch((e) => log.error("test-validity", "REVERT başarısız — dosya mutasyonlu kalmış olabilir!", { file, e }));
  }
}
