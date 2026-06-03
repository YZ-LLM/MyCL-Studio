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
