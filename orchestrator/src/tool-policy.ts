// tool-policy — claude CLI araç-izin politikası (tek doğruluk kaynağı).
//
// KÖK NEDEN (YZLLM 2026-06-13, gerçek trace): cli-session/cli-run/persistent-cli-session
// claude'u izin sormayan bir kiple başlatır (o gün `acceptEdits`, v15.14'ten beri
// `bypassPermissions`) → `--allowedTools` bir KISITLAMA DEĞİL (yalnız oto-onay listesi).
// Tek gerçek engel `--disallowedTools`. Yani deny-list'te
// OLMAYAN her tehlikeli araç koşabilir — `allowedTools: ["Read","Grep","Glob"]` olsa bile.
//
// İki kanıtlı kaçış aynı sınıftandı:
//   1) `Bash` → salt-okunur Faz 9 `cat > admin.js << EOF` ile production kodunu EZDİ (Write yasağını baypas).
//   2) `Agent`/`Task` (alt-ajan doğuran araç) → Faz 9 bunu çağırdı; alt-ajan üst-fazın kısıtına TABİ DEĞİL
//      (kendi geniş varsayılan araç-setiyle: Write/Edit/Bash), hem kod-yazma kaçışı HEM de iç tool-çağrıları
//      üst-stream'e yansımadığı için 200+ sn "yeni komut yok" = donma.
//
// Bu yüzden her salt-okunur/saf faz, gerektirmediği tehlikeli araçları AÇIKÇA deny-list'e koymalı.
// İSTİSNA (2026-11-27): sıfır araç politikasında ret listesi eksik kalıyordu (listede olmayan yerleşik araçlar
// ve MCP araçları açıktı); orada asıl engel izin listesidir: `--tools ""` + `--strict-mcp-config`
// (bkz. zeroToolLaunchArgs). Ret listesi ikinci kat olarak kalır.
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

/**
 * `runClaudeCli` / `runClaudeCliSession` çağrısının GERÇEKTE uygulanan deny-list'i.
 *
 * CANLI KANIT (ekransız deneme koşusu 6, 2026-11-27): ilgililik sınıflandırıcısı `disallowedTools`
 * VERMEDEN çağrılıyordu → `bypassPermissions` altında Write/Edit/Bash açıktı; tek engel prompt'taki
 * "Do NOT call any tool." cümlesiydi. Model parça metinlerini görev sandı ve MyCL'in başlatıldığı
 * klasöre 10 dosya yazdı. Aynı açık iki çağrıda daha vardı (konuşma özeti, proje tipi).
 *
 * Kaynağında çözüm (KATI #6): politika VERİLMEYEN çağrı tam yetkili DEĞİL, ARAÇSIZ sayılır.
 * `disallowedTools` iki başlatıcıda da zorunlu alandır (unutan çağrı derlenmez); bu işlev, tipin
 * göremediği yolları (cast, düz JS) da kapalı tarafa düşürür. Açıkça verilen liste — boş dizi dahil —
 * çağıranın bilinçli kararıdır ve aynen uygulanır (yalnız tehlikeli Bash tabanı eklenir).
 *
 * Kod üretim yolu (`codegen/cli-backend.ts`) bunu KULLANMAZ: orada tam yazma yetkisi işin kendisidir
 * ve `withDangerousBashDeny(undefined)` bilinçli sabittir.
 */
export function effectiveDisallowedTools(disallowed: string[] | undefined): string[] {
  return withDangerousBashDeny(disallowed ?? ZERO_TOOLS_DISALLOWED);
}

/**
 * SAF: bu çağrının politikası "sıfır araç" mı? Ölçüt tek yerde: uygulanan ret listesi
 * `ZERO_TOOLS_DISALLOWED`'ın tamamını içeriyor (politika verilmeyen çağrı da buraya düşer).
 */
export function isZeroToolPolicy(disallowed: string[] | undefined): boolean {
  const deny = effectiveDisallowedTools(disallowed);
  return ZERO_TOOLS_DISALLOWED.every((t) => deny.includes(t));
}

/**
 * SAF: sıfır araç politikalı çağrının `claude` sürecine EK bayrakları; öteki politikalarda boş.
 *
 * CANLI KANIT (ekransız deneme koşuları 9, 10, 11; 2026-11-27): ilgililik sınıflandırıcısı sıfır araç ret
 * listesiyle koştuğu hâlde `ListAgents`, `ToolSearch`, `SendMessage` araçlarını çağırdı. Ret listesi yalnız
 * adını bildiği yerleşik araçları kapatır; CLI'ın sunduğu öteki yerleşik araçlar ve kullanıcının kendi MCP
 * sunucularının araçları (`mcp__…`) açık kalıyordu (`bypassPermissions`).
 *   • `--tools ""`: hiçbir yerleşik araç sunulmaz (izin listesi; ret listesi gibi eksik kalamaz).
 *   • `--strict-mcp-config`: `--mcp-config` verilmediği için hiçbir MCP sunucusu yüklenmez.
 * Ret listesi ikinci kat olarak kalır. Çağıranlar bu bayrakları YAZMAZ; başlatıcılar politikadan türetir.
 */
export function zeroToolLaunchArgs(disallowed: string[] | undefined): string[] {
  return isZeroToolPolicy(disallowed) ? ["--tools", "", "--strict-mcp-config"] : [];
}

/**
 * SAF: çağrının istemini veren bayrak. Sıfır araç politikasında `--system-prompt` (Claude Code'un ajan
 * istemi YERİNE), öteki politikalarda `--append-system-prompt` (ajan isteminin sonuna; eskisiyle aynı).
 *
 * CANLI KANIT (ekransız deneme koşuları 6, 7, 13; 2026-11-27): ilgililik sınıflandırıcısı puan yerine
 * "Proje durumunu kontrol edeyim…", "Phase 5'e geçmeli ve todo app'i implementation yapmalıyım" gibi
 * işe girişme metni üretti (yaklaşık on denemenin dördü). İstem ajan isteminin sonuna eklendiği için
 * model kendini kodlama ajanı sanıyordu; yalnız metin işleyen çağrının ajan istemine ihtiyacı yok.
 */
export function systemPromptFlag(disallowed: string[] | undefined): "--system-prompt" | "--append-system-prompt" {
  return isZeroToolPolicy(disallowed) ? "--system-prompt" : "--append-system-prompt";
}

/**
 * SAF: sıfır araç politikalı çağrının `claude` sürecine EK ortam değişkenleri; öteki politikalarda boş.
 * Kullanıcının kişisel ve proje talimat dosyaları (CLAUDE.md, CLAUDE.local.md) ve otomatik hafızası
 * bu çağrılara girmez: puanlayıcı ve özetleyici her makinede aynı davranır. Koşu 6, 7 ve 13'teki
 * yanlış cevapların Türkçe ve "faz" diliyle yazılması kişisel talimat dosyasının girdiğini düşündürüyordu
 * (hipotez; çağrı koşturulmadı).
 *   • `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`: belgeye göre kullanıcı, proje ve otomatik hafıza dosyalarının
 *     hiçbiri yüklenmez.
 *   • `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: otomatik hafıza ne yüklenir ne yazılır.
 * `--bare` BİLEREK kullanılmaz: abonelik girişini (OAuth, anahtar zinciri) hiç okumaz. `--setting-sources`
 * kullanılmaz: boş değeri ve talimat dosyalarına etkisi belgede yok.
 */
export function zeroToolLaunchEnv(disallowed: string[] | undefined): Record<string, string> {
  return isZeroToolPolicy(disallowed)
    ? { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }
    : {};
}
