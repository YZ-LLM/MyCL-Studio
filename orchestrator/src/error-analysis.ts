// error-analysis — F1: bir HATA olunca MyCL analiz eder. 2026-06-10 (YZLLM: "kolayca
// çözebileceği şeyi bile soruyor — kendisi en iyi çözümü bulup çözsün"): varsayılan artık
// OTO-ÇÖZÜM — ajan best_index ile en iyi çözümü seçer, failPhase sormadan uygular (kullanıcı
// kararı + alternatifleri chat'te görür). askq yalnız fallback: çözüm üretilemedi / oto-deneme
// limiti (failPhase guard) doldu / güvenlik override (Kabul et, devam et — hep insan kararı).
// Faz-fail bir helper'dan (failPhase, index.ts) tetiklenir.
//
// Backend: ORKESTRATÖR rolü (ana ajana/codegen'e GİTMEZ — kullanıcı kuralı).
// living-docs.ts deseni birebir: abonelik/CLI modunda runClaudeCli (Read/Grep/
// Glob/Bash açık → ajan kodu/hatayı inceler). Ajan tek bir {"kind":"error_analysis",
// ...} JSON bloğu döner; extractKindBlock ile parse. TR çıktı UI'da gösterilir
// (orkestrator rolü, ana ajan değil → TR meşru). Görünür + fail-closed: claude
// hatası ya da blok üretilememesi → görünür hata mesajı + audit + null id döner
// (caller askq açmaz). Sessiz fallback YOK.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve as resolvePath, relative as relPath, isAbsolute } from "node:path";
import { appendAudit } from "./audit.js";
import { extractKindBlock } from "./cli-json.js";
import Anthropic from "@anthropic-ai/sdk";
import { runClaudeCli } from "./cli-run.js";
import { READ_ONLY_DISALLOWED_TOOLS } from "./tool-policy.js";
import { resolveLlmClient, isApiAccountError } from "./claude-api.js";
import { backendForRole, orchestratorModelId, resolveProvider, zaiKeyForRole, type MyclConfig } from "./config.js";
import { buildProjectFacts } from "./project-facts.js";
import { type AskqOption, emitAskq, emitChatMessage, emitClaudeStream } from "./ipc.js";
import { VERIFY_BEFORE_CLAIM, DECISION_PRINCIPLES, USER_FACING_CLARITY_RULE } from "./agent-language.js";
import { log } from "./logger.js";
import type { PhaseId, State } from "./types.js";

/** Faz-fail bağlamı — caller (failPhase) doldurur. */
export interface ErrorContext {
  /** Hatanın oluştuğu faz (audit + UI için). */
  phase: PhaseId;
  /** Kullanıcıya gösterilecek hata mesajı (phaseFailMessage çıktısı). */
  message: string;
  /** Opsiyonel ham hata detayı (stderr/exception) — prompt'a beslenir. */
  detail?: string;
  /**
   * Güvenlik-baseline Unit 2: BLOCKING gate (örn. Faz 13 güvenlik). true ise askq
   * "Kabul et, devam et" (OPT_ACCEPT_CONTINUE) seçeneği EKLER + blocking'e zorlar —
   * "TAMAMLANDI deme" (soft→blocking) ama "takılma yok" (kullanıcı override edebilir).
   */
  allowAcceptContinue?: boolean;
  /**
   * "Kabul et, devam et" seçilirse hangi fazın `phase-N-complete`
   * (detail:"security_accepted_by_user") yazılıp advanceToNextPhase(N) çağrılacağı.
   * allowAcceptContinue=true iken set edilmeli (yoksa accept-continue dalı no-op).
   */
  acceptContinuePhase?: number;
  /**
   * YZLLM 2026-07-01 (FIX B): AYNI hata daha önce denendiyse, kullanıcının/otonun seçtiği önceki çözümler.
   * Prompt'a "bunlar uygulandı ama gate HÂLÂ fail — TEKRARLAMA, daha derin kök / farklı yaklaşım / kasıtlı mı?"
   * olarak enjekte edilir → aynı-soru döngüsü kırılır (analiz farklı bir çözüme ya da "kabul et"e yönelir).
   */
  priorAttempts?: string[];
  /**
   * YZLLM 2026-07-01 (FIX A): manuel modda aynı hata MANUAL_LOOP_MAX kez sürdü (döngü tükendi). true ise askq
   * eski çözüm listesini TEKRAR sunmaz; farklı seçenekler verir (kabul-kalıcı / farklı-yaklaşım / dur).
   */
  loopExhausted?: boolean;
}

/**
 * YZLLM 2026-07-03: kod-konumu referansı — "Kodu göster" salt-okunur popup'ını besler. Orkestratör
 * proje-kökü sınırlı okumayla (tool-handlers normalizeAndCheck) snippet'i doldurur; ön yüz dosyaya DOKUNMAZ
 * (Tauri fs yok). Konum belirlenemezse code_ref YOK → buton çıkmaz (fail-soft).
 */
export interface CodeRef {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

/**
 * YZLLM 2026-07-03 (teker teker sor): tek bir DISTINCT sorun. Bir gate-fail birden çok distinct sorun
 * bulursa (SQL-injection + test parolaları + 3.taraf takvim = 3 finding), her biri ayrı ayrı sorulur.
 * İlişkili düşük-seviye sonuçlar TEK finding'te gruplanır (20 semgrep satırı = 3 finding, 20 değil).
 */
export interface ErrorFinding {
  summary_tr: string;
  detail_tr?: string;
  solutions_tr: string[];
  best_index: number;
  code_ref?: CodeRef;
}

/** Ajanın döndüğü analiz bloğu (parse + doğrulama sonrası). */
export interface ErrorAnalysis {
  blocking: boolean;
  summary_tr: string;
  /** YZLLM 2026-06-30: teknik açıklama (dosya/satır/kod) — kullanıcıya YALNIZ "Detay" açınca gösterilir.
   *  Boş/yoksa "Detay" toggle'ı çıkmaz (geriye uyumlu). summary_tr sade kalır. */
  detail_tr?: string;
  solutions_tr: string[];
  /** Ajanın UYGULAYACAĞI çözümün 0-tabanlı index'i (doğruluk önce, sonra en düşük risk). */
  best_index: number;
  /**
   * YZLLM 2026-07-03 (teker teker sor): DISTINCT sorunların listesi. Parser HER ZAMAN ≥1 eleman verir —
   * `findings` alanı yoksa üst-seviye alanlardan tek eleman sentezlenir (geriye uyumlu: 1 finding = bugünkü
   * tek-soru yolu birebir). >1 ise orkestratör bir bulgu-kuyruğu kurar (finding-queue.ts) + teker teker sorar.
   */
  findings: ErrorFinding[];
}

/**
 * runtime.pendingErrorAnalysis ile eşleştirilen kayıt. handleAskqAnswer yeni
 * branch'i bu id ile askq cevabını analiz seçeneklerine eşler.
 */
export interface PendingErrorAnalysis {
  id: string;
  phase: PhaseId;
  blocking: boolean;
  /** YZLLM 2026-07-01 (FIX B): bu hatanın imzası — kullanıcı cevap verince seçim bu sig'e kaydedilir (karar hafızası). */
  sig?: string;
  /** Sıralı askq seçenekleri (UI'daki sırayla — index eşlemesi için). */
  options: string[];
  /** Ajanın önerdiği çözümler (TR). "Çöz" → debug akışına bunlar bağlam olur. */
  solutions_tr: string[];
  /**
   * Güvenlik-baseline Unit 2: "Kabul et, devam et" seçilirse phase-N-complete
   * (detail:"security_accepted_by_user") yazılıp advanceToNextPhase(N) çağrılacak faz.
   * undefined → accept-continue seçeneği sunulmadı (normal hata akışı).
   */
  acceptContinuePhase?: number;
  /**
   * 2026-06-10 (YZLLM: "hata çözümünü sorma, kendisi çözsün"): set ise askq AÇILMAMIŞTIR;
   * failPhase bu çözümü handleAskqAnswer ile otomatik route eder (aynı yol, soru yok).
   */
  auto_selected_solution?: string;
  /**
   * YZLLM 2026-06-26: Claude (abonelik+API) kredi/limit hatası AMA z.ai (GLM) anahtarı VAR + henüz z.ai'de
   * DEĞİLİZ → "tüm sağlayıcılar tükendi" demek YALAN olur (z.ai hiç denenmedi; canlı: $6.29 bakiye varken
   * "tükendi" dedi). Bu durumda failPermanent YERİNE bu sinyal döner; failPhase TÜM rolleri z.ai'ya geçirip
   * fazı tekrar koşar (askq AÇILMAZ — sentinel). Diğer alanlar boştur.
   */
  needsProviderSwitch?: boolean;
  /**
   * YZLLM 2026-07-03 (cevap-hatırlama merdiveni): bu pending, kullanıcının GERÇEK seçimi değil, kayıtlı bir
   * cevabın YENİDEN uygulanmasıdır (Kademe 2/3). handleAskqAnswer bunu görünce cevabı answer-memory'ye TEKRAR
   * kaydetmez (reuseApproved bayrağını sıfırlamasın). Yalnız applyRecalledErrorAnswer set eder.
   */
  fromRecall?: boolean;
  /**
   * YZLLM 2026-07-03 (teker teker sor): triage'ın bulduğu TÜM distinct finding'ler. >1 ise orkestratör
   * bir bulgu-kuyruğu kurar (finding-queue.ts). Bu pending yalnız KUYRUKTAKİ MEVCUT finding'i temsil eder.
   */
  findings?: ErrorFinding[];
  /**
   * YZLLM 2026-07-03: bu pending'in mesajına iliştirilmiş kod-konumu ("Kodu göster" popup'ı). handleAskqAnswer
   * için işlevsel değil; yalnız plumbing izlenebilirliği (asıl taşıyıcı emitChatMessage code_ref'idir).
   */
  code_ref?: CodeRef;
}

// Sabit seçenek etiketleri (TR — orkestrator çıktısı UI'da gösterilir).
// EXPORT: index.ts handleAskqAnswer branch'i bu BİREBİR string'lerle eşleşir
// (elle yeniden yazınca TR-karakter/yazım drift'i eşlemeyi kırardı → tek kaynak).
export const OPT_SOLVE = "Çöz";
export const OPT_REANALYZE = "Tekrar analiz et";
export const OPT_QUEUE = "İş listesine kaydet, çözmeden devam et";
// Güvenlik-baseline Unit 2: blocking gate'te kullanıcı override (bulguyu kabul edip devam).
export const OPT_ACCEPT_CONTINUE = "Kabul et, devam et";
// FIX D (YZLLM 2026-07-01): aynı gate döngüsü tükendiğinde kullanıcı bulguyu KALICI kabul eder →
// bir sonraki iterasyonda kapı o bulguyu ARTIK işaretlemez (.mycl/accepted-findings.jsonl). Döngü kalıcı kırılır.
export const OPT_ACCEPT_PERMANENT = "Kabul et — kalıcı, bir daha sorma";
// FIX A: loop tükendiğinde "elle inceleyeceğim" — işi park et, aynı soruyu körü körüne tekrarlama.
export const OPT_STOP_MANUAL = "Dur — elle inceleyeceğim";

/**
 * SAF: analiz çıktısından askq seçeneklerini kur (test edilebilir, yan etki yok).
 *
 * İki şekil:
 * - blocking → çözüm seçenekleri + "Tekrar analiz et" (çözmeden ilerlemek
 *   imkânsız; "iş listesine kaydet" YOK).
 * - non-blocking → ["İş listesine kaydet, çözmeden devam et", ...çözümler]
 *   + "Tekrar analiz et". Çözüm yoksa jenerik "Çöz" konur (akış tıkanmasın).
 *
 * Çözümler trim + boş eleme + dedup; her şekilde sonda "Tekrar analiz et".
 */
export function buildErrorAnalysisAskq(
  solutions_tr: string[],
  blocking: boolean,
  opts?: {
    allowAcceptContinue?: boolean;
    permanentNoProvider?: boolean;
    loopExhausted?: boolean;
    allowPermanentAccept?: boolean;
  },
): { options: AskqOption[] } {
  const allowAcceptContinue = opts?.allowAcceptContinue === true;
  const permanentNoProvider = opts?.permanentNoProvider === true;
  const loopExhausted = opts?.loopExhausted === true;
  const allowPermanentAccept = opts?.allowPermanentAccept === true;
  const seen = new Set<string>();
  const solutions: string[] = [];
  for (const s of solutions_tr) {
    const t = typeof s === "string" ? s.trim() : "";
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    solutions.push(t);
  }

  const options: string[] = [];
  // KALICI sağlayıcı-yok (kredi/yetki bitti): "Çöz", çözüm-uygula ve "Tekrar analiz" HEPSİ bir sağlayıcı
  // (CLI/API/z.ai) ister → hep aynı hatayı verir → sonsuz döngü (canlı bug). Yalnız "kaydet + devam"
  // (+ blocking gate'te kabul) sun; sağlayıcı dönünce iş listesinden tekrar denenir.
  if (permanentNoProvider) {
    options.push(OPT_QUEUE);
    if (allowAcceptContinue) options.push(OPT_ACCEPT_CONTINUE);
    return { options };
  }
  // FIX A/D (YZLLM 2026-07-01): aynı gate döngüsü tükendi (MANUAL_LOOP_MAX/AUTO_SOLVE_MAX) → AYNI çözümleri
  // körü körüne TEKRAR sunma. Kalıcı-kabul (bulgu kasıtlıysa) + memory-aware analizin FARKLI önerileri + park.
  if (loopExhausted) {
    if (allowPermanentAccept) options.push(OPT_ACCEPT_PERMANENT);
    if (allowAcceptContinue) options.push(OPT_ACCEPT_CONTINUE);
    options.push(...solutions); // buildErrorAnalysisPrompt priorAttempts enjeksiyonu → bunlar öncekilerden farklı
    options.push(OPT_STOP_MANUAL);
    options.push(OPT_REANALYZE);
    return { options };
  }
  if (!blocking) {
    // Bloklayıcı değil: çözmeden devam etme seçeneği en başta.
    options.push(OPT_QUEUE);
  }
  if (solutions.length > 0) {
    options.push(...solutions);
  } else if (!blocking || allowAcceptContinue) {
    // Çözüm üretilemedi → jenerik "Çöz" (debug akışı tetiklensin). Non-blocking'de
    // ya da blocking-ama-accept-continue (güvenlik gate) durumunda bir solve yolu şart.
    options.push(OPT_SOLVE);
  }
  if (allowAcceptContinue) {
    // Güvenlik-baseline Unit 2: blocking gate'te kullanıcı bulguyu kabul edip
    // devam edebilir (override). "İş listesine kaydet" değil — bu blocking, kabul+devam.
    options.push(OPT_ACCEPT_CONTINUE);
  }
  // Her şekilde en sonda yeniden analiz.
  options.push(OPT_REANALYZE);

  return { options };
}

/**
 * SAF: ajan serbest metninden {kind:"error_analysis"} bloğunu parse + doğrula.
 * summary_tr zorunlu (boş olamaz); solutions_tr string dizisi (yoksa []).
 * Bulunamazsa / geçersizse null (caller görünür hata verir, sessiz değil).
 */
/** Teker-teker güvenliği: en çok bu kadar ayrı soru sorulur; fazlası tek "diğer bulgular" entry'sinde
 *  birleştirilir (LLM aşırı-bölerse 20-soru felaketini önler; hiçbir bulgu SESSİZCE düşmez — KATI #4). */
const MAX_FINDINGS = 8;

/** SAF: LLM'in verdiği code_ref'i gevşek doğrula (file + satır gerekli; snippet'i orkestratör doldurur). */
function parseCodeRefLoose(obj: unknown): CodeRef | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const file = o.file;
  if (typeof file !== "string" || file.trim() === "") return null;
  const rawLine = typeof o.startLine === "number" ? o.startLine : typeof o.line === "number" ? o.line : undefined;
  if (typeof rawLine !== "number" || !Number.isFinite(rawLine)) return null;
  const startLine = Math.max(1, Math.floor(rawLine));
  const endRaw = typeof o.endLine === "number" && Number.isFinite(o.endLine) ? Math.floor(o.endLine) : startLine;
  const endLine = Math.max(startLine, endRaw);
  const snippet = typeof o.snippet === "string" ? o.snippet : "";
  return { file: file.trim(), startLine, endLine, snippet };
}

/** SAF: bir finding objesini doğrula (summary_tr zorunlu; boşsa null). */
function parseOneFinding(obj: unknown): ErrorFinding | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const summary = o.summary_tr;
  if (typeof summary !== "string" || summary.trim() === "") return null;
  const rawSolutions = o.solutions_tr;
  const solutions_tr = Array.isArray(rawSolutions)
    ? rawSolutions.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter((s) => s !== "")
    : [];
  const rawBest = o.best_index;
  const best_index =
    typeof rawBest === "number" && Number.isInteger(rawBest) && rawBest >= 0 && rawBest < solutions_tr.length
      ? rawBest
      : 0;
  const rawDetail = o.detail_tr;
  const detail_tr = typeof rawDetail === "string" && rawDetail.trim() !== "" ? rawDetail.trim() : undefined;
  const code_ref = parseCodeRefLoose(o.code_ref);
  return { summary_tr: summary.trim(), detail_tr, solutions_tr, best_index, ...(code_ref ? { code_ref } : {}) };
}

export function parseErrorAnalysisBlock(text: string): ErrorAnalysis | null {
  const block = extractKindBlock(text, ["error_analysis"]);
  if (!block) return null;
  const o = block as Record<string, unknown>;
  const blocking = o.blocking === true;

  // YZLLM 2026-07-03 (teker teker sor): findings[] varsa her DISTINCT sorunu ayrıştır; yoksa üst-seviye
  // alanlardan tek eleman sentezle (GERİYE UYUMLU — 1 finding = bugünkü tek-soru yolu birebir).
  let findings: ErrorFinding[] = [];
  if (Array.isArray(o.findings)) {
    findings = o.findings.map(parseOneFinding).filter((f): f is ErrorFinding => f !== null);
  }
  if (findings.length === 0) {
    const flat = parseOneFinding(o);
    if (!flat) return null; // ne findings ne düz-alan → geçersiz (caller görünür hata verir)
    findings = [flat];
  }
  // Soft cap: aşırı-bölmede fazlası TEK "diğer bulgular" entry'sinde birleşir (sessizce düşmez).
  if (findings.length > MAX_FINDINGS) {
    const head = findings.slice(0, MAX_FINDINGS - 1);
    const tail = findings.slice(MAX_FINDINGS - 1);
    const mergedSolutions = Array.from(new Set(tail.flatMap((f) => f.solutions_tr)));
    head.push({
      summary_tr: `Diğer ${tail.length} güvenlik bulgusu (birlikte ele alınacak)`,
      detail_tr: tail.map((f, i) => `${i + 1}. ${f.summary_tr}`).join("\n"),
      solutions_tr: mergedSolutions.length > 0 ? mergedSolutions : ["Kalan bulguların hepsini kaynağında düzelt"],
      best_index: 0,
    });
    findings = head;
  }
  const head = findings[0];
  return {
    blocking,
    summary_tr: head.summary_tr,
    detail_tr: head.detail_tr,
    solutions_tr: head.solutions_tr,
    best_index: head.best_index,
    findings,
  };
}

/** Snippet için okunacak bağlam satır sayısı (finding satırının etrafı). */
const CODE_SNIPPET_CONTEXT = 3;

/**
 * PROJE-KÖKÜ SINIRLI salt-okuma: finding'in code_ref'ine gerçek snippet'i ekler ("Kodu göster" popup'ı).
 * tool-handlers normalizeAndCheck deseni — dosya kök DIŞINDAysa veya okunamıyorsa `undefined` döner
 * (buton çıkmaz; fail-soft — kod gösterememek akışı bozmaz). Ön yüz dosyaya ASLA dokunmaz (snippet gömülür).
 */
export async function resolveCodeRef(
  projectRoot: string,
  ref: CodeRef | undefined,
): Promise<CodeRef | undefined> {
  if (!ref || !ref.file) return undefined;
  try {
    const rootAbs = resolvePath(projectRoot);
    const abs = isAbsolute(ref.file) ? resolvePath(ref.file) : resolvePath(rootAbs, ref.file);
    // GÜVENLİK (mahkeme, YZLLM 2026-07-03): salt string/".." kontrolü YETMEZ — proje kökü İÇİNDEKİ bir symlink
    // kök DIŞINI gösterebilir (ör. SSH anahtarı). fs.realpath ile GERÇEK dosya kimliğini çöz + kök'ün realpath'ine
    // göre containment doğrula. realpath dosya yoksa throw → catch → undefined (fail-soft, buton yok).
    const rootReal = await fs.realpath(rootAbs);
    const absReal = await fs.realpath(abs);
    const rel = relPath(rootReal, absReal);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined; // kök dışı (symlink dahil) → buton yok
    const content = await fs.readFile(absReal, "utf8");
    const lines = content.split("\n");
    if (lines.length === 0) return undefined;
    const start = Math.min(Math.max(1, ref.startLine), lines.length);
    const end = Math.min(Math.max(start, ref.endLine), lines.length);
    const from = Math.max(1, start - CODE_SNIPPET_CONTEXT);
    const to = Math.min(lines.length, end + CODE_SNIPPET_CONTEXT);
    const snippet = lines
      .slice(from - 1, to)
      .map((ln, i) => `${String(from + i).padStart(4)} | ${ln}`)
      .join("\n");
    return { file: ref.file, startLine: from, endLine: to, snippet };
  } catch {
    return undefined; // okunamıyor → fail-soft
  }
}

/**
 * YZLLM 2026-07-03 (teker teker sor): TEK bir blocking finding'in özet mesajı + askq'sini emit eder, pending döner.
 * analyzeAndAskError'ın emisyon mantığının yeniden-kullanılabilir hali — bulgu-kuyruğunda finding[1..] için
 * (finding-queue advanceFindingQueue) çağrılır. Auto modda en iyi çözümü seçip askq açmaz (auto_selected_solution).
 */
export function emitBlockingFindingAskq(
  finding: ErrorFinding,
  opts: { phase: PhaseId; sig?: string; acceptContinuePhase?: number; auto: boolean; rawDetail?: string },
): PendingErrorAnalysis {
  const { options } = buildErrorAnalysisAskq(finding.solutions_tr, true, { allowAcceptContinue: true });
  const optionLabels = options.map((o) => (typeof o === "string" ? o : o.label));
  const id = `error_analysis_${randomUUID()}`;
  const msgDetail = finding.detail_tr ?? opts.rawDetail;
  const best = finding.solutions_tr[finding.best_index];
  if (opts.auto && typeof best === "string" && best.trim() !== "") {
    const others = finding.solutions_tr.filter((_, i) => i !== finding.best_index);
    emitChatMessage(
      "assistant",
      `${finding.summary_tr}\n\n🤖 **En iyi çözüm otomatik seçildi:** ${best}` +
        (others.length > 0 ? `\nDeğerlendirilen alternatifler:\n${others.map((s) => `- ${s}`).join("\n")}` : ""),
      { detail: msgDetail, code_ref: finding.code_ref },
    );
    return {
      id,
      phase: opts.phase,
      blocking: true,
      sig: opts.sig,
      options: optionLabels,
      solutions_tr: finding.solutions_tr,
      acceptContinuePhase: opts.acceptContinuePhase,
      code_ref: finding.code_ref,
      auto_selected_solution: best.trim(),
    };
  }
  emitChatMessage(
    "assistant",
    `${finding.summary_tr}\nBu hata çözülmeden ilerlemek mümkün değil. Nasıl ilerleyelim?`,
    { detail: msgDetail, code_ref: finding.code_ref },
  );
  emitAskq({
    id,
    question: `Faz ${opts.phase} hatası — çözülmeden ilerlenemez. Nasıl ilerleyelim?`,
    options,
  });
  return {
    id,
    phase: opts.phase,
    blocking: true,
    sig: opts.sig,
    options: optionLabels,
    solutions_tr: finding.solutions_tr,
    acceptContinuePhase: opts.acceptContinuePhase,
    code_ref: finding.code_ref,
  };
}

/** Pure: orkestratör analiz prompt'unu kur (test edilebilir). canInvestigate=false → API tek-atış (tool yok).
 *  projectFacts: proje-gerçekleri özeti (dil JS/TS, framework...) — ajan körüne karar vermesin. */
export function buildErrorAnalysisPrompt(
  errCtx: ErrorContext,
  canInvestigate = true,
  projectFacts?: string,
): string {
  return [
    "You are MyCL Studio's orchestrator. A phase in the build pipeline just FAILED.",
    canInvestigate
      ? "Inspect the codebase (Read/Grep/Glob/Bash are available) to understand the failure,"
      : "Reason from the error message and raw detail below (no tools available — use the given evidence),",
    "then produce a short root-cause analysis and concrete next steps for the developer.",
    "",
    ...(projectFacts && projectFacts.trim()
      ? [
          projectFacts.trim(),
          "Use these facts: do NOT propose changes that contradict the project's nature (e.g. adding a tsconfig",
          "or TypeScript tooling to a JavaScript project). A tool that doesn't fit the project type is the TOOL's",
          "problem (skip it), not a project defect.",
          "",
        ]
      : []),
    `Failed phase: ${errCtx.phase}`,
    "Error message shown to the developer:",
    errCtx.message,
    ...(errCtx.detail && errCtx.detail.trim()
      ? ["", "Raw error detail:", errCtx.detail.slice(0, 4000)]
      : []),
    // YZLLM 2026-07-01 (FIX B): aynı hata tekrarladıysa önceki denemeleri ENJEKTE et → LLM aynı çözüme dönmesin.
    ...(errCtx.priorAttempts && errCtx.priorAttempts.length
      ? [
          "",
          "PREVIOUS ATTEMPTS for THIS SAME failure (already applied, but the gate STILL fails — so the root",
          "cause is NOT what these changed). DO NOT re-propose them:",
          ...errCtx.priorAttempts.map((s) => `- ${s}`),
          "Find a DEEPER root cause OR a genuinely DIFFERENT approach. Critically: could this finding be",
          "INTENTIONAL / by-design (e.g. a dev-only seeded credential a test/review harness needs, a marker the",
          "spec asked for)? If so, it is a FALSE-POSITIVE — say so and recommend the user ACCEPT it (document it),",
          "NOT re-fix it. Repeating the same fix that already failed is the wrong move.",
        ]
      : []),
    "",
    "Decide whether this error is BLOCKING (the pipeline genuinely cannot proceed",
    "until it is resolved) or NON-BLOCKING (work could continue and the fix queued).",
    "",
    "Emit EXACTLY ONE JSON object as the LAST thing in your reply, no other JSON.",
    "If the failure contains MULTIPLE DISTINCT problems (e.g. a SQL-injection in a search screen, seeded test",
    "passwords, and a vulnerable 3rd-party calendar dependency = 3 DISTINCT problems), emit ONE `findings` entry",
    "per DISTINCT problem — GROUP related low-level results into a single finding (3 problems, NOT 20 separate",
    "semgrep lines). If there is only ONE problem, `findings` has exactly ONE entry.",
    '{"kind":"error_analysis","blocking":<true|false>,"findings":[{"summary_tr":"<1-2 SHORT plain-language sentences IN TURKISH: what broke, in human terms — NO file paths, line numbers, or code>","detail_tr":"<fuller technical explanation IN TURKISH (file/line/code OK) — shown ONLY on demand via Details; PREFER filling it for a code-level failure; use \"\" only for a pure environment error>","solutions_tr":["<a SHORT plain-language DIRECTION IN TURKISH — a few words, NOT a full patch, no line numbers/code/endpoint paths>","<option 2>"],"best_index":<0-based index of the solution YOU would apply>,"code_ref":{"file":"<repo-relative path this finding is about>","startLine":<1-based line>,"endLine":<1-based end line>}}]}',
    "",
    "`code_ref` is OPTIONAL per finding: include it ONLY when the finding points to a SPECIFIC place in the",
    "project's source (so the developer can press \"Kodu göster\"). OMIT `code_ref` for findings with no single",
    "code location (e.g. a dependency CVE from npm-audit). Do NOT include a snippet — MyCL fills it from disk.",
    "",
    "Rules: summary_tr, detail_tr, and every solutions_tr entry MUST be in Turkish (the developer reads Turkish).",
    "summary_tr = the PLAIN essence for a non-technical reader (no file:line, no code). detail_tr = the technical",
    "detail (file/line/code allowed — shown only on demand); if none, use \"\". Each solution is a distinct SHORT",
    "DIRECTION (a few words — not a restatement of the error, not a full patch/step-by-step). 2-4 solutions per finding.",
    'Do NOT include a "queue it" / "re-analyze" option — MyCL adds those automatically.',
    "",
    "DIAGNOSE THE ACTUAL ERROR, not generic causes. If a 'Spawn output' / 'actual error'",
    "is provided above, the root cause is IN THAT OUTPUT — read it. Common classes:",
    "- 'argument list too long' / E2BIG → the ENVIRONMENT (shell env too large), NOT the",
    "  project. Fix: trim env / new shell — do NOT touch project code, deps, or ports.",
    "- 'command not found' / ENOENT → missing script or dependency, NOT a port issue.",
    "- 'EADDRINUSE' / port in use → port conflict (free the port / pick another).",
    "- the SAME failure persists after a fix → the cause is NOT what you changed; widen",
    "  the diagnosis (environment/external), do NOT repeat project-level edits.",
    "- Claude account/credit/usage-limit error ('credit balance too low', usage limit, billing/auth) → an",
    "  EXTERNAL provider/billing issue, NOT a code bug. MyCL HAS an automatic z.ai (GLM) fallback for",
    "  main/orchestrator/translator turns (both SDK and CLI) when a z.ai key is configured — do NOT tell the",
    "  user 'there is no fallback / no architectural z.ai switch'. The only blocking case is when z.ai is ALSO",
    "  missing or failing; then advise topping up Claude credit OR adding a z.ai key. Do NOT retry a dead provider.",
    "GATE INTEGRITY: NEVER propose a solution that makes a gate pass by WEAKENING it — no deleting/skipping",
    "tests, loosening assertions, disabling lint rules, eslint-disable, lowering thresholds, or editing the",
    "gate/lint/tsconfig config to ignore the failure. Fix the underlying CODE so the gate passes honestly.",
    "best_index: pick the solution YOU would apply (correctness first, then lowest",
    "risk) — MyCL may AUTO-APPLY it without asking the user. RANK by reversibility &",
    "cost: cheap reversible code/config edits FIRST; slow/destructive actions (deleting",
    "node_modules, full reinstall, wiping caches) LAST and only if the error output",
    "clearly points to corrupted deps. Prefer fixes MyCL can execute over manual ones.",
    "",
    VERIFY_BEFORE_CLAIM, // YZLLM 2026-06-12: kök-neden bir HİPOTEZDIR — doğrulamadan fix uygulama (yanlış-fix önle).
    "",
    DECISION_PRINCIPLES, // Parça 3: no-silent-fallback / kuşkuda-fail-closed / correct-by-construction (YZLLM gibi karar).
    USER_FACING_CLARITY_RULE, // YZLLM 2026-06-30: summary_tr sade/insan-odaklı, detay detail_tr'ye, çözümler kısa yön.
  ].join("\n");
}

/**
 * IMPURE: hatayı orkestratör rolüyle analiz et, UI'a özet + askq bas, runtime
 * pending eşlemesi için kaydı döndür. NON-BLOCKING — askq açar, ana akışı
 * kilitlemez. Fail-closed: claude hatası / blok üretilememesi → görünür hata
 * mesajı + audit + null (caller askq açmaz, sessiz fallback YOK).
 *
 * Backend-aware (2026-06-10): orkestratör cli → runClaudeCli (araştırmalı); api → Anthropic SDK
 * tek-atış triage (tool yok; derin araştırmayı seçilen fix downstream yapar). İkisi de aynı JSON'u üretir.
 *
 * @returns PendingErrorAnalysis (caller runtime.pendingErrorAnalysis'e yazar) ya
 *   da analiz başarısızsa null.
 */
export async function analyzeAndAskError(
  state: State,
  config: MyclConfig,
  errCtx: ErrorContext,
  opts?: {
    /**
     * 2026-06-10 (YZLLM): true → askq AÇMA; ajanın best_index çözümünü auto_selected_solution
     * olarak döndür (failPhase otomatik route eder). Çözüm üretilemediyse askq'ya düşer.
     * "Kabul et, devam et" (güvenlik override) ASLA otomatik seçilmez — o hep insan kararı.
     */
    autoResolve?: boolean;
  },
): Promise<PendingErrorAnalysis | null> {
  const fail = async (msg: string, detail: string): Promise<null> => {
    // Görünür hata (sadece log.warn değil) — fail-closed.
    emitChatMessage("error", `⚠️ ${msg}`);
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: errCtx.phase,
      event: "error-analysis-failed",
      caller: "mycl-orchestrator",
      detail: detail.slice(0, 200),
    }).catch(() => {});
    return null;
  };
  // KALICI sağlayıcı-yok (kredi/yetki): analizin KENDİSİ de bir sağlayıcı ister → "tekrar analiz" hep aynı
  // hatayı verir → SONSUZ DÖNGÜ (canlı bug). Döngüyü kır: net durum mesajı + yalnız "kaydet + devam" askq'sı
  // (Çöz/Tekrar-analiz YOK). Sağlayıcı (kredi/z.ai) dönünce iş listesinden tekrar denenir.
  // YZLLM 2026-06-26: z.ai sinyali — Claude account-error AMA z.ai (GLM) anahtarı var + henüz z.ai'de değiliz →
  // "tükendi" demek YALAN (z.ai denenmedi). failPermanent yerine bu döner; failPhase z.ai'ya geçip fazı tekrar koşar.
  const signalProviderSwitch = (): PendingErrorAnalysis => ({
    id: `error_analysis_${randomUUID()}`,
    phase: errCtx.phase,
    blocking: false,
    options: [],
    solutions_tr: [],
    needsProviderSwitch: true,
  });
  const failPermanent = async (provDetail: string): Promise<PendingErrorAnalysis> => {
    const id = `error_analysis_${randomUUID()}`;
    const blocking = !!errCtx.allowAcceptContinue;
    const { options } = buildErrorAnalysisAskq([], blocking, {
      allowAcceptContinue: errCtx.allowAcceptContinue,
      permanentNoProvider: true,
    });
    const optionLabels = options.map((o) => (typeof o === "string" ? o : o.label));
    // DÜRÜST mesaj (YZLLM 2026-06-26): buraya yalnız z.ai bizi KURTARAMADIĞINDA gelinir — ya z.ai zaten
    // seçili+o da tükendi, ya da z.ai anahtarı hiç yok. "tüm sağlayıcılar tükendi (Claude+z.ai)" diye SABİT
    // yazmak (z.ai bakiyesi varken) yalandı → duruma göre net söyle.
    const onZai = resolveProvider(config, "orchestrator").isZai;
    const detail = onZai
      ? `z.ai (GLM) bakiyeniz/kotanız da tükendi — z.ai panelinden bakiye yükleyin, sonra iş listesinden tekrar denenir.`
      : `Anthropic kredisi/limiti tükendi ve yapılandırılmış bir z.ai (GLM) yedeği yok — kredi yükleyin VEYA ` +
        `Ayarlar → API Anahtarları'ndan bir z.ai anahtarı girin; sonra iş listesinden tekrar denenir.`;
    emitChatMessage(
      "assistant",
      `⛔ Faz ${errCtx.phase} hata analizi YAPILAMADI: ${detail} ` +
        `Bu bir ortam sorunu, kod hatası değil — "tekrar analiz" hep aynı hatayı verir. İşi kaydedip devam et.`,
    );
    emitAskq({
      id,
      question: `Faz ${errCtx.phase}: hata analizi yapılamadı (sağlayıcı tükendi). Ne yapalım?`,
      options,
    });
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: errCtx.phase,
      event: "error-analysis-no-provider",
      caller: "mycl-orchestrator",
      detail: provDetail.slice(0, 200),
    }).catch(() => {});
    return {
      id,
      phase: errCtx.phase,
      blocking,
      options: optionLabels,
      solutions_tr: [],
      acceptContinuePhase: errCtx.acceptContinuePhase,
    };
  };
  try {
    // Hata analizi ORKESTRATÖR rolüdür. Backend'e göre: cli → araştırmalı (Read/Grep/Bash);
    // api → tek-atış triage (YZLLM 2026-06-10 "bunu çözmüştük" — API modunda da çalışmalı).
    // Tek-atışta derin araştırmayı SEÇİLEN FİX downstream (Faz 0 / SDK) yapar → triage hızlı + yeterli.
    // YZLLM 2026-06-12: hata-analizi orkestratör BEYİN rolü → merdiven-dışı strong tier (Opus 4.8). Düşük
    // modelde gerçek testleri okumadan kök-neden uyduruyordu; strong + max ile sağlam akıl yürütme.
    const analysisModel = orchestratorModelId(config.selected_models);
    const useCli = backendForRole(config, "orchestrator") === "cli";
    // Proje-gerçeklerini ajana ver (YZLLM: "proje bilgisini cömertçe ver → daha iyi yanıt"; ajan JS/TS bilsin).
    const facts = await buildProjectFacts(state.project_root).catch(() => null);
    const factsSummary = facts?.summary;
    emitChatMessage("system", "🔎 Hata analiz ediliyor (orkestratör)…");
    let analysisText: string;
    if (useCli) {
      emitClaudeStream({ sub: "init", text: "cli-error-analysis", model: analysisModel, cwd: state.project_root });
      const res = await runClaudeCli({
        systemPrompt: buildErrorAnalysisPrompt(errCtx, true, factsSummary),
        userMessage: "Inspect the failure and emit the error_analysis JSON block now.",
        modelId: analysisModel,
        cwd: state.project_root,
        allowedTools: ["Read", "Grep", "Glob", "Bash"],
        disallowedTools: READ_ONLY_DISALLOWED_TOOLS, // salt-okunur hata analizi: yazma + alt-ajan yasak, Bash açık
        effort: "max", // orkestratör beyin → en yüksek efor (kabul edilen tavan: Opus 4.8 · max)
        onText: (t) => emitClaudeStream({ sub: "text", text: t }),
        observer: (tu) =>
          emitClaudeStream({ sub: "tool_use", tool_name: tu.name, tool_input: tu.input }),
        // idle-kill KAPALI (YZLLM 2026-06-18 — canlı Faz 8 derail KÖKÜ): Opus 4.8 max-efor düşünme
        // İÇERİĞİNİ varsayılan GİZLER → uzun sessiz düşünme `--include-partial-messages` ile bile
        // stdout satırı akıtmaz → sabit idle-timeout (eski 300s) meşru düşünmeyi YANLIŞ öldürüyordu
        // ("cli idle timeout 300000ms" → error-analysis fail → ana iş "düştü" → pipeline raydan çıktı,
        // kuyruktaki alt-işe saptı). Tek-atış analiz → idle yok.
        timeoutMs: 0,
        // Hang-timeout (YZLLM gate-fix #4, 2026-06-19): error-analysis bir TRIAGE — çoğu 1-3 dk'da biter.
        // 30dk default wall-clock hang için fazla uzun (canlı 44dk "model çalışıyor" donması). 15dk'ya sık:
        // derin araştırma+düşünme için bol, no-output hang'i 30→15dk'ya yarılar (idle yok, thinking ölmez).
        wallClockMs: 900_000,
      });
      if (res.usage) emitClaudeStream({ sub: "token_usage", usage: res.usage });
      if (!res.ok) {
        const et = String(res.error ?? "");
        // Kredi/yetki (kalıcı): z.ai (GLM) anahtarı VAR + henüz z.ai'de değilsek → z.ai'ya geç sinyali (yalan
        // "tükendi" YOK). z.ai yoksa/zaten z.ai'deysek → döngü-kıran dürüst failPermanent. Aksi (account dışı)
        // → normal fail (reanalyze yardımcı olabilir).
        if (isApiAccountError(et)) {
          const canSwitchZai = !!zaiKeyForRole(config.api_keys, "main") && !resolveProvider(config, "orchestrator").isZai;
          return canSwitchZai ? signalProviderSwitch() : await failPermanent(et);
        }
        return await fail("Hata analizi yapılamadı (claude hatası).", et);
      }
      analysisText = res.text;
    } else {
      // API yolu — Anthropic SDK tek-atış (tool yok; hata mesajı + detail'den triage).
      try {
        // z.ai Aşama 2 ⑤b: Sağlayıcı=Z.AI ise hata-analizi turu GLM'e (z.ai key+endpoint) gider; claude'da AYNEN korunur.
        const { client, model } = resolveLlmClient(
          config,
          "orchestrator",
          config.api_keys.orchestrator ?? config.api_keys.main,
          analysisModel,
          { timeoutMs: 120_000 },
        );
        const response = await client.messages.create({
          model,
          max_tokens: 2048,
          system: buildErrorAnalysisPrompt(errCtx, false, factsSummary),
          messages: [
            {
              role: "user",
              content:
                "Emit the error_analysis JSON block now, reasoning from the error message and detail provided.",
            },
          ],
        });
        analysisText = response.content
          .filter((c): c is Anthropic.TextBlock => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      } catch (e) {
        const et = String(e);
        if (isApiAccountError(et)) {
          const canSwitchZai = !!zaiKeyForRole(config.api_keys, "main") && !resolveProvider(config, "orchestrator").isZai;
          return canSwitchZai ? signalProviderSwitch() : await failPermanent(et);
        }
        return await fail("Hata analizi yapılamadı (API hatası).", et);
      }
    }

    const analysis = parseErrorAnalysisBlock(analysisText);
    if (!analysis) {
      return await fail("Hata analizi bloğu üretilemedi.", "no valid {kind:error_analysis} block");
    }

    // YZLLM 2026-07-03 (Kodu göster): her finding'in code_ref'ine proje-kökü sınırlı GERÇEK snippet'i doldur
    // (okunamıyor/kök-dışı → undefined → o finding'de "Kodu göster" butonu çıkmaz). Kuyruğa da resolved gider.
    for (const f of analysis.findings) {
      f.code_ref = await resolveCodeRef(state.project_root, f.code_ref);
    }
    const headCodeRef = analysis.findings[0]?.code_ref;

    // Güvenlik-baseline Unit 2: allowAcceptContinue (blocking gate) → blocking'e zorla
    // (LLM "non-blocking" dese bile gate bloklayıcı; askq "Kabul et, devam et" sunar).
    const blocking = errCtx.allowAcceptContinue ? true : analysis.blocking;
    const { options } = buildErrorAnalysisAskq(analysis.solutions_tr, blocking, {
      allowAcceptContinue: errCtx.allowAcceptContinue,
      // FIX A/D: döngü tükendiyse (manuel MANUAL_LOOP_MAX / oto AUTO_SOLVE_MAX) aynı çözümleri tekrar sunma;
      // kalıcı-kabul + park seçenekleri gelsin (failPhase errCtx.loopExhausted set eder).
      loopExhausted: errCtx.loopExhausted,
      allowPermanentAccept: errCtx.loopExhausted,
    });
    const optionLabels = options.map((o) => (typeof o === "string" ? o : o.label));

    const id = `error_analysis_${randomUUID()}`;

    // 2026-06-10 (YZLLM: "kolayca çözebileceği şeyi bile soruyor — kendisi çözsün"):
    // autoResolve + somut çözüm varsa askq AÇILMAZ; en iyi çözüm otomatik seçilir,
    // failPhase aynı routing'i (handleAskqAnswer) otomatik sürer. Güvenlik override'ı
    // (Kabul et, devam et) hiçbir zaman otomatik seçilmez — auto yol hep ÇÖZMEYİ dener.
    const best = analysis.solutions_tr[analysis.best_index];
    if (opts?.autoResolve && typeof best === "string" && best.trim() !== "") {
      const others = analysis.solutions_tr.filter((_, i) => i !== analysis.best_index);
      emitChatMessage(
        "assistant",
        `${analysis.summary_tr}\n\n🤖 **En iyi çözüm otomatik seçildi:** ${best}` +
          (others.length > 0
            ? `\nDeğerlendirilen alternatifler:\n${others.map((s) => `- ${s}`).join("\n")}`
            : ""),
        // Sade özet; teknik açıklama "Detay"da. FAIL-SAFE (mahkeme): LLM detail_tr atlarsa ham hata detayına düş →
        // "Detay" hep içerikli olur (sessiz bilgi kaybı yok; kullanıcı doğrulayabilir). İkisi de boşsa toggle çıkmaz.
        { detail: analysis.detail_tr ?? errCtx.detail, code_ref: headCodeRef },
      );
      await appendAudit(state.project_root, {
        ts: Date.now(),
        phase: errCtx.phase,
        event: "error-analysis",
        caller: "mycl-orchestrator",
        detail: `blocking=${blocking} solutions=${analysis.solutions_tr.length} findings=${analysis.findings.length} auto_selected=true`,
      }).catch(() => {});
      return {
        id,
        phase: errCtx.phase,
        blocking,
        options: optionLabels,
        solutions_tr: analysis.solutions_tr,
        acceptContinuePhase: errCtx.acceptContinuePhase,
        auto_selected_solution: best.trim(),
        findings: analysis.findings,
        code_ref: headCodeRef,
      };
    }

    // UI'da SADE özet (orkestratör TR çıktısı). Teknik açıklama "Detay göster" ile açılır (detail_tr varsa).
    emitChatMessage(
      "assistant",
      blocking
        ? `${analysis.summary_tr}\nBu hata çözülmeden ilerlemek mümkün değil. Nasıl ilerleyelim?`
        : `${analysis.summary_tr}\nNasıl ilerleyelim?`,
      // FAIL-SAFE (mahkeme): detail_tr yoksa ham hata detayına düş → "Detay" hep içerikli (sessiz bilgi kaybı yok).
      { detail: analysis.detail_tr ?? errCtx.detail, code_ref: headCodeRef },
    );

    // askq emit → OS bildirimi mevcut askq yolundan OTOMATİK tetiklenir.
    emitAskq({
      id,
      question: blocking
        ? `Faz ${errCtx.phase} hatası — çözülmeden ilerlenemez. Nasıl ilerleyelim?`
        : `Faz ${errCtx.phase} hatası. Nasıl ilerleyelim?`,
      options,
    });

    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: errCtx.phase,
      event: "error-analysis",
      caller: "mycl-orchestrator",
      detail: `blocking=${blocking} solutions=${analysis.solutions_tr.length} findings=${analysis.findings.length}`,
    }).catch((e) => log.error("error-analysis", "error-analysis audit yazılamadı (denetim izi eksik)", { error: String(e) }));

    return {
      id,
      phase: errCtx.phase,
      blocking,
      options: optionLabels,
      solutions_tr: analysis.solutions_tr,
      acceptContinuePhase: errCtx.acceptContinuePhase,
      findings: analysis.findings,
      code_ref: headCodeRef,
    };
  } catch (err) {
    // Hiçbir koşulda ana akışı bozma — ama GÖRÜNÜR + tanılanabilir (sessiz-fallback denetimi: iç fail()
    // ile aynı seviye). log.warn→log.error + hata detayını mesaja kat + audit'e yaz (müfettiş trajectory'si görsün).
    log.error("error-analysis", "analyzeAndAskError beklenmedik hata (non-fatal)", err);
    emitChatMessage("error", `⚠️ Hata analizi beklenmedik bir nedenle yapılamadı: ${String(err).slice(0, 200)}`);
    await appendAudit(state.project_root, {
      ts: Date.now(),
      phase: errCtx.phase,
      event: "error-analysis-failed",
      caller: "mycl-orchestrator",
      detail: String(err).slice(0, 200),
    }).catch(() => {});
    return null;
  }
}
