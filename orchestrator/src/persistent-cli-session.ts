// persistent-cli-session — KALICI `claude` süreci (YZLLM 2026-06-11: "bir claude oturumu açıp her zaman onu kullan").
//
// SORUN: her çağrı ayrı `claude -p` süreci açıyordu → cold-start + ısı + 8 çekirdek saturasyonu. ÇÖZÜM: rol başına
// TEK kalıcı süreç (`--input-format stream-json`), stdin'den mesaj alır, stdout'tan turu okur, CANLI kalır → respawn
// yok, ısı düşer. Biriken bağlam zengin/tutarlı çıktı verir (claude'un compaction'ı bağlamı sınırlar). YZLLM: "tek
// atışlar da var olan oturumu kullansın, sadece son turn dikkate alınsın."
//
// API ASLA terk edilmez (YZLLM): bu yalnız CLI/abonelik yolu. Tek bir tur bile başarısızsa caller eski cold-start
// `runClaudeCli`'ya düşer (fail-safe, regresyon yok). Turlar SERİ (tek konuşma — araya girilemez); eşzamanlı send
// kuyruğa alınır.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { guardSandboxOrWarn, sandboxSettingsArgs } from "./agent-sandbox.js";
import { shouldFolderGuard, wrapReadOnlyClaude } from "./claude-folder-guard.js";
import {
  noteRateLimitEvent,
  finalizeCliRateLimit,
  type RateLimitInfo,
} from "./cli-rate-limit.js";
import { appendFile, readFile } from "node:fs/promises";
import { claudeSpawnEnv, resolveClaudePath } from "./codegen/cli-backend.js";
import { emitChatMessage, recordTokenUsage } from "./ipc.js";
import { log } from "./logger.js";
import { waitIfPaused } from "./pause.js";
import { withDangerousBashDeny } from "./tool-policy.js";
import { globalConfigFile } from "./paths.js";

// Oturum transcript'i (YZLLM 2026-06-11: "arka plan oturumları kör noktada kalmasın, herşey loglansın, orkestratör
// ne düşündüklerini bulabilsin"). Her kalıcı tur buraya yazılır → orkestratör readSessionTranscript ile bulur.
const SESSION_TRANSCRIPT = globalConfigFile("session-transcripts.jsonl");

function recordSessionTurn(rec: {
  id: string;
  model: string;
  effort?: string;
  ok: boolean;
  input: string;
  output: string;
}): void {
  const line =
    JSON.stringify({
      ts: Date.now(),
      id: rec.id,
      model: rec.model,
      effort: rec.effort,
      ok: rec.ok,
      input: rec.input.slice(0, 800), // önizleme (bloat değil, ama "ne düşündü" görünür)
      output: rec.output.slice(0, 2000),
    }) + "\n";
  appendFile(SESSION_TRANSCRIPT, line, "utf-8").catch((e) =>
    log.warn("persistent-cli", "transcript satırı yazılamadı (best-effort gözlem)", { error: String(e) }),
  );
}

/** Orkestratör için: son N kalıcı-oturum turunu oku (kör nokta yok — ne düşündüklerini bul). Best-effort. */
export async function readSessionTranscript(
  limit = 50,
): Promise<Array<{ ts: number; id: string; model: string; effort?: string; ok: boolean; input: string; output: string }>> {
  try {
    const raw = await readFile(SESSION_TRANSCRIPT, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean).slice(-limit);
    return lines.map((l) => JSON.parse(l)).filter(Boolean);
  } catch (e) {
    // errno-AYRIMI (sessiz-fallback denetimi): ENOENT = transcript hiç yok (ilk açılış, normal). BAŞKA hata
    // (EACCES/bozuk JSON) = var ama okunamadı → orkestratörün kör-nokta bağlamı eksik kaldı, görünür kıl.
    if ((e as { code?: string }).code !== "ENOENT") {
      log.error("persistent-cli", "transcript okunamadı (var ama bozuk/erişilemez) — kör-nokta bağlamı eksik", {
        code: (e as { code?: string }).code,
      });
    }
    return [];
  }
}

export interface PersistentSessionOpts {
  /** Rol kimliği — log/teşhis için (örn. "translator-en-tr"). */
  id: string;
  modelId: string;
  systemPrompt: string;
  /** Açılış eforu (low/medium/high/xhigh/max). Sonra send(opts.effort) ile oturum-içi değişebilir. */
  effort?: string;
  /** claude'un çalışacağı dizin. Tek-atış/çevirmen için zararsız (tool yok). */
  cwd: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Assistant metin parçaları (UI stream köprüsü — codegen/orkestratör için). */
  onText?: (text: string) => void;
  /** Her tool_use (codegen observer köprüsü). */
  observer?: (toolUse: { name: string; input: Record<string, unknown> }) => void;
}

export interface SessionTurnResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * Başarısız tur GEÇİCİ DIŞ kesinti mi (API erişilemez/timeout/limit) yoksa YAPISAL bozulma mı (oturum bozuk)?
 * YZLLM 2026-06-22 (canlı transcript teşhisi): translator-en-to-tr "kararsız" uyarılarının asıl sebebi çöp girdi
 * DEĞİL (repro: çöp log satırı bile başarıyla çevriliyor) — "Request timed out" / "Unable to connect (ConnectionRefused)"
 * gibi DIŞ API kesintileri. Bunlar oturum kusuru sayılmaz: cold-start aynı backend'i kullanır, fayda etmez.
 * Hem error hem (CLI'nin assistant-text olarak bastığı) çıktı metni taranır.
 */
export function isTransientOutage(r: SessionTurnResult): boolean {
  const s = `${r.error ?? ""} ${r.text ?? ""}`;
  return /timed out|time ?out|unable to connect|connection ?refused|econnrefused|econnreset|etimedout|enotfound|eai_again|socket hang up|fetch failed|network|overloaded|rate.?limit|too many requests|\b429\b|\b503\b|\b502\b|\b504\b|service unavailable/i.test(
    s,
  );
}

/**
 * Tek kalıcı claude süreci + seri tur kuyruğu. Lazy spawn (ilk send'de). Süreç ölürse sonraki send yeniden açar
 * (tur-içi ölüm → o tur {ok:false}, caller fallback). dispose() ile kapatılır.
 */
export class PersistentClaudeSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private alive = false;
  // Aktif turun çözücüleri (stdout okuyucu bunları doldurur).
  private pending: {
    texts: string[];
    resolve: (r: SessionTurnResult) => void;
    sawRateLimitBlocked: boolean;
  } | null = null;
  // Oturum-içi model/efor durumu — control_request ile değişir (respawn yok).
  private curModel: string;
  private curEffort: string | undefined;
  private ctlSeq = 0;
  private pendingControls = new Map<string, (ok: boolean) => void>();
  // Sağlık (YZLLM 2026-06-11): art arda hata = bozuk oturum → oto-yenileme. _fails ardışık başarısızlık sayısı.
  private fails = 0;
  /** Oturum kalıcı olarak kararsız mı (çok yenilendi) — caller buna bakıp cold-start/API'ye düşebilir. */
  unhealthy = false;
  // Bu kararsızlık-epizodu için kullanıcı bilgilendirildi mi (60sn'de bir aynı mesajı spam'leme; recovery'de sıfırlanır).
  private episodeNoticed = false;
  // stderr son ~2KB (YZLLM 2026-06-22: stderr eskiden tamamen yutuluyordu → yapısal hatada kör teşhis. Artık tail saklanır).
  private lastStderr = "";

  constructor(private opts: PersistentSessionOpts) {
    this.curModel = opts.modelId;
    this.curEffort = opts.effort;
  }

  private buildArgs(): string[] {
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      this.opts.modelId,
      "--no-session-persistence",
      // v15.14 (YZLLM canlı-test 0620): acceptEdits → bypassPermissions (Bash izin-prompt
      // hang'i; bkz cli-backend/cli-session/cli-run aynı düzeltme). Bu rollerde (çevirmen/
      // llm-reasoning) Bash zaten yasak ama tutarlılık + gelecek-güvenli; baseline deny korunur.
      "--permission-mode",
      "bypassPermissions",
      "--add-dir",
      this.opts.cwd,
      "--append-system-prompt",
      this.opts.systemPrompt,
    ];
    if (this.curEffort && this.curEffort !== "ultracode") args.push("--effort", this.curEffort);
    if (this.opts.allowedTools?.length) args.push("--allowedTools", ...this.opts.allowedTools);
    args.push("--disallowedTools", ...withDangerousBashDeny(this.opts.disallowedTools));
    // Çevirmen/tek-atış read-only → sandbox (cwd hapsi). ultracode yok.
    args.push(...sandboxSettingsArgs(this.opts.cwd, false));
    return args;
  }

  private start(): boolean {
    if (!guardSandboxOrWarn()) return false;
    const bin = resolveClaudePath() ?? "claude";
    const args = this.buildArgs();
    // macOS folder-guard (TCC penceresini kaynağında kes): Bash YOK ise sandbox-exec ile sar (cli-run ile aynı karar).
    // Kalıcı süreç bir kez açıldığı için tarama da bir kez olur — cold-start'tan daha az TCC teması.
    const spawnCmd = shouldFolderGuard({ allowedTools: this.opts.allowedTools })
      ? wrapReadOnlyClaude(bin, args)
      : { cmd: bin, args };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spawnCmd.cmd, spawnCmd.args, {
        cwd: this.opts.cwd,
        env: claudeSpawnEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch (e) {
      log.warn("persistent-cli", `${this.opts.id}: spawn failed`, e);
      return false;
    }
    this.child = child;
    this.alive = true;
    const rl = createInterface({ input: child.stdout });
    this.rl = rl;
    rl.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (d) => {
      // stderr'i tüket (backpressure) + son ~2KB sakla → yapısal hatada gerçek sebep görünür (kör teşhis yok).
      this.lastStderr = (this.lastStderr + String(d)).slice(-2048);
    });
    child.on("exit", (code) => {
      this.alive = false;
      log.info("persistent-cli", `${this.opts.id}: exited`, { code });
      // Tur-içi ölüm → bekleyen turu başarısız çöz (caller fallback eder).
      if (this.pending) {
        const pend = this.pending;
        this.pending = null;
        pend.resolve({ ok: false, text: pend.texts.join(""), error: `session exited code=${code}` });
      }
      for (const r of this.pendingControls.values()) r(false);
      this.pendingControls.clear();
      this.child = null;
      this.rl = null;
    });
    log.info("persistent-cli", `${this.opts.id}: started (persistent)`);
    return true;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // banner / NDJSON-dışı
    }
    const type = ev.type;
    // control_response: model/efor değişim cevabı — turdan bağımsız gelir (pending olmayabilir).
    if (type === "control_response") {
      const resp = (ev.response ?? {}) as Record<string, unknown>;
      const rid = String(resp.request_id ?? "");
      const cb = this.pendingControls.get(rid);
      if (cb) {
        this.pendingControls.delete(rid);
        cb(resp.subtype === "success");
      }
      return;
    }
    if (!this.pending) return;
    if (type === "rate_limit_event") {
      const info = ev.rate_limit_info as RateLimitInfo | undefined;
      noteRateLimitEvent(info);
      // blocked sinyali tur sonucu ile finalize edilir (overage kurtarabilir).
      if (info && /reject|blocked|exceeded/i.test(String(info.status ?? ""))) {
        this.pending.sawRateLimitBlocked = true;
      }
    } else if (type === "assistant") {
      const msg = ev.message as { content?: unknown[] } | undefined;
      for (const b of Array.isArray(msg?.content) ? msg!.content : []) {
        const blk = b as Record<string, unknown>;
        if (blk.type === "text" && typeof blk.text === "string") {
          this.pending.texts.push(blk.text);
          this.opts.onText?.(blk.text); // UI stream köprüsü
        } else if (blk.type === "tool_use" && typeof blk.name === "string") {
          this.opts.observer?.({ name: blk.name, input: (blk.input ?? {}) as Record<string, unknown> });
        }
      }
    } else if (type === "result") {
      // Tur bitti. is_error → başarısız.
      const isErr = ev.is_error === true || ev.subtype === "error";
      const usage = (ev.usage ?? (ev.message as Record<string, unknown> | undefined)?.usage) as
        | Record<string, number>
        | undefined;
      if (usage) {
        recordTokenUsage({
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        });
      }
      const pend = this.pending;
      this.pending = null;
      const ok = !isErr;
      finalizeCliRateLimit(ok); // başardıysa limit temizle; blocked+fail → API'ye geç
      pend.resolve({
        ok,
        text: pend.texts.join("").trim(),
        error: ok ? undefined : "session turn is_error",
      });
    }
  }

  /** control_request gönder + cevabı bekle (model/efor değişimi). 10sn'de cevap yoksa false. */
  private sendControl(request: Record<string, unknown>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const child = this.child;
      if (!child) {
        resolve(false);
        return;
      }
      const rid = `ctl-${++this.ctlSeq}`;
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(t);
        this.pendingControls.delete(rid);
        resolve(ok);
      };
      const t = setTimeout(() => finish(false), 10_000);
      this.pendingControls.set(rid, finish);
      try {
        child.stdin.write(JSON.stringify({ type: "control_request", request_id: rid, request }) + "\n");
      } catch (e) {
        log.error("persistent-cli", "control_request stdin'e yazılamadı", { error: String(e) });
        finish(false);
      }
    });
  }

  /** Oturum-içi model+efor'u istenen değere getir (değişmişse). Doğrulandı: set_model + apply_flag_settings. */
  private async ensureModelEffort(model?: string, effort?: string): Promise<void> {
    if (model && model !== this.curModel) {
      if (await this.sendControl({ subtype: "set_model", model })) this.curModel = model;
      else {
        // YÜK-TAŞIYAN sapma (sessiz-fallback denetimi): model değişimi başarısızsa oturum YANLIŞ modelde
        // devam eder (ör. müfettiş Sonnet yerine eski modelde → çapraz-aile çeşitliliği kaybolur). GÖRÜNÜR kıl.
        log.error("persistent-cli", "set_model BAŞARISIZ — oturum yanlış modelde devam ediyor", { wanted: model, current: this.curModel });
        emitChatMessage(
          "system",
          `⚠️ Model değişimi (${model}) başarısız — oturum mevcut modelde (${this.curModel}) devam ediyor; sonuç beklenenden farklı olabilir.`,
        );
      }
    }
    if (effort && effort !== this.curEffort && effort !== "ultracode") {
      if (await this.sendControl({ subtype: "apply_flag_settings", settings: { effort } })) this.curEffort = effort;
      else log.error("persistent-cli", "apply_flag_settings(effort) BAŞARISIZ — eski efor sürüyor", { wanted: effort, current: this.curEffort });
    }
  }

  /**
   * Bir turu gönder (seri kuyruk). opts.model/effort verilirse turdan ÖNCE oturum-içi değiştirilir (respawn yok).
   * Süreç yoksa açar. opts.timeoutMs içinde result gelmezse {ok:false}.
   */
  send(userText: string, opts: { model?: string; effort?: string; timeoutMs?: number } = {}): Promise<SessionTurnResult> {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const run = (): Promise<SessionTurnResult> =>
      new Promise<SessionTurnResult>((resolve) => {
        void (async () => {
        await waitIfPaused(); // Duraklat denetimi: yeni kalıcı-oturum turu SINIRI (pause SÜRESİ tavana dahil DEĞİL).
        // YZLLM 2026-06-13 (gerçek-koşu: çevirmen turu ~16dk asılı kaldı, turn-timeout HİÇ ateşlemedi):
        // timer'ı pause'dan SONRA ama start/ensureModelEffort/write'tan ÖNCE kur. Eskiden timer write'ın hemen
        // önünde kuruluyordu → start() ya da ensureModelEffort (control_request await'i) asılırsa timer HİÇ
        // kurulmuyor, tur sonsuz asılıyor + seri-kuyruk arkasındaki tüm turlar donuyordu. Artık post-pause her iş
        // (start + model/efor + result bekleme) tek tavan altında.
        let settled = false;
        const finish = (r: SessionTurnResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        const timer = setTimeout(() => {
          log.warn("persistent-cli", `${this.opts.id}: turn timeout`, { timeoutMs });
          // Timeout → süreci öldür (kirli durumdan kaçın); sonraki send yeniden açar.
          this.kill();
          finish({ ok: false, text: this.pending?.texts.join("") ?? "", error: `turn timeout ${timeoutMs}ms` });
        }, timeoutMs);
        if (!this.alive && !this.start()) {
          finish({ ok: false, text: "", error: "session start failed" });
          return;
        }
        // Model/efor istenen değilse oturum-içi değiştir (control_request — respawn yok).
        await this.ensureModelEffort(opts.model, opts.effort);
        const child = this.child;
        if (!child) {
          finish({ ok: false, text: "", error: "no child" });
          return;
        }
        // pending'i finish ile sar (timeout/exit ikisini de kapsasın).
        this.pending = {
          texts: [],
          sawRateLimitBlocked: false,
          resolve: finish,
        };
        const msg = {
          type: "user",
          message: { role: "user", content: [{ type: "text", text: userText }] },
        };
        try {
          child.stdin.write(JSON.stringify(msg) + "\n");
        } catch (e) {
          finish({ ok: false, text: "", error: `stdin write failed: ${String(e)}` });
        }
        })().catch((e) => {
          // Timer-öncesi throw (start()/ensureModelEffort()) Promise'i ASILI
          // bırakmasın → her durumda resolve (timeout'suz deadlock sınıfını kapatır).
          resolve({ ok: false, text: "", error: `session send threw: ${String(e)}` });
        });
      });
    // Seri kuyruk: bir tur bitmeden sonraki başlamasın (tek konuşma). Her sonuçtan sonra sağlık değerlendir.
    const next = this.queue.then(run, run).then((r) => {
      this.applyHealth(r);
      // Transcript: her tur retrievable (orkestratör kör noktada kalmasın — ne düşündüklerini bulabilsin).
      recordSessionTurn({ id: this.opts.id, model: this.curModel, effort: this.curEffort, ok: r.ok, input: userText, output: r.text });
      return r;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Sağlık değerlendirme (YZLLM: "sürekli açık oturumdan hata olursa tespit et → yeni oturum"). Başarı → sayaç sıfır.
   * Başarısızlık → süreci kapat (sonraki send TAZE başlar = oto-yenileme) + görünür mesaj. 3+ ardışık → unhealthy
   * (caller cold-start/API'ye düşebilir). Bu, orkestratörün gördüğü "MyCL bozuk oturumu yeniledi" davranışıdır.
   */
  private applyHealth(r: SessionTurnResult): void {
    if (r.ok) {
      // Toparladı: kararsızlık epizodundan çıktıysak kullanıcıya görünür "düzeldi" de (sessiz toparlama yok).
      if (this.unhealthy) {
        emitChatMessage("system", `✓ "${this.opts.id}" kalıcı oturumu toparladı — normal yola dönüldü.`);
      }
      this.fails = 0;
      this.unhealthy = false;
      this.episodeNoticed = false;
      return;
    }
    this.fails++;
    // YZLLM 2026-06-22 (canlı teşhis): hatayı sınıflandır. GEÇİCİ dış kesinti (API timeout/bağlantı/limit)
    // "oturum kararsız" DEĞİLDİR — cold-start aynı backend'i kullanır, fayda etmez; ayrıca sıcak oturumu
    // boş yere öldürüp 60sn'de bir respawn etmek israf. Yalnız YAPISAL bozulmada öldür + "kararsız" de.
    const transient = isTransientOutage(r);
    if (this.alive && !transient) this.kill(); // yapısal bozulma → kapat (sonraki çağrı taze açar); dış kesinti → sıcak tut
    if (this.fails < 3) {
      log.warn("persistent-cli", `${this.opts.id}: hata → oturum yenilenecek (taze açılacak)`, {
        fails: this.fails,
        transient,
        error: r.error,
      });
      return;
    }
    this.unhealthy = true;
    if (this.episodeNoticed) return; // epizot başına TEK görünür mesaj (60sn-spam'i önle); recovery'de sıfırlanır
    this.episodeNoticed = true;
    if (transient) {
      // Dış API kesintisi: oturum kusuru değil — dürüst + doğru teşhis (yanlış "oturum bozuk" damgası yok).
      emitChatMessage(
        "system",
        `⚠️ "${this.opts.id}": API'ye ${this.fails} kez üst üste ulaşılamadı (timeout/bağlantı) — geçici dış kesinti, oturum sorunu değil. API toparlayınca otomatik düzelir; bu sırada yavaş cold-start yolundan denenir.`,
      );
    } else {
      // Yapısal bozulma: gerçek hatayı (stderr tail) yüzeye çıkar — kör teşhis yok.
      const tail = this.lastStderr.trim().slice(-300);
      const detail = tail ? ` — son hata: ${tail}` : r.error ? ` — ${r.error}` : "";
      emitChatMessage(
        "system",
        `⚠️ "${this.opts.id}" kalıcı oturumu ${this.fails} kez üst üste hata verdi — kararsız sayıldı; geçici olarak cold-start/eski yola düşülüyor${detail}.`,
      );
    }
  }

  private kill(): void {
    this.alive = false;
    const child = this.child;
    try {
      this.rl?.close();
    } catch {
      /* yut */
    }
    // GRACEFUL: stdin EOF → claude turu bitirip çıkar (sandbox-exec sarmalı olsa bile stdin geçişli → torun da kapanır,
    // orphan yok). Ardından emniyet için SIGTERM, hâlâ canlıysa SIGKILL — sandbox-exec sarmalayıcı takılmasın.
    try {
      child?.stdin.end();
    } catch {
      /* yut */
    }
    try {
      child?.kill("SIGTERM");
    } catch {
      /* yut */
    }
    if (child && child.pid) {
      setTimeout(() => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {
          /* yut */
        }
      }, 2000);
    }
    this.child = null;
    this.rl = null;
  }

  dispose(): void {
    this.kill();
  }
}

// Oturum kaydı — aynı (id) için tek kalıcı süreç. YZLLM 2026-06-11: "istediğimiz kadar claude açabiliriz" → YAPAY
// sayı sınırı YOK; yalnız BOŞTA kalan (uzun süre kullanılmayan) oturumlar temizlenir (RAM emniyeti). Karışmaması
// gereken / farklı sistem-promptlu her iş kendi oturumunu açar.
const _sessions = new Map<string, PersistentClaudeSession>();
const _lastUsed = new Map<string, number>();
const IDLE_DISPOSE_MS = 20 * 60_000; // 20 dk boşta → kapat (aktif olanlar sınırsız kalır)
const SAFETY_CAP = 40; // yalnız kaçak-koruma (gerçek kullanımda erişilmez); aşılırsa en eski boşta kapanır

function sweepIdle(nowMs: number): void {
  for (const [id, s] of _sessions) {
    if (nowMs - (_lastUsed.get(id) ?? 0) > IDLE_DISPOSE_MS) {
      _sessions.delete(id);
      _lastUsed.delete(id);
      s.dispose();
      log.info("persistent-cli", "boşta oturum kapatıldı", { id });
    }
  }
}

/** id'ye göre kalıcı oturumu al/oluştur. Boşta-temizlik + (yalnız emniyet) sayı tavanı. */
export function getPersistentSession(opts: PersistentSessionOpts): PersistentClaudeSession {
  const now = nowMsSafe();
  sweepIdle(now);
  _lastUsed.set(opts.id, now);
  let s = _sessions.get(opts.id);
  if (s) return s;
  s = new PersistentClaudeSession(opts);
  _sessions.set(opts.id, s);
  // Emniyet tavanı (kaçak koruma): en eski-boşta kapanır. Normalde erişilmez.
  while (_sessions.size > SAFETY_CAP) {
    let oldestId: string | undefined;
    let oldestTs = Infinity;
    for (const [id, ts] of _lastUsed) {
      if (id !== opts.id && ts < oldestTs) {
        oldestTs = ts;
        oldestId = id;
      }
    }
    if (oldestId === undefined) break;
    _sessions.get(oldestId)?.dispose();
    _sessions.delete(oldestId);
    _lastUsed.delete(oldestId);
  }
  return s;
}

// Date.now sarmalı (test/erişilebilirlik) — bu modül workflow değil, normal Node; Date.now serbest.
function nowMsSafe(): number {
  return Date.now();
}

/** Kısa deterministik hash (oturum id'si için — systemPrompt+model → kararlı kısa anahtar). SAF. */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Tümünü kapat (shutdown / proje değişimi). */
export function disposeAllPersistentSessions(): void {
  for (const s of _sessions.values()) s.dispose();
  _sessions.clear();
}

// Orphan claude süreci bırakma (bellek: stray process temizle): orkestratör çıkarken kalıcı süreçleri öldür.
let _exitHookInstalled = false;
function installExitHook(): void {
  if (_exitHookInstalled) return;
  _exitHookInstalled = true;
  for (const sig of ["exit", "SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => disposeAllPersistentSessions());
  }
}
installExitHook();
