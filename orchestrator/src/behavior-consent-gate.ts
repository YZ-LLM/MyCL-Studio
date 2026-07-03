// behavior-consent-gate — Faz 8 KURULMADAN ÖNCE çalışan orkestratör kapısı. YZLLM 2026-07-03.
//
// Sözleşme: MyCL var olan bir davranışı DEĞİŞTİRMEDEN ÖNCE kullanıcıya kısa/net, TEK TEK (sıralı)
// sorar. EVET → değişiklik + `.feature`+test+kod BİRLİKTE güncellenir (bayat artefakt yok). HAYIR →
// o davranışın dosyalarına dokunulmaz, davranış olduğu gibi kalır, iterasyonun gerisi sürer.
//
// Tasarım (KATI#6 correct-by-construction): kapı değişiklik kümesini Faz 8 başında TAZE hesaplar
// (behavior-consent.ts, deterministik spec farkı) → soru her Write'tan önce sorulur. Kararlar diske
// yazılır (.mycl/behavior-consent.jsonl); kapı her Faz 8 kuruluşunda notu bu kayıtlardan yeniden üretir
// → retry / sidebar yeniden-koş onay bağlamını KAYBETMEZ (mahkeme bulgusu #5). İmza içerikten türediğinden
// spec değişince imza değişir → recall eşleşmez → taze sorar (bulgu #7 doğal çözüm).
//
// Kuplaj: index.ts/handleAskqAnswer bir `behavior_consent_*` cevabını resolveConsentAnswer'a yollar
// (2 satır); kapının kendi bellekteki çözücü haritası sıralı bekleme sağlar (kalıcı kaynak consent.jsonl).

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { MyclConfig } from "./config.js";
import type { State } from "./types.js";
import { emitAskq, emitChatMessage } from "./ipc.js";
import { translate } from "./translator.js";
import { save as saveState } from "./state.js";
import { currentSpecPath } from "./devs-paths.js";
import { readAuditLogTail } from "./audit.js";
import {
  computeBehaviorChangeSet,
  appendBehaviorConsent,
  readBehaviorConsent,
  latestConsentFor,
  MAX_CONSENT_ASKS,
  type BehaviorChange,
  type BehaviorConsentRecord,
  type ConsentDecision,
} from "./behavior-consent.js";

// Sabit askq etiketleri (handleAskqAnswer id-öneki ile eşler, etiketle DEĞİL → yeniden-ifade güvenli).
const CHANGE_YES = "Evet, değiştir";
const REMOVE_YES = "Evet, kaldır";
const CONSENT_NO = "Hayır, dokunma";
const REUSE_YES = "Evet, aynısı";
const REUSE_NO = "Hayır, yeniden karar ver";
const CB_ALL = "Hepsini onayla, devam et";
const CB_STOP = "Dur, spec'i gözden geçireceğim";

const CONSENT_ID_PREFIX = "behavior_consent_";

// Kapı Faz 8 dağıtım akışından cevabı BEKLER (await). handleAskqAnswer id ile bu haritadaki çözücüyü
// tetikler → sıralı tek-tek döngü ilerler. Bellekte (persist YOK; kalıcı karar kaynağı consent.jsonl).
const pendingConsent = new Map<string, (sel: string) => void>();

function emitConsentAskq(question: string, options: string[]): Promise<string> {
  const id = `${CONSENT_ID_PREFIX}${randomUUID()}`;
  return new Promise<string>((resolve) => {
    pendingConsent.set(id, resolve);
    // sensitive: oto-cevap YOK — davranış değişikliği HER ZAMAN kullanıcıya sorulur (Faz 6 gibi).
    // Bu yüzden autoAnswerPick'e uğramaz; doğrudan emitAskq.
    emitAskq({ id, question, options });
  });
}

/** index.ts/handleAskqAnswer bir behavior_consent_* cevabını buraya yollar. İşlendiyse true. */
export function resolveConsentAnswer(id: string, selected: string): boolean {
  const resolve = pendingConsent.get(id);
  if (!resolve) return false;
  pendingConsent.delete(id);
  resolve(selected);
  return true;
}

export function isConsentAskqId(id: string): boolean {
  return id.startsWith(CONSENT_ID_PREFIX);
}

async function trText(config: MyclConfig, en: string): Promise<string> {
  if (!en.trim()) return en;
  try {
    return (await translate(config, en, "en-to-tr")).text;
  } catch {
    return en; // çeviri başarısızsa İngilizce göster: soru yine GÖRÜNÜR (KATI#4 — sessiz kayıp değil)
  }
}

async function askOneBehavior(
  state: State,
  config: MyclConfig,
  ch: BehaviorChange,
): Promise<ConsentDecision> {
  const iter = state.iteration_count ?? 1;
  const recall = latestConsentFor(await readBehaviorConsent(state.project_root), ch.sig);
  // Aynı iterasyonda zaten karar verildiyse (Faz 8 yeniden koşuldu) → sessiz yeniden-kullan (idempotent).
  if (recall && recall.iteration === iter) return recall.decision;

  const priorTr = await trText(config, ch.priorStatement);

  // Kademe 2: aynı davranış değişikliği FARKLI bir iterasyonda daha önce de sorulmuş → hafif onay.
  // (Nadir — imza değiştikçe eşleşmez; ama birebir tekrarda kullanıcıyı yormamak için.) Asla sessiz-oto değil.
  if (recall) {
    const label = recall.decision === "yes" ? "değiştir/kaldır" : "dokunma";
    emitChatMessage(
      "assistant",
      `Bu davranış daha önce de değişmişti — geçen sefer **${label}** demiştin: ${priorTr}`,
    );
    const sel = await emitConsentAskq("Aynı kararı kullanayım mı?", [REUSE_YES, REUSE_NO]);
    if (sel === REUSE_YES) return recall.decision;
    // Hayır → taze karara düş.
  }

  // Kademe 1: taze soru.
  if (ch.kind === "removed") {
    const q = `Var olan bir davranışı **kaldırmak** üzereyim:\n\n• ${priorTr}\n\nBu davranışı kaldırayım mı?`;
    return (await emitConsentAskq(q, [REMOVE_YES, CONSENT_NO])) === REMOVE_YES ? "yes" : "no";
  }
  const newTr = await trText(config, ch.newStatement ?? "");
  const q =
    "Var olan bir davranışı **değiştirmek** üzereyim:\n\n" +
    `• Şu an: ${priorTr}\n• Olacak: ${newTr}\n\nBu değişikliği yapayım mı?`;
  return (await emitConsentAskq(q, [CHANGE_YES, CONSENT_NO])) === CHANGE_YES ? "yes" : "no";
}

/** Faz 8 codegen ajanına (İngilizce çalışır) enjekte edilecek onay talimatı bloğu. */
function buildConsentNote(yes: BehaviorChange[], no: BehaviorChange[]): string {
  let s = "";
  if (yes.length > 0) {
    s +=
      "\n\n---\n## APPROVED behavior changes (the user explicitly consented)\n" +
      "For EACH item below, update its `.feature` scenario, its test AND the code TOGETHER in this " +
      "iteration — leave NO stale artifact (no lying doc/test):\n";
    for (const c of yes) {
      s +=
        c.kind === "removed"
          ? `- REMOVE this behavior: ${c.priorStatement}\n`
          : `- CHANGE — from: ${c.priorStatement} — to: ${c.newStatement ?? "(see spec)"}\n`;
    }
  }
  if (no.length > 0) {
    s +=
      "\n\n---\n## REFUSED behavior changes (the user said NO)\n" +
      "Do NOT modify the behavior, code, test, or `.feature` of the following. Keep them EXACTLY as " +
      "they are RIGHT NOW, even if the spec seems to ask otherwise. Build the rest of the iteration " +
      "around them:\n";
    for (const c of no) s += `- KEEP AS-IS: ${c.priorStatement}\n`;
  }
  return s;
}

// ── Layer C: onaylı davranış değişikliği ama .feature güncellenmedi mi (bayat artefakt riski) ──

/**
 * SAF: bu iterasyonda EN AZ BİR davranış değişikliği ONAYLANDI ("yes") ama HİÇ `.feature` yazılmadı/güncellenmedi
 * (bddWriteCount===0) → onaylı davranışlar için yaşayan dokümantasyon koddan geri kalmış olabilir. Kaba ama
 * güvenli (yanlış-poz: yes-var/feature-yok nadir + zararsız görünür bayrak). Bloke DEĞİL — Faz 9 sinyali.
 */
export function detectStaleConsentedArtifacts(
  records: BehaviorConsentRecord[],
  iteration: number,
  bddWriteCount: number,
): string[] {
  if (bddWriteCount > 0) return [];
  return records.filter((r) => r.iteration === iteration && r.decision === "yes").map((r) => r.priorStatement);
}

/** I/O: consent.jsonl + bu iterasyonun audit'lerinden bayat-artefakt sinyalini hesapla (Faz 9 çağırır). */
export async function checkConsentStaleArtifacts(state: State): Promise<string[]> {
  const iter = state.iteration_count ?? 1;
  const iterStart = state.iteration_started_at ?? 0;
  const [records, audit] = await Promise.all([
    readBehaviorConsent(state.project_root).catch(() => [] as BehaviorConsentRecord[]),
    readAuditLogTail(state.project_root, 1500).catch(() => []),
  ]);
  const bddWriteCount = audit.filter((e) => e.event === "bdd-scenario-write" && e.ts >= iterStart).length;
  return detectStaleConsentedArtifacts(records, iter, bddWriteCount);
}

async function recordConsent(
  projectRoot: string,
  iteration: number,
  c: BehaviorChange,
  decision: ConsentDecision,
): Promise<void> {
  await appendBehaviorConsent(projectRoot, {
    ts: Date.now(),
    iteration,
    sig: c.sig,
    decision,
    scope: "behavior-consent",
    priorStatement: c.priorStatement,
    featureFiles: c.featureFiles,
    testFiles: c.testFiles,
  });
}

/**
 * Faz 8 KURULMADAN önce çalışır. Dönüş: DEVAM (true) / DUR (false — kullanıcı devre-kesicide
 * "spec'i gözden geçireceğim" dedi). Foreign kökende Layer B envanteri gelene dek MyCL spec geçmişi
 * olmadığından değişiklik kümesi boş kalır → sıfır soru (sessiz-atlama değil; genuinely korunacak yok).
 */
export async function runBehaviorConsentGate(state: State, config: MyclConfig): Promise<boolean> {
  // Her koşuda geçici alanları temizle → önceki iterasyonun notu/yasak-yolu sızmaz.
  state.pending_behavior_consent_note = undefined;
  state.behavior_consent_no_paths = undefined;

  // YABANCI proje: pre-change spec-diff sorusu YOK (kullanıcı kararı — Layer B). Yabancıda mevcut davranışın
  // kesin spec'i yoktur; test-adı eşleşmesi "test ekleme"yi "davranış değiştirme"den ayıramaz → yanlış sorular.
  // Bunun yerine deterministik BASELINE yüzeyi (behavior-baseline): entegrasyon öncesi geçen bir test iterasyon
  // sonrası düşerse Faz 8 GÖRÜNÜR bayrak verir (bloke etmez). Bkz snapshotBehaviorBaseline + phase-8 surface.
  if (state.origin === "foreign") return true;

  if (!state.iteration_started_at) return true; // iter-1 defansif (scope 0'dan başlar)
  let currentSpecMd: string;
  try {
    currentSpecMd = await fs.readFile(currentSpecPath(state), "utf-8");
  } catch {
    return true; // spec yoksa Faz 8 kendi spec-check'inde GÖRÜNÜR hata verir; kapı sessiz geçer (çift-hata yok)
  }

  const set = await computeBehaviorChangeSet({
    projectRoot: state.project_root,
    iteration: state.iteration_count ?? 1,
    iterationTs: state.iteration_started_at,
    currentSpecMd,
  });
  if (set.changes.length === 0) return true;

  const yes: BehaviorChange[] = [];
  const no: BehaviorChange[] = [];

  // Devre kesici (patoloji koruması, toplu-soru DEĞİL): tek iterasyonda çok fazla değişiklik →
  // neredeyse kesin bozuk-diff. 12 açılır pencere yerine tek bilinçli karar.
  if (set.changes.length > MAX_CONSENT_ASKS) {
    emitChatMessage(
      "system",
      `⚠️ Bu iterasyon **${set.changes.length}** var olan davranışı birden değiştiriyor — bu genelde ` +
        "spec'in fazla değiştiğinin işaretidir. Tek tek yerine bir kez soruyorum.",
    );
    if ((await emitConsentAskq("Çok sayıda davranış değişiyor — nasıl devam edeyim?", [CB_ALL, CB_STOP])) === CB_STOP) {
      emitChatMessage("system", "⏸️ Durdum — spec'i gözden geçir, sonra Faz 8'i yeniden başlat.");
      return false;
    }
    yes.push(...set.changes); // "Hepsini onayla"
  } else {
    for (const ch of set.changes) {
      const decision = await askOneBehavior(state, config, ch);
      (decision === "yes" ? yes : no).push(ch);
    }
  }

  const iter = state.iteration_count ?? 1;
  for (const c of yes) await recordConsent(state.project_root, iter, c, "yes");
  for (const c of no) await recordConsent(state.project_root, iter, c, "no");

  state.pending_behavior_consent_note = buildConsentNote(yes, no);
  const noPaths = no.flatMap((c) => [...c.featureFiles, ...c.testFiles]);
  state.behavior_consent_no_paths = noPaths.length > 0 ? noPaths : undefined;
  // NOT: foreign köken bu noktaya ULAŞMAZ (yukarıda erken-return) → source_edit_approved burada set EDİLMEZ;
  // yabancı koruma baseline yüzeyiyle sağlanır, kaynak-edit hook'u rezerve kalır.

  // Persist best-effort: not her koşta yeniden üretilir → disk hatası kritik değil (KATI#4 dürüst: yutulmaz, loglanır).
  await saveState(state).catch((e) => {
    emitChatMessage("system", `⚠️ Onay durumu diske yazılamadı (kritik değil, yeniden üretilir): ${String(e)}`);
  });
  return true;
}
