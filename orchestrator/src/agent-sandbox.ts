// agent-sandbox — main-ajan `claude` alt-süreçlerini açık proje + alt klasörlerine
// hapsetme (güvenlik). Kullanıcı kuralı: "ajan YALNIZ proje + alt klasörlerine
// erişir, başka hiçbir yere değil." + "her zaman çapraz-platform."
//
// Hedef platformlar: macOS + Linux (Windows KAPSAM DIŞI — kullanıcı kararı).
// Mekanizma: Claude Code YERLİ sandbox'ı (`--settings`) — çekirdek-zorlamalı:
//   - macOS: Seatbelt (yerleşik, kurulum yok).
//   - Linux: bubblewrap (`bwrap`) + `socat` (kurulu olmalı).
//   - mac/linux DIŞI platform: DESTEKLENMEZ → enforce'ta spawn-öncesi durdurulur (fail-closed).
// `sandbox.enabled:true` + `allowUnsandboxedCommands:false` → YAZMA+BASH otomatik
// proje-hapsine girer. OKUMA için (yerli sandbox'ta read-allowlist anahtarı YOK)
// home top-level girdileri (runtime + proje HARİÇ) `denyRead` + `permissions.deny`.
//
// İki katmanlı fail-closed: (1) claude'un kendi `failIfUnavailable:true` bayrağı
// sandbox kurulamazsa exit 1 yapar; (2) MyCL spawn-ÖNCESİ `guardSandboxOrWarn` ile
// platform/bağımlılık kontrolü yapıp GÖRÜNÜR Türkçe hata/uyarı verir (sessiz
// fallback yasağı — claude'un teknik çıktısına güvenmeyiz).

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix as pathPosix, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { emitChatMessage } from "./ipc.js";

export type SandboxPolicy = "enforce" | "warn" | "off";

// claude/node/sistem RUNTIME — denyRead'e KONULMAZ (yoksa claude kırılır).
// Çapraz-platform: ortak + platforma-özel. Asıl korunan kullanıcı verisi
// (Music/Pictures/Documents/Desktop/Downloads/.ssh/.aws/diğer-projeler) bu
// sette OLMADIĞI için denylenir.
const RUNTIME_ALLOW_COMMON = [
  ".claude", // PRIMARY config (CLAUDE_CONFIG_DIR ?? ~/.claude) — her OS'ta
  ".claude.json", // global config/MCP/auth-state
  ".config", // Linux XDG (~/.config/anthropic SDK + gh/git); mac'te de zararsız
  ".local", // ~/.local/share/claude/versions + ~/.local/bin/claude
  ".cache", // ~/.cache/claude staging + npm/araç cache
  ".npm", // npx/MCP alt-süreç cache
  ".nvm",
  ".bun",
  ".asdf",
];

// YZLLM 2026-06-17: sandbox.enabled → claude AĞI da default DENY-ALL eder (whitelist zorunlu). npm/yarn/pnpm gibi
// GÜVENİLİR paket altyapısı engellenirse her greenfield `npm install` kırılır (E2BIG-fix bunu AÇIĞA çıkardı —
// önceden argv-E2BIG claude'u hiç başlatmadığı için ağ sorunu görünmüyordu). Bu yüzden yaygın paket registry +
// prebuilt-binary host'ları `sandbox.allowedDomains` ile DEFAULT allow. Whitelist olduğu için keyfi domain
// (saldırgan C2 / exfil) HÂLÂ deny. Ampirik (gerçek claude --settings + npm install) doğrulanır.
const PACKAGE_REGISTRY_DOMAINS = [
  "registry.npmjs.org", // npm (pnpm de default bunu kullanır)
  "registry.yarnpkg.com", // yarn
  "registry.npmjs.com", // npm legacy alias
  "nodejs.org", // node/araç binary indirmeleri
  "github.com", // git-deps + prebuilt binary host
  "codeload.github.com", // github tarball indirme
  "objects.githubusercontent.com", // github release asset (prebuilt binary)
  "raw.githubusercontent.com", // github ham içerik (bazı postinstall script'leri)
];

/** Platforma göre runtime allow-set (denyRead'e konulmayacak home girdileri). */
export function runtimeAllowFor(platform: NodeJS.Platform): Set<string> {
  const s = new Set(RUNTIME_ALLOW_COMMON);
  if (platform === "darwin") s.add("Library"); // Caches/App Support/keychain (securityd)
  // Linux: .config zaten ortak sette. mac/linux dışı: denyRead üretilmez (aşağı).
  return s;
}

let _policy: SandboxPolicy = "enforce";
export function setSandboxPolicy(p: SandboxPolicy): void {
  _policy = p;
}
export function getSandboxPolicy(): SandboxPolicy {
  return _policy;
}

// ───────────────────────── Platform / availability ─────────────────────────

export interface SandboxAvailability {
  available: boolean;
  /** available=false ise neden (Türkçe, kullanıcıya gösterilir). */
  reason?: string;
}

/**
 * SAF: platform + araç varlığı → sandbox kurulabilir mi. Host'tan bağımsız test
 * edilebilir (paths.ts saf-fonksiyon kalıbı). hasBwrap/hasSocat yalnız linux'ta anlamlı.
 */
export function detectSandboxAvailability(params: {
  platform: NodeJS.Platform;
  hasBwrap: boolean;
  hasSocat: boolean;
}): SandboxAvailability {
  const { platform, hasBwrap, hasSocat } = params;
  if (platform === "darwin") return { available: true }; // Seatbelt yerleşik
  if (platform === "linux") {
    if (hasBwrap && hasSocat) return { available: true };
    const missing = [!hasBwrap ? "bubblewrap (bwrap)" : null, !hasSocat ? "socat" : null]
      .filter(Boolean)
      .join(" + ");
    return {
      available: false,
      reason: `${missing} kurulu değil — sandbox başlatılamaz (kur: apt install bubblewrap socat / dnf install bubblewrap socat)`,
    };
  }
  // mac/linux dışı (Windows dahil): Claude Code yerli sandbox'ı çalışmaz → fail-closed.
  return {
    available: false,
    reason: `bu platform (${platform}) desteklenmiyor — sandbox yalnız macOS ve Linux'ta çalışır`,
  };
}

function hasCommand(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let _availabilityCache: SandboxAvailability | undefined;
/** İmpure: process.platform + (linux'ta) bwrap/socat varlığı. Process başına cache'lenir. */
export function sandboxAvailable(): SandboxAvailability {
  if (_availabilityCache) return _availabilityCache;
  const platform = process.platform;
  const linux = platform === "linux";
  _availabilityCache = detectSandboxAvailability({
    platform,
    hasBwrap: linux ? hasCommand("bwrap") : true,
    hasSocat: linux ? hasCommand("socat") : true,
  });
  return _availabilityCache;
}

// ───────────────────────── Spawn-öncesi görünür kapı ─────────────────────────

export interface SandboxGuardDecision {
  /** true → spawn'a devam; false → spawn ETME (enforce + sandbox yok). */
  proceed: boolean;
  /** Kullanıcıya gösterilecek görünür mesaj (sessiz fallback yasağı). */
  message?: { level: "error" | "warning"; text: string };
}

/**
 * SAF: policy + availability → spawn kararı + görünür mesaj.
 *   enforce + yok → proceed:false + error (ajan çalıştırılmaz).
 *   warn    + yok → proceed:true  + warning (hapissiz devam, kullanıcı bilir).
 *   off / available → proceed:true (mesaj yok).
 */
export function sandboxGuard(
  policy: SandboxPolicy,
  availability: SandboxAvailability,
): SandboxGuardDecision {
  if (policy === "off" || availability.available) return { proceed: true };
  if (policy === "enforce") {
    return {
      proceed: false,
      message: {
        level: "error",
        text: `🔒 Sandbox kurulamadı: ${availability.reason}. Politika "enforce" — ajan çalıştırılmadı. (Bağımlılığı kurun ya da ayarlardan agent_sandbox_policy'i "warn"/"off" yapın.)`,
      },
    };
  }
  return {
    proceed: true,
    message: {
      level: "warning",
      text: `⚠️ Sandbox kurulamadı: ${availability.reason}. Ajan dosya/bash HAPSİ OLMADAN çalışıyor (policy="warn").`,
    },
  };
}

let _guardEmitted = false;
/**
 * İmpure spawn-öncesi kapı (3 caller bunu çağırır). Görünür mesajı process başına
 * BİR kez emit eder; her spawn'da kararı döner. false → caller spawn etmemeli.
 */
export function guardSandboxOrWarn(): boolean {
  if (_policy === "off") return true;
  const decision = sandboxGuard(_policy, sandboxAvailable());
  if (decision.message && !_guardEmitted) {
    _guardEmitted = true;
    emitChatMessage(decision.message.level === "error" ? "error" : "system", decision.message.text);
  }
  return decision.proceed;
}

// ───────────────────────── Settings üretimi ─────────────────────────

export interface SandboxBuildResult {
  settings: Record<string, unknown>;
  /** denyRead girdisi sayısı (test + log). */
  denyCount: number;
  /** Dolu ise ev dizini okuma reddi GENİŞ biçime düştü (proje dosya araçları kilitli) — çağıran görünür uyarır. */
  readFallbackReason?: string;
  /** Geniş ret nedeni MyCL kurulumundaysa true (uyarıdaki öneri buna göre seçilir). */
  readFallbackInstallFault?: boolean;
}

/**
 * Ajanın kum havuzunda EK yetenekleri (YZLLM onayı 2026-07-30, canlı cave kanıtı: 245 kez
 * "EPERM: listen 0.0.0.0:5173"). Yerli sandbox ağı DENY-ALL yapar; yerel port bağlama da buna dahil →
 * ajan kendi test sunucusunu/dev sunucusunu açamıyor, tarayıcı testi hiç koşamıyor ve ajan bunu PROJE
 * hatası sanıp günlerce "düzeltmeye" çalışıyor. Ampirik (claude 2.1.220, /tmp): mevcut ayarla
 * BIND_ERROR:EPERM; `network.allowLocalBinding` ile BIND_OK.
 * EN AZ YETKİ: yetenek YALNIZ gerçekten sunucu/tarayıcı testi koşan rollere verilir (kod yazan ajan,
 * müfettiş — bulguyu KENDİ yeniden üretmek zorunda, Faz 0 hata ayıklama). Çeviri/özet/planlama
 * rollerinde verilmez; onların üretilen ayarı bugünle BİREBİR aynı kalır (network anahtarı yazılmaz).
 */
export interface SandboxCaps {
  /** Ajan 127.0.0.1'e bağlanabilsin (kendi test/dev sunucusunu açabilsin). Varsayılan: kapalı. */
  localBinding?: boolean;
}

/**
 * Yerel port iznine ihtiyaç duyan codegen etiketleri — AÇIK liste (kuşkuda VERME; yeni bir salt-okunur
 * codegen rolü eklenirse otomatik yetki almasın). Kaynak: codegen/backend.ts CLI_ELIGIBLE_TAGS.
 */
const LOCAL_BINDING_TAGS: ReadonlySet<string> = new Set([
  "phase-5", // UI kurulumu — dev sunucu + smoke
  "phase-8", // BDD+TDD — testler sunucu ayağa kaldırır
  "verify-feature", // gerçek uygulama doğrulaması — Playwright
  "parallel-module", // modül paralel codegen (aynı işler)
  "gate-autofix", // gate düzeltmesi — testi yeniden koşar
]);

/** SAF: bu codegen etiketi yerel port izni almalı mı. */
export function needsLocalBinding(tag: string): boolean {
  return LOCAL_BINDING_TAGS.has(tag);
}

/**
 * İterasyon gate overlay'inin ARAÇ ANI kancaları (Faz C). Verilmezse ayara HİÇBİR anahtar
 * eklenmez — SandboxCaps ile aynı desen, üretilen argv bugünküyle bayt bayt aynı kalır.
 */
export interface OverlayHooks {
  /** `orchestrator/overlay-guard.mjs` mutlak yolu. */
  guardPath: string;
  /** Muhafıza argv ile geçen DONUK kural kümesi (base64 JSON — ajan değiştiremez). */
  rulesB64: string;
  /** SessionStart kancasının yazacağı kanarya işareti (bu spawn'a özel). */
  ackPath: string;
}

/** Kancanın uygulandığı araçlar — muhafız yalnız YAZMA araçlarını görür (patlama yarıçapı dar). */
const OVERLAY_HOOK_MATCHER = "Write|Edit|MultiEdit|NotebookEdit";

/**
 * SAF: Claude Code `hooks` bloğu. Yollar çift tırnaklı (boşluklu dizinler); base64 kurallar
 * yalnız [A-Za-z0-9+/=] içerdiği için tırnaksız güvenli.
 *
 * SessionStart = kanarya (blok yutulduysa hiç çalışmaz → MyCL koşuyu kapısız sayar),
 * PreToolUse = gerçek engel (exit 2 → yazma reddedilir, stderr modele döner).
 */
export function buildOverlayHookBlock(overlay: OverlayHooks): Record<string, unknown> {
  const node = (args: string): string => `node "${overlay.guardPath}" ${args}`;
  return {
    SessionStart: [
      { hooks: [{ type: "command", command: node(`--ack "${overlay.ackPath}"`) }] },
    ],
    PreToolUse: [
      {
        matcher: OVERLAY_HOOK_MATCHER,
        hooks: [{ type: "command", command: node(`--rules ${overlay.rulesB64}`) }],
      },
    ],
  };
}

/**
 * AJAN TALİMAT YÜZEYİ (harness kaçış denetimi, 2026-11-26). Claude Code her spawn'da proje kökündeki
 * `CLAUDE.md` / `CLAUDE.local.md` dosyalarını bağlama, `.claude/` ayarlarını (KANCALAR dahil) ve
 * `.mcp.json` sunucularını oturuma yükler. Bunlar proje İÇİNDE durduğu için kod yazan ajan onlara
 * yazabiliyordu → iki kaçış:
 *   (1) Bir ajanın gerekçesi sonraki TÜM işçilere ve "bağımsız" müfettişlere talimat olarak sızar
 *       (durumsuz işçi + ayrı denetçi varsayımı çöker — denetçi, denetlediği ajanın yazdığını okur).
 *   (2) `.claude/settings.json` içine yazılan kanca / `.mcp.json` içine yazılan sunucu sonraki spawn'da
 *       kum havuzu DIŞINDA koşar.
 * OKUMA açık kalır (kullanıcının kendi proje talimatları ajanlara ulaşmaya devam eder — davranış aynı);
 * yalnız AJANIN bunları değiştirmesi kapanır. MyCL'in kendi (orkestratör süreci) yazımı etkilenmez.
 * SINIR (dürüst): yalnız proje KÖKÜ korunur. Alt dizinlerdeki `CLAUDE.md` glob gerektirir; Seatbelt'te
 * glob genişlemesi güvenilir değil (yukarıdaki V2 notu) → kapsam dışı, README'de yazılı.
 */
export const AGENT_INSTRUCTION_FILES = ["CLAUDE.md", "CLAUDE.local.md", ".mcp.json"] as const;
export const AGENT_INSTRUCTION_DIRS = [".claude"] as const;

/** SAF: ajan talimat yüzeyinin mutlak yolları (dosyalar + dizinler). */
export function agentInstructionPaths(projectRoot: string): { files: string[]; dirs: string[] } {
  return {
    files: AGENT_INSTRUCTION_FILES.map((f) => pathPosix.join(projectRoot, f)),
    dirs: AGENT_INSTRUCTION_DIRS.map((d) => pathPosix.join(projectRoot, d)),
  };
}

/**
 * SAF: mutlak bir yol için `permissions.deny` YAZMA kuralı (Edit tüm yazma araçlarını kapsar).
 * YOL BİÇİMİ (ampirik, gerçek claude 2.1.332 + macOS, 2026-11-26): Claude Code izin kurallarında TEK
 * eğik çizgiyle başlayan yol dosya sistemi kökü DEĞİL, ayarın/projenin köküne göreli sayılır; mutlak
 * yol ÇİFT eğik çizgiyle (`//Users/...`) yazılır. Eskiden burada `Edit(/Users/.../.mycl/**)` üretiliyordu
 * → kural hiçbir dosyayla eşleşmiyordu: Write aracı `.mycl/y.txt` dosyasını yazabildi (çekirdek
 * `denyWrite` yalnız Bash'i kapsıyor, yazma araçlarını değil). Çift eğik çizgiyle aynı deneme reddedildi.
 * Tüm Edit kuralları BURADAN üretilir ki biçim tek yerde doğru kurulsun.
 */
export function editDenyRule(absPath: string, opts: { subtree?: boolean } = {}): string {
  // Yol KAÇIRILIR (mahkeme 4. tur): "proj [v2]" gibi bir proje yolunda kaçışsız kural köşeli parantezi karakter
  // sınıfı sayar ve `.mycl` / `CLAUDE.md` ile eşleşmez. Ev dizini altındaki projede geniş Read reddi artık
  // olmadığından bu kurallar yazma araçları için TEK korumadır.
  return `Edit(/${escapePermissionGlob(absPath)}${opts.subtree ? "/**" : ""})`;
}

/** SAF: talimat yüzeyi için `permissions.deny` girdileri (Edit tüm yazma araçlarını kapsar). */
export function agentInstructionPermDeny(projectRoot: string): string[] {
  const { files, dirs } = agentInstructionPaths(projectRoot);
  return [
    ...files.map((f) => editDenyRule(f)),
    ...dirs.map((d) => editDenyRule(d, { subtree: true })),
  ];
}

/** Bir dizinin girdi adları; okunamazsa null (çağıran güvenli tarafa düşer). Enjekte edilir → saf test. */
export type ListDir = (dir: string) => string[] | null;

/**
 * Ev dizini okuma reddi kurallarının toplam BAYT bütçesi. Ayar tek bir argv dizgisi olarak gidiyor; Linux tek
 * argümanı 128 KB ile sınırlar (aşılırsa spawn E2BIG). Yol SAYISI değil bayt sayılır: derin ve Türkçe harfli
 * yollar ortalamayı kolayca ikiye katlar (mahkeme bulgusu). 64 KB → ayarın geri kalanı için bol pay kalır.
 */
export const MAX_HOME_READ_DENY_BYTES = 64 * 1024;

/**
 * SAF: izin kuralı deseninde özel anlamı olan karakterleri ters eğik çizgiyle kaçır. REGEX YOK (düz döngü).
 * Ampirik (gerçek claude 2.1.332): `Read(//…/d3 [koseli])` kuralı `d3 [koseli]` klasörüyle EŞLEŞMEDİ
 * (köşeli parantez karakter sınıfı sayılıyor → içerik okundu); `\[x\]` biçimi reddetti. Boşluk, yuvarlak
 * parantez, süslü parantez ve Türkçe harfler kaçışsız çalışıyor.
 */
export function escapePermissionGlob(path: string): string {
  let out = "";
  for (const ch of path) {
    out += ch === "\\" || ch === "[" || ch === "]" || ch === "*" || ch === "?" ? `\\${ch}` : ch;
  }
  return out;
}

/** SAF: mutlak bir yol (dosya ya da dizin) için okuma reddi — kendisi + alt ağacı, mutlak (çift çizgili) biçimde. */
export function readDenyRules(absPath: string): string[] {
  const esc = escapePermissionGlob(absPath);
  return [`Read(/${esc})`, `Read(/${esc}/**)`];
}

export interface HomeReadDeny {
  rules: string[];
  /** Dolu ise dar kural üretilemedi ve GENİŞ redde düşüldü (dosya araçları projede de kilitli). */
  fallbackReason?: string;
  /** Neden MyCL'in KENDİ kurulumundaysa true → kullanıcıya "projeyi taşı" değil "kurulumu onar" denir. */
  installFault?: boolean;
}

/**
 * SAF: proje ev dizini ALTINDAYKEN dosya araçları (Read/Glob/Grep/Write/Edit) için okuma reddi.
 *
 * NEDEN (gerçek ortam denemesi, claude 2.1.332 + macOS, 2026-11-26):
 *  - Çekirdek kum havuzu (`denyRead`/`allowRead`) YALNIZ Bash'i kapsıyor. `Read(…)` izin kuralı olmadan Read
 *    aracı ev dizinindeki başka bir klasördeki dosyayı okudu → araç katmanında ev dizinini koruyan tek şey bu kural.
 *  - Eski kural `Read(//<ev>)` bu sürümde TÜM alt ağacı kapsıyor ve ret, izinden baskın → ev dizini altındaki
 *    projede Read/Write/Edit HER dosyada reddediliyordu ("covered by a Read deny rule"); ajan yalnız Bash'le çalışabildi.
 * ÇÖZÜM İKİ KATMAN:
 *  (1) TABAN (bu fonksiyon): ev dizininden proje üst dizinine kadar her düzeyde, projeye giden bileşen DIŞINDAKİ
 *      her girdi ayrı ayrı reddedilir. Çalışma zamanı girdileri (.claude, Library…) de reddedilir: o liste
 *      çekirdek katmanda claude SÜRECİ içindir, ajanın dosya araçlarının oraya erişmesi gerekmez (ev dizini
 *      dışındaki projede de zaten kapalıydı). Read reddi yazma araçlarını da kapatıyor (ampirik).
 *  (2) YÜKLEM (home-guard.mjs kancası): liste spawn anında alındığı için henüz VAR OLMAYAN adlar bu kurallarla
 *      kapanmaz (ör. `~/.zshenv`, `~/proj/CLAUDE.md` — mahkeme bulgusu). Kanca "ev dizininde ama projede değil"
 *      yüklemiyle hepsini kapatır. Dar kurallar YALNIZ kanca eklenebiliyorsa üretilir (buildAgentSandboxSettings).
 * SINIR (dürüst): kanca Claude tarafından hiç yüklenmezse (ayar şeması değişirse) geriye yalnız taban kalır →
 * var olan veri kapalı, yeni adlar yazma araçlarına açık. Zincirdeki dizinlerin AD listesi kurallardan okunabilir.
 * Proje ev dizininin KENDİSİ ise reddedilecek bir şey yoktur (kullanıcı ev dizinini proje yapmıştır).
 * GÜVENLİ TARAF: liste okunamazsa, projeye giden ad listede aynen yoksa ya da bayt bütçesi aşılırsa geniş redde
 * düşülür (ev dizini korunur, proje dosya araçları kilitlenir) ve `fallbackReason` döner → çağıran GÖRÜNÜR uyarır.
 */
export function buildHomeReadDeny(params: {
  home: string;
  projectRoot: string;
  listDir: ListDir;
}): HomeReadDeny {
  const { listDir } = params;
  const home = normalizeAbs(params.home);
  const projectRoot = normalizeAbs(params.projectRoot);
  const broad = (reason: string): HomeReadDeny => ({ rules: readDenyRules(home), fallbackReason: reason });
  const chain = projectRoot === home ? [] : projectRoot.slice(home.length + 1).split("/");
  const rules: string[] = [];
  let bytes = 0;
  let dir = home;
  for (let level = 0; level < chain.length; level++) {
    const names = listDir(dir);
    if (names === null) return broad(`"${dir}" dizini listelenemedi`);
    // Projeye giden bileşen listede BİREBİR yoksa (büyük küçük harf / Unicode yazım farkı) onu "kardeş" sanıp
    // reddederdik → proje sessizce kilitlenirdi. Emin değilsek dar kural üretme: görünür geniş ret.
    if (!names.includes(chain[level]!)) {
      return broad(`"${dir}" içinde projeye giden "${chain[level]}" adı listede aynen bulunamadı`);
    }
    for (const name of names) {
      if (name === chain[level]) continue; // projeye giden yol
      for (const rule of readDenyRules(pathPosix.join(dir, name))) {
        rules.push(rule);
        bytes += Buffer.byteLength(rule, "utf-8") + 3; // JSON tırnakları + virgül
      }
    }
    if (bytes > MAX_HOME_READ_DENY_BYTES) {
      return broad(`projeye giden yoldaki girdiler ayar boyutu sınırını aşıyor (${bytes} bayt)`);
    }
    dir = pathPosix.join(dir, chain[level]!);
  }
  return { rules };
}

/** SAF: mutlak POSIX yolu sadeleştir (`//`, `.`, `..`, sondaki eğik çizgi) — zincir hesabı metne dayanıyor. */
export function normalizeAbs(p: string): string {
  const n = pathPosix.normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/** SAF: yol, kabukta çift tırnak içine olduğu gibi yazılabilir mi (REGEX YOK — düz döngü). */
export function isShellQuoteSafe(path: string): boolean {
  for (const ch of path) {
    if (ch === '"' || ch === "$" || ch === "`" || ch === "\\" || ch === "\n" || ch === "\r") return false;
  }
  return true;
}

/** Ev dizini muhafızının (home-guard.mjs) uygulandığı araçlar: yol alan tüm dosya araçları. */
const HOME_GUARD_MATCHER = "Read|Write|Edit|MultiEdit|NotebookEdit|NotebookRead|Glob|Grep|LS";

/** SAF: ev dizini muhafızı PreToolUse girdisi. Kurallar argv'de base64 (ajan değiştiremez). */
export function buildHomeGuardHook(params: {
  guardPath: string;
  home: string;
  projectRoot: string;
  /** Kancayı koşturacak node ikilisi. Varsayılan "node" (PATH); gerçek çağıran `process.execPath` verir. */
  nodePath?: string;
}): unknown {
  const rulesB64 = Buffer.from(
    JSON.stringify({ home: params.home, project_root: params.projectRoot }),
    "utf-8",
  ).toString("base64");
  return {
    matcher: HOME_GUARD_MATCHER,
    hooks: [
      { type: "command", command: `"${params.nodePath ?? "node"}" "${params.guardPath}" --rules ${rulesB64}` },
    ],
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Muhafız betiğinin mutlak yolu (__dirname = orchestrator/dist ya da orchestrator/src; bir üst = orchestrator kökü; `orchestrator/*.mjs` paketli). */
export function homeGuardPath(): string {
  return resolvePath(__dirname, "..", "home-guard.mjs");
}

/**
 * SAF: home top-level girdilerinden (runtime + proje HARİÇ) denyRead + Claude Code
 * `--settings` nesnesi üret. platform enjekte edilir (test edilebilir).
 *   - off → yalnız ultracode (sandbox yok).
 *   - win32 → denyRead ÜRETME (Seatbelt/bwrap orada yok, yollar POSIX değil);
 *     sandbox.enabled + failIfUnavailable(=enforce) yine konur (claude exit-1 savunması).
 *   - darwin/linux → POSIX yol mantığı (pathPosix), runtimeAllowFor(platform).
 */
export function buildAgentSandboxSettings(params: {
  projectRoot: string;
  ultracode: boolean;
  policy: SandboxPolicy;
  platform: NodeJS.Platform;
  home: string;
  /** Ek yetenekler (yerel port). Verilmezse hiçbir ek yetenek yok — üretilen ayar eski davranışla birebir. */
  caps?: SandboxCaps;
  /**
   * İterasyon gate kancaları. Verilmezse `hooks` anahtarı HİÇ yazılmaz (regresyon testi:
   * overlay'siz çıktı JSON'u bugünkiyle birebir aynı).
   */
  overlay?: OverlayHooks;
  /**
   * Dizin listeleyici (yalnız proje ev dizini ALTINDAYKEN kullanılır — buildHomeReadDeny). Verilmezse liste
   * "okunamadı" sayılır → güvenli geniş ret + `readFallbackReason` (sessiz değil).
   */
  listDir?: ListDir;
  /**
   * `home-guard.mjs` mutlak yolu. Proje ev dizini altındayken dar okuma kuralları YALNIZ bu verilirse üretilir
   * (kanca olmadan dar kural yeni adları açık bırakır); verilmezse güvenli geniş ret + `readFallbackReason`.
   */
  homeGuardPath?: string;
  /**
   * Kancayı koşturacak node ikilisinin mutlak yolu. NEDEN: Claude Code 0 ve 2 dışındaki çıkış kodunu ENGEL
   * saymıyor → `node` PATH'te yoksa (127) kanca sessizce atlanırdı. Gerçek çağıran MyCL'in kendi node'unu verir.
   */
  nodePath?: string;
}): SandboxBuildResult {
  const { projectRoot, ultracode, policy, platform, home, caps, overlay, listDir, homeGuardPath, nodePath } =
    params;
  // Overlay KUM HAVUZUNDAN BAĞIMSIZ bir sözleşmedir: sandbox politikası "off" olsa bile
  // iterasyon gate'leri uygulanır (kullanıcı sandbox'ı kapatmakla gate'leri kapatmış olmaz).
  const hooksBlock: Record<string, unknown> = overlay
    ? { hooks: buildOverlayHookBlock(overlay) }
    : {};
  const base: Record<string, unknown> = ultracode
    ? { ultracode: true, ...hooksBlock }
    : { ...hooksBlock };
  // ADLİ DENETİM DÜZELTMESİ (2026-09-10): eskiden burada HİÇBİR koruma kalmadan dönülüyordu —
  // kum havuzunu kapatmak, MyCL'in kendi KANIT DEFTERİNİ (.mycl) de ajanın yazmasına açıyordu.
  // Bunlar iki ayrı karar: kullanıcı "işletim sistemi hapsini kapat" diyebilir, ama "hüküm hangi
  // kayıttan üretiliyorsa onu yazmaya da izin ver" demiş olmaz. Hüküm `.mycl/audit.log`'dan geri
  // okunuyor; oraya yazabilen, kapıyı geçmeden kapının KAYDINI geçebilir (mahkeme bunu geçici
  // dizinde kanıtladı: 7 satır değişince hüküm KISMİ'den GEÇTİ'ye döndü).
  // Bu yüzden `.git` + `.mycl` yazma reddi politikadan BAĞIMSIZ, her zaman yazılıyor.
  if (policy === "off") {
    const evidenceDirs = [pathPosix.join(projectRoot, ".git"), pathPosix.join(projectRoot, ".mycl")];
    return {
      settings: {
        ...base,
        permissions: {
          deny: [
            ...evidenceDirs.map((d) => editDenyRule(d, { subtree: true })),
            ...agentInstructionPermDeny(projectRoot),
          ],
        },
      },
      denyCount: 0,
    };
  }

  const failIfUnavailable = policy === "enforce";
  // Yalnız istendiğinde yazılır → istenmeyen rollerde `network` anahtarı HİÇ oluşmaz (argv birebir eski).
  const networkBlock = caps?.localBinding ? { network: { allowLocalBinding: true } } : {};

  // mac/linux dışı platform: yerli sandbox yok → POSIX-olmayan yollarla anlamsız
  // denyRead üretme. Gerçek fail-closed guardSandboxOrWarn (spawn-öncesi) +
  // claude failIfUnavailable. (Windows kapsam dışı; bu sadece güvenli catch-all.)
  if (platform !== "darwin" && platform !== "linux") {
    return {
      settings: {
        ...base,
        sandbox: { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable, ...networkBlock },
      },
      denyCount: 0,
    };
  }

  const allow = runtimeAllowFor(platform);
  // İKİ AYRI liste (v15.13, ampirik doğrulama — /tmp testleri):
  //  - denyRead = ÇEKİRDEK sandbox (claude bunu her Bash çağrısında sandbox-exec/bwrap profil
  //    argv'sine çevirir → BÜYÜRSE "spawn E2BIG: argument list too long"). Bu yüzden DARWIN'de
  //    `/**`'i ATLA: Seatbelt subpath semantiği → bir dizini reddetmek İÇERİĞİNİ de reddeder
  //    (V3: dir-only "secret" → "secret/data.txt" engellendi) → `/**` REDUNDANT, atlamak güvenli +
  //    profili ~2x küçültür. Linux (bwrap) subpath semantiği doğrulanmadı → `/**`'i KORU.
  //    DİKKAT: brace-glob `{a,b}` Seatbelt'te GENİŞLEMİYOR (V2: sızdırdı) → glob-compress GÜVENLİ DEĞİL.
  //  - permDeny = prompt-katmanı (defense-in-depth, E2BIG'i ETKİLEMEZ) → her iki formu KORU.
  // YZLLM 2026-06-17 (E2BIG KÖK ÇÖZÜMÜ): home'daki onlarca girdiyi (YZLLM'in home'unda 355) TEK TEK denyRead yerine →
  // home'u TEK kuralla deny + proje ve runtime-allow girdilerini `allowRead` ile RE-ALLOW. claude-code
  // `filesystem.allowRead`, denyRead-region'ındaki yolları OVERRIDE eder (resmi doküman; macOS Seatbelt + Linux
  // bwrap kernel-seviye, doğrulandı). Böylece sandbox profil argv'si ~355'ten ~birkaç kurala iner → "spawn E2BIG:
  // argument list too long" BİTER. GÜVENLİK AYNI: home'daki allow-DIŞI her şey (.ssh/.aws/.gnupg/Documents/Downloads/
  // diğer-projeler…) KAPALI; yalnız proje + runtime (claude/.config/.cache/Library) açık. /tmp ampirik testiyle
  // ".ssh/.aws kapalı + proje açık" teyit edilir (mevcut V2/V3 deseni).
  const subForms = (p: string): string[] => (platform === "darwin" ? [p] : [p, `${p}/**`]);
  const denyRead: string[] = subForms(home); // TÜM home deny — tek kural (argv küçük)
  const allowRead: string[] = [...subForms(projectRoot)]; // proje re-allow (deny home'dan istisna)
  // EV DİZİNİ ALTINDAKİ PROJE (2026-11-26 yeniden kuruldu — gerekçe + ampirik kanıt: buildHomeReadDeny).
  // Eski hâl `Read(//<ev>)` tek kuralıydı: yazıldığı sürümde yalnız dizinin kendisini kapsadığı varsayılmıştı;
  // 2.1.332'de alt ağacı da kapsıyor → proje dosya araçlarına tümüyle kapanıyordu. Ev dizini DIŞINDAKİ projede
  // geniş ret projeyi kapsamaz → orada davranış aynen korunur.
  const normHome = normalizeAbs(home);
  const normProject = normalizeAbs(projectRoot);
  const projectUnderHome = normProject === normHome || normProject.startsWith(`${normHome}/`);
  // Kanca komutu kabukta çift tırnak içinde koşar: yolda `"`, `$`, ters tırnak ya da ters eğik çizgi varsa komut
  // bozulur ya da başka bir yola genişler → kanca başlatılamaz, Claude Code bunu engel saymaz (sessiz açık).
  // Böyle bir kurulum yolunda dar kural üretilmez: görünür geniş ret (mahkeme 3. tur).
  const unsafeHookPath = [homeGuardPath, nodePath].some((p) => p !== undefined && !isShellQuoteSafe(p));
  const homeRead: HomeReadDeny = !projectUnderHome
    ? { rules: readDenyRules(home) }
    : !homeGuardPath
      ? {
          rules: readDenyRules(home),
          fallbackReason: "ev dizini muhafızı betiği (home-guard.mjs) bulunamadı",
          installFault: true,
        }
      : unsafeHookPath
        ? {
            rules: readDenyRules(home),
            fallbackReason: "MyCL kurulum yolunda kabuk için özel karakter var",
            installFault: true,
          }
        : buildHomeReadDeny({ home, projectRoot, listDir: listDir ?? (() => null) });
  const permDeny: string[] = homeRead.rules;
  // Kanca yalnız dar kurallar gerçekten üretildiyse eklenir (geniş rette her şey zaten kapalı).
  const homeGuardHook =
    projectUnderHome && homeGuardPath && !homeRead.fallbackReason
      ? buildHomeGuardHook({ guardPath: homeGuardPath, home: normHome, projectRoot: normProject, nodePath })
      : undefined;
  const permAllow: string[] = [`Read(${projectRoot}/**)`];
  for (const name of allow) {
    const entry = pathPosix.join(home, name);
    allowRead.push(...subForms(entry)); // runtime girdisi (claude/.config/.cache/Library…) re-allow
    permAllow.push(`Read(${entry}/**)`);
  }
  // YZLLM 2026-06-11 tehlike-taraması (EMPİRİK DOĞRULANDI): CLI sandbox cwd'ye hapsediyor ama `.git`'i (cwd altında)
  // YAZILABİLİR bırakıyordu → ajan `.git/hooks/pre-commit` yazabilir → kullanıcı `git commit` yapınca sandbox-DIŞI,
  // makinede kod çalışır (kalıcılık/escalation). API yolu (tool-handlers denied_paths) `.git`'i zaten reddediyordu;
  // CLI yolu etmiyordu (asimetri). FIX: filesystem.denyWrite ile `.git` (READ açık — git status/log için; yalnız
  // YAZMA kapalı). Doğrulandı: .git yazımı engellenir, normal proje yazımı bozulmaz.
  const gitDir = pathPosix.join(projectRoot, ".git");
  // .mycl: ajan buraya YAZARSA sahte audit olayı (tdd-green/phase-complete) enjekte edip gate'leri oyunlayabilir
  // (sahte-yeşil — güven-modelinin kalbi; EMPİRİK doğrulandı sandbox izin veriyordu). MyCL'in KENDİ (orkestratör
  // süreci) .mycl yazımı etkilenmez — bu yalnız AJAN sandbox'ı. READ açık (spec.md/patterns.md okunur).
  const myclDir = pathPosix.join(projectRoot, ".mycl");
  const instr = agentInstructionPaths(projectRoot);
  const denyWrite = [
    gitDir,
    `${gitDir}/**`,
    myclDir,
    `${myclDir}/**`,
    // Ajan talimat yüzeyi (CLAUDE.md / .claude / .mcp.json) — gerekçe yukarıda agentInstructionPaths.
    ...instr.files,
    ...instr.dirs.flatMap((d) => [d, `${d}/**`]),
  ];
  // npm/araç paket-cache YAZMA izni (YZLLM 2026-06-17): sandbox default YALNIZ cwd + $TMPDIR'e yazdırır → npm cache
  // ~/.npm (home-altı) write-deny → `npm install` EPERM ("root-owned" yanıltıcı; gerçekte sandbox write-deny).
  // Cache dizinleri (paket tarball/araç cache — executable DEĞİL) `allowWrite` ile açılır; auth (.claude/.config)
  // write-deny KALIR (resmi kanal: claude doküman allowWrite önerir, NPM_CONFIG_CACHE env-hack'i değil). Ampirik
  // (gerçek claude + npm install) doğrulanır.
  const allowWrite: string[] = [];
  for (const d of [".npm", ".cache"]) {
    allowWrite.push(...subForms(pathPosix.join(home, d)));
  }
  // Kanca birleştirme: overlay kancaları (varsa) aynen kalır, ev dizini muhafızı PreToolUse listesine EKLENİR.
  // Muhafız yoksa `hooks` anahtarına dokunulmaz → o durumda üretilen ayar eskisiyle birebir.
  const overlayHooks = (hooksBlock.hooks ?? {}) as Record<string, unknown[]>;
  const mergedHooks: Record<string, unknown> = homeGuardHook
    ? { hooks: { ...overlayHooks, PreToolUse: [...(overlayHooks.PreToolUse ?? []), homeGuardHook] } }
    : {};
  const settings: Record<string, unknown> = {
    ...base,
    ...mergedHooks,
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false, // bash kaçış kapısı kapalı
      failIfUnavailable, // sandbox kurulamazsa claude fail-closed (enforce)
      allowedDomains: PACKAGE_REGISTRY_DOMAINS, // güvenilir paket registry + binary host (ağ default deny-all)
      filesystem: { denyRead, allowRead, denyWrite, allowWrite },
      ...networkBlock, // yalnız yetenek istendiğinde (yerel port); istenmezse anahtar HİÇ yok
    },
    // Defense-in-depth (prompt katmanı): .git + .mycl YAZMA reddi (hook-persistence + audit-forge vektörleri).
    permissions: {
      // NOT (2026-07-30, claude'un KENDİ uyarısı — her ajan spawn'ında iki satır gürültü basıyordu):
      // "Write(path) is not matched by file permission checks — only Edit(path) rules are. Edit rules
      // cover all file-editing tools." → Write(...) formu ETKİSİZ; koruma zaten Edit(...) ile sağlanıyor.
      // Etkisiz formu kaldırdık: koruma AYNI (Edit tüm yazma araçlarını kapsıyor), uyarı gürültüsü bitti.
      deny: [
        ...permDeny,
        editDenyRule(gitDir, { subtree: true }),
        editDenyRule(myclDir, { subtree: true }),
        ...agentInstructionPermDeny(projectRoot),
      ],
      allow: permAllow,
    },
  };
  return {
    settings,
    denyCount: denyRead.length,
    ...(homeRead.fallbackReason ? { readFallbackReason: homeRead.fallbackReason } : {}),
    ...(homeRead.installFault ? { readFallbackInstallFault: true } : {}),
  };
}

/** İmpure: gerçek dizin listeleyici. Hata → null (buildHomeReadDeny güvenli geniş redde düşer). */
function listDirSync(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

const _readFallbackEmitted = new Set<string>();

/**
 * İmpure: home'u oku → settings üret → `["--settings", json]`. policy + platform
 * modülden/process'ten. policy="off" → eski davranış (yalnız ultracode).
 * home okunamazsa enforce/warn'da GÖRÜNÜR uyarı (sessiz read-koruma kaybı yasak).
 */
/**
 * sandboxSettingsArgs'ın dış dünyaya dokunan girdileri. Varsayılanlar gerçek ortamdır; test bunları enjekte eder
 * (mahkeme 4. tur: betik varlık denetimi, MyCL'in kendi node'u ve "bir kez uyar" davranışı hiçbir testte yoktu →
 * biri silinse tüm testler yeşil kalırdı).
 */
export interface SandboxArgsDeps {
  home: string;
  platform: NodeJS.Platform;
  listDir: ListDir;
  guardPath: string;
  exists: (p: string) => boolean;
  execPath: string;
  emit: (text: string) => void;
}

export function sandboxSettingsArgs(
  projectRoot: string,
  ultracode: boolean,
  caps?: SandboxCaps,
  overlay?: OverlayHooks,
  depsOverride?: Partial<SandboxArgsDeps>,
): string[] {
  const deps: SandboxArgsDeps = {
    home: homedir(),
    platform: process.platform,
    listDir: listDirSync,
    guardPath: homeGuardPath(),
    exists: existsSync,
    execPath: process.execPath,
    emit: (text) => emitChatMessage("system", text),
    ...depsOverride,
  };
  if (_policy === "off") {
    // Sandbox kapalı olsa DA overlay kancaları ve kanıt/talimat yazma reddi eklenir (ayrı sözleşmeler).
    // (2026-11-26, mahkeme O3) Eskiden ultracode de overlay de yoksa buradan `[]` dönülüyordu → yukarıdaki
    // "off olsa BİLE kanıt defteri yazmaya kapalı" kuralı o spawn'lara HİÇ ulaşmıyordu (ayar üretiliyor
    // ama gönderilmiyordu). Artık her zaman gönderilir: içinde yalnız yazma reddi var, kum havuzu YOK.
    const { settings } = buildAgentSandboxSettings({
      projectRoot,
      ultracode,
      policy: "off",
      platform: deps.platform,
      home: deps.home,
      caps,
      overlay,
    });
    return ["--settings", JSON.stringify(settings)];
  }
  const platform = deps.platform;
  const home = deps.home;
  // ÇEKİRDEK katman (denyRead) ev dizinini TEK kuralla kapatır → dizin listesine bağlı DEĞİL. Dizin listesi yalnız
  // ARAÇ katmanındaki dar okuma kuralları için alınır (proje ev dizini altındaysa — buildHomeReadDeny); liste
  // okunamazsa geniş redde düşülür ve aşağıda GÖRÜNÜR uyarı verilir (koruma hiçbir durumda boş kalmaz).
  const { settings, readFallbackReason, readFallbackInstallFault } = buildAgentSandboxSettings({
    projectRoot,
    ultracode,
    policy: _policy,
    platform,
    home,
    caps,
    overlay,
    listDir: deps.listDir,
    // Betik diskte YOKSA (bozuk paket) yol verilmez → dar kural üretilmez, geniş ret + görünür uyarı. Aksi hâlde
    // kanca başlatılamaz, Claude Code bunu engel saymaz ve yeni adlar sessizce açık kalırdı (mahkeme bulgusu).
    homeGuardPath: deps.exists(deps.guardPath) ? deps.guardPath : undefined,
    nodePath: deps.execPath,
  });
  // SESSİZ DÜŞÜŞ YOK (KATI #4): geniş redde düşüldüyse ajan proje dosyalarını araçla okuyup yazamaz —
  // kullanıcı bunu proje hatası sanmasın. Proje + neden başına BİR kez (her spawn'da tekrar gürültü olur;
  // süreç başına tek bayrak ikinci projeyi sessiz bırakırdı — mahkeme bulgusu).
  const fallbackKey = `${projectRoot}\n${readFallbackReason ?? ""}`;
  if (readFallbackReason && !_readFallbackEmitted.has(fallbackKey)) {
    _readFallbackEmitted.add(fallbackKey);
    deps.emit(
      `⚠️ Ev dizini okuma koruması dar kurala çevrilemedi: ${readFallbackReason}. Güvenli tarafta kalındı: ` +
        `ajan bu projede dosya okuma ve yazma araçlarını kullanamaz, yalnız kabuk komutlarıyla çalışır ` +
        `(yavaş ve hataya açık). ` +
        // Öneri nedene göre: kurulum kaynaklı nedende projeyi başka klasöre taşımak hiçbir şeyi değiştirmez.
        (readFallbackInstallFault
          ? `Sorun MyCL kurulumunda: kurulumu onarmak (ya da özel karakter içermeyen bir yola kurmak) bunu çözer.`
          : `Projeyi daha az girdili bir klasöre ya da ev dizini dışına taşımak bunu çözer.`),
    );
  }
  return ["--settings", JSON.stringify(settings)];
}
