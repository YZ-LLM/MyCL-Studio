// phase-9-debate-review — Faz 9 çok-ajanlı "bulan + çürüten" risk incelemesi (YZLLM 2026-06-13).
//
// Anthropic'in dahili /ultrareview deseni (Code with Claude 2026): N uzman BULUCU her biri TEK kusur
// sınıfı arar (paralel, salt-okunur), sonra her bulguyu BAĞIMSIZ bir ÇÜRÜTÜCÜ gerçek koda karşı yeniden
// doğrular → yanlış-pozitifleri eler. Tek-ajan incelemeden çok daha kaliteli: kaliteyi yükselten asıl şey
// bu yanlış-pozitif ayıklama. hypothesis-investigation fan-out desenini taklit eder (Promise.allSettled ×
// N runClaudeCli, READ_ONLY_DISALLOWED_TOOLS, salt-okunur). ETKİLEŞİMSİZ: bulur → doğrular → decisions[]
// döner (kullanıcı onayı YOK — YZLLM "kendisi en iyisini bulsun"). Çıktı risk-fix dispatch'ine akar.
//
// Backend: CLI/abonelik (runClaudeCli). API modunda caller eski tek-ajan qa-askq'ya düşer (görünür notla;
// "review fan-out CLI-only" açık-maddesiyle tutarlı). FAIL-CLOSED: tüm bulucular patlarsa ok:false → Faz 9
// fail (boş bulgu listesini "risk yok" sayma = sahte-yeşil yasağı).

import { extractKindBlock } from "./cli-json.js";
import { runClaudeCli } from "./cli-run.js";
import { READ_ONLY_DISALLOWED_TOOLS, PURE_REASONING_DISALLOWED_TOOLS } from "./tool-policy.js";
import { log } from "./logger.js";
import { dedupeFindings } from "./phase-9-debate-dedup.js";
import { emitAgentEvent, emitChatMessage } from "./ipc.js";
import { withAgentRun } from "./agent-cost-context.js";

/** Bir bulucunun ürettiği (doğrulama öncesi) ya da doğrulanmış risk bulgusu. */
export interface DebateFinding {
  /** Risk ifadesi (kısa, somut). */
  risk: string;
  /** fix = düzeltilmeli; rule = sistemik, kural ekle. (skip bulguları RAPOR EDİLMEZ — bulucu yalnız gerçek riski döner.) */
  decision: "fix" | "rule";
  /** Kanıt + ne yapılacağı (dosya/satır). */
  detail?: string;
  /** "fix" ise hangi fazda uygulanır: ui→Faz 5, db→Faz 7, code→Faz 8. rule→none. */
  fix_phase: "ui" | "db" | "code" | "none";
  severity: "high" | "medium" | "low";
  /** Hangi eksenin bulucusu buldu (iz). */
  axis: string;
}

export interface DebateAxis {
  key: string;
  label: string;
  focus: string;
  /** YZLLM 2026-06-30: örtüşen eksenler dalgalara bölünür. Dalga 1 (temel) paralel koşar; Dalga 2 (rafine,
   *  örtüştüğü Dalga-1 eksenini tamamlar) Dalga-1 bulgularını GÖRÜR + onları TEKRAR ETMEZ → kendi açısına
   *  odaklanır (daha hızlı/ucuz/temiz). Correctness↔Error-paths, Security↔STRIDE, Maintainability↔Tech-debt. */
  wave: 1 | 2;
}

/** phase-09-risk.md'nin eksenleri — her birine bir uzman bulucu. (YZLLM 2026-06-15: STRIDE eklendi → 7 eksen.) */
export const DEBATE_AXES: DebateAxis[] = [
  { key: "correctness", wave: 1, label: "Correctness", focus: "Does the code actually satisfy EVERY acceptance criterion (not just run)? Unimplemented/partial ACs, wrong logic, off-by-one, broken edge cases." },
  { key: "security", wave: 1, label: "Security", focus: "Input validation, authz/authn boundaries, secrets, injection (SQL/cmd/XSS), unsafe deserialize, SSRF, path traversal, missing rate limits." },
  // YZLLM 2026-06-15 (gstack /cso esinli): yapısal STRIDE tehdit-modeli — düz "security" ekseninden farklı
  // olarak DEĞİŞEN her bileşen/endpoint/veri-akışı için 6 kategoriyi SİSTEMATİK yürür. Hafif: yalnız bu
  // iterasyonun saldırı yüzeyi + yalnız AZALTILMAMIŞ tehditleri bulgu yapar (akademik tam-model değil).
  // Dalga 2: Security bulucusunun bulgularını görür → onları tekrar etmez, yalnız sistematik STRIDE açığını arar.
  { key: "stride", wave: 2, label: "STRIDE threat model", focus: "Walk the 6 STRIDE categories for EACH changed endpoint / data flow / privilege boundary, name the concrete threat, and report ONLY the UNMITIGATED ones: Spoofing (faked identity — weak/missing authn, guessable tokens, no session validation); Tampering (modifiable data/requests — missing integrity/validation, mass-assignment, client-trusted fields); Repudiation (security-relevant actions not logged/auditable — no audit trail on create/delete/permission-change); Information disclosure (response/error/log leaks data the caller shouldn't see — IDOR, verbose stack traces, PII in logs, over-broad SELECT *); Denial of service (attacker-triggerable unbounded work — no pagination/rate-limit, expensive unindexed query, unbounded upload/loop); Elevation of privilege (lower-priv user reaches higher-priv action — missing/!=ownership authz check, insecure direct object reference, role check only in UI)." },
  { key: "error-paths", wave: 2, label: "Error & edge paths", focus: "Failure handling, empty/null/huge/unicode inputs, partial writes/failures, swallowed errors, unhandled rejections, resource leaks." },
  { key: "performance", wave: 1, label: "Performance & resources", focus: "N+1 queries, unbounded loops/allocations, missing indexes, memory/handle leaks, blocking I/O on hot paths." },
  { key: "maintainability", wave: 1, label: "Maintainability", focus: "Duplicated logic, dead code, unclear contracts, leaky/missing abstractions, over-complex flow, shotgun changes." },
  { key: "tech-debt", wave: 2, label: "Technical debt", focus: "TODO/FIXME/HACK markers, prod-mock, hardcoded credentials/config, empty catch, skipped/disabled tests, loosened assertions, lowered thresholds." },
];

/** Dalga 1 = temel eksenler (paralel, bağımsız). Dalga 2 = rafine eksenler (Dalga-1 bulgularını görür). */
export const WAVE1_AXES = DEBATE_AXES.filter((a) => a.wave === 1);
export const WAVE2_AXES = DEBATE_AXES.filter((a) => a.wave === 2);

export interface DebateReviewContext {
  specRisks: string;
  phase9Audit: string;
  techDebtFindings: string;
  changedFiles: string;
}

export interface DebateReviewResult {
  /** false → tüm bulucular başarısız (fail-closed; caller Faz 9'u "fail" yapmalı, "risk yok" SAYMAMALI). */
  ok: boolean;
  findings: DebateFinding[];
  axisCount: number;
  axisOk: number;
  rawCount: number;
  confirmedCount: number;
  reason?: string;
}

const FINDER_TIMEOUT_MS = 150_000;
const VALIDATOR_TIMEOUT_MS = 120_000;

function contextBlock(ctx: DebateReviewContext): string {
  return (
    "## Spec risks (from spec.md)\n---\n" + ctx.specRisks + "\n---\n\n" +
    "## Phase 9 audit (recent events)\n---\n" + ctx.phase9Audit + "\n---\n\n" +
    "## Technical-debt deterministic scan (THIS iteration's changed files)\n---\n" + ctx.techDebtFindings + "\n---\n\n" +
    "## Changed files you may inspect (THIS iteration only)\n" + ctx.changedFiles + "\n"
  );
}

function finderSystemPrompt(axis: DebateAxis): string {
  return (
    "You are an ADVERSARIAL code-review FINDER agent with READ-ONLY tools: Read, Grep, Glob, Bash.\n" +
    "You are the LAST line before this code ships WITHOUT human review — assume there IS a bug and your job is to FIND it.\n\n" +
    `## YOUR SINGLE LENS: ${axis.label}\n${axis.focus}\n` +
    "Hunt ONLY this class of issue. Ignore other classes (other finders cover them). Going broad dilutes you.\n\n" +
    "## Discipline\n" +
    "- INSPECT the actual code (Grep/Glob to locate, Read to confirm, Bash for read-only checks only). DO NOT modify anything.\n" +
    "- Ground EVERY finding in concrete evidence you observed (file path, line, function, value). No speculation.\n" +
    "- Scope is STRICTLY this iteration's changed files (listed below). Do NOT raise issues about pre-existing untouched code.\n" +
    "- Hunt false greens: shallow/mock tests that pass without exercising the real path, skipped gates, loosened assertions.\n" +
    "- If you cannot point to the concrete guard/test that makes something safe, it is NOT safe — report it.\n" +
    "- Report ONLY real risks. If your lens finds nothing genuine, return an empty findings array (do NOT invent noise).\n\n" +
    "## For each finding classify:\n" +
    "- decision: 'fix' (must be addressed before shipping) or 'rule' (systemic — encode a convention so it's caught earlier).\n" +
    "- fix_phase: where the fix applies — 'ui' (Phase 5: component/page/styling), 'db' (Phase 7: schema/migration/index), " +
    "'code' (Phase 8: backend/logic/validation — the general case). Use 'none' only for 'rule'. When unsure, 'code'.\n" +
    "- severity: 'high' | 'medium' | 'low'.\n\n" +
    "## OUTPUT — CLI mode (no custom tool)\n" +
    "Your ENTIRE final reply must be exactly ONE JSON block and nothing else:\n" +
    '{"kind":"findings","findings":[{"risk":"<concise>","decision":"fix","fix_phase":"code","severity":"high","detail":"<evidence: file:line + what + why unsafe>"}]}\n' +
    'Empty if nothing real: {"kind":"findings","findings":[]}'
  );
}

function validatorSystemPrompt(f: DebateFinding): string {
  return (
    "You are an adversarial VERIFIER with READ-ONLY tools: Read, Grep, Glob, Bash.\n" +
    "Another agent claims the risk below. Your job is to REFUTE it: re-check it against the ACTUAL code and decide if it is REAL or a FALSE POSITIVE.\n\n" +
    "## Be skeptical by default\n" +
    "- Read the cited file/lines yourself. If the claimed problem is NOT actually present (already guarded, validated, " +
    "tested, or the claim misread the code), it is a FALSE POSITIVE → is_real=false.\n" +
    "- Only confirm is_real=true if you can SEE the concrete unsafe code/missing guard with your own eyes.\n" +
    "- If you cannot verify either way after reading, default to is_real=false (we drop unprovable findings — better than noise).\n\n" +
    `## Claimed risk\nLens: ${f.axis}\nDecision: ${f.decision} | fix_phase: ${f.fix_phase} | severity: ${f.severity}\n` +
    `Risk: ${f.risk}\nEvidence claimed: ${f.detail ?? "(none)"}\n\n` +
    "## If the evidence is a MERGED cluster (several bulleted claims), verify EACH claim against the code and set " +
    "is_real=true if AT LEAST ONE is a genuine issue (state which in reason). Only false if ALL are false positives.\n\n" +
    "## OUTPUT — exactly ONE JSON block, nothing else:\n" +
    '{"kind":"verdict","is_real":true,"reason":"<what you saw in the code that confirms or refutes (per claim if merged)>"}'
  );
}

function parseFindings(text: string, axis: string): DebateFinding[] {
  const block = extractKindBlock(text, ["findings"]);
  if (!block || !Array.isArray(block.findings)) return [];
  const out: DebateFinding[] = [];
  for (const raw of block.findings as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const risk = typeof r.risk === "string" ? r.risk.trim() : "";
    if (!risk) continue;
    const decision = r.decision === "rule" ? "rule" : "fix";
    const fpRaw = String(r.fix_phase ?? "").trim().toLowerCase();
    const fix_phase: DebateFinding["fix_phase"] =
      fpRaw === "ui" || fpRaw === "db" || fpRaw === "code" || fpRaw === "none" ? fpRaw : "code";
    const sevRaw = String(r.severity ?? "").trim().toLowerCase();
    const severity: DebateFinding["severity"] =
      sevRaw === "high" || sevRaw === "medium" || sevRaw === "low" ? sevRaw : "medium";
    out.push({
      risk,
      decision,
      detail: typeof r.detail === "string" ? r.detail.trim() : undefined,
      fix_phase: decision === "rule" ? "none" : fix_phase,
      severity,
      axis,
    });
  }
  return out;
}

/** YZLLM 2026-06-30: Dalga-2 bulucularına Dalga-1 bulgularını "zaten raporlandı, TEKRAR ETME" olarak enjekte et →
 *  rafine eksen kendi açısına odaklanır (mükerrer iş↓, daha hızlı/ucuz/temiz kafa). Boş → "" (enjeksiyon yok). */
function priorFindingsBlock(prior: DebateFinding[]): string {
  if (prior.length === 0) return "";
  const lines = prior
    .map((f, i) => `${i + 1}. [${f.axis}] ${f.risk}${f.detail ? ` — ${f.detail.slice(0, 160)}` : ""}`)
    .join("\n");
  return (
    "\n\n## ALREADY REPORTED by earlier review lenses — DO NOT re-report any of these (a duplicate wastes effort " +
    "and muddies dedup). Focus ONLY on risks from YOUR lens that these MISSED. If your lens finds nothing NEW, " +
    "return an empty findings array.\n" +
    "IMPORTANT: a DEEPER, MORE SEVERE, or DIFFERENTLY-LOCATED variant of a listed item is NOT a duplicate — REPORT " +
    "it. Only skip a finding if it is the IDENTICAL root issue at the IDENTICAL location as one already listed.\n" +
    lines +
    "\n"
  );
}

/** Bir bulucu dalgasını (eksen kümesi) PARALEL koşar → {bulgular, başarılı-eksen-sayısı}. userMessage dalgaya
 *  göre değişir (Dalga 2'ye prior-findings bloğu eklenir). Ajan Takımı görünürlüğü korunur (withAgentRun). */
async function runFinderWave(
  axes: DebateAxis[],
  userMessage: string,
  modelId: string,
  extraEnv: Record<string, string> | undefined,
  projectRoot: string,
  effort: string | undefined,
): Promise<{ findings: DebateFinding[]; axisOk: number }> {
  const settled = await Promise.allSettled(
    axes.map((a) =>
      withAgentRun({ label: a.label, group: "Faz 9 İnceleme — Bulucular", phase: 9 }, async () => {
        emitAgentEvent({ sub: "started", agent_label: a.label, agent_group: "Faz 9 İnceleme — Bulucular", phase: 9 });
        try {
          return await runClaudeCli({
            systemPrompt: finderSystemPrompt(a),
            userMessage,
            modelId,
            extraEnv, // ⑥ z.ai ise z.ai endpoint'i
            cwd: projectRoot,
            allowedTools: ["Read", "Grep", "Glob", "Bash"],
            disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
            effort,
            timeoutMs: FINDER_TIMEOUT_MS,
          });
        } finally {
          emitAgentEvent({ sub: "completed", agent_label: a.label });
        }
      }),
    ),
  );
  const findings: DebateFinding[] = [];
  let axisOk = 0;
  settled.forEach((r, i) => {
    const axis = axes[i].key;
    if (r.status !== "fulfilled") {
      log.warn("phase-9-debate", "bulucu reddedildi", { axis, reason: String(r.reason) });
      return;
    }
    if (!r.value.ok) {
      log.warn("phase-9-debate", "bulucu başarısız", { axis, error: r.value.error });
      return;
    }
    axisOk++;
    findings.push(...parseFindings(r.value.text, axis));
  });
  return { findings, axisOk };
}

const SEV_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/**
 * SAF (test edilebilir): LLM cluster gruplarını bulgulara uygular. Her grup → tek temsilci (en yüksek severity;
 * eşitse en zengin detail). GÜVENLİK: geçersiz/kapsam-dışı/tekrar index'ler atlanır; HİÇBİR gruba girmeyen bulgu
 * AYNEN korunur (yanlış-birleştirme dışında bulgu KAYBI olmaz — sahte-yeşil yasağı). Birden çok eksen → "a+b".
 */
export function applyClusters(findings: DebateFinding[], groups: unknown[]): DebateFinding[] {
  const out: DebateFinding[] = [];
  const covered = new Set<number>();
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    const idxs = g.filter(
      (x): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x < findings.length && !covered.has(x),
    );
    if (idxs.length === 0) continue;
    idxs.forEach((x) => covered.add(x));
    let rep = findings[idxs[0]];
    for (const x of idxs.slice(1)) {
      const f = findings[x];
      const higher = (SEV_RANK[f.severity] ?? 0) > (SEV_RANK[rep.severity] ?? 0);
      const sameSevMoreDetail = f.severity === rep.severity && (f.detail?.length ?? 0) > (rep.detail?.length ?? 0);
      if (higher || sameSevMoreDetail) rep = f;
    }
    if (idxs.length > 1) {
      // KRİTİK GÜVENLİK (mahkeme HIGH): yanlış birleştirmede DÜŞEN bulgu çürütücüye HİÇ ulaşmasın diye TÜM üye
      // risk+detail'i temsilcinin detail'inde KORU (bilgi kaybı yok). Çürütücü kümeyi görür → "en az biri gerçek
      // mi" diye doğrular; gerçek olan(lar) hayatta kalır + düzeltmeye tüm bağlam gider. Sahte-yeşil yasağı korunur.
      const members = idxs.map((x) => findings[x]);
      const combinedDetail =
        "MERGED cluster of related findings — verify EACH claim (is_real=true if AT LEAST ONE is a genuine issue):\n" +
        members.map((m) => `• [${m.axis}/${m.severity}] ${m.risk}${m.detail ? ` — ${m.detail}` : ""}`).join("\n");
      out.push({ ...rep, axis: [...new Set(members.map((m) => m.axis))].join("+"), detail: combinedDetail });
    } else {
      out.push(rep);
    }
  }
  // Hiçbir gruba girmeyen index → GÜVENLİ tarafta kal, aynen ekle (LLM atlamış olabilir; bulgu kaybı yok).
  findings.forEach((f, i) => {
    if (!covered.has(i)) out.push(f);
  });
  return out;
}

/**
 * SEMANTİK dedup (YZLLM 2026-06-30): metin-birebir dedup'tan SONRA, farklı eksenlerin AYNI kök sorunu FARKLI
 * kelimelerle raporladığı bulguları LLM ile MUHAFAZAKÂR birleştirir (yalnız kesin aynı kök+konum; kuşkuda AYRI
 * bırak — yanlış birleştirme gerçek bir bulguyu sessizce düşürür, bu dupe'tan çok daha kötü). Çürütücü maliyetini
 * düşürür. FAIL-SAFE: hata/parse-fail/atlanan-index → o bulgular AYNEN korunur (bulgu kaybı YOK). Kod okumaz
 * (saf metin kümeleme; konum ayrımı için detail'deki file:line'a bakar; kod-seviyesi doğrulamayı çürütücü yapar).
 */
async function semanticDedupeFindings(
  findings: DebateFinding[],
  modelId: string,
  extraEnv: Record<string, string> | undefined,
  projectRoot: string,
  effort: string | undefined,
): Promise<DebateFinding[]> {
  if (findings.length < 2) return findings;
  const list = findings
    .map((f, i) => `${i}. [${f.axis}/${f.severity}] ${f.risk}${f.detail ? ` — ${f.detail.slice(0, 200)}` : ""}`)
    .join("\n");
  const system =
    "You cluster code-review findings by ROOT ISSUE. Multiple review lenses can report the SAME underlying problem " +
    "in different words. Group ONLY findings that describe the SAME root issue at the SAME code location.\n" +
    "BE CONSERVATIVE: when in doubt, keep SEPARATE. A wrong merge silently drops a real distinct risk — far worse " +
    "than leaving a duplicate. Different files / locations / root-causes = SEPARATE, even if worded similarly.\n\n" +
    "## OUTPUT — exactly ONE JSON block, nothing else:\n" +
    '{"kind":"clusters","groups":[[0,3],[1],[2]]}\n' +
    "Each inner array = indices of findings that are the SAME issue. Include EVERY index exactly once (singletons as 1-element arrays).";
  const res = await withAgentRun(
    { label: "Semantik birleştirme", group: "Faz 9 İnceleme — Semantik Dedup", phase: 9 },
    async () => {
      emitAgentEvent({ sub: "started", agent_label: "Semantik birleştirme", agent_group: "Faz 9 İnceleme — Semantik Dedup", phase: 9 });
      try {
        return await runClaudeCli({
          systemPrompt: system,
          userMessage: "Findings:\n" + list,
          modelId,
          extraEnv,
          cwd: projectRoot,
          disallowedTools: PURE_REASONING_DISALLOWED_TOOLS, // saf metin kümeleme — kod/Bash aracı GEREKMEZ (mahkeme)
          effort, // pipeline effort'u geçir (bulucu/çürütücü ile parite; mahkeme)
          timeoutMs: 60_000,
        });
      } finally {
        emitAgentEvent({ sub: "completed", agent_label: "Semantik birleştirme" });
      }
    },
  );
  if (!res.ok) {
    log.warn("phase-9-debate", "semantik dedup başarısız → metin-dedup sonucu korunur (bulgu kaybı yok)", { error: res.error });
    return findings;
  }
  const block = extractKindBlock(res.text, ["clusters"]);
  const groups = block && Array.isArray(block.groups) ? (block.groups as unknown[]) : null;
  if (!groups) {
    log.warn("phase-9-debate", "semantik dedup: cluster bloğu yok → metin-dedup sonucu korunur");
    return findings;
  }
  const out = applyClusters(findings, groups);
  if (out.length < findings.length) {
    log.info("phase-9-debate", "semantik dedup birleştirdi", { before: findings.length, after: out.length });
  }
  return out;
}

/**
 * Çok-ajanlı risk incelemesi: 2-dalga bulucular → metin-dedup → semantik-dedup → paralel çürütücüler (bulgu başına).
 * Yalnız doğrulanan (is_real) bulgular döner. Tüm bulucular patlarsa ok:false (fail-closed).
 */
export async function runDebateReview(
  projectRoot: string,
  modelId: string,
  effort: string | undefined,
  ctx: DebateReviewContext,
  // ⑥ z.ai: Sağlayıcı=Z.AI ise caller resolveCliProvider'dan env'i (ANTHROPIC_BASE_URL+token) geçer →
  // tüm bulucu/çürütücü claude CLI'ları z.ai endpoint'ine gider (çok-ajanlı z.ai). undefined → claude.
  extraEnv?: Record<string, string>,
): Promise<DebateReviewResult> {
  const ctxText = contextBlock(ctx);
  const userMsg =
    "Investigate THIS iteration's changed code from your lens and emit the findings JSON block.\n\n" + ctxText;

  // 1. BULUCULAR — 2 DALGA (YZLLM 2026-06-30, kullanıcı isteği: örtüşen eksenler sıralı çalışsın, önceki bulguları
  // bilsin, tekrar etmesin → daha hızlı/ucuz/temiz). Dalga 1 (temel: correctness/security/maintainability/
  // performance) PARALEL. Dalga 2 (rafine: error-paths/stride/tech-debt) Dalga-1 bulgularını GÖRÜR + tekrar ETMEZ,
  // yalnız kendi açısının kaçırılan riskini arar. Her bulucu Ajan Takımı popup'ında görünür (withAgentRun).
  const wave1 = await runFinderWave(WAVE1_AXES, userMsg, modelId, extraEnv, projectRoot, effort);
  const wave2 = await runFinderWave(
    WAVE2_AXES,
    userMsg + priorFindingsBlock(wave1.findings),
    modelId,
    extraEnv,
    projectRoot,
    effort,
  );
  const raw = [...wave1.findings, ...wave2.findings];
  const axisOk = wave1.axisOk + wave2.axisOk;

  // FAIL-CLOSED (mahkeme, sahte-yeşil yasağı): Dalga 1 (temel eksenler) TÜMÜ patladıysa — ya da hiçbir eksen
  // koşmadıysa — "risk yok" SAYMA, Faz 9 fail etmeli. Dalga 1 essential (correctness/security temeli); onsuz
  // "temiz" iddiası anlamsız. (Eski "axisOk===0" 2-dalgada Dalga-2'nin tek blip'te sıfırlanmasını kaçırıyordu.)
  if (wave1.axisOk === 0) {
    return {
      ok: false,
      findings: [],
      axisCount: DEBATE_AXES.length,
      axisOk,
      rawCount: 0,
      confirmedCount: 0,
      reason: "Dalga-1 (temel) bulucular başarısız (CLI hatası?) — boş sonuç 'risk yok' sayılmaz (sahte-yeşil yasağı)",
    };
  }
  // GÖRÜNÜR kısmi-kapsam uyarısı (mahkeme, sessiz-atlama yasağı): bir eksen koşmadıysa "temiz" YANILTICI olabilir.
  if (axisOk < DEBATE_AXES.length) {
    const failedCount = DEBATE_AXES.length - axisOk;
    emitChatMessage(
      "system",
      `⚠️ Faz 9 incelemesi KISMİ: ${axisOk}/${DEBATE_AXES.length} inceleme merceği koştu (${failedCount} eksen ` +
        `başarısız — CLI/ağ hatası?). Bu mercek(ler)in kapsamı bu koşuda EKSİK; "risk yok" tam kapsam sayılmamalı.`,
    );
  }

  if (raw.length === 0) {
    return { ok: true, findings: [], axisCount: DEBATE_AXES.length, axisOk, rawCount: 0, confirmedCount: 0 };
  }

  // 2. DEDUP — metin-birebir (saf, test edilebilir) → SONRA semantik (LLM, muhafazakâr; farklı kelimeyle aynı
  // kök sorunu birleştirir; fail-safe + üye risk+detail korunur → bulgu kaybı yok). Çürütücü maliyetini↓.
  const textDeduped = dedupeFindings(raw);
  const deduped = await semanticDedupeFindings(textDeduped, modelId, extraEnv, projectRoot, effort);

  // 3. ÇÜRÜTÜCÜLER — bulgu başına paralel; yanlış-pozitifleri ele. Ajan Takımı görünürlüğü (mahkeme #4).
  const valSettled = await Promise.allSettled(
    deduped.map((f, i) => {
      const vLabel = `Çürütücü ${i + 1} (${f.axis})`;
      return withAgentRun({ label: vLabel, group: "Faz 9 İnceleme — Çürütücüler", phase: 9 }, async () => {
        emitAgentEvent({ sub: "started", agent_label: vLabel, agent_group: "Faz 9 İnceleme — Çürütücüler", phase: 9 });
        try {
          return await runClaudeCli({
            systemPrompt: validatorSystemPrompt(f),
            userMessage:
              "Re-check the claimed risk against the actual code, then emit the verdict JSON block.",
            modelId,
            extraEnv, // ⑥ z.ai ise z.ai endpoint'i
            cwd: projectRoot,
            allowedTools: ["Read", "Grep", "Glob", "Bash"],
            disallowedTools: READ_ONLY_DISALLOWED_TOOLS,
            effort,
            timeoutMs: VALIDATOR_TIMEOUT_MS,
          });
        } finally {
          emitAgentEvent({ sub: "completed", agent_label: vLabel });
        }
      });
    }),
  );

  const confirmed: DebateFinding[] = [];
  valSettled.forEach((r, i) => {
    const f = deduped[i];
    if (r.status !== "fulfilled" || !r.value.ok) {
      // Çürütücü patladı → kuşkuda DÜŞÜR (refute-default; sahte bulguyu kullanıcıya/düzeltmeye taşıma).
      log.warn("phase-9-debate", "çürütücü başarısız → bulgu düşürüldü", {
        axis: f.axis,
        risk: f.risk.slice(0, 60),
      });
      return;
    }
    const verdict = extractKindBlock(r.value.text, ["verdict"]);
    if (verdict && verdict.is_real === true) {
      confirmed.push(f);
    } else {
      log.info("phase-9-debate", "yanlış-pozitif elendi", {
        axis: f.axis,
        risk: f.risk.slice(0, 60),
        reason: typeof verdict?.reason === "string" ? verdict.reason.slice(0, 100) : "is_real!=true",
      });
    }
  });

  return {
    ok: true,
    findings: confirmed,
    axisCount: DEBATE_AXES.length,
    axisOk,
    rawCount: deduped.length,
    confirmedCount: confirmed.length,
  };
}
