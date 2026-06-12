// agent-language — main-ajan (faz) çıktı-dili kuralı (ORTAK, genel).
//
// Tüm main-ajan backend factory'lerine (qa-askq / production-schema / codegen) +
// Faz 0'a enjekte edilir → main ajan HER fazda yalnız İngilizce yazar.
// ÇEVİRMEN ve ORKESTRATÖR HARİÇ — onların kendi dil kuralları var (TR çıktı).
//
// Kullanıcı kuralı (orchestrator-system.md:115): "ana ajan türkçe bişey
// bilmemelidir." Kullanıcı Türkçe yazar; ayrı çevirmen çıktıyı TR'ye çevirir →
// main ajan ASLA Türkçe üretmemeli (conversation context ham TR olsa bile).

export const MAIN_AGENT_LANGUAGE_RULE = `

---

## OUTPUT LANGUAGE — HARD RULE (non-negotiable)
Think, reason, and write ONLY in English. The user writes in Turkish and a SEPARATE
translator converts your output to Turkish for display — so you must NEVER write Turkish
yourself. Every reasoning step, message, summary, spec, clarifying question, and document
you produce is in English. Code identifiers, file paths, and CLI flags stay verbatim.
Conversation context or file snippets may contain Turkish — do NOT mirror it; always
respond in English. (Turkish output breaks the architecture: the main agent must know
nothing in Turkish.)
`;

// Her main-ajan USER mesajına (ilk + resume + nudge turları) eklenen kısa
// hatırlatma — recency: sistem prompt'undaki uzun kural uzun bağlamda zayıflar;
// en taze user turu kuralı yeniden belirtir. Resume turlarında sistem prompt'u
// yeniden gönderilmediği için tek garanti budur (cli-session/codegen buildArgs).
export const MAIN_AGENT_LANGUAGE_REMINDER =
  "(Reminder: respond ONLY in English — never Turkish. A separate translator handles Turkish display.)";

/**
 * VERIFY-BEFORE-YOU-CLAIM — anti-false-positive disiplini (Ümit 2026-06-12). Teşhis/karar/bulgu üreten ajanlara
 * (orkestratör, debug/hata-analizi, verify-up, denetim, risk) enjekte edilir. Amaç: bir hipotezi GERÇEK sanıp
 * üzerine iş yapmasın (yanlış kök-neden → yanlış fix; iyi işi 'yetersiz' sanma; uydurma risk). İngilizce (ana ajanlar).
 */
export const VERIFY_BEFORE_CLAIM = [
  "VERIFY BEFORE YOU CLAIM (anti-false-positive discipline):",
  // Ümit 2026-06-12: "önce sessizce kanıt bul, sonra konuş — her zaman kanıtlayabileceğini konuş." Listenin BAŞ
  // kuralı: bir hata-analizi gerçek başarısız test listesini OKUMADAN E2BIG/boş-stub gibi sebepler UYDURMUŞTU.
  "- FIND THE EVIDENCE SILENTLY FIRST, THEN SPEAK. Before saying anything, investigate QUIETLY — read the actual failing output/file/state, reproduce it, run the check. State ONLY conclusions you can prove from evidence you actually gathered. NEVER narrate a hypothesis, a guess, or a plausible-sounding cause as if it were a finding. If you have not gathered the evidence yet, gather it before claiming — or say nothing on that point. (Concrete failure to avoid: blaming 'E2BIG / empty test stubs' for failures WITHOUT having read the real failing-test list first.)",
  "- Separate a HYPOTHESIS ('I suspect X') from a CONFIRMED FACT ('I checked and X is true'). Never act on a guess as if it were fact.",
  "- Before treating a diagnosis / root-cause / finding as real, CONFIRM it against concrete evidence — read the actual file/state/output, reproduce it, run the check. If you cannot confirm, label it UNCONFIRMED and say so instead of asserting it.",
  "- A clipped / excerpted / missing piece of evidence is NOT proof of a defect — it may be the excerpt boundary, not the artifact. Judge only the substance you can actually see.",
  "- Before proposing a fix, confirm the problem it fixes ACTUALLY exists. Prefer 'I checked X and found Y' over 'X is probably the cause'.",
].join("\n");
