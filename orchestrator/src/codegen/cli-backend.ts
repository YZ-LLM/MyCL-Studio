// codegen/cli-backend — Claude Code CLI (`claude -p`) tabanlı codegen backend.
//
// v15.8 (2026-05-30): Flag açıkken (Settings → Özellikler → Claude Code CLI)
// codegen fazları (Phase 5 + verify-feature + Phase 8 + parallel-module + gate-autofix)
// main ajanı SDK turn-loop yerine
// `claude` CLI subprocess'i ile çalıştırır.
//
// Gerçek bayraklar (claude 2.1.141 ile doğrulandı):
//   -p / --print, --model, --effort (low/medium/high/xhigh/max),
//   --settings '{"ultracode":true}' (ultracode efor seviyesi DEĞİL — ayrı ayar),
//   --output-format stream-json --verbose, --permission-mode, --add-dir,
//   --allowedTools/--disallowedTools, --no-session-persistence,
//   --append-system-prompt. (v15.9: --max-budget-usd KALDIRILDI — gerekli
//   codegen'i kesiyordu; maliyet sınırı bu sürümde YOK, --max-turns de YOK.)
//
// Güvenlik (SDK bash-guard/path-sandbox paritesi KISMİ): cwd=project_root +
// --add-dir <project_root> ile dosya erişimi sınırlı; --disallowedTools ile
// tehlikeli bash reddedilir; env safeEnv() (API key ENJEKTE EDİLMEZ → abonelik
// OAuth/keychain). --bare KULLANILMAZ: claude --help'e göre "OAuth and keychain
// are never read" — aboneliği kırardı (kullanıcı API key'siz CLI kullanıyor).
// İnce write-deny (.mycl/ vb.) tam birebir değil — not.
//
// UYARI: stream-json olay şeması + permission-mode davranışı CANLI doğrulama
// ister (gerçek `claude -p` koşumu, LLM maliyeti). Parser defansif yazıldı.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { MAIN_AGENT_LANGUAGE_REMINDER } from "../agent-language.js";
import { guardSandboxOrWarn, sandboxSettingsArgs } from "../agent-sandbox.js";
import {
  noteRateLimitEvent,
  noteCliRateLimitError,
  detectCliRateLimit,
  type RateLimitInfo,
} from "../cli-rate-limit.js";
import type { CodegenOutcome, CodegenRunOpts } from "../base/codegen-controller.js";
import type { CodegenBackend } from "./backend.js";
import { killProcessTree } from "../dev-server-launcher.js";
import { appendAudit } from "../audit.js";
import { emitChatMessage, emitClaudeStream, recordTokenUsage } from "../ipc.js";
import { resolveCodebaseMemoryMcpConfig } from "../codebase-memory-setup.js";
import { resolveCogneeMcpConfig } from "../cognee-setup.js";
import { log } from "../logger.js";
import { globalConfigDir } from "../paths.js";
import { dedupePathValue, safeEnv } from "../safe-env.js";
import { withDangerousBashDeny } from "../tool-policy.js";
import { extractTokenUsage } from "../cli-json.js";

/** Tehlikeli bash → CLI --disallowedTools (tek kaynak: tool-policy.DANGEROUS_BASH_DENY).
 * bypassPermissions ile birlikte deny kuralı mode'dan önce → rm/sudo/git-push/chmod/publish bloklu. */
// PARİTE (mahkeme denetimi 2026-07-11): diğer 3 builder withDangerousBashDeny(...) sarmalayıcısından geçer; burası
// çıplak sabiti push'luyordu → sarmalayıcı sertleştirilirse codegen sessizce almazdı. Bugün davranış birebir aynı
// (per-call liste yok → yalnız baseline döner); sarmalayıcıya bağlanmak gelecek sertleştirmeyi otomatik kapsar.
const DISALLOWED_TOOLS = withDangerousBashDeny(undefined);

/** Codegen'in ihtiyaç duyduğu araçlar (auto-approve allowlist). */
const ALLOWED_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];

// ZAMAN-KAYBI PLANI (YZLLM 2026-07-07): CLI codegen'de HİÇBİR timer YOKTU (cli-backend eski notu: "--max-turns YOK")
// → gerçek veri: Faz 8 medyan 12dk ama MAX 288dk (4.8 saat) sınırsız thrashing. cli-run.ts'teki KANITLANMIŞ deseni
// (idle reset-on-output + set-once wall-clock) porto ediyoruz. idle = TAM SESSİZLİK (hung); wall-clock = aktif ama
// patolojik uzun. Eşikler medyan×5-8 pay: normal codegen'e ASLA dokunmaz, yalnız patolojiyi keser. Tavan SESSİZ
// DEĞİL: görünür banner + `codegen-budget-cap` audit + {kind:"done"} → fazın kendi doğrulaması (Faz 8 anchor / Faz 5
// dev-server+CSP) GERÇEK durumu belirler (correct-by-construction hakem; eksik iş LOUD fail eder, KATI #4).
// idle = TAM ÇIKTI-YOK süresi. cli-run.ts (salt-okunur analiz) 10dk kullanır; AMA codegen ajanı `npm install`/`npm
// test`i tek Bash çağrısında koşar → o sürede stream'e HİÇBİR olay düşmez (install ~10dk sürebilir, Faz 5 install
// timeout'u 600s). 10dk idle meşru bir build'i kesebilirdi → codegen'e daha cömert 15dk (build'i rahat aşar, gerçek
// hung'ı yine yakalar; runaway'i zaten wall-clock keser). Correct-by-construction: meşru işi ASLA kesme.
const CODEGEN_IDLE_MS = 900_000; // 15 dk tam çıktı-yok → hung → sonuçlandır

/** Codegen wall-clock tavanı — faz-türüne göre (tag). Medyan×5-8 pay. */
export function codegenWallClockMs(tag: string): number {
  if (tag === "phase-8") return 90 * 60_000; // TDD codegen (medyan ~12dk, patoloji 288dk)
  if (tag === "phase-5") return 60 * 60_000; // UI codegen (kod-yorumu: 133dk runaway)
  return 30 * 60_000; // verify-feature / gate-autofix / parallel-module
}

/** Banner için okunur faz etiketi (tag → TR). */
function codegenPhaseLabel(tag: string): string {
  if (tag === "phase-8") return "Faz 8 (TDD kod üretimi)";
  if (tag === "phase-5") return "Faz 5 (UI kod üretimi)";
  return `Kod üretimi (${tag})`;
}

// undefined = henüz çözülmedi; null = bulunamadı; string = mutlak yol.
let claudePathCache: string | null | undefined;

/**
 * `claude` CLI'ın MUTLAK yolunu çöz. Paketlenmiş .app Finder'dan açılınca PATH
 * minimaldir (`/usr/bin:/bin`...) ve `claude` standart kurulumda `~/.local/bin`'de
 * → düz `command -v claude` (minimal PATH) onu BULAMAZ. Bilinen konumlar + login
 * shell fallback ile sağlam çöz. Sonuç process boyunca cache'lenir.
 */
export function resolveClaudePath(): string | null {
  if (claudePathCache !== undefined) return claudePathCache;
  const home = homedir();
  const candidates = [
    join(home, ".local", "bin", "claude"), // resmi installer (claude.ai/install.sh)
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      claudePathCache = c;
      return c;
    }
  }
  // Login shell fallback — kullanıcı profili (nvm/asdf/özel PATH) yüklensin.
  for (const shell of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (!existsSync(shell)) continue;
    try {
      const out = execSync(`${shell} -lc 'command -v claude'`, {
        timeout: 3000,
        encoding: "utf-8",
      }).trim();
      if (out && existsSync(out)) {
        claudePathCache = out;
        return out;
      }
    } catch {
      /* bu shell başarısız — sıradakini dene */
    }
  }
  claudePathCache = null;
  return null;
}

/** `claude` CLI erişilebilir mi? (resolveClaudePath != null) */
export function isClaudeAvailable(): boolean {
  return resolveClaudePath() !== null;
}

/**
 * `claude` spawn'ı için env: safeEnv() + claude'un bulunduğu dizin ve bilinen bin
 * konumları PATH'in başına eklenir → claude kendi alt-process'lerini (node, rg)
 * ve kendini bulabilsin. API key ENJEKTE EDİLMEZ → abonelik (oauthAccount).
 */
// v15.14 (F2): prompt cache ömrü — modül-singleton (setSandboxPolicy deseni). index.ts
// config yüklenince setCacheTtl ile set eder; claudeSpawnEnv "1h"de ENABLE_PROMPT_CACHING_1H
// enjekte eder (CLI/abonelik yolu; 3 spawn noktası bu env'i kullanır → tek nokta, threadleme yok).
let _cacheTtl: "5m" | "1h" = "5m";
export function setCacheTtl(ttl: "5m" | "1h" | undefined): void {
  _cacheTtl = ttl === "1h" ? "1h" : "5m";
}

export function claudeSpawnEnv(): NodeJS.ProcessEnv {
  const base = safeEnv();
  const home = homedir();
  const resolved = resolveClaudePath();
  const extras = [
    resolved ? dirname(resolved) : "",
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter(Boolean);
  const prev = base.PATH ?? "";
  return {
    ...base,
    // dedupe: extras zaten PATH'te olabilir; E2BIG öz-iyileştirmesiyle tutarlı (safe-env).
    PATH: dedupePathValue([...extras, prev].filter(Boolean).join(":")),
    LC_ALL: "C",
    // v15.14 (macOS izin pencereleri): claude'un IDE/tarayıcı oto-bağlanma taraması
    // (DevToolsActivePort: Chrome/Brave/Edge + kurulu-uygulama enumerasyonu) macOS TCC'de
    // "başka uygulama verisi / Downloads / Apple Music" izinlerini tetikliyordu. MyCL claude'u
    // HEADLESS sürüyor — IDE'ye bağlanmaya/gereksiz trafiğe İHTİYACI YOK → ikisini de kapat
    // (claude env'le sorunsuz çalışıyor, doğrulandı). Tarama olmadan TCC prompt'u çıkmaz.
    CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Dosya-ekleme (attachment) taraması claude'un KR7 fonksiyonuyla ~/Desktop, ~/Documents,
    // ~/Downloads haritasını kurup dokunuyor → macOS "Belgeler/İndirilenler" izni soruyor. MyCL
    // claude'a dosya-ekleme yaptırmıyor (proje yolu zaten cwd/--add-dir) → kapat (claude çalışır,
    // doğrulandı ATTACH_OK). Klasör taramasını kaynağında keser.
    CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
    // F2: 1 saatlik prompt cache (yalnız "1h"de; aksi env'e KOYMA = 5dk varsayılan).
    ...(_cacheTtl === "1h" ? { ENABLE_PROMPT_CACHING_1H: "1" } : {}),
  };
}

/**
 * agent-skills dizini tespiti (`<config>/agent-skills`).
 *
 * Skills'i AÇIKÇA --plugin-dir ile bağlarız: kullanıcının global plugin
 * setine bağımlı olmadan MyCL'in agent-skills'ini deterministik yükler.
 * 2026-06-09 (YZLLM: "sadece önermesin, bağlasın"): kurulum OTOMATİK —
 * open_project'te `skills-setup.ensureAgentSkills` pinli commit'ten kurar
 * (eski "auto-clone yok" kararı YZLLM talimatıyla tersine döndü; risk pinle sınırlı).
 */
export function resolveSkillsDir(): string | null {
  try {
    const dir = join(globalConfigDir(), "agent-skills");
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** skills ipucu process başına bir kez gösterilsin (spam yok). */
let skillsHintShown = false;

/**
 * codebase-memory-mcp tool-kullanım ipucu (EN — codegen ajanı İngilizce çalışır). Faz system-prompt'una BİRLEŞTİRİLİR
 * (ayrı ikinci --append-system-prompt DEĞİL — Claude Code'da son-kazanır/overwrite). Yoksa tool'lar görünür ama proaktif
 * index_repository çağrılmaz → değer realize olmaz.
 */
const CODEBASE_MEMORY_HINT =
  "A codebase-memory MCP server is available (tools: mcp__codebase-memory__index_repository, search_graph, " +
  "get_architecture, trace_path, semantic_query). To understand existing code STRUCTURE (call chains, imports, " +
  "routes, dead code), call index_repository(repo_path=<project root>) ONCE, then query these tools INSTEAD of " +
  "grepping file-by-file — far fewer tokens. Fall back to Read/Grep only if a structural query returns nothing.";

/**
 * cognee kalıcı hafıza tool-kullanım ipucu (EN). Faz system-prompt'una BİRLEŞTİRİLİR (ayrı --append-system-prompt DEĞİL).
 */
const COGNEE_HINT =
  "A cognee persistent-memory MCP server is available (tools: mcp__cognee__recall, mcp__cognee__remember, " +
  "mcp__cognee__forget). It holds cross-session knowledge about THIS project (past decisions, what worked/failed). " +
  "BEFORE non-trivial work, call recall(...) to surface relevant prior experience and avoid repeating past mistakes. " +
  "AFTER a key architectural decision or a fix that resolved a real problem, call remember(...) with a concise note so " +
  "future sessions learn. Keep remember to genuinely reusable learnings — each call runs entity extraction (not free).";

/**
 * SAF (test edilebilir): etkin MCP server'larını TEK `--mcp-config`'e toplar + hint'lerini faz system-prompt'una
 * BİRLEŞTİRİR. KRİTİK (mahkeme 2026-07-13): (1) hint'ler AYRI `--append-system-prompt` OLMAZ — bu bayrak Claude Code'da
 * son-kazanır (overwrite) → faz talimatını EZERDİ; TEK değere katılır. (2) Çoklu MCP config TEK `--mcp-config` altında
 * VARIADIC verilir (İKİ ayrı `--mcp-config` bayrağı da son-kazanır tuzağına düşebilir). servers boş → değişmez.
 */
export function applyMcpServerArgs(
  systemPrompt: string,
  servers: Array<{ configPath: string; hint: string }>,
): { systemPrompt: string; mcpArgs: string[] } {
  if (servers.length === 0) return { systemPrompt, mcpArgs: [] };
  return {
    systemPrompt: `${systemPrompt}\n\n${servers.map((s) => s.hint).join("\n\n")}`,
    mcpArgs: ["--mcp-config", ...servers.map((s) => s.configPath), "--strict-mcp-config"],
  };
}

export class CliCodegenBackend implements CodegenBackend {
  private child: ChildProcess | null = null;
  private aborted = false;
  private lastTextTail = ""; // 529 imzası assistant-text'te (stderr'de değil); run-başı sıfırlanır, fail-reason'da kullanılır

  constructor(private readonly opts: CodegenRunOpts) {}

  abort(): void {
    this.aborted = true;
    if (this.child && this.child.pid) {
      try {
        // detached → claude grup-lideri → killProcessTree(-pid) claude + TÜM alt sürecini (ajanın
        // başlattığı arka-plan dev-server dahil) öldürür → abort'ta orphan/port-çakışması kalmaz.
        killProcessTree(this.child.pid);
      } catch (err) {
        log.warn("cli-backend", "abort kill failed", err);
      }
    }
  }

  async run(): Promise<CodegenOutcome> {
    const { opts } = this;
    // v15.11 GÜVENLİK: spawn-öncesi sandbox kapısı (enforce + sandbox yok → çalıştırma).
    if (!guardSandboxOrWarn()) {
      return { kind: "failed", reason: "sandbox kurulamadı (policy=enforce) — codegen çalıştırılmadı" };
    }
    const effort = opts.effortOverride ?? opts.config.claude_code_flags.effort ?? "max";
    const args = this.buildArgs(effort);

    const skillsDir = resolveSkillsDir();
    if (skillsDir) {
      log.info("cli-backend", "agent-skills bound", { dir: skillsDir });
    } else if (!skillsHintShown) {
      skillsHintShown = true;
      emitChatMessage(
        "system",
        "💡 agent-skills henüz kurulmamış (otomatik kurulum proje açılışında dener; başarısızsa elle):\n`git clone https://github.com/addyosmani/agent-skills ~/.mycl/agent-skills`",
      );
    }

    log.info("cli-backend", "spawning claude CLI", {
      tag: opts.tag,
      model: opts.modelId,
      effort,
      cwd: opts.state.project_root,
    });
    emitClaudeStream({
      sub: "init",
      text: `cli-${opts.tag}`,
      model: opts.modelId,
      cwd: opts.state.project_root,
    });
    emitChatMessage(
      "system",
      `🤖 Claude Code CLI çalıştırılıyor (model: ${opts.modelId}, efor: ${effort})…`,
    );

    return new Promise<CodegenOutcome>((resolve) => {
      // Mutlak yol — minimal PATH'te bare "claude" ENOENT verir (paketlenmiş .app).
      const claudeBin = resolveClaudePath() ?? "claude";
      const child = spawn(claudeBin, args, {
        cwd: opts.state.project_root,
        // v15.8: API key ENJEKTE EDİLMEZ → abonelik (oauthAccount); PATH zenginleştirilir
        // (claudeSpawnEnv) ki claude kendi alt-process'lerini bulsun.
        env: claudeSpawnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        // STRAY-CLEANUP (YZLLM 2026-06-19): detached → claude PROCESS-GROUP LİDERİ olur. Ajan Bash'te
        // (kuralları çiğneyip) arka-plan dev-server başlatırsa o GRANDCHILD claude'un grubuna girer →
        // close/abort'ta killProcessTree(-pid) GRUBU (orphan dahil) öldürür. dev-server-launcher ile aynı
        // desen. piped stdio + detached güvenli (terminal devralma yok). (Linux'ta da bwrap içi grup korunur.)
        detached: true,
      });
      this.child = child;

      let resultIsError = false;
      let resultSeen = false;
      this.lastTextTail = ""; // bu run için 529-text kuyruğunu sıfırla (YZLLM 2026-06-17)
      let numTurns = 0;
      let stderrTail = "";

      // ZAMAN-KAYBI PLANI (YZLLM 2026-07-07): idle + wall-clock timer'ları (cli-run.ts deseni). `settled` guard →
      // tek çözüm; finish() timer'ları temizler + grubu öldürür + tek kez resolve eder (çift-resolve yok).
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout>;
      let wallTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: CodegenOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        if (wallTimer) clearTimeout(wallTimer);
        // STRAY-CLEANUP: claude grup-lideri → -pid grubu (orphan grandchild dev-server dahil) öldürür.
        if (child.pid) {
          try {
            killProcessTree(child.pid);
          } catch (err) {
            log.warn("cli-backend", "finish kill failed", err);
          }
        }
        this.child = null;
        emitClaudeStream({ sub: "stop", text: `cli-${opts.tag} done` });
        // ABORT HER ZAMAN KAZANIR (mahkeme bulgusu): timer (onCap→done) ile abort() dar yarışında — abort() bu
        // sürüde settled/timer'a dokunmaz — kullanıcı abort'u yanlışlıkla {kind:"done"}'a düşmesin (rollback+
        // "phase-8-aborted" yolu korunur). this.aborted senkron set edildiğinden burada güvenle kontrol edilir.
        resolve(this.aborted && outcome.kind !== "aborted" ? { kind: "aborted", turns: numTurns } : outcome);
      };

      // Bütçe tavanı → GÖRÜNÜR sonuçlandır (sessiz kesme YOK, KATI #4). {kind:"done"} → fazın kendi doğrulaması
      // (Faz 8 anchor / Faz 5 dev-server+CSP) gerçek durumu belirler. Yazılan dosyalar diskte kalır (--no-session-
      // persistence yalnız konuşmayı kaybeder) → yeniden koşuda kaldığı yerden. numTurns closure'dan (fire anındaki).
      const onCap = (which: "idle" | "wall", ms: number): void => {
        if (settled) return; // kapanış zaten sonuçlandırdıysa (89:59'da doğal bitiş) yanlış "tavan" banner/audit üretme (mahkeme bulgusu — settled-guard tutarlılığı)
        const min = Math.round(ms / 60_000);
        const label = codegenPhaseLabel(opts.tag);
        log.warn("cli-backend", `codegen ${which}-cap — force-conclude`, { tag: opts.tag, ms, turns: numTurns });
        emitChatMessage(
          "system",
          which === "wall"
            ? `⏱️ ${label} ${min} dk bütçe tavanına ulaştı (olası takılma/sonsuz döngü) — mevcut haliyle sonuçlandırılıyor; MyCL final testi gerçek durumu belirleyecek. (Yazılan dosyalar diskte kalır.)`
            : `⏱️ ${label} ${min} dk boyunca hiç çıktı üretmedi (takılma) — mevcut haliyle sonuçlandırılıyor; MyCL final testi gerçek durumu belirleyecek.`,
        );
        void appendAudit(opts.state.project_root, {
          ts: Date.now(),
          phase: opts.state.current_phase,
          event: "codegen-budget-cap",
          caller: "mycl-orchestrator",
          detail: `${opts.tag} ${which}-cap ${min}dk (turns=${numTurns})`,
        }).catch((e) => log.warn("cli-backend", "budget-cap audit yazılamadı", e));
        // capped:true → kendi doğrulaması OLMAYAN caller (module-parallel worker) fail-closed olsun (doğrulanmamış
        // modül sessizce merge olmasın). Faz 5/8 bunu yok sayar (anchor/dev-server zaten hakem).
        finish({ kind: "done", turns: numTurns, capped: true });
      };

      const idleMs = CODEGEN_IDLE_MS;
      const wallMs = codegenWallClockMs(opts.tag);
      const resetIdle = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => onCap("idle", idleMs), idleMs);
      };
      resetIdle();
      // Wall-clock: spawn'da BİR kez kurulur, çıktıyla sıfırlanmaz → "sürekli akıtan ama bitmeyen" runaway'i keser.
      wallTimer = setTimeout(() => onCap("wall", wallMs), wallMs);

      const rl = createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        resetIdle(); // aktif çıktı → idle sıfırla (yavaş-ama-aktif codegen ölmez; yalnız tam-sessizlik/wall-clock keser)
        const trimmed = line.trim();
        if (!trimmed) return;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return; // NDJSON olmayan satır (banner vs.) — atla
        }
        try {
          this.handleEvent(ev, (turns, isErr) => {
            if (typeof turns === "number") numTurns = turns;
            if (typeof isErr === "boolean") {
              resultIsError = isErr;
              resultSeen = true;
            }
          });
        } catch (err) {
          log.warn("cli-backend", "event handler threw", err);
        }
      });

      child.stderr!.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });

      child.on("error", (err) => {
        log.error("cli-backend", "spawn error", err);
        finish({ kind: "failed", reason: `claude CLI spawn failed: ${String(err)}` });
      });

      child.on("close", (code) => {
        if (settled) return; // timer/error zaten sonuçlandırdı (çift-resolve yok)
        // STRAY-CLEANUP: ajanın başlattığı (kuralları çiğneyen) arka-plan orphan'larını süpür —
        // claude grup-lideri olduğu için -pid grubu temizler (finish içinde de yapılır; burada erken cleanup).
        if (this.aborted) {
          finish({ kind: "aborted", turns: numTurns });
          return;
        }
        // Başarı: exit 0 + result event'i is_error=false (veya result hiç
        // gelmediyse exit 0'a güven).
        if (code === 0 && (!resultSeen || !resultIsError)) {
          finish({ kind: "done", turns: numTurns });
        } else {
          // Auto Mode: hata usage/rate-limit imzası taşıyorsa CLI'yi limitli işaretle (hata-yolu) → fallback.
          const rlErr = detectCliRateLimit(stderrTail);
          if (rlErr) noteCliRateLimitError(rlErr);
          // YZLLM 2026-06-17: 529 "Overloaded" exit-kodunu 1 yapar ama mesaj assistant-TEXT'te (stderr'de DEĞİL) →
          // reason'a yansımıyordu → failPhase'in 529-branch'i eşleşmiyor → debug 3 dk boşa araştırıyordu. İmzayı taşı.
          const transientHint = /529|Overloaded|overloaded_error/i.test(`${this.lastTextTail} ${stderrTail}`)
            ? " :: API 529 Overloaded (transient — geçici sunucu yükü)"
            : "";
          finish({
            kind: "failed",
            reason: `claude CLI exit=${code}${stderrTail ? ` :: ${stderrTail.slice(0, 300)}` : ""}${transientHint}`,
          });
        }
      });
    });
  }

  /** stream-json olayını emitClaudeStream + observer'a köprüle. */
  private handleEvent(
    ev: Record<string, unknown>,
    onResult: (turns?: number, isError?: boolean) => void,
  ): void {
    const type = ev.type;
    if (type === "system") {
      // init — model/cwd zaten emit edildi; tekrar gerekmez.
      return;
    }
    if (type === "rate_limit_event") {
      // v15.12 Auto Mode: abonelik usage-limit + resetsAt sinyali.
      noteRateLimitEvent(ev.rate_limit_info as RateLimitInfo | undefined);
      return;
    }
    if (type === "assistant") {
      const msg = ev.message as { content?: unknown[] } | undefined;
      const content = Array.isArray(msg?.content) ? msg!.content : [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          emitClaudeStream({ sub: "text", text: b.text });
          this.lastTextTail = (this.lastTextTail + b.text).slice(-2000); // 529/transient tespiti için (YZLLM 2026-06-17)
          if (this.opts.onTestResult) {
            for (const r of parseTestResultMarkers(b.text)) {
              this.opts.onTestResult(r.green, r.detail);
            }
          }
        } else if (b.type === "tool_use") {
          const name = String(b.name ?? "");
          const input = (b.input as Record<string, unknown>) ?? {};
          emitClaudeStream({ sub: "tool_use", tool_name: name, tool_input: input });
          // Observer köprüsü — Phase 5 "ui-file-write" audit'i bu sayede çalışır.
          // stream-json tool_result'ı ayrı vermediği için is_error=false varsayılır.
          if (this.opts.observer) {
            void this.opts
              .observer({ tool_use: { name, input }, result: { is_error: false } })
              .catch((err) => log.warn("cli-backend", "observer threw", err));
          }
        }
      }
      return;
    }
    if (type === "result") {
      const isError = ev.is_error === true || ev.subtype === "error";
      const turns = typeof ev.num_turns === "number" ? ev.num_turns : undefined;
      const cost = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined;
      const u = extractTokenUsage(ev.usage); // tek kaynak: cli-json.ts (4× kopya kaldırıldı)
      if (u) {
        emitClaudeStream({ sub: "token_usage", usage: u });
        // F1: codegen fazının faz-maliyet kovasını doldur + gerçek $ + model (eskiden
        // cost yalnız loglanıp atılıyordu; kova hiç dolmuyordu). Aktif kova yoksa no-op.
        recordTokenUsage({ ...u, total_cost_usd: cost, model: this.opts.modelId });
      }
      if (cost !== undefined) {
        log.info("cli-backend", "run cost", { cost_usd: cost, turns });
      }
      onResult(turns, isError);
    }
  }

  private buildArgs(effort: string): string[] {
    const { opts } = this;
    // MCP server'ları (opt-in): codebase-memory (yapısal) + cognee (kalıcı hafıza). Hint'ler TEK --append-system-prompt'a,
    // config'ler TEK --mcp-config'e birleştirilir — çift-bayrak son-kazanır tuzağı YOK (mahkeme CRITICAL 2026-07-13).
    const mcpServers: Array<{ configPath: string; hint: string }> = [];
    const cbmCfg = resolveCodebaseMemoryMcpConfig(opts.config);
    if (cbmCfg) mcpServers.push({ configPath: cbmCfg, hint: CODEBASE_MEMORY_HINT });
    const cogneeCfg = resolveCogneeMcpConfig(opts.config);
    if (cogneeCfg) mcpServers.push({ configPath: cogneeCfg, hint: COGNEE_HINT });
    const cbm = applyMcpServerArgs(opts.systemPrompt, mcpServers);
    // Faz EN system prompt + EN task — translator zaten EN üretti (mimari sınır).
    // v15.12: user mesajına İngilizce-çıktı hatırlatması (recency, belt-and-suspenders).
    const args: string[] = [
      "-p",
      `${opts.initialUserMessage}\n\n${MAIN_AGENT_LANGUAGE_REMINDER}`,
      "--append-system-prompt",
      cbm.systemPrompt,
      "--model",
      opts.modelId,
      "--output-format",
      "stream-json",
      "--verbose",
      // KRİTİK (mahkeme bulgusu YZLLM 2026-07-07): partial mesajlar — uzun thinking/sentez turunda token delta'larını
      // stream'ler. Bu OLMADAN idle-timer meşru uzun-düşünme turunu (effort=max) yanlışlıkla keserdi (o tur bitene
      // dek stdout'a satır düşmez → resetIdle çağrılmaz). cli-run.ts:94 + cli-session.ts:105 ile PARİTE. handleEvent
      // yalnız TAM "assistant"ı işler → partial "stream_event"ler yok sayılır (çift parseTestResultMarkers/observer YOK).
      "--include-partial-messages",
      // v15.14 (YZLLM canlı-test 0620): `acceptEdits` yalnız Write/Edit'i oto-onaylar,
      // Bash'i DEĞİL. Borulu/bileşik Bash (`cat x 2>&1 | head`) Claude Code'da her
      // alt-komut için ayrı izin kontrolü doğurur → non-interaktif stream-json'da
      // cevaplayan olmayınca CLI SONSUZA DEK ASILIR (Vestel_BO Faz 5 ~18dk hang, 0 kod).
      // `control_request` şeması belgelenmemiş → handshake'e güvenme. `bypassPermissions`
      // prompt'u tümden kaldırır AMA `--disallowedTools` deny-list'i KORUNUR (deny kuralı
      // mode'dan ÖNCE değerlendirilir → rm/sudo/git-push/chmod hâlâ bloklu); sandbox-exec
      // zaten kök-dışını engelliyor. Bkz claude-code-guide doğrulaması.
      "--permission-mode",
      "bypassPermissions",
      // SPREAD (kod-analiz): `<tools...>` variadic — her tool ayrı argv; join(" ") boşluklu
      // desenleri (Bash(rm *)) bozuyordu. cli-run/cli-session ile tek konvansiyon.
      "--allowedTools",
      ...ALLOWED_TOOLS,
      "--disallowedTools",
      ...DISALLOWED_TOOLS,
      "--add-dir",
      opts.state.project_root,
      "--no-session-persistence",
      // v15.9: --max-budget-usd KALDIRILDI (YZLLM). $2 cap opus/ultracode tam-app
      // codegen'ini ortada kesiyordu (Faz 5 exit=1 → degraded). Maliyet sınırı
      // gerekli işi kesmemeli; gereksiz harcama ajan scope disiplini + faz/tur
      // yapısıyla önlenir, $-cap ile değil.
    ];
    // agent-skills opt-in: dizin varsa --plugin-dir ile açıkça bağla.
    const skillsDir = resolveSkillsDir();
    if (skillsDir) {
      args.push("--plugin-dir", skillsDir);
    }
    // codebase-memory-mcp opt-in (YZLLM 2026-07-13): flag AÇIK + binary kurulu ise MCP server'ını --mcp-config +
    // --strict-mcp-config ile bağla (deterministik: yalnız MyCL'in config'i; --plugin-dir gibi kullanıcının global
    // MCP'sine bağımlı DEĞİL). Prompt ipucu YUKARIDA systemPrompt'a birleştirildi (ikinci --append-system-prompt faz
    // talimatını ezerdi — mahkeme CRITICAL). null → eklenmez (grep fallback; KATI #4 görünür uyarı ensure'da verildi).
    args.push(...cbm.mcpArgs);
    // v15.11 GÜVENLİK: --settings ile sandbox (+ ultracode) — ajanı proje-root'a hapset.
    args.push(...sandboxSettingsArgs(opts.state.project_root, effort === "ultracode"));
    if (effort && effort !== "ultracode") {
      args.push("--effort", effort);
    }
    return args;
  }
}

/**
 * v15.8: Ajan metnindeki `MYCL_TEST_RESULT: green|red[: <neden>]` marker'larını
 * çıkar (Faz 8 TDD self-report; CLI stream-json tool_result.is_error taşımaz).
 * REGEX YOK — düz substring satır taraması (kullanıcı kuralı). Saf + test edilebilir.
 */
export function parseTestResultMarkers(
  text: string,
): Array<{ green: boolean; detail: string }> {
  const MARKER = "MYCL_TEST_RESULT:";
  const out: Array<{ green: boolean; detail: string }> = [];
  for (const line of text.split("\n")) {
    const idx = line.indexOf(MARKER);
    if (idx < 0) continue;
    const rest = line.slice(idx + MARKER.length).trim();
    const lower = rest.toLowerCase();
    if (lower.startsWith("green")) out.push({ green: true, detail: rest });
    else if (lower.startsWith("red")) out.push({ green: false, detail: rest });
  }
  return out;
}
