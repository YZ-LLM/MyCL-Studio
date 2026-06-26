// cli-session — resume-yetenekli `claude` CLI çalıştırıcı (interaktif fazlar için).
//
// runClaudeCli tek-atıştır (--no-session-persistence). Faz-ortası askq gereken
// fazlar (qa-askq, production-schema approval, Faz 0 D2) için: ilk tur --session-id
// <uuid> ile başlatılır, ajan soru yazıp bitince MyCL kullanıcıya sorar, cevabı
// --resume <uuid> ile aynı oturuma geri besler. Her tur ayrı process (hata
// izolasyonu); oturum bağlamı claude'un kendi disk oturumunda taşınır.
//
// Abonelik: API key ENJEKTE EDİLMEZ (claudeSpawnEnv). cli-run.ts ile aynı parse;
// ek olarak onText (UI stream köprüsü) + observer (Faz 8 tool_use) callback'leri.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { MAIN_AGENT_LANGUAGE_REMINDER } from "./agent-language.js";
import { guardSandboxOrWarn, sandboxSettingsArgs } from "./agent-sandbox.js";
import {
  noteRateLimitEvent,
  noteCliRateLimitError,
  finalizeCliRateLimit,
  detectCliRateLimit,
  type RateLimitInfo,
} from "./cli-rate-limit.js";
import { claudeSpawnEnv, resolveClaudePath } from "./codegen/cli-backend.js";
import { shouldFolderGuard, wrapReadOnlyClaude } from "./claude-folder-guard.js";
import { recordTokenUsage } from "./ipc.js";
import { log } from "./logger.js";
import { withDangerousBashDeny } from "./tool-policy.js";

export interface CliSessionTurnOpts {
  /** Sabit oturum kimliği (faz-instance başına bir uuid, tüm turlar aynı). */
  sessionId: string;
  /** İlk tur false (--session-id); sonraki turlar true (--resume). */
  resume: boolean;
  /** İlk tur: görev metni; sonraki turlar: askq cevabı (EN). */
  userMessage: string;
  /** Sadece ilk turda --append-system-prompt olarak geçer. */
  systemPrompt?: string;
  modelId: string;
  cwd: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  effort?: string;
  maxBudgetUsd?: number;
  /** IDLE-timeout: bu süre boyunca HİÇ çıktı gelmezse öldür (her olayda sıfırlanır). */
  timeoutMs?: number;
  /** WALL-CLOCK cap: tek çağrı için sabit toplam-süre tavanı (olaylarla SIFIRLANMAZ);
   *  runaway/sonsuz-düşünme'yi keser. Verilmezse WALL_CLOCK_MAX_MS. <=0 → kapalı. */
  wallClockMs?: number;
  /** Assistant metin parçaları geldikçe (UI stream köprüsü). */
  onText?: (text: string) => void;
  /** Her tool_use için (Faz 8 observer köprüsü). */
  observer?: (toolUse: { name: string; input: Record<string, unknown> }) => void;
  /** claudeSpawnEnv ÜSTÜNE eklenecek ekstra env (cli-run.ts ile aynı): account-error → z.ai-CLI
   *  fallback'inde ANTHROPIC_BASE_URL/AUTH_TOKEN enjekte etmek için. claudeSpawnEnv ANTHROPIC_* döndürmez → temiz override. */
  extraEnv?: Record<string, string>;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface CliSessionResult {
  ok: boolean;
  text: string;
  toolUses: Array<{ name: string; input: Record<string, unknown> }>;
  turns: number;
  error?: string;
  /** result olayından alınan token kullanımı (faz-başına maliyet raporu için). */
  usage?: TokenUsage;
}

// IDLE timeout: YZLLM 2026-06-11 "sınırsız yap" → 0 idi; AMA 2026-06-12 Faz 9 18+ dk SONSUZ takıldı (resume-claude
// hung, hiç çıktı yok, 0 olduğu için asla ölmedi). İdle = ÇIKTI YOKLUĞU; `--include-partial-messages` her token
// delta'sında sıfırlar → AKTİF iş (yavaş thinking dahil) ASLA tetiklemez, yalnız 10 dk TAM SESSİZ (gerçek hang/
// deadlock) tetikler. Yani "yavaş işi öldürme" korunur, sonsuz takılma biter. Kill → fail → escalation/retry kurtarır.
const DEFAULT_TIMEOUT_MS = 600_000; // 10 dk hiç çıktı yok → hung → öldür (cömert; aktif iş token akıtır)
// WALL-CLOCK tavanı (YZLLM 2026-06-13): tek claude çağrısı en fazla bu kadar SÜREBİLİR — olaylarla
// sıfırlanmaz. idle-timer "sürekli düşünen" modeli kaçırıyordu (Faz 9 79 dk asılı); bu mutlak tavan keser.
// 30 dk: meşru uzun codegen'e (Faz 8) cömert, ama 79/133-dk pataolojiyi bounded yapar.
const WALL_CLOCK_MAX_MS = 1_800_000; // 30 dk

function buildArgs(opts: CliSessionTurnOpts): string[] {
  // v15.12: her main-ajan user mesajına İngilizce-çıktı hatırlatması (ilk + resume
  // + nudge). Recency: resume turlarında sistem prompt'u yeniden gönderilmez → tek
  // garanti bu. Çevirmen runClaudeCli kullanır (bunu DEĞİL) → yalnız main-ajan etkilenir.
  const args: string[] = ["-p", `${opts.userMessage}\n\n${MAIN_AGENT_LANGUAGE_REMINDER}`];
  if (opts.resume) {
    args.push("--resume", opts.sessionId);
  } else {
    args.push("--session-id", opts.sessionId);
    if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
  }
  args.push(
    "--model",
    opts.modelId,
    "--output-format",
    "stream-json",
    "--verbose",
    // v15.10: partial mesajlar — uzun thinking/sentez sırasında token delta'ları
    // stream'lenir → idle timer gerçek ilerlemede sıfırlanır, yalnız GERÇEK hang'de
    // (delta yok) tetiklenir. Çok-turlu qa-askq resume'unun sessiz asılmasını çözer.
    "--include-partial-messages",
    "--permission-mode",
    // v15.14 (YZLLM canlı-test 0620): `acceptEdits` Bash izin-prompt'unu önlemiyordu
    // (yalnız Write/Edit oto-onay) → borulu/bileşik Bash non-interaktif modda asılıyordu.
    // `bypassPermissions` prompt'u kaldırır; deny-list (opts.disallowedTools) deny kuralı
    // mode'dan ÖNCE değerlendirildiği için KORUNUR (salt-okunur fazların Write/Bash yasağı
    // dahil). Bkz cli-backend.ts aynı düzeltme + claude-code-guide protokol doğrulaması.
    "bypassPermissions",
    "--add-dir",
    opts.cwd,
  );
  // NOT: --no-session-persistence KOYMA — --resume oturumun diskte olmasını gerektirir.
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", ...opts.allowedTools);
  }
  // bypassPermissions ile birlikte: tehlikeli-Bash baseline'ı HER ZAMAN ekle (deny kuralı
  // mode'dan önce → rm/sudo/git-push/chmod/publish bloklu kalır; salt-okunur fazlarda zaten
  // Bash tümden yasaksa zararsız-fazlalık). Bkz tool-policy.DANGEROUS_BASH_DENY.
  args.push("--disallowedTools", ...withDangerousBashDeny(opts.disallowedTools));
  if (opts.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  }
  // v15.11 GÜVENLİK: --settings ile sandbox (+ ultracode) — ajanı opts.cwd'ye hapset.
  args.push(...sandboxSettingsArgs(opts.cwd, opts.effort === "ultracode"));
  if (opts.effort && opts.effort !== "ultracode") {
    args.push("--effort", opts.effort);
  }
  return args;
}

/**
 * Tek oturum-turu çalıştır (ilk veya resume). Tüm assistant metnini + tool_use'ları
 * toplar. Hata/timeout → { ok:false, error }.
 */
export function runClaudeCliSession(opts: CliSessionTurnOpts): Promise<CliSessionResult> {
  // v15.11 GÜVENLİK: spawn-öncesi sandbox kapısı (enforce + sandbox yok → çalıştırma).
  if (!guardSandboxOrWarn()) {
    return Promise.resolve({
      ok: false,
      text: "",
      toolUses: [],
      turns: 0,
      error: "sandbox kurulamadı (policy=enforce) — ajan çalıştırılmadı",
    });
  }
  const args = buildArgs(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const claudeBin = resolveClaudePath() ?? "claude";
  // YZLLM 2026-06-12 (TCC penceresi kökü): cli-session ATLANMIŞTI — folder-guard yalnız cli-run +
  // persistent-cli-session'a eklenmişti. Oysa cli-session translator + production-schema (Faz 2/3/4/7
  // ONAY fazları) + qa-askq + quality-audit + llm-reasoning'in backbone'u → onay fazlarında her claude
  // başlatıldığında klasör/medya TCC penceresi çıkıyordu. Bash YOK ise sandbox-exec ile sar (aynı karar).
  const spawnCmd = shouldFolderGuard({ allowedTools: opts.allowedTools })
    ? wrapReadOnlyClaude(claudeBin, args)
    : { cmd: claudeBin, args };

  return new Promise<CliSessionResult>((resolve) => {
    let settled = false;
    const texts: string[] = [];
    const toolUses: CliSessionResult["toolUses"] = [];
    let turns = 0;
    let resultIsError = false;
    let resultSeen = false;
    let resultErrorText = "";
    let stderrTail = "";
    let usage: TokenUsage | undefined;
    // YZLLM 2026-06-12 (#5 kör-nokta log): hang teşhisi için SON olayın türü + zamanı. Idle-timeout/close'ta
    // loglanır → "ne yaparken/hangi olaydan sonra sustu" görünür (Faz 9 18dk hang'inde bu bilgi YOKTU).
    let lastEventType = "none";
    let lastEventTs = Date.now();

    const child = spawn(spawnCmd.cmd, spawnCmd.args, {
      cwd: opts.cwd,
      // API key YOK → abonelik; PATH zenginleştirilir. extraEnv (varsa, z.ai-CLI fallback) ÜSTE eklenir.
      env: opts.extraEnv ? { ...claudeSpawnEnv(), ...opts.extraEnv } : claudeSpawnEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timer: ReturnType<typeof setTimeout>;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (r: CliSessionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (wallTimer) clearTimeout(wallTimer);
      try { child.kill("SIGTERM"); } catch { /* zaten bitti */ }
      resolve(r);
    };

    // IDLE-bazlı kill: her stdout/stderr satırında sıfırlanır → uzun ama aktif
    // tur (tool-yoğun review) öldürülmez; yalnızca timeoutMs boyunca HİÇ çıktı
    // gelmezse (gerçekten asılı) öldürür.
    const resetTimer = (): void => {
      clearTimeout(timer);
      if (timeoutMs <= 0) return; // sınırsız (YZLLM): idle-kill kapalı
      timer = setTimeout(() => {
        log.warn("cli-session", "idle timeout — killing claude (HANG teşhisi)", {
          timeoutMs,
          resume: opts.resume,
          model: opts.modelId,
          lastEventType, // son alınan stream olayı (assistant/result/rate_limit/none)
          msSinceLastEvent: Date.now() - lastEventTs, // son olaydan beri geçen süre (≈ sessizlik)
          turnsSoFar: turns,
          textChunks: texts.length,
          toolUsesSoFar: toolUses.length,
          stderrTail: stderrTail.slice(-300),
        });
        done({ ok: false, text: texts.join(""), toolUses, turns, usage, error: `cli idle timeout ${timeoutMs}ms` });
      }, timeoutMs);
    };
    resetTimer();

    // WALL-CLOCK cap (YZLLM 2026-06-13, Faz 9 79dk asılı kökü): idle-timer her stream
    // olayında (thinking-token dahil) SIFIRLANIR → sürekli "düşünen"/döngüye giren model
    // ASLA idle-out olmaz, saatlerce koşar. Bu timer spawn'da BİR kez kurulur, olaylarla
    // SIFIRLANMAZ → tek bir claude çağrısı wallClockMs'i aşamaz (runaway/sonsuz-düşünme tavanı).
    const wallClockMs = opts.wallClockMs ?? WALL_CLOCK_MAX_MS;
    if (wallClockMs > 0) {
      wallTimer = setTimeout(() => {
        log.warn("cli-session", "WALL-CLOCK cap — killing claude (runaway/sonsuz-düşünme)", {
          wallClockMs,
          model: opts.modelId,
          lastEventType,
          turnsSoFar: turns,
          toolUsesSoFar: toolUses.length,
        });
        done({
          ok: false,
          text: texts.join(""),
          toolUses,
          turns,
          usage,
          error: `cli wall-clock cap ${wallClockMs}ms aşıldı (olası sonsuz-düşünme/döngü)`,
        });
      }, wallClockMs);
    }

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      resetTimer();
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return; // NDJSON olmayan satır (banner) — atla
      }
      const type = ev.type;
      lastEventType = typeof type === "string" ? type : "unknown"; // #5: hang teşhisi
      lastEventTs = Date.now();
      if (type === "rate_limit_event") {
        // v15.12 Auto Mode: abonelik usage-limit + resetsAt sinyali.
        noteRateLimitEvent(ev.rate_limit_info as RateLimitInfo | undefined);
      } else if (type === "assistant") {
        const msg = ev.message as { content?: unknown[] } | undefined;
        for (const block of Array.isArray(msg?.content) ? msg!.content : []) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            texts.push(b.text);
            opts.onText?.(b.text);
          } else if (b.type === "tool_use") {
            const tu = {
              name: String(b.name ?? ""),
              input: (b.input as Record<string, unknown>) ?? {},
            };
            toolUses.push(tu);
            opts.observer?.(tu);
          }
        }
      } else if (type === "result") {
        resultSeen = true;
        resultIsError = ev.is_error === true || ev.subtype === "error";
        if (resultIsError) resultErrorText = String(ev.result ?? ev.error ?? "");
        if (typeof ev.num_turns === "number") turns = ev.num_turns;
        const u = ev.usage as Record<string, unknown> | undefined;
        if (u) {
          usage = {
            input_tokens: Number(u.input_tokens ?? 0),
            output_tokens: Number(u.output_tokens ?? 0),
            cache_read_input_tokens: Number(u.cache_read_input_tokens ?? 0),
            cache_creation_input_tokens: Number(u.cache_creation_input_tokens ?? 0),
          };
          // F1: faz-maliyet kovasını CLI modunda da doldur + gerçek $ + model (kova yoksa no-op).
          const costUsd = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined;
          recordTokenUsage({ ...usage, total_cost_usd: costUsd, model: opts.modelId });
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      // NOT: idle timer'ı SIFIRLAMA — stderr gürültüsü (rate-limit retry vb.)
      // gerçek bir stdout-hang'i maskelemesin. Canlılık sinyali yalnız stdout
      // (partial mesajlar dahil). Sadece tail'i tut (hata teşhisi).
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    child.on("error", (err) => {
      done({ ok: false, text: texts.join(""), toolUses, turns, error: `spawn failed: ${String(err)}` });
    });

    child.on("close", (code) => {
      const ok = code === 0 && (!resultSeen || !resultIsError);
      // Auto Mode: hata usage/rate-limit imzası taşıyorsa CLI'yi limitli işaretle (hata-yolu).
      if (!ok) {
        const rl = detectCliRateLimit(`${resultErrorText} ${stderrTail}`);
        if (rl) noteCliRateLimitError(rl);
      }
      // YZLLM 2026-06-11 "denesin zaten çalışacak": kararı çağrı SONUCUNA göre ver — başardıysa (overage karşıladı)
      // limitleme + eski limiti temizle; gerçekten başarısız + blocked-event görülmüşse ŞİMDİ API'ye geç.
      finalizeCliRateLimit(ok);
      done({
        ok,
        text: texts.join(""),
        toolUses,
        turns,
        usage,
        // Hata metni: resultErrorText (result event — account/kredi hatası BURADA gelir) + stderrTail.
        // İkisini de kat ki isApiAccountError sınıflandırması (z.ai fallback tetiği) "credit balance"i görsün.
        error: ok
          ? undefined
          : `claude exit=${code}` +
            (resultErrorText ? ` :: ${resultErrorText.slice(0, 300)}` : "") +
            (stderrTail ? ` :: ${stderrTail.slice(0, 300)}` : ""),
      });
    });
  });
}
