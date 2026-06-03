// relevance/injectors — per-placeholder context builder'lar.
//
// Faz prompt template'larındaki `{{...}}` placeholder'larını relevance
// engine sonucundan formatlanmış markdown ile doldurur. Bu turda iki
// injector: spec digest + abandoned intents digest (Phase 2 proof-of-concept).
// Diğer placeholder'lar (PHASE_6_AUDIT, ACCEPTANCE_CRITERIA, SPEC_RISKS, vs.)
// sonraki turlara ertelendi.
//
// Boş sonuç durumunda "(no relevant ... found)" sentinel'i — fail-safe pattern;
// faz çökmez, Claude context'siz devam eder.

import type { MyclConfig } from "../config.js";
import { isExistingProject } from "../phase-1-codebase-probe.js";
import type { State } from "../types.js";
import { extractSpecChunks } from "./chunk-store.js";
import { getRelevantChunks } from "./relevance-engine.js";
import type { ScoredChunk } from "./types.js";

/**
 * spec.md'nin section'larından mevcut intent'e en alakalı olanları
 * markdown digest olarak döndür. Şu anki Faz 2 `{{EXISTING_SPEC_DIGEST}}`
 * placeholder'ı bunu kullanır.
 *
 * Boş sonuç → "(no relevant spec sections found)" — eskiden "(no prior spec)"
 * idi; relevance-aware sentinel daha bilgilendirici.
 */
export async function buildRelevantSpecDigest(
  config: MyclConfig,
  state: State,
  intent: string,
): Promise<string> {
  const chunks = await getRelevantChunks(config, state, {
    sources: ["spec"],
    intent,
    max_chunks: 4,
    min_score: 6,
  });
  if (chunks.length === 0) {
    return "(no relevant spec sections found)";
  }
  return chunks.map(formatSpecChunk).join("\n\n");
}

/**
 * v15.11: features.md'den mevcut intent'e en alakalı özellikleri markdown digest
 * olarak döndür. Faz 2 `{{EXISTING_FEATURES_DIGEST}}` placeholder'ı için — ajan
 * mevcut özellikleri görüp gereksiz/kapsam-dışı clarifying sormaz.
 */
export async function buildRelevantFeatureDigest(
  config: MyclConfig,
  state: State,
  intent: string,
): Promise<string> {
  const chunks = await getRelevantChunks(config, state, {
    sources: ["features"],
    intent,
    max_chunks: 6,
    min_score: 5,
  });
  if (chunks.length === 0) {
    return "(no documented features yet)";
  }
  return chunks.map(formatSpecChunk).join("\n\n");
}

/**
 * abandoned-intents.jsonl'dan mevcut intent'e en alakalı vazgeçmeleri
 * markdown digest olarak döndür. Faz 2 `{{ABANDONED_INTENTS_DIGEST}}`
 * placeholder'ı bunu kullanır.
 */
export async function buildRelevantAbandonedDigest(
  config: MyclConfig,
  state: State,
  intent: string,
): Promise<string> {
  const chunks = await getRelevantChunks(config, state, {
    sources: ["abandoned"],
    intent,
    max_chunks: 5,
    min_score: 5, // Daha düşük threshold: vazgeçme history'si kıymetli signal
  });
  if (chunks.length === 0) {
    return "(no relevant prior abandonments)";
  }
  return chunks.map(formatAbandonedChunk).join("\n\n");
}

/**
 * brief.md'nin section'larından mevcut intent'e en alakalı olanları markdown
 * digest olarak döndür. Phase 4 + Phase 7 `{{ENGINEERING_BRIEF}}` placeholder'ı
 * için. Eskiden brief.md full-content idi; şimdi relevance-filtered section'lar.
 */
export async function buildRelevantEngineeringBrief(
  config: MyclConfig,
  state: State,
  intent: string,
): Promise<string> {
  const chunks = await getRelevantChunks(config, state, {
    sources: ["brief"],
    intent,
    max_chunks: 4,
    min_score: 6,
  });
  if (chunks.length === 0) {
    return "(no relevant brief sections found)";
  }
  return chunks.map(formatBriefChunk).join("\n\n");
}

/**
 * Phase 6 `{{PHASE_6_AUDIT}}` — Phase 5'nın audit event'lerinden mevcut intent'e
 * en alakalı olanlar. Eskiden last-30 capping idi; şimdi relevance-filtered.
 */
export async function buildRelevantPhase6Audit(
  config: MyclConfig,
  state: State,
  intent: string,
): Promise<string> {
  return await buildAuditDigest(config, state, intent, 6);
}

/**
 * Phase 9 + Phase 19 ortak `{{PHASE_9_AUDIT}}` — TDD codegen event'leri.
 * Phase 8 multi-turn olduğu için 50-100 event olabilir; relevance ile top-N.
 */
export async function buildRelevantPhase9Audit(
  config: MyclConfig,
  state: State,
  intent: string,
): Promise<string> {
  return await buildAuditDigest(config, state, intent, 9);
}

async function buildAuditDigest(
  config: MyclConfig,
  state: State,
  intent: string,
  auditPhase: number,
): Promise<string> {
  const chunks = await getRelevantChunks(config, state, {
    sources: ["audit"],
    intent,
    audit_phase: auditPhase,
    max_chunks: 10,
    min_score: 5, // audit event'leri kısa; daha düşük threshold mantıklı
  });
  if (chunks.length === 0) {
    return `(no relevant Phase ${auditPhase} audit events found)`;
  }
  return chunks.map(formatAuditChunk).join("\n");
}

/**
 * Deterministic helper (LLM call YOK): spec.md'nin belirli bir section'unu
 * markdown formatlı döndür. AC / Risks / Scope gibi başlık-bazlı section'lar
 * için relevance scoring gereksiz — section'un kendisi zaten Phase 6/10/19
 * tarafından deterministik olarak hedeflenir.
 *
 * Mevcut `audit.ts:extractSpecSection`'a alternatif (chunk-store consistency).
 * Section yoksa sentinel string.
 */
export async function getSpecSectionMarkdown(
  projectRoot: string,
  heading: string,
): Promise<string> {
  const chunks = await extractSpecChunks(projectRoot);
  const match = chunks.find(
    (c) => c.metadata.heading?.toLowerCase() === heading.toLowerCase(),
  );
  if (!match) {
    return `(no '${heading}' section in spec)`;
  }
  return match.text;
}

/**
 * Pure formatter — spec chunk'ından markdown digest entry üretir. Export
 * edildi çünkü test edilen tek pure logic; format değişimi unit test
 * tarafından yakalanır.
 */
export function formatSpecChunk(c: ScoredChunk): string {
  const heading = c.metadata.heading ?? "(unnamed)";
  return `### ${heading} (relevance ${c.score}/10 — ${c.reason})\n${c.text}`;
}

/**
 * Pure formatter — brief chunk'ından markdown digest entry. Spec ile aynı
 * format (heading + score + reason + body).
 */
export function formatBriefChunk(c: ScoredChunk): string {
  const heading = c.metadata.heading ?? "(unnamed)";
  return `### ${heading} (relevance ${c.score}/10 — ${c.reason})\n${c.text}`;
}

/**
 * Pure formatter — audit chunk'ından kısa satır. Audit event'leri normalde
 * tek satır olduğu için kompakt format: `- [score/10] event text — reason`.
 */
export function formatAuditChunk(c: ScoredChunk): string {
  return `- [${c.score}/10] ${c.text} — ${c.reason}`;
}

/**
 * Phase 1 (Intent Gathering) için zengin proje bağlamı. Tüm chunk kaynaklarını
 * (spec, abandoned, audit, patterns, brief, git) tek query'de toplar; mevcut
 * intent'e en alakalı parçaları source-bazlı gruplanmış markdown olarak döner.
 *
 * Vibe coding'in "MyCL hafızası" iddiasını Phase 1'de somutlaştırır: Claude
 * iterasyon başında "yeni bir uygulama mı?" gibi bağlamsız soru soramaz;
 * proje zaten var olduğunu görür ve **mevcut özelliklere göre** clarifying
 * yapar.
 *
 * Relevance boş dönerse (bu niyet için indekslenmiş spec/audit chunk'ı yok)
 * sentinel döner — AMA projenin gerçekten boş olup olmadığını `isExistingProject`
 * (deterministik dosya sistemi) belirler. Mevcut kod varken relevance boş olabilir
 * (henüz .mycl spec/audit yazılmamış); o durumda "fresh project" DEMEK yanlış
 * (greenfield false-positive). Mevcut projede sentinel "mevcudu değiştir, sıfırdan
 * kurma" der; gerçekten boş projede "fresh project" der.
 */
export async function buildRelevantProjectContext(
  config: MyclConfig,
  state: State,
  intent: string,
): Promise<string> {
  const chunks = await getRelevantChunks(config, state, {
    // v15.11: "features" — yaşayan özellik dökümantasyonu (en grounded kaynak;
    // ajan "X özelliği var mı?" diye sormak yerine features.md'den görür).
    sources: ["features", "spec", "abandoned", "audit", "patterns", "brief", "git"],
    intent,
    // Phase 1 için zengin context — diğer fazlardan (max=5) yüksek.
    max_chunks: 8,
    // Proje bağlamı için düşük threshold — alakalı parçalar daha az direkt
    // olabilir ama yine de değerli (örn. genel audit özetleri).
    min_score: 5,
  });

  if (chunks.length === 0) {
    // Relevance boş ≠ proje boş. Deterministik dosya sistemiyle ayırt et.
    const existing = await isExistingProject(state.project_root);
    if (existing) {
      return "(no indexed MyCL context (spec/audit) for this intent yet — but the project has EXISTING CODE; per the codebase snapshot, MODIFY the existing code, do NOT rebuild from scratch)";
    }
    return "(no prior project context — fresh project)";
  }

  return formatProjectContextGroups(chunks);
}

/**
 * Pure formatter — ScoredChunk[] listesini source bazlı gruplara böler ve
 * her grup için markdown sub-section üretir. Phase 1 prompt'unda Claude'un
 * "spec'te şu var, audit'te şu yapıldı" gibi ayrıştırılmış görmesi için.
 *
 * Format:
 *   ### spec
 *   - **Scope** (relevance 8/10 — matches todo crud): "## Scope\n..."
 *   - **Acceptance Criteria** (relevance 7/10 — ...): "..."
 *   ### audit
 *   - [7/10] Phase 8: tdd-green ... — ui-related
 *   ### git
 *   - [6/10] abc1234 add auth middleware — Files: ...
 */
export function formatProjectContextGroups(chunks: ScoredChunk[]): string {
  // Source başına grupla; içeride score'a göre desc sırala.
  const groups = new Map<string, ScoredChunk[]>();
  for (const c of chunks) {
    const arr = groups.get(c.source) ?? [];
    arr.push(c);
    groups.set(c.source, arr);
  }

  // Source render sırası — okunabilirlik için anlamlı bir öncelik.
  // v15.11: "features" en başta — mevcut özellikler ajanın ilk görmesi gereken.
  const order = ["features", "spec", "brief", "abandoned", "audit", "git", "patterns"];
  const sections: string[] = [];

  for (const source of order) {
    const items = groups.get(source);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => b.score - a.score);
    const lines = items.map((c) => {
      // audit / git — kompakt one-liner; spec / brief / patterns / abandoned —
      // section bazlı, daha geniş.
      if (c.source === "audit" || c.source === "git") {
        return formatAuditChunk(c);
      }
      const label = c.metadata.heading ?? c.metadata.event ?? "(item)";
      return `- **${label}** (relevance ${c.score}/10 — ${c.reason})\n  ${c.text.replace(/\n/g, "\n  ")}`;
    });
    sections.push(`### ${source}\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Pure formatter — abandoned chunk'ından markdown digest entry. Iteration
 * + date + score + reason header.
 */
export function formatAbandonedChunk(c: ScoredChunk): string {
  const iter = c.metadata.iteration ?? "?";
  const date = c.metadata.ts
    ? new Date(c.metadata.ts).toISOString().slice(0, 10)
    : "?";
  return `### Iteration ${iter} (${date}, relevance ${c.score}/10 — ${c.reason})\n${c.text}`;
}
