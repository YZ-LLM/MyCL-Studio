// spec-comprehension — spec onayından ÖNCE "okudun mu?" kapısı (Ümit 2026-06-11, #6 deliği: kullanıcı spec'i
// OKUMADAN onaylamasın). Spec'ten gerçek bir kabul kriteri (AC) + LLM'in ürettiği SAHTE (spec'te OLMAYAN) çeldiriciler
// → çoktan-seçmeli. Kullanıcı spec'i okumadan gerçek AC'yi ayırt edemez.
//
// ⚠️ İZOLASYON (Ümit "dikkat et"): çeldiriciler YALNIZ bu modülün döndürdüğü nesnede + askq seçeneklerinde yaşar.
// HİÇBİR yere yazılmaz — spec.md'ye değil, state'e değil, audit'e değil, log'a değil. Spec'i yazan ajan onları HİÇ
// görmez (ayrı, izole bir LLM çağrısı). Cevaptan sonra çağıran taraf nesneyi atar. Yanlış cevap "kullanıcı yanlış
// cevap verdi" diye loglanır — seçilen çeldirici ASLA loglanmaz. Sızarsa sistem saçmalar.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runReasoning } from "./llm-reasoning.js";
import { translate } from "./translator.js";
import { appendAudit } from "./audit.js";
import { emit, emitChatMessage } from "./ipc.js";
import type { MyclConfig } from "./config.js";
import type { PhaseId } from "./types.js";
import { log } from "./logger.js";

/** spec.md'den kabul kriteri (AC) METİNLERİNİ ayrıştırır. `- **AC1**: metin` deseni (Faz 4 spec formatı). SAF. */
export function parseAcTexts(specMd: string): string[] {
  const re = /^\s*-\s+\*\*AC\d+\*\*:\s*(.+?)\s*$/gm;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(specMd)) !== null) {
    const t = m[1].trim();
    if (t.length >= 4) out.push(t);
  }
  return out;
}

export interface ComprehensionQuestion {
  /** Kullanıcıya gösterilecek soru (TR). */
  question_tr: string;
  /** Karışık seçenekler (TR): bir tanesi gerçek AC, diğerleri sahte çeldirici. */
  options_tr: string[];
  /** Doğru seçeneğin indeksi (gerçek AC). Yalnız bellekte; hiçbir yere yazılmaz. */
  correctIndex: number;
}

/**
 * LLM ile SAHTE kabul kriterleri üretir — spec'te OLMAYAN, makul ama yanlış. İzole tek-atış çağrı (spec-yazan ajanla
 * paylaşılmaz). Üretilenler yalnız döndürülür; çağıran askq'ya koyar + atar. Fail → boş (kapı sayı-sorusuna düşmez,
 * çağıran AC-sayısı yeterli değilse kapıyı atlar).
 */
async function generateDistractors(
  config: MyclConfig,
  projectRoot: string,
  specMd: string,
  realAcs: string[],
  count: number,
): Promise<string[]> {
  const sys =
    "You generate PLAUSIBLE-BUT-FALSE acceptance criteria for a reading-comprehension check. Given a spec, write " +
    `${count} acceptance criteria that sound realistic for this kind of project but are NOT in the spec and are ` +
    "clearly different from the real ones (different feature/behavior). They must be believable yet wrong. Output " +
    "ONLY a JSON array of exactly " + count + " short English strings, no other text. NEVER copy a real criterion.";
  const user =
    `SPEC:\n${specMd.slice(0, 6000)}\n\nREAL acceptance criteria (do NOT reuse these):\n` +
    realAcs.map((a, i) => `${i + 1}. ${a}`).join("\n") +
    `\n\nNow output the JSON array of ${count} false-but-plausible criteria.`;
  let text: string;
  try {
    const r = await runReasoning(config, {
      systemPrompt: sys,
      userMessage: user,
      modelId: config.selected_models.main,
      projectRoot,
      maxTokens: 800,
    });
    text = r.text;
  } catch (e) {
    log.warn("spec-comprehension", "distractor generation failed", e);
    return [];
  }
  // JSON array'i ayıkla (model bazen ```json sarar).
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]) as unknown[];
    return arr
      .filter((x): x is string => typeof x === "string" && x.trim().length >= 4)
      .map((x) => x.trim())
      .slice(0, count);
  } catch {
    return [];
  }
}

const TR = async (config: MyclConfig, en: string): Promise<string> => {
  try {
    return (await translate(config, en, "en-to-tr")).text || en;
  } catch {
    return en;
  }
};

/**
 * Spec'ten anlama-kontrol sorusu kurar. AC yoksa/azsa (en az 1 gerçek + en az 2 çeldirici üretilemezse) → null
 * (çağıran kapıyı atlar; sayı-sorusu YOK — Ümit). `nonce` ile her denemede farklı gerçek-AC seçilir (gameleme zorlaşır).
 * İZOLASYON: dönen nesne dışında hiçbir kalıcılık yok.
 */
export async function buildComprehensionQuestion(
  config: MyclConfig,
  projectRoot: string,
  specMd: string,
  nonce: number,
): Promise<ComprehensionQuestion | null> {
  const acs = parseAcTexts(specMd);
  if (acs.length === 0) return null;
  const realEn = acs[nonce % acs.length];
  const distractorsEn = await generateDistractors(config, projectRoot, specMd, acs, 3);
  if (distractorsEn.length < 2) return null; // yeterli çeldirici yok → kapıyı atla (sayı-sorusuna düşme)

  // TR'ye çevir (kullanıcı Türkçe görür). Gerçek AC + çeldiriciler.
  const realTr = await TR(config, realEn);
  const distractorsTr = await Promise.all(distractorsEn.slice(0, 3).map((d) => TR(config, d)));

  // Karıştır: gerçek AC'yi nonce'a göre bir konuma koy (deterministik, denemeye göre değişir).
  const options = [...distractorsTr];
  const correctIndex = nonce % (options.length + 1);
  options.splice(correctIndex, 0, realTr);

  return {
    question_tr:
      "Spec'i okuduğunu doğrulayalım: Aşağıdakilerden hangisi bu spec'in GERÇEK bir kabul kriteri? (Diğerleri bu spec'te YOK.)",
    options_tr: options,
    correctIndex,
  };
}

/** Backend-bağımsız askq emit+bekle fonksiyonu (her backend kendi askq mekanizmasıyla sağlar). */
export type AskOnce = (question_tr: string, options_tr: string[], allowOther: boolean) => Promise<string>;

/**
 * Spec onayından ÖNCE okuma-doğrulama kapısı (Ümit 2026-06-11, #6) — PAYLAŞILAN (API+CLI backend ikisi de çağırır).
 * Doğru cevap gelene dek döner: spec'i biçimli popup'ta göster + çoktan-seçmeli sor (gerçek AC vs İZOLE sahte
 * çeldiriciler). Yanlış → SADECE "kullanıcı yanlış cevap verdi" loglanır (seçim/çeldirici ASLA yazılmaz) + spec
 * tekrar + "okudum anladım" + tekrar soru. Soru kurulamazsa (AC yok / çeldirici üretilemedi) kapıyı ATLA (sayı
 * sorusu YOK). İZOLASYON: çeldiriciler yalnız askq seçeneklerinde; hiçbir kalıcı yere yazılmaz.
 */
export async function runComprehensionGate(
  config: MyclConfig,
  projectRoot: string,
  phaseId: PhaseId,
  askOnce: AskOnce,
): Promise<void> {
  let specMd: string;
  try {
    specMd = await readFile(join(projectRoot, ".mycl", "spec.md"), "utf-8");
  } catch {
    return; // spec yok → kapı yok
  }
  const specTr = await translate(config, specMd, "en-to-tr")
    .then((r) => r.text)
    .catch(() => specMd);
  for (let attempt = 0; attempt < 25; attempt++) {
    const q = await buildComprehensionQuestion(config, projectRoot, specMd, attempt);
    if (!q) return; // çeldirici/AC üretilemedi → kapıyı atla (sayı-sorusuna DÜŞME)
    emit("spec_review", { spec_tr: specTr }); // frontend: biçimli popup (GuideModal)
    emitChatMessage("system", "📋 Spec'i açtım — okuyup aşağıdaki soruyu yanıtla (okumadan onay yok).");
    const sel = await askOnce(q.question_tr, q.options_tr, false);
    if (sel === q.options_tr[q.correctIndex]) {
      emitChatMessage("system", "✅ Spec okuma doğrulandı — onaya geçiyorum.");
      return;
    }
    // YANLIŞ — SADECE generic log; seçilen çeldirici ASLA hiçbir yere yazılmaz (Ümit: sisteme sızmasın).
    await appendAudit(projectRoot, {
      ts: Date.now(),
      phase: phaseId,
      event: "spec-comprehension-wrong",
      caller: "user",
      detail: "kullanıcı yanlış cevap verdi",
    });
    emitChatMessage(
      "system",
      "❌ Spec onayı alınamadı. Lütfen Spec'i okuyunuz ve ardından **okudum anladım** yazınız.",
    );
    emit("spec_review", { spec_tr: specTr });
    let ack = "";
    while (!/okudum\s*,?\s*anlad/i.test(ack)) {
      ack = await askOnce("Spec'i okuduysan 'okudum anladım' yaz.", [], true);
    }
  }
}
