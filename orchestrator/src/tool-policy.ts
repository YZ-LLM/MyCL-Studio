// tool-policy — claude CLI araç-izin politikası (tek doğruluk kaynağı).
//
// KÖK NEDEN (Ümit 2026-06-13, gerçek trace): cli-session/cli-run/persistent-cli-session
// claude'u `--permission-mode acceptEdits` ile başlatır → `--allowedTools` bir KISITLAMA
// DEĞİL (yalnız oto-onay listesi). Tek gerçek engel `--disallowedTools`. Yani deny-list'te
// OLMAYAN her tehlikeli araç koşabilir — `allowedTools: ["Read","Grep","Glob"]` olsa bile.
//
// İki kanıtlı kaçış aynı sınıftandı:
//   1) `Bash` → salt-okunur Faz 9 `cat > admin.js << EOF` ile production kodunu EZDİ (Write yasağını baypas).
//   2) `Agent`/`Task` (alt-ajan doğuran araç) → Faz 9 bunu çağırdı; alt-ajan üst-fazın kısıtına TABİ DEĞİL
//      (kendi geniş varsayılan araç-setiyle: Write/Edit/Bash), hem kod-yazma kaçışı HEM de iç tool-çağrıları
//      üst-stream'e yansımadığı için 200+ sn "yeni komut yok" = donma.
//
// Bu yüzden her salt-okunur/saf faz, gerektirmediği tehlikeli araçları AÇIKÇA deny-list'e koymalı.
// Kullanım: yalnız spread (`[...SABIT]`) — bu paylaşılan dizilere in-place `.push()` YAPMA.

/** Alt-ajan doğuran araçlar — salt-okunur/saf fazlarda ASLA gerekmez; kaçış + donma vektörü. */
export const SUBAGENT_SPAWN_TOOLS = ["Agent", "Task"] as const;

/** Doğrudan dosya-yazma araçları. */
export const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"] as const;

/**
 * Salt-okunur ANALİZ fazları için deny-list: yazma + alt-ajan yasak, ama Bash AÇIK kalır
 * (faz kodu Read/Grep/Glob/Bash ile inceler). Örn: phase-0 D1, error-analysis, living-docs,
 * module-stock, hypothesis-investigation.
 */
export const READ_ONLY_DISALLOWED_TOOLS: string[] = [...WRITE_TOOLS, ...SUBAGENT_SPAWN_TOOLS];

/**
 * Saf akıl-yürütme / kabuk-gerektirmeyen fazlar için deny-list: yazma + alt-ajan + Bash yasak.
 * Örn: translator (saf çeviri), llm-reasoning, qa-askq (Faz 1/2/9 salt-okunur inceleme),
 * model-discovery ping/web-keşif. (WebSearch/WebFetch listede DEĞİL → gerektiğinde açık kalır.)
 */
export const PURE_REASONING_DISALLOWED_TOOLS: string[] = [...READ_ONLY_DISALLOWED_TOOLS, "Bash"];
