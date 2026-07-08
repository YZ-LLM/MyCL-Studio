// risk-fix-parallel — Faz 9 risk düzeltmelerini İZOLE KOPYALARDA paralel koşar (git'e DOKUNMAZ).
//
// Kullanıcı seçimi (YZLLM 2026-07-07, zaman-kaybı planı #6): "kopya tabanlı kur, varsayılan açık, birleştirme
// çakışması çıkarsa mahkeme kursun, doğruları bulsun."
//
// NEDEN git worktree DEĞİL: worktree yalnız COMMIT'li kodu görür; pipeline'ın Faz 1-8 işi genelde commit'siz
// (kirli çalışma ağacı) → worktree bayat kodu görür + birleştirince pipeline'ı geri alır. Bunun yerine mevcut
// kaynak ağacı N izole kopyaya alınır (node_modules/.git/.mycl hariç), her fix kendi kopyasında paralel codegen
// koşar, DEĞİŞEN dosyalar tool-use observer'ından toplanır, ana ağaca birleştirilir. İKİ fix AYNI dosyayı
// değiştirdiyse ÇAPRAZ-AİLE MAHKEMESİ (Sonnet üretici + düşman doğrulayıcı) doğru birleşimi üretir. Birleştirme
// sonrası TAM test takımı bir kez koşulur; kırmızıysa ana ağaç GERİ ALINIR → {ok:false} → caller SERİ (tam
// test-odaklı) yola düşer. FAIL-CLOSED: her hata → seri fallback (hiçbir şey yarım kalmaz).

import { cp, readFile, readdir, writeFile, mkdir, rm, rmdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { exec } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { createCodegenBackend } from "./codegen/backend.js";
import { selectModelForTask } from "./model-catalog.js";
import { runReasoning } from "./llm-reasoning.js";
import { INSPECTOR_MODEL_DEFAULT } from "./inspector.js";
import { extractKindBlock } from "./cli-json.js";
import { confirmForeignWriteFiles } from "./foreign-write-consent.js";
import { resolveMechanicalCmd, isMissingCommand } from "./base/mechanical-runner.js";
import { emitAgentEvent, emitChatMessage, emitError } from "./ipc.js";
import { withAgentRun } from "./agent-cost-context.js";
import { traceAgentEvent } from "./agent-trace.js";
import { TOOLS_CODEGEN, type ToolContext } from "./tool-handlers.js";
import { safeEnv } from "./safe-env.js";
import { appendAudit } from "./audit.js";
import type { ToolDef } from "./claude-api.js";
import type { MyclConfig } from "./config.js";
import type { State } from "./types.js";
import { log } from "./logger.js";

const execAsync = promisify(exec);

/** Faz 9 kod-fix'i (target 8) — dispatchRiskFixes'ten gelen detail/risk. */
export interface CodeFix {
  detail: string;
  risk: string;
}

export interface ParallelRiskFixOutcome {
  /** true → düzeltmeler ana ağaca uygulandı + konsolide test yeşil. false → caller SERİ fallback yapmalı. */
  ok: boolean;
  reason: string;
  integratedFiles?: string[];
  conflictsResolved?: number;
  /** GERİ ALMA KISMEN BAŞARISIZ (mahkeme bulgusu): ana ağaçta doğrulanmamış içerik kalmış olabilir → caller SERİ
   * fallback'i o dosyalara UYGULAMAMALI (bozuk taban üstüne otomatik düzeltme yapmasın), GÖRÜNÜR uyarıp durmalı. */
  treeCorrupted?: boolean;
  /** B1.1 (foreign): kullanıcı GERÇEK-dosya onayını REDDETTİ → caller SERİ fallback YAPMAMALI (aksi halde aynı
   * düzeltmeler seri uygulanır = reddi baypas eder); kod-fix'leri ATLA (uygulanmadan bırak). */
  userRejected?: boolean;
}

/** Kopyaya alınmayacak dizin adları (ağır / paylaşılmamalı / build çıktısı). */
const COPY_EXCLUDE = new Set([
  ".git", ".mycl", "node_modules", "dist", "build", ".next", "out", "target", "coverage", ".venv", "__pycache__",
]);

/** Mahkemeye verilen dosya boyut tavanı — çok büyük dosyada LLM birleşimi güvenilmez → seri fallback. */
const MAX_MERGE_FILE_BYTES = 48_000;

const FIX_WORKER_SYSTEM = [
  "You are fixing ONE specific risk in an ISOLATED COPY of the project (other fixes run in parallel copies).",
  "Read the relevant code, then apply a MINIMAL, targeted fix for THIS risk ONLY.",
  "If practical, add/update a test that confirms the fix (the FULL suite runs later on the merged result).",
  "Edit ONLY the files this risk needs. Do NOT refactor unrelated code; do NOT touch package.json / lockfiles /",
  "config unless the fix strictly requires it. Prefer Write/Edit for file changes (so your changes are tracked).",
  "Use Read/Grep/Glob to understand, Write/Edit to implement. Finish when the fix is applied.",
].join("\n");

const MERGE_PRODUCER_SYSTEM = [
  "You are a cross-family MERGE arbiter (mahkeme). Two or more INDEPENDENT risk-fixes edited the SAME file, each",
  "in isolation from the same base. Produce ONE correct merged version that incorporates EVERY fix without losing",
  "any, and without breaking the base code's unrelated behavior.",
  "Rules: keep ALL fixes; never drop/weaken a fix; preserve unrelated base code exactly; if two fixes overlap,",
  "combine them so BOTH intents hold. Do not introduce syntax errors.",
  "Output the COMPLETE merged file content between a line `===MERGED_START===` and a line `===MERGED_END===`.",
  "Output NOTHING else — no prose, no code fences, just the markers and the file content between them.",
].join("\n");

const MERGE_VERIFIER_SYSTEM = [
  "You are an ADVERSARIAL verifier for a proposed file MERGE. You get the base, each fix's version + intent, and",
  "the proposed MERGE. Decide: does the merge incorporate EVERY fix's intent AND preserve the base's unrelated",
  "behavior, with no syntax errors and no lost code? Be skeptical — DEFAULT TO REJECT if any fix seems",
  "dropped/weakened or the merge looks broken/truncated.",
  'Output ONLY one JSON block: {"kind":"verdict","ok":true|false,"reason":"<short>"}.',
].join("\n");

/** Kaynak ağacı `dest`'e kopyalar (COPY_EXCLUDE dizinleri hariç). */
async function copyProjectInto(src: string, dest: string): Promise<void> {
  await cp(src, dest, {
    recursive: true,
    filter: (s: string) => {
      const rel = relative(src, s);
      if (!rel) return true;
      return !rel.split(/[/\\]/).some((seg) => COPY_EXCLUDE.has(seg));
    },
  });
}

/** Dosya-içi büyük/ikili dosyaları atla (kaynak-kod fix'i değil; utf-8 karşılaştırma güvenilmez). */
const MAX_DIFF_FILE_BYTES = 512_000;

/** Okuma hatası GERÇEKTEN "dosya yok" (ENOENT) mu, yoksa izin/IO mu? (mahkeme bulgusu: karıştırma → veri kaybı). */
function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * KOPYA ile ana ağaç arasında GERÇEKTEN değişen/yeni dosyaları bulur (COPY_EXCLUDE hariç). Observer YERİNE bu
 * kullanılır (mahkeme bulgusu 3/4): Bash/sed/betik ile yapılan değişiklikler tool-use observer'ında görünmez;
 * içerik-farkı hangi araçla değiştiğini önemsemeden yakalar. Silinen dosyalar ele alınmaz (fix'ler nadiren siler).
 */
async function collectChangedFiles(
  copyDir: string,
  root: string,
): Promise<{ changed: Set<string>; deleted: Set<string>; skipped: Set<string> }> {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const skipped = new Set<string>(); // büyük/okunamayan → paralel güvenle doğrulayamaz → seri (mahkeme bulgusu, KATI #4)
  // copy → root: değişen/yeni dosyalar (içerik farkı).
  const walkCopy = async (relDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(copyDir, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (COPY_EXCLUDE.has(e.name)) continue;
      const rel = relDir ? join(relDir, e.name) : e.name;
      if (e.isDirectory()) {
        await walkCopy(rel);
        continue;
      }
      if (!e.isFile()) continue;
      let copyContent: string;
      try {
        const buf = await readFile(join(copyDir, rel));
        if (buf.length > MAX_DIFF_FILE_BYTES) {
          skipped.add(rel); // büyük/ikili → SESSİZCE atlama (mahkeme bulgusu 2) → çağıran seri'ye düşer
          continue;
        }
        copyContent = buf.toString("utf-8");
      } catch {
        skipped.add(rel); // kopya dosyası okunamadı → sessizce "değişmedi" sayma
        continue;
      }
      let baseContent = "";
      try {
        baseContent = await readFile(join(root, rel), "utf-8");
      } catch (e) {
        if (!isEnoent(e)) {
          skipped.add(rel); // base ENOENT DEĞİL (izin/IO hatası) → "yeni dosya" varsayma → seri (mahkeme bulgusu 1)
          continue;
        }
        baseContent = ""; // gerçekten yok → yeni dosya
      }
      if (copyContent !== baseContent) changed.add(rel);
    }
  };
  // root → copy: SİLİNEN dosyalar (mahkeme bulgusu: ana ağaçta var, kopyada yok → fix silmiş).
  const walkRoot = async (relDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (COPY_EXCLUDE.has(e.name)) continue;
      const rel = relDir ? join(relDir, e.name) : e.name;
      if (e.isDirectory()) {
        await walkRoot(rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (!existsSync(join(copyDir, rel))) deleted.add(rel);
    }
  };
  await walkCopy("");
  await walkRoot("");
  return { changed, deleted, skipped };
}

/** Bir fix'i izole kopyada codegen ile koşar. Değişen dosyalar SONRADAN collectChangedFiles ile bulunur (Bash dahil). */
async function runFixWorker(
  fix: CodeFix,
  index: number,
  copyDir: string,
  cfg: MyclConfig,
  baseState: State,
): Promise<{ ok: boolean; error?: string }> {
  const label = `risk-fix-${index + 1}`;
  return withAgentRun({ label, group: "Faz 9 Paralel Düzeltme", phase: 9 }, async () => {
    emitAgentEvent({ sub: "started", agent_label: label, agent_group: "Faz 9 Paralel Düzeltme", phase: 9 });
    try {
      const modelId = selectModelForTask("codegen", cfg.selected_models.model_tiers).modelId;
      const toolCtx: ToolContext = { project_root: copyDir };
      const backend = createCodegenBackend({
        tag: "parallel-module", // CLI-eligible + tur-bütçeli (cli-backend wall-clock / SDK maxTurns) — item #1/#2
        phaseId: 8,
        state: { ...baseState, project_root: copyDir, pending_backend_fix: fix.detail },
        config: cfg,
        systemPrompt: FIX_WORKER_SYSTEM,
        modelId,
        apiKey: cfg.api_keys.main,
        initialUserMessage: `Fix this risk now (minimal, targeted):\n${fix.detail}`,
        tools: TOOLS_CODEGEN as unknown as ToolDef[],
        toolContext: toolCtx,
        allowed_tool_names: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
        betas: cfg.claude_code_flags.betas,
        observer: async (ctx) => {
          void traceAgentEvent({ ts: Date.now(), agent_label: label, sub: "tool_use", tool_name: ctx.tool_use.name });
        },
      });
      const outcome = await backend.run();
      if (outcome.kind === "done" && !outcome.capped) return { ok: true };
      return {
        ok: false,
        error: outcome.kind === "done" ? "tur/wall-clock tavanı (capped)" : outcome.kind === "failed" ? outcome.reason : "aborted",
      };
    } catch (err) {
      return { ok: false, error: String(err).slice(0, 200) };
    } finally {
      emitAgentEvent({ sub: "completed", agent_label: label });
    }
  });
}

export function parseMergedContent(text: string): string | null {
  const startIdx = text.indexOf("===MERGED_START===");
  const endIdx = text.lastIndexOf("===MERGED_END===");
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return null;
  let body = text.slice(startIdx + "===MERGED_START===".length, endIdx);
  // Marker satırlarının kendi newline'larını kırp (içeriği bozmadan).
  body = body.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return body;
}

/**
 * ÇAPRAZ-AİLE MAHKEMESİ: aynı dosyayı değiştiren ≥2 fix için doğru birleşimi üretir (Sonnet üretici) + düşman
 * doğrulayıcı (Sonnet) onaylar. Doğrulayıcı reddederse null → caller seri fallback. Fail-closed.
 */
async function resolveConflictMahkeme(
  cfg: MyclConfig,
  projectRoot: string,
  args: { file: string; base: string; versions: { index: number; content: string; intent: string }[] },
): Promise<string | null> {
  const label = `mahkeme-merge:${args.file.slice(-40)}`;
  return withAgentRun({ label, group: "Faz 9 Birleştirme Mahkemesi", phase: 9 }, async () => {
    emitAgentEvent({ sub: "started", agent_label: label, agent_group: "Faz 9 Birleştirme Mahkemesi", phase: 9 });
    try {
      const versionsBlock = args.versions
        .map((v) => `--- FIX ${v.index + 1} INTENT: ${v.intent.slice(0, 400)}\n--- FIX ${v.index + 1} VERSION of ${args.file}:\n${v.content}`)
        .join("\n\n");
      const userMessage = `FILE: ${args.file}\n\n=== BASE (original) ===\n${args.base}\n\n${versionsBlock}\n\nProduce the merged file between the markers.`;
      // 1) Üretici (Sonnet, çapraz aile)
      const prod = await runReasoning(cfg, {
        systemPrompt: MERGE_PRODUCER_SYSTEM,
        userMessage,
        modelId: INSPECTOR_MODEL_DEFAULT,
        projectRoot,
        maxTokens: 16_000,
      });
      if (!prod.ok) {
        log.warn("risk-fix-parallel", "mahkeme üretici başarısız → seri fallback", { file: args.file });
        return null;
      }
      const merged = parseMergedContent(prod.text);
      if (merged === null || merged.trim() === "") {
        log.warn("risk-fix-parallel", "mahkeme birleşim üretemedi (marker yok/boş) → seri fallback", { file: args.file });
        return null;
      }
      // 2) Düşman doğrulayıcı (Sonnet) — birleşim her fix'i koruyor mu? KATI: yalnız AÇIKÇA ok===true ise kabul.
      // (mahkeme bulgusu 2: doğrulayıcı ERİŞİLEMEZSE kabul etme → seri; bulgu 5: verdict null/bozuksa kabul etme → seri.)
      const verify = await runReasoning(cfg, {
        systemPrompt: MERGE_VERIFIER_SYSTEM,
        userMessage: `${userMessage}\n\n=== PROPOSED MERGE ===\n${merged}`,
        modelId: INSPECTOR_MODEL_DEFAULT,
        projectRoot,
        maxTokens: 1500,
      });
      if (!verify.ok) {
        log.warn("risk-fix-parallel", "mahkeme doğrulayıcı ERİŞİLEMEDİ → seri fallback (doğrulanmamış birleşim kabul edilmez)", { file: args.file });
        return null;
      }
      const verdict = extractKindBlock(verify.text, ["verdict"]) as { ok?: unknown } | null;
      if (!verdict || verdict.ok !== true) {
        log.warn("risk-fix-parallel", "mahkeme doğrulayıcı REDDETTİ/belirsiz → seri fallback", { file: args.file });
        return null;
      }
      return merged;
    } finally {
      emitAgentEvent({ sub: "completed", agent_label: label });
    }
  });
}

/** Profil test komutunu ana ağaçta bir kez koşar. green=true → geçti. ran=false → test komutu yok/eksik (atlandı). */
async function runConsolidatedTest(state: State): Promise<{ ran: boolean; green: boolean; tail: string }> {
  const cmd = await resolveMechanicalCmd({ type: "profile_key", key: "test" }, state).catch(() => null);
  if (!cmd) return { ran: false, green: true, tail: "" };
  try {
    await execAsync(cmd, {
      cwd: state.project_root,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...safeEnv(), LC_ALL: "C" },
    });
    return { ran: true, green: true, tail: "" };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    const out = `${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}`;
    // Komut yok / ortam hatası → GERÇEK test-fail değil → geçti say (seri yol zaten kendi anchor'ını koşar).
    if (isMissingCommand({ code: typeof e.code === "number" ? e.code : 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") })) {
      return { ran: false, green: true, tail: "" };
    }
    return { ran: true, green: false, tail: out.slice(-500) };
  }
}

/**
 * Faz 9 kod-fix'lerini izole kopyalarda PARALEL koşar + mahkeme-birleştirir + konsolide test eder.
 * ok:true → düzeltmeler ana ağaçta + test yeşil. ok:false → hiçbir kalıcı hasar YOK (revert edilir) → caller SERİ.
 */
export async function runParallelRiskFixes(
  state: State,
  cfg: MyclConfig,
  fixes: CodeFix[],
): Promise<ParallelRiskFixOutcome> {
  const root = state.project_root;
  if (fixes.length < 2) return { ok: false, reason: "<2 kod-fix → seri" };
  const baseDir = join(root, ".mycl", "parallel-fixes");
  const copies: { index: number; dir: string; fix: CodeFix }[] = [];
  const cleanup = async (): Promise<void> => {
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    // 1) İzole kopyalar
    for (let i = 0; i < fixes.length; i++) {
      const dir = join(baseDir, `fix-${i + 1}`);
      await mkdir(dir, { recursive: true });
      await copyProjectInto(root, dir);
      copies.push({ index: i, dir, fix: fixes[i] });
    }
    emitChatMessage("system", `⚡ Faz 9 — ${fixes.length} kod düzeltmesi izole kopyalarda AYNI ANDA koşuyor (git'e dokunulmaz).`);

    // 2) Fix worker'larını PARALEL koş
    const results = await Promise.allSettled(
      copies.map((c) => runFixWorker(c.fix, c.index, c.dir, cfg, state)),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "fulfilled" || !r.value.ok) {
        const err = r.status === "rejected" ? String(r.reason) : r.value.error;
        await cleanup();
        return { ok: false, reason: `paralel worker başarısız (fix ${i + 1}: ${String(err).slice(0, 120)}) → seri` };
      }
    }

    // 3) Her kopyanın GERÇEKTEN değiştirdiği dosyaları TAM-AĞAÇ FARKIYLA bul (Bash dahil her araç — mahkeme bulgusu 3/4).
    const fileToFixes = new Map<string, { index: number; content: string; intent: string }[]>();
    for (const c of copies) {
      const { changed, deleted, skipped } = await collectChangedFiles(c.dir, root);
      // SİLME: paralel yol güvenli birleştiremez (mahkeme bulgusu) → GÖRÜNÜR + seri fallback (seri Faz 8 silmeyi doğru işler).
      if (deleted.size > 0) {
        await cleanup();
        return { ok: false, reason: `fix ${c.index + 1} dosya SİLDİ (${[...deleted].slice(0, 3).join(", ")}) — paralel yol silmeyi desteklemez → seri` };
      }
      // BÜYÜK/OKUNAMAYAN değişiklik: sessizce "değişmedi" sayma (mahkeme bulgusu 2) → GÖRÜNÜR + seri (eksik-fix ok:true riski).
      if (skipped.size > 0) {
        await cleanup();
        return { ok: false, reason: `fix ${c.index + 1} büyük/okunamayan dosya değiştirdi (${[...skipped].slice(0, 3).join(", ")}) — paralel doğrulayamaz → seri` };
      }
      for (const rel of changed) {
        let copyContent: string;
        try {
          copyContent = await readFile(join(c.dir, rel), "utf-8");
        } catch {
          continue;
        }
        const arr = fileToFixes.get(rel) ?? [];
        arr.push({ index: c.index, content: copyContent, intent: c.fix.detail });
        fileToFixes.set(rel, arr);
      }
    }
    if (fileToFixes.size === 0) {
      await cleanup();
      return { ok: false, reason: "paralel düzeltmeler hiçbir dosya değiştirmedi → seri (düzeltme uygulanmadı)" };
    }

    // 4) Birleşimleri HESAPLA (yazımdan ÖNCE — mahkeme başarısızsa hiçbir şey yazılmaz). Çakışan dosya → mahkeme.
    let conflicts = 0;
    const toWrite: { rel: string; content: string; base: string; existed: boolean }[] = [];
    for (const [rel, versions] of fileToFixes) {
      let baseContent = "";
      let existed = false;
      try {
        baseContent = await readFile(join(root, rel), "utf-8");
        existed = true;
      } catch (e) {
        if (!isEnoent(e)) {
          // ENOENT DEĞİL (izin/IO) → existed=false varsayma; aksi geri almada rm ile VAR OLAN dosyayı kalıcı siler
          // (mahkeme bulgusu 1 — veri kaybı). GÖRÜNÜR + seri (temiz taban → seri Faz 8 doğru işler).
          await cleanup();
          return { ok: false, reason: `base dosya okunamadı (${rel}: ${String(e).slice(0, 60)}) — güvenlik için seri` };
        }
        existed = false; // gerçekten yok → yeni dosya
      }
      if (versions.length === 1) {
        toWrite.push({ rel, content: versions[0].content, base: baseContent, existed });
        continue;
      }
      // ÇAKIŞMA: aynı dosyayı ≥2 fix değiştirdi → mahkeme.
      const tooBig = baseContent.length > MAX_MERGE_FILE_BYTES || versions.some((v) => v.content.length > MAX_MERGE_FILE_BYTES);
      if (tooBig) {
        await cleanup();
        return { ok: false, reason: `çakışan dosya çok büyük (${rel}) — mahkeme güvenilmez → seri` };
      }
      conflicts++;
      emitChatMessage("system", `⚖️ Birleştirme çakışması: ${rel} — mahkeme (Sonnet) doğru birleşimi üretiyor…`);
      const merged = await resolveConflictMahkeme(cfg, root, { file: rel, base: baseContent, versions });
      if (merged === null) {
        await cleanup();
        return { ok: false, reason: `mahkeme birleşimi başarısız (${rel}) → seri` };
      }
      toWrite.push({ rel, content: merged, base: baseContent, existed });
    }

    // 4.5) B1.1 YABANCI-YAZMA HASSAS ONAYI (foreign): B1 kapısı NİYET kapsamıyla sordu; burada GERÇEK dosya listesi
    // (toWrite) belli → yazımdan ÖNCE kesin dosyalar + EDD-dokunulan davranışla son onay. Red → userRejected (caller
    // SERİ fallback YAPMAZ; kod-fix atlanır). İzole kopyalar zaten temizlenir → ana ağaç dokunulmadı.
    if (state.origin === "foreign") {
      const ok = await confirmForeignWriteFiles(state, cfg, toWrite.map((w) => w.rel));
      if (!ok) {
        await cleanup();
        return { ok: false, userRejected: true, reason: "kullanıcı gerçek-dosya onayını reddetti — kod düzeltmeleri uygulanmadı" };
      }
    }

    // 5) UYGULA → konsolide test → kırmızıysa VEYA yazım/test sırasında HERHANGİ bir hatada TÜM yazılanları base'e
    // GERİ AL (ana ağaç yarı-değişik kalmasın; seri fallback TEMİZ tabana koşsun — KATI #4/#2). Yalnız GERÇEKTEN
    // yazdıklarımı geri alırım (written), yeni dosyaları silerim.
    const written: typeof toWrite = [];
    let testRan = false;
    // revertAll GERİ-ALMA HATALARINI DÖNER (mahkeme bulgusu 1: sessiz yutma → ana ağaç yarı-değişik kalabilir).
    // Kısmi başarısızlıkta caller GÖRÜNÜR uyarır (KATI #4) — sessizce seri yola düşmez.
    const revertAll = async (): Promise<string[]> => {
      const failed: string[] = [];
      for (const w of written) {
        const dest = join(root, w.rel);
        try {
          if (w.existed) {
            await writeFile(dest, w.base, "utf-8");
          } else {
            await rm(dest, { force: true });
            // Yeni dosya için açılmış olabilecek boş üst-dizini best-effort kaldır (mahkeme bulgusu 3 — kozmetik artık).
            // rmdir DOLU dizinde başarısız olur → paylaşılan/dolu dizin ASLA silinmez (güvenli, tek-seviye).
            await rmdir(dirname(dest)).catch(() => {});
          }
        } catch (e) {
          failed.push(w.rel);
          log.error("risk-fix-parallel", "GERİ ALMA BAŞARISIZ — dosya ana ağaçta doğrulanmamış içerikle kaldı", { file: w.rel, err: String(e).slice(0, 120) });
        }
      }
      return failed;
    };
    // Geri-alma sonrası kısmi başarısızlığı GÖRÜNÜR + ciddi reason ile bildir; aksi mevcut "seri fallback" mesajı.
    const failReason = (base: string, reverted: string[]): string => {
      if (reverted.length === 0) return `${base} → geri alındı → seri (tam test-odaklı)`;
      emitError(
        `⛔ Paralel düzeltme geri alınırken ${reverted.length} dosya ESKİ HALİNE DÖNDÜRÜLEMEDİ (${reverted.join(", ").slice(0, 120)}) — ana ağaçta doğrulanmamış içerik kalmış olabilir, ELLE KONTROL et.`,
        reverted.join(", "),
      );
      return `${base} → PARÇALI GERİ ALMA BAŞARISIZ (${reverted.length} dosya) → seri (elle kontrol gerekebilir)`;
    };
    try {
      for (const w of toWrite) {
        const dest = join(root, w.rel);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, w.content, "utf-8");
        written.push(w);
      }
      await appendAudit(root, {
        ts: Date.now(),
        phase: 9,
        event: "risk-fix-parallel-applied",
        caller: "mycl-orchestrator",
        detail: `${fixes.length} fix paralel; ${toWrite.length} dosya; ${conflicts} çakışma mahkemeyle çözüldü`,
      }).catch(() => {});

      emitChatMessage("system", "🧪 Paralel düzeltmeler birleştirildi — tüm test takımı bir kez koşuluyor (konsolide doğrulama)…");
      const test = await runConsolidatedTest(state);
      testRan = test.ran;
      if (test.ran && !test.green) {
        const reverted = await revertAll();
        await cleanup();
        return { ok: false, reason: failReason(`konsolide test KIRMIZI. ${test.tail.slice(0, 120)}`, reverted), treeCorrupted: reverted.length > 0 };
      }
      // ÇAKIŞMA çözüldü AMA test komutu yok (mahkeme bulgusu 2-b): mahkeme-birleşimini doğrulayacak DETERMİNİSTİK
      // hakem yok → tek başına LLM doğrulayıcıya güvenme → geri al + seri (o fix'ler tam TDD'den geçsin).
      if (conflicts > 0 && !testRan) {
        const reverted = await revertAll();
        await cleanup();
        return { ok: false, reason: failReason("çakışma çözüldü ama test komutu yok (deterministik hakem yok)", reverted), treeCorrupted: reverted.length > 0 };
      }
    } catch (applyErr) {
      const reverted = await revertAll(); // yazım/test sırasında beklenmedik hata → geri al → temiz base → seri
      await cleanup();
      return { ok: false, reason: failReason(`paralel uygulama hatası: ${String(applyErr).slice(0, 100)}`, reverted), treeCorrupted: reverted.length > 0 };
    }

    await cleanup();
    return {
      ok: true,
      reason: testRan
        ? `${fixes.length} fix paralel + konsolide test YEŞİL (${toWrite.length} dosya, ${conflicts} çakışma mahkemeyle çözüldü)`
        : `${fixes.length} fix paralel + entegre (${toWrite.length} dosya; test komutu yok → Faz 10+ kapıları doğrular)`,
      integratedFiles: toWrite.map((w) => w.rel),
      conflictsResolved: conflicts,
    };
  } catch (err) {
    log.error("risk-fix-parallel", "paralel risk-fix beklenmedik hata → seri fallback", err);
    await cleanup();
    return { ok: false, reason: `paralel risk-fix hata: ${String(err).slice(0, 160)} → seri` };
  }
}
