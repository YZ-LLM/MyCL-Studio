// cli-interactive-loop — faz-ortası askq gerektiren CLI fazlarının çekirdek döngüsü.
//
// Ajan görevini yapar; soru gerekince text-JSON askq bloğu yazıp biter → MyCL
// (onAskq) kullanıcıya sorar, cevabı --resume ile aynı oturuma geri besler → ajan
// final blok (terminalKinds'ten biri) yazana dek döngü. Blok parse edilemezse 1
// sıkı-nudge retry; yine olmazsa InteractiveCliError → caller görünür SDK fallback.
//
// qa-askq (Faz 1/2/9) + production-schema approval (Faz 3/4/7) bunu kullanır.
// Tek-atış / interaktif-olmayan fazlar (Faz 0 D1) doğrudan runClaudeCli kullanır.

import { extractKindBlock } from "./cli-json.js";
import { runClaudeCliSession } from "./cli-session.js";
import { log } from "./logger.js";

export class InteractiveCliError extends Error {
  override readonly name = "InteractiveCliError";
}

export interface InteractiveCliOpts {
  /** Faz-instance başına sabit uuid (tüm turlar aynı oturum). */
  sessionId: string;
  modelId: string;
  cwd: string;
  /** Base faz prompt + çıktı talimatı (caller hazırlar). */
  systemPrompt: string;
  initialUserMessage: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  effort?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** Toplam tur güvenlik sınırı (askq + final). Aşılırsa hata. */
  maxTurns: number;
  /** Bu kind gelince loop biter, blok döner (örn. ["complete","approval","abandon"]). */
  terminalKinds: readonly string[];
  /** Bu kind gelince onAskq çağrılır (genelde "askq"). */
  askqKind: string;
  /** askq bloğu → kullanıcı cevabı (EN). Backend submitAskqAnswer'a bağlar. */
  onAskq: (block: Record<string, unknown>) => Promise<string>;
  onText?: (t: string) => void;
  observer?: (tu: { name: string; input: Record<string, unknown> }) => void;
  /** Log/stream etiketi (örn. "cli-phase-1"). */
  label: string;
}

const STRICT_NUDGE =
  "WARNING: No valid JSON decision/question block was found in your previous output. This time write " +
  "ONLY a single valid JSON object (may be inside a ```json block), no other text. " +
  "The `kind` field is required.";

/**
 * Interaktif CLI fazını koştur; terminal blok döner. askq → onAskq → resume.
 * Parse başarısız → 1 nudge retry → InteractiveCliError.
 */
export async function runInteractiveCliLoop(
  opts: InteractiveCliOpts,
): Promise<Record<string, unknown>> {
  const allKinds = [opts.askqKind, ...opts.terminalKinds];
  let resume = false;
  let userMessage = opts.initialUserMessage;
  let nudgedThisTurn = false;

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    const res = await runClaudeCliSession({
      sessionId: opts.sessionId,
      resume,
      userMessage,
      systemPrompt: resume ? undefined : opts.systemPrompt,
      modelId: opts.modelId,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      effort: opts.effort,
      maxBudgetUsd: opts.maxBudgetUsd,
      timeoutMs: opts.timeoutMs,
      onText: opts.onText,
      observer: opts.observer,
    });
    if (!res.ok) {
      throw new InteractiveCliError(`${opts.label}: CLI turu başarısız — ${res.error ?? "bilinmeyen"}`);
    }

    const block = extractKindBlock(res.text, allKinds);
    if (block === null) {
      // Blok yok → bir kez sıkı-nudge ile resume; yine yoksa hata.
      if (nudgedThisTurn) {
        log.warn(opts.label, "JSON blok yok (nudge sonrası da) — fallback", {
          tail: res.text.slice(-300),
        });
        throw new InteractiveCliError(`${opts.label}: geçerli JSON blok üretilemedi`);
      }
      nudgedThisTurn = true;
      resume = true;
      userMessage = STRICT_NUDGE;
      log.warn(opts.label, "JSON blok yok — nudge retry", {});
      continue;
    }
    nudgedThisTurn = false;

    if (block.kind === opts.askqKind) {
      log.info(opts.label, "askq bloğu — kullanıcıya soruluyor", { turn });
      const answerEn = await opts.onAskq(block); // submitAskqAnswer köprüsü
      resume = true;
      userMessage = answerEn;
      continue;
    }

    // terminalKinds'ten biri → bitir.
    log.info(opts.label, "terminal blok", { turn, kind: block.kind });
    return block;
  }

  throw new InteractiveCliError(
    `${opts.label}: maxTurns (${opts.maxTurns}) aşıldı — terminal bloğa ulaşılamadı`,
  );
}
