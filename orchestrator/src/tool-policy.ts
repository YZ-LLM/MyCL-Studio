// tool-policy — claude CLI araç-izin politikası (tek doğruluk kaynağı).
//
// KÖK NEDEN (YZLLM 2026-06-13, gerçek trace): cli-session/cli-run/persistent-cli-session
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

/** Doğrudan dosya-yazma araçları. YZLLM 2026-06-15: "MultiEdit" KALDIRILDI — güncel
 * Claude Code CLI bu aracı tanımıyor; deny-list'te geçince "no known tool" hatası verip
 * TÜM salt-okunur çağrıları (intake-split, çevirmen, living-docs) çökertiyordu. Edit/Write
 * zaten yasaklı (MultiEdit onların varyantıydı). */
export const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"] as const;

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

/**
 * SIFIR-ARAÇ deny-list: saf metin dönüşümü (ör. ders damıtma) — OKUMA dahil hiçbir araç açılmaz.
 * MAHKEME CRITICAL (2026-07-17): PURE_REASONING listesi Read/Grep/Glob'u kapatmıyordu → damıtıcı
 * proje dosyalarını okuyup içeriği sözdizim izi bırakmadan parafraz edebilirdi (leakGate sözdizimseldir).
 * Girdisi zaten prompt'ta olan çağrılar için tek doğru duruş: araçsız.
 */
export const ZERO_TOOLS_DISALLOWED: string[] = [
  ...PURE_REASONING_DISALLOWED_TOOLS,
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
];

/**
 * Tehlikeli Bash desenleri — Bash AÇIK olan HER CLI çağrısında deny-list'e dahil edilmeli.
 *
 * YZLLM canlı-test 0620: codegen + analiz fazları non-interaktif `claude -p`'yi
 * `--permission-mode bypassPermissions` ile koşar (acceptEdits Bash izin-prompt'unu
 * önlemiyordu → borulu/bileşik Bash headless'ta SONSUZA DEK ASILIYORDU). bypassPermissions
 * prompt'u kaldırır AMA deny kuralları mode'dan ÖNCE değerlendirildiği için bu baseline'ı
 * her Bash-açık çağrıya katarsak rm/sudo/git-push/chmod/publish yine BLOKLU kalır (güvenli).
 * Salt-okunur READ_ONLY_DISALLOWED bunları içermiyordu (yalnız Write/Edit/alt-ajan) → boşluk.
 */
export const DANGEROUS_BASH_DENY: string[] = [
  "Bash(rm *)",
  "Bash(sudo *)",
  "Bash(git push *)",
  "Bash(chmod *)",
  "Bash(npm publish *)",
  "Bash(yarn publish *)",
  "Bash(pnpm publish *)",
];

/**
 * Verilen deny-list'e tehlikeli-Bash baseline'ını ekler (dedup). Bash zaten tümden yasaksa
 * (saf-akıl fazları) baseline zararsız-fazlalık. bypassPermissions ile birlikte kullanılır.
 */
export function withDangerousBashDeny(disallowed: string[] | undefined): string[] {
  return Array.from(new Set([...(disallowed ?? []), ...DANGEROUS_BASH_DENY]));
}
