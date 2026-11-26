import { describe, expect, it } from "vitest";
import {
  agentInstructionPaths,
  sandboxSettingsArgs,
  setSandboxPolicy,
  getSandboxPolicy,
  buildAgentSandboxSettings,
  detectSandboxAvailability,
  runtimeAllowFor,
  sandboxGuard,
  needsLocalBinding,
  buildHomeReadDeny,
  escapePermissionGlob,
  MAX_HOME_READ_DENY_BYTES,
  normalizeAbs,
  isShellQuoteSafe,
} from "../src/agent-sandbox.js";

// Saf fonksiyonlar — platform/home/policy/projectRoot enjekte edilir; host'tan bağımsız (çapraz-platform).
// paths.test.ts kalıbı. IPC yan etkisi yok.
//
// E2BIG KÖK ÇÖZÜMÜ (YZLLM 2026-06-17): home'u TEK kuralla deny + proje/runtime girdilerini `allowRead` ile
// RE-ALLOW (eski: her home girdisini tek tek denyRead → profil argv'si şişer → "spawn E2BIG"). Güvenlik
// NİYETİ AYNI ve burada KANITLANIR: gizli/korunan girdiler (.ssh/.aws/medya/diğer-projeler) allowRead'de
// ASLA olmaz → home-deny altında kalır → ajan okuyamaz (sızma-yok). Yalnız proje + runtime açılır.

const HOME = "/Users/umit";
const LINUX_HOME = "/home/umit";
// Home'da bulunan tipik GİZLİ/korunan girdiler — bunlar allowRead'de ASLA olmamalı (deny home altında kalmalı).
const SECRET_ENTRIES = [
  "Music", "Pictures", "Documents", "Desktop", "Downloads", ".ssh", ".aws", ".gnupg", "other-project",
];

function deny(settings: Record<string, unknown>): string[] {
  return (settings.sandbox as { filesystem?: { denyRead?: string[] } })?.filesystem?.denyRead ?? [];
}
function allow(settings: Record<string, unknown>): string[] {
  return (settings.sandbox as { filesystem?: { allowRead?: string[] } })?.filesystem?.allowRead ?? [];
}

describe("agent-sandbox · detectSandboxAvailability (çapraz-platform)", () => {
  it("darwin → her zaman available (Seatbelt yerleşik)", () => {
    expect(detectSandboxAvailability({ platform: "darwin", hasBwrap: false, hasSocat: false }))
      .toEqual({ available: true });
  });

  it("linux + bwrap & socat var → available", () => {
    expect(detectSandboxAvailability({ platform: "linux", hasBwrap: true, hasSocat: true }))
      .toEqual({ available: true });
  });

  it("linux + bwrap yok → unavailable + reason bwrap içerir", () => {
    const r = detectSandboxAvailability({ platform: "linux", hasBwrap: false, hasSocat: true });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/bwrap/);
  });

  it("linux + socat yok → unavailable + reason socat içerir", () => {
    const r = detectSandboxAvailability({ platform: "linux", hasBwrap: true, hasSocat: false });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/socat/);
  });

  it("mac/linux dışı (örn. win32) → unavailable + 'desteklenmiyor' (fail-closed catch-all)", () => {
    const r = detectSandboxAvailability({ platform: "win32", hasBwrap: true, hasSocat: true });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/desteklenmiyor|macOS|Linux/);
  });
});

describe("agent-sandbox · sandboxGuard (görünür fail-closed)", () => {
  const unavailable = { available: false, reason: "test sebebi" };

  it("off → proceed, mesaj yok", () => {
    expect(sandboxGuard("off", unavailable)).toEqual({ proceed: true });
  });

  it("available → proceed, mesaj yok (policy farketmez)", () => {
    expect(sandboxGuard("enforce", { available: true })).toEqual({ proceed: true });
    expect(sandboxGuard("warn", { available: true })).toEqual({ proceed: true });
  });

  it("enforce + unavailable → proceed:false + error mesajı", () => {
    const d = sandboxGuard("enforce", unavailable);
    expect(d.proceed).toBe(false);
    expect(d.message?.level).toBe("error");
    expect(d.message?.text).toMatch(/test sebebi/);
  });

  it("warn + unavailable → proceed:true + warning mesajı (hapissiz devam)", () => {
    const d = sandboxGuard("warn", unavailable);
    expect(d.proceed).toBe(true);
    expect(d.message?.level).toBe("warning");
    expect(d.message?.text).toMatch(/HAPSİ OLMADAN|hapsi olmadan/i);
  });
});

describe("agent-sandbox · runtimeAllowFor (platform-aware)", () => {
  it("darwin → Library + .config dahil", () => {
    const s = runtimeAllowFor("darwin");
    expect(s.has("Library")).toBe(true);
    expect(s.has(".config")).toBe(true);
    expect(s.has(".claude")).toBe(true);
  });

  it("linux → .config dahil, Library YOK", () => {
    const s = runtimeAllowFor("linux");
    expect(s.has(".config")).toBe(true);
    expect(s.has("Library")).toBe(false);
  });
});

describe("agent-sandbox · buildAgentSandboxSettings · macOS home-deny + allowRead (E2BIG kök)", () => {
  const PROJ = "/tmp/mycl-validate/shop";
  const { settings, denyCount } = buildAgentSandboxSettings({
    projectRoot: PROJ,
    ultracode: false,
    policy: "enforce",
    platform: "darwin",
    home: HOME,
  });
  const denyRead = deny(settings);
  const allowRead = allow(settings);

  it("denyRead = TEK home kuralı (darwin dir-only — subpath içeriği kapsar, /** redundant=E2BIG için atlanır)", () => {
    expect(denyRead).toEqual([HOME]);
  });

  it("denyCount = 1 (argv küçük kalır → 'spawn E2BIG' biter)", () => {
    expect(denyCount).toBe(1);
  });

  it("proje allowRead'de → deny home'dan RE-ALLOW (ajan kodu okuyabilir)", () => {
    expect(allowRead).toContain(PROJ);
  });

  it("runtime girdileri allowRead'de (.claude/.claude.json/.config/.cache/.npm/Library)", () => {
    for (const rt of [".claude", ".claude.json", ".config", ".cache", ".npm", "Library"]) {
      expect(allowRead).toContain(`${HOME}/${rt}`);
    }
  });

  it("GÜVENLİK — gizli/korunan girdiler allowRead'de DEĞİL → home-deny altında kalır → okunamaz (sızma-yok)", () => {
    for (const s of SECRET_ENTRIES) {
      expect(allowRead).not.toContain(`${HOME}/${s}`);
      expect(allowRead).not.toContain(`${HOME}/${s}/**`);
    }
  });

  it("permissions: home Read-deny + proje/runtime Read-allow; .git/.mycl write-deny korunur", () => {
    const permDeny = (settings.permissions as { deny: string[] }).deny;
    const permAllow = (settings.permissions as { allow: string[] }).allow;
    expect(permDeny).toContain(`Read(/${HOME})`);
    expect(permDeny).toContain(`Read(/${HOME}/**)`);
    expect(permAllow).toContain(`Read(${PROJ}/**)`);
    expect(permAllow).toContain(`Read(${HOME}/.claude/**)`);
    // GÜVENLİK paritesi: gizli girdiler prompt-katmanında da allow EDİLMEZ.
    expect(permAllow).not.toContain(`Read(${HOME}/.ssh/**)`);
    // 2026-07-30: Write(...) formu claude'da dosya izin kontrolüne GİRMİYOR (aracın kendi uyarısı) —
    // koruma Edit(...) ile sağlanıyor (tüm yazma araçlarını kapsar). Etkisiz form kaldırıldı.
    expect(permDeny).toContain("Edit(//tmp/mycl-validate/shop/.git/**)");
    expect(permDeny).toContain("Edit(//tmp/mycl-validate/shop/.mycl/**)");
    expect(permDeny).not.toContain("Write(/tmp/mycl-validate/shop/.git/**)");
    const denyWrite = (settings.sandbox as { filesystem: { denyWrite: string[] } }).filesystem.denyWrite;
    expect(denyWrite).toEqual([
      `${PROJ}/.git`,
      `${PROJ}/.git/**`,
      `${PROJ}/.mycl`,
      `${PROJ}/.mycl/**`,
      // Ajan talimat yüzeyi (2026-11-26): ajan kendi/sonraki işçilerin talimatını ve kancalarını yazamaz.
      `${PROJ}/CLAUDE.md`,
      `${PROJ}/CLAUDE.local.md`,
      `${PROJ}/.mcp.json`,
      `${PROJ}/.claude`,
      `${PROJ}/.claude/**`,
    ]);
  });

  // HARNESS KAÇIŞ DENETİMİ (2026-11-26): Claude Code her spawn'da proje kökündeki CLAUDE.md'yi bağlama,
  // .claude/ ayarlarını (kancalar) ve .mcp.json'u oturuma yükler. Ajan bunlara yazabiliyordu → gerekçesi
  // sonraki işçilere/müfettişlere talimat olarak sızıyor, yazdığı kanca hapis DIŞINDA koşuyordu.
  // YOL BİÇİMİ (2026-11-26, gerçek claude 2.1.332 + macOS denemesi): izin kuralında tek eğik çizgiyle başlayan
  // yol proje köküne GÖRELİ sayılır → `Edit(/Users/.../.mycl/**)` hiçbir dosyayla eşleşmiyordu ve Write aracı
  // `.mycl` içine yazabildi. Mutlak yol çift eğik çizgiyle yazılır. Hiçbir Edit kuralı tek çizgili kalmamalı.
  it("her Edit yazma reddi mutlak yol biçiminde (çift eğik çizgi) — tek çizgili kural eşleşmez", () => {
    const permDeny = (settings.permissions as { deny: string[] }).deny;
    const editRules = permDeny.filter((d) => d.startsWith("Edit("));
    expect(editRules.length).toBeGreaterThanOrEqual(6); // .git + .mycl + 3 dosya + .claude
    for (const r of editRules) expect(r.startsWith(`Edit(/${PROJ}/`)).toBe(true);
  });

  // Mahkeme 4. tur: Edit kuralları kaçışsızdı → "proj [v2]" yolunda `.mycl` kuralı eşleşmez; ev dizini altındaki
  // projede geniş Read reddi artık olmadığından bu kurallar yazma araçları için tek korumadır.
  it("Edit yazma reddi: proje yolundaki desen karakterleri kaçırılır", () => {
    const { settings: st } = buildAgentSandboxSettings({
      projectRoot: "/srv/proj [v2]/a*b", ultracode: false, policy: "enforce", platform: "darwin", home: "/Users/umit",
    });
    const d = (st.permissions as { deny: string[] }).deny;
    expect(d).toContain("Edit(//srv/proj \\[v2\\]/a\\*b/.mycl/**)");
    expect(d).toContain("Edit(//srv/proj \\[v2\\]/a\\*b/.git/**)");
    expect(d).toContain("Edit(//srv/proj \\[v2\\]/a\\*b/CLAUDE.md)");
    expect(d).toContain("Edit(//srv/proj \\[v2\\]/a\\*b/.claude/**)");
    expect(d.filter((r) => r.startsWith("Edit(") && r.includes("proj [v2]"))).toEqual([]);
  });

  it("ajan talimat yüzeyi YAZMAYA kapalı, OKUMAYA açık (kullanıcının proje talimatları ajana ulaşır)", () => {
    const permDeny = (settings.permissions as { deny: string[] }).deny;
    expect(permDeny).toContain(`Edit(/${PROJ}/CLAUDE.md)`);
    expect(permDeny).toContain(`Edit(/${PROJ}/CLAUDE.local.md)`);
    expect(permDeny).toContain(`Edit(/${PROJ}/.mcp.json)`);
    expect(permDeny).toContain(`Edit(/${PROJ}/.claude/**)`);
    // Okuma reddi YOK: proje Read-allow'u bu dosyaları da kapsar, ayrı bir Read-deny eklenmedi.
    expect(permDeny.filter((d) => d.startsWith("Read(") && d.includes("CLAUDE"))).toEqual([]);
    const fsCfg = (settings.sandbox as { filesystem: { denyRead: string[] } }).filesystem;
    expect(fsCfg.denyRead.some((d) => d.includes("CLAUDE.md") || d.endsWith("/.claude"))).toBe(false);
  });

  it("agentInstructionPaths: yalnız proje KÖKÜ (alt dizin glob'u yok — Seatbelt glob güvenilmez)", () => {
    expect(agentInstructionPaths("/p")).toEqual({
      files: ["/p/CLAUDE.md", "/p/CLAUDE.local.md", "/p/.mcp.json"],
      dirs: ["/p/.claude"],
    });
  });

  it("ağ: güvenilir paket registry'leri allowedDomains'te (npm install için; ağ default deny-all, keyfi domain hariç)", () => {
    const domains = (settings.sandbox as { allowedDomains?: string[] }).allowedDomains ?? [];
    expect(domains).toContain("registry.npmjs.org");
    expect(domains).toContain("registry.yarnpkg.com");
    expect(domains).not.toContain("*"); // wildcard YOK — whitelist disiplini (keyfi domain deny kalır)
  });

  it("npm/araç cache YAZMA: allowWrite ~/.npm + ~/.cache içerir; auth (.claude/.config) write-DEĞİL", () => {
    const aw = (settings.sandbox as { filesystem: { allowWrite?: string[] } }).filesystem.allowWrite ?? [];
    expect(aw).toContain(`${HOME}/.npm`);
    expect(aw).toContain(`${HOME}/.cache`);
    expect(aw).not.toContain(`${HOME}/.claude`); // auth → write-deny KALIR (ajan auth değiştiremez)
    expect(aw).not.toContain(`${HOME}/.config`);
  });
});

describe("agent-sandbox · buildAgentSandboxSettings · Linux home-deny + allowRead", () => {
  const PROJ = "/srv/app";
  const { settings, denyCount } = buildAgentSandboxSettings({
    projectRoot: PROJ,
    ultracode: false,
    policy: "enforce",
    platform: "linux",
    home: LINUX_HOME,
  });
  const denyRead = deny(settings);
  const allowRead = allow(settings);

  it("linux denyRead = [home, home/**] (bwrap subpath semantiği doğrulanmadı → /** KORUNUR)", () => {
    expect(denyRead).toEqual([LINUX_HOME, `${LINUX_HOME}/**`]);
  });

  it("linux denyCount = 2", () => {
    expect(denyCount).toBe(2);
  });

  it("linux: proje + runtime iki formda allowRead'de; .config dahil, Library YOK (darwin-only)", () => {
    expect(allowRead).toContain(PROJ);
    expect(allowRead).toContain(`${PROJ}/**`);
    expect(allowRead).toContain(`${LINUX_HOME}/.config`);
    expect(allowRead).toContain(`${LINUX_HOME}/.config/**`);
    expect(allowRead).not.toContain(`${LINUX_HOME}/Library`);
  });

  it("linux GÜVENLİK: .ssh/Music allowRead'de değil", () => {
    expect(allowRead).not.toContain(`${LINUX_HOME}/.ssh`);
    expect(allowRead).not.toContain(`${LINUX_HOME}/Music`);
  });
});

describe("agent-sandbox · proje home'un ALTINDA olsa bile allowRead ile re-allow", () => {
  it("derin alt-yol (Documents/work/app): proje allowRead'de ama Documents'in KENDİSİ değil (gerisi kapalı)", () => {
    const PROJ = `${HOME}/Documents/work/app`;
    const { settings } = buildAgentSandboxSettings({
      projectRoot: PROJ, ultracode: false, policy: "enforce", platform: "darwin", home: HOME,
    });
    const allowRead = allow(settings);
    expect(allowRead).toContain(PROJ); // proje yolu açık
    expect(allowRead).not.toContain(`${HOME}/Documents`); // Documents kökü açılmaz → gerisi deny
    expect(deny(settings)).toEqual([HOME]); // home tek-deny değişmez
  });

  // EV DİZİNİ ALTINDAKİ PROJE (2026-11-26, gerçek claude 2.1.332 denemesi + mahkeme): eski tek kural
  // `Read(//<ev>)` alt ağacı da kapsıyor ve ret izinden baskın → proje dosya araçlarına tümüyle kapanıyordu.
  // Yeni: (1) taban — projeye giden yol DIŞINDAKİ her girdi ayrı ayrı reddedilir; (2) yüklem — home-guard
  // kancası var olmayan adları da kapatır. Dar kurallar YALNIZ kanca eklenebiliyorsa üretilir.
  const tree: Record<string, string[]> = {
    [HOME]: [".ssh", "Documents", "proj", ".claude", "Library", "notlar.txt"],
    [`${HOME}/proj`]: ["cave5", "baska-proje", "gizli [eski]"],
  };
  const listDir = (d: string): string[] | null => tree[d] ?? null;
  const GUARD = "/opt/mycl/orchestrator/home-guard.mjs";
  const readDeny = (st: Record<string, unknown>): string[] =>
    (st.permissions as { deny: string[] }).deny.filter((r) => r.startsWith("Read("));
  const preToolUse = (st: Record<string, unknown>): Array<{ matcher: string; hooks: Array<{ command: string }> }> =>
    ((st.hooks as Record<string, unknown> | undefined)?.PreToolUse ?? []) as never;
  const build = (projectRoot: string, extra: Record<string, unknown> = {}) =>
    buildAgentSandboxSettings({
      projectRoot, ultracode: false, policy: "enforce", platform: "darwin", home: HOME,
      listDir, homeGuardPath: GUARD, ...extra,
    });

  it("EV ALTI proje (~/proj/cave5): kardeşler VE çalışma zamanı girdileri reddedilir, projeye giden yol serbest", () => {
    const PROJ = `${HOME}/proj/cave5`;
    const { settings, readFallbackReason } = build(PROJ);
    const rd = readDeny(settings);
    expect(readFallbackReason).toBeUndefined();
    expect(rd).toContain(`Read(/${HOME}/.ssh)`);
    expect(rd).toContain(`Read(/${HOME}/.ssh/**)`);
    expect(rd).toContain(`Read(/${HOME}/Documents/**)`);
    expect(rd).toContain(`Read(/${HOME}/notlar.txt)`);
    expect(rd).toContain(`Read(/${HOME}/proj/baska-proje/**)`);
    // Köşeli parantez kaçırılır (kaçışsız kural gerçek claude'da o klasörle EŞLEŞMEDİ → içerik okundu).
    expect(rd).toContain(`Read(/${HOME}/proj/gizli \\[eski\\]/**)`);
    // Mahkeme YÜKSEK bulgusu: çalışma zamanı girdileri araç katmanında AÇIK kalmamalı (~/.claude/settings.json
    // içine yazılan kanca hapis dışında koşar). O liste çekirdek katmanda claude süreci içindir.
    expect(rd).toContain(`Read(/${HOME}/.claude/**)`);
    expect(rd).toContain(`Read(/${HOME}/Library/**)`);
    // Projeyi kapsayan HİÇBİR Read reddi yok: ne ev dizininin kendisi, ne zincir, ne proje.
    for (const covering of [HOME, `${HOME}/proj`, PROJ]) {
      expect(rd).not.toContain(`Read(/${covering})`);
      expect(rd).not.toContain(`Read(/${covering}/**)`);
    }
    // Çekirdek katman değişmedi: ev tek kuralla kapalı, proje yeniden açık.
    expect(deny(settings)).toEqual([HOME]);
    expect(allow(settings)).toContain(PROJ);
  });

  it("EV ALTI proje: home-guard kancası tüm dosya araçlarına bağlanır; kurallar argv'de (ev + proje)", () => {
    const PROJ = `${HOME}/proj/cave5`;
    const hooks = preToolUse(build(PROJ).settings);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.matcher).toBe("Read|Write|Edit|MultiEdit|NotebookEdit|NotebookRead|Glob|Grep|LS");
    const cmd = hooks[0]!.hooks[0]!.command;
    expect(cmd.startsWith(`"node" "${GUARD}" --rules `)).toBe(true);
    // Gerçek çağıran MyCL'in kendi node'unu verir: PATH'te node yoksa kanca sessizce atlanmasın.
    const withNode = preToolUse(build(PROJ, { nodePath: "/opt/node/bin/node" }).settings)[0]!.hooks[0]!.command;
    expect(withNode.startsWith(`"/opt/node/bin/node" "${GUARD}" --rules `)).toBe(true);
    const rules = JSON.parse(Buffer.from(cmd.split("--rules ")[1]!, "base64").toString("utf-8"));
    expect(rules).toEqual({ home: HOME, project_root: PROJ });
  });

  it("EV ALTI proje + overlay: overlay kancaları aynen kalır, muhafız PreToolUse listesine EKLENİR", () => {
    const overlay = { guardPath: "/opt/overlay-guard.mjs", rulesB64: "QUJD", ackPath: "/tmp/ack.json" };
    const st = build(`${HOME}/proj/cave5`, { overlay }).settings;
    const hooks = st.hooks as Record<string, unknown[]>;
    expect(hooks.SessionStart).toHaveLength(1); // overlay kanaryası korunur
    const pre = preToolUse(st);
    expect(pre).toHaveLength(2);
    expect(pre[0]!.hooks[0]!.command).toContain("overlay-guard.mjs");
    expect(pre[1]!.hooks[0]!.command).toContain("home-guard.mjs");
  });

  it("EV ALTI proje: muhafız yolu yoksa dar kural ÜRETİLMEZ → güvenli geniş ret + neden, kanca da yok", () => {
    const { settings, readFallbackReason } = build(`${HOME}/proj/cave5`, { homeGuardPath: undefined });
    expect(readFallbackReason).toContain("home-guard");
    expect(readDeny(settings)).toEqual([`Read(/${HOME})`, `Read(/${HOME}/**)`]);
    expect(settings.hooks).toBeUndefined();
  });

  // Mahkeme 3. tur: kanca komutu çift tırnakla yazılıyor; yolda `$` varsa başka yola genişler → betik bulunamaz,
  // exit 1 → Claude Code engel saymaz (sessiz açık). Böyle yolda dar kural üretilmez.
  it("EV ALTI proje: muhafız ya da node yolunda kabuk özel karakteri varsa güvenli geniş ret + neden", () => {
    for (const extra of [
      { homeGuardPath: "/opt/my$PWD/home-guard.mjs" },
      { homeGuardPath: '/opt/a"b/home-guard.mjs' },
      { nodePath: "/opt/`x`/node" },
      { nodePath: "/opt/a\\b/node" },
    ]) {
      const { settings, readFallbackReason } = build(`${HOME}/proj/cave5`, extra);
      expect(readFallbackReason).toContain("özel karakter");
      expect(readDeny(settings)).toEqual([`Read(/${HOME})`, `Read(/${HOME}/**)`]);
      expect(settings.hooks).toBeUndefined();
    }
    // Boşluklu yol güvenlidir (çift tırnak korur).
    expect(build(`${HOME}/proj/cave5`, { homeGuardPath: "/Applications/MyCL Studio.app/x/home-guard.mjs" })
      .readFallbackReason).toBeUndefined();
    expect(isShellQuoteSafe("/a b/c")).toBe(true);
    expect(isShellQuoteSafe("/a$b")).toBe(false);
  });

  it("EV ALTI proje: liste okunamazsa / verilmezse güvenli geniş ret + neden (sessiz düşüş yok)", () => {
    const a = build(`${HOME}/okunamayan/app`, { listDir: (d: string) => (d === HOME ? ["okunamayan"] : null) });
    expect(a.readFallbackReason).toContain("listelenemedi");
    expect(readDeny(a.settings)).toEqual([`Read(/${HOME})`, `Read(/${HOME}/**)`]);
    expect(a.settings.hooks).toBeUndefined();
    const b = build(`${HOME}/proj/cave5`, { listDir: undefined });
    expect(b.readFallbackReason).toBeDefined();
    expect(readDeny(b.settings)).toEqual([`Read(/${HOME})`, `Read(/${HOME}/**)`]);
  });

  // Mahkeme bulgusu: readdir farklı yazım (büyük küçük harf / Unicode) dönerse proje "kardeş" sayılıp
  // sessizce kilitlenirdi. Emin değilsek dar kural yok: görünür geniş ret.
  it("EV ALTI proje: projeye giden ad listede AYNEN yoksa güvenli geniş ret + neden", () => {
    const r = buildHomeReadDeny({ home: HOME, projectRoot: `${HOME}/Proj/cave5`, listDir });
    expect(r.fallbackReason).toContain("aynen bulunamadı");
    expect(r.rules).toEqual([`Read(/${HOME})`, `Read(/${HOME}/**)`]);
  });

  it("EV ALTI proje: bayt bütçesi aşılırsa güvenli geniş ret + neden (argv taşması yerine)", () => {
    const long = "ç".repeat(60);
    const many = Array.from({ length: 700 }, (_, i) => `${long}${i}`);
    const r = buildHomeReadDeny({ home: HOME, projectRoot: `${HOME}/cave5`, listDir: () => [...many, "cave5"] });
    expect(r.fallbackReason).toContain("sınırını aşıyor");
    expect(r.rules).toEqual([`Read(/${HOME})`, `Read(/${HOME}/**)`]);
    // Aynı SAYIDA kısa ad bütçeye sığar → sınır sayı değil bayt.
    const short = Array.from({ length: 700 }, (_, i) => `d${i}`);
    const ok = buildHomeReadDeny({ home: HOME, projectRoot: `${HOME}/cave5`, listDir: () => [...short, "cave5"] });
    expect(ok.fallbackReason).toBeUndefined();
    expect(ok.rules).toHaveLength(1400);
    expect(Buffer.byteLength(JSON.stringify(ok.rules), "utf-8")).toBeLessThan(MAX_HOME_READ_DENY_BYTES);
  });

  // Mahkeme bulgusu: sondaki eğik çizgi zinciri ["proj","cave5",""] yapıp projenin KENDİ içeriğini reddettiriyordu.
  it("EV ALTI proje: sondaki eğik çizgi ve `//` içeren proje yolu aynı kuralları üretir", () => {
    const clean = buildHomeReadDeny({ home: HOME, projectRoot: `${HOME}/proj/cave5`, listDir });
    for (const messy of [`${HOME}/proj/cave5/`, `${HOME}//proj/./cave5`, `${HOME}/proj/x/../cave5`]) {
      expect(buildHomeReadDeny({ home: HOME, projectRoot: messy, listDir })).toEqual(clean);
    }
    expect(normalizeAbs("/a/b/")).toBe("/a/b");
    expect(normalizeAbs("/")).toBe("/");
  });

  it("ön eki aynı olan dizin (/Users/umit2) ev dizini ALTI sayılmaz → geniş ret korunur, kanca yok", () => {
    const { settings, readFallbackReason } = build(`${HOME}2/app`);
    expect(readFallbackReason).toBeUndefined();
    expect(readDeny(settings)).toEqual([`Read(/${HOME})`, `Read(/${HOME}/**)`]);
    expect(settings.hooks).toBeUndefined();
  });

  it("proje ev dizininin KENDİSİ ise reddedilecek kardeş yok, liste de okunmaz", () => {
    const r = buildHomeReadDeny({
      home: HOME, projectRoot: HOME, listDir: () => { throw new Error("çağrılmamalı"); },
    });
    expect(r).toEqual({ rules: [] });
  });

  it("escapePermissionGlob: yalnız desen karakterleri kaçırılır; boşluk, parantez, Türkçe harf aynen kalır", () => {
    expect(escapePermissionGlob("/h/a [b]*?\\c")).toBe("/h/a \\[b\\]\\*\\?\\\\c");
    expect(escapePermissionGlob("/h/d2 (parantez) çğş {a,b}")).toBe("/h/d2 (parantez) çğş {a,b}");
  });

  it("ev-DIŞI proje (/tmp/...): broad Read(~/**) prompt-deny KORUNUR (regresyon yok)", () => {
    const { settings } = buildAgentSandboxSettings({
      projectRoot: "/tmp/mycl-x/app", ultracode: false, policy: "enforce", platform: "darwin", home: HOME,
    });
    const permDeny = (settings.permissions as { deny: string[] }).deny;
    expect(permDeny).toContain(`Read(/${HOME})`);
    expect(permDeny).toContain(`Read(/${HOME}/**)`); // ev-dışı projede broad deny korunur
  });
});

describe("agent-sandbox · buildAgentSandboxSettings · mac/linux dışı (örn. win32, sandbox yok)", () => {
  const { settings, denyCount } = buildAgentSandboxSettings({
    projectRoot: "C:\\Users\\umit\\proj",
    ultracode: false,
    policy: "enforce",
    platform: "win32",
    home: "C:\\Users\\umit",
  });

  it("win32 → denyRead ÜRETME (POSIX-olmayan yol bug'ına girme)", () => {
    expect(denyCount).toBe(0);
    expect("filesystem" in (settings.sandbox as object)).toBe(false);
    expect("permissions" in settings).toBe(false);
  });

  it("win32 → sandbox.enabled + failIfUnavailable korunur (claude exit-1 savunması)", () => {
    const sb = settings.sandbox as { enabled: boolean; failIfUnavailable: boolean };
    expect(sb.enabled).toBe(true);
    expect(sb.failIfUnavailable).toBe(true); // enforce
  });
});

describe("agent-sandbox · ultracode merge + policy modları", () => {
  it("ultracode=true → settings.ultracode:true", () => {
    const { settings } = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: true, policy: "enforce", platform: "darwin", home: HOME,
    });
    expect(settings.ultracode).toBe(true);
  });

  it("ultracode=false → ultracode anahtarı YOK", () => {
    const { settings } = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "enforce", platform: "darwin", home: HOME,
    });
    expect("ultracode" in settings).toBe(false);
  });

  it("enforce → failIfUnavailable:true; warn → false; allowUnsandboxedCommands:false", () => {
    const e = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "enforce", platform: "darwin", home: HOME,
    });
    const w = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "warn", platform: "darwin", home: HOME,
    });
    expect((e.settings.sandbox as { failIfUnavailable: boolean }).failIfUnavailable).toBe(true);
    expect((w.settings.sandbox as { failIfUnavailable: boolean }).failIfUnavailable).toBe(false);
    expect((e.settings.sandbox as { allowUnsandboxedCommands: boolean }).allowUnsandboxedCommands).toBe(false);
  });

  it("off → sandbox YOK; ultracode korunur", () => {
    const off = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: true, policy: "off", platform: "darwin", home: HOME,
    });
    expect(off.denyCount).toBe(0);
    expect("sandbox" in off.settings).toBe(false);
    expect(off.settings.ultracode).toBe(true);
  });

  // ADLİ DENETİM DÜZELTMESİ (2026-09-10): "off" eskiden HİÇBİR koruma bırakmadan dönüyordu — kum
  // havuzunu kapatmak, MyCL'in kendi KANIT DEFTERİNİ de ajanın yazmasına açıyordu. Bunlar iki ayrı
  // karar: kullanıcı işletim sistemi hapsini kapatabilir, ama "hükmün üretildiği kaydı da yaz"
  // demiş olmaz. Hüküm .mycl/audit.log'dan geri okunuyor; oraya yazabilen kapıyı geçmeden kapının
  // KAYDINI geçebilir (mahkeme geçici dizinde kanıtladı).
  it("off olsa BİLE kanıt defteri (.mycl) ve .git yazmaya kapalı kalır", () => {
    const off = buildAgentSandboxSettings({
      projectRoot: "/tmp/x", ultracode: false, policy: "off", platform: "darwin", home: HOME,
    });
    const deny = (off.settings.permissions as { deny: string[] } | undefined)?.deny ?? [];
    expect(deny).toContain("Edit(//tmp/x/.mycl/**)");
    expect(deny).toContain("Edit(//tmp/x/.git/**)");
    // Talimat yüzeyi de politikadan BAĞIMSIZ korunur (aynı gerekçe: hapsi kapatmak ≠ "ajan kendi
    // talimatını ve kancasını yazsın" demek).
    expect(deny).toContain("Edit(//tmp/x/CLAUDE.md)");
    expect(deny).toContain("Edit(//tmp/x/.claude/**)");
    expect(deny).toContain("Edit(//tmp/x/.mcp.json)");
    // Kum havuzu YİNE yok — yalnız kanıt koruması eklendi (politikanın anlamı korunuyor).
    expect("sandbox" in off.settings).toBe(false);
    expect(off.denyCount).toBe(0);
  });
});

// YEREL PORT İZNİ (YZLLM onayı 2026-07-30, canlı cave kanıtı: 245 kez "EPERM: listen 0.0.0.0:5173").
// Ampirik olarak doğrulandı (claude 2.1.220, /tmp): ayar `sandbox.network.allowLocalBinding` olmadan
// BIND_ERROR:EPERM, onunla BIND_OK. En az yetki: yalnız gerçekten sunucu açan roller.
describe("agent-sandbox · yerel port yeteneği (SandboxCaps)", () => {
  const P = { projectRoot: "/tmp/proj", ultracode: false, policy: "enforce" as const, home: "/Users/u" };

  it("REGRESYON KİLİDİ: caps verilmezse üretilen ayar caps:{} ile BİREBİR aynı (network anahtarı YOK)", () => {
    for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
      const a = buildAgentSandboxSettings({ ...P, platform });
      const b = buildAgentSandboxSettings({ ...P, platform, caps: {} });
      const c = buildAgentSandboxSettings({ ...P, platform, caps: { localBinding: false } });
      expect(b.settings).toEqual(a.settings);
      expect(c.settings).toEqual(a.settings);
      expect((a.settings.sandbox as Record<string, unknown>).network).toBeUndefined();
    }
  });

  it("caps.localBinding → sandbox.network.allowLocalBinding=true (darwin/linux/diğer platform dahil)", () => {
    for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
      const { settings } = buildAgentSandboxSettings({ ...P, platform, caps: { localBinding: true } });
      const sb = settings.sandbox as { network?: { allowLocalBinding?: boolean } };
      expect(sb.network?.allowLocalBinding).toBe(true);
    }
  });

  it("yerel port AÇILINCA dosya koruması aynen durur (izin genişlemesi yalnız ağ tarafında)", () => {
    const open = buildAgentSandboxSettings({ ...P, platform: "darwin", caps: { localBinding: true } });
    const closed = buildAgentSandboxSettings({ ...P, platform: "darwin" });
    const fs1 = (open.settings.sandbox as { filesystem: unknown }).filesystem;
    const fs2 = (closed.settings.sandbox as { filesystem: unknown }).filesystem;
    expect(fs1).toEqual(fs2);
    expect((open.settings.sandbox as { allowUnsandboxedCommands: boolean }).allowUnsandboxedCommands).toBe(false);
    expect(open.settings.permissions).toEqual(closed.settings.permissions);
  });

  it("policy=off: caps yok sayılır (sandbox hiç kurulmaz — eski davranış)", () => {
    const { settings } = buildAgentSandboxSettings({
      ...P, policy: "off", platform: "darwin", caps: { localBinding: true },
    });
    expect(settings.sandbox).toBeUndefined();
  });

  it("needsLocalBinding: yalnız sunucu/tarayıcı testi koşan codegen etiketleri (açık liste)", () => {
    for (const t of ["phase-5", "phase-8", "verify-feature", "parallel-module", "gate-autofix"])
      expect(needsLocalBinding(t)).toBe(true);
    // Kod yazmayan / sunucu açmayan roller: izin YOK (kuşkuda verme).
    for (const t of ["phase-2", "phase-4", "phase-7", "translator", "quality-audit", "phase-9-debate", ""])
      expect(needsLocalBinding(t)).toBe(false);
  });
});

// Mahkeme 4. tur: bu üç davranış yalnız sandboxSettingsArgs içinde ve hiçbir testte yoktu.
describe("sandboxSettingsArgs: ev dizini altındaki projede gerçek çağıran davranışı", () => {
  const H = "/Users/umit";
  const P = `${H}/proj/cave5`;
  const P2 = `${H}/proj/diger`;
  const listDir = (d: string): string[] | null =>
    ({ [H]: ["proj", ".ssh"], [`${H}/proj`]: ["cave5", "diger"] })[d] ?? null;
  const call = (project: string, over: Record<string, unknown>, emitted: string[]) => {
    const args = sandboxSettingsArgs(project, false, undefined, undefined, {
      home: H, platform: "darwin", listDir, guardPath: "/opt/mycl/home-guard.mjs",
      exists: () => true, execPath: "/opt/node/bin/node", emit: (t: string) => emitted.push(t), ...over,
    });
    return JSON.parse(args[1] ?? "{}") as {
      hooks?: { PreToolUse?: Array<{ hooks: Array<{ command: string }> }> };
      permissions: { deny: string[] };
    };
  };
  const withEnforce = (fn: () => void) => {
    const prev = getSandboxPolicy();
    setSandboxPolicy("enforce");
    try { fn(); } finally { setSandboxPolicy(prev); }
  };

  it("betik varsa: kanca MyCL'in KENDİ node ikilisiyle koşar, dar kurallar üretilir, uyarı yok", () => withEnforce(() => {
    const emitted: string[] = [];
    const st = call(P, {}, emitted);
    expect(st.hooks?.PreToolUse?.[0]?.hooks[0]?.command.startsWith('"/opt/node/bin/node" "/opt/mycl/home-guard.mjs" --rules ')).toBe(true);
    expect(st.permissions.deny).toContain(`Read(/${H}/.ssh/**)`);
    expect(st.permissions.deny).not.toContain(`Read(/${H})`);
    expect(emitted).toEqual([]);
  }));

  it("betik diskte YOKSA: geniş ret, kanca yok, GÖRÜNÜR uyarı", () => withEnforce(() => {
    const emitted: string[] = [];
    const st = call(`${P}-betiksiz`, { exists: () => false, listDir: () => ["proj"] }, emitted);
    expect(st.hooks).toBeUndefined();
    expect(st.permissions.deny).toContain(`Read(/${H})`);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("home-guard.mjs");
    expect(emitted[0]).toContain("dosya okuma ve yazma araçlarını kullanamaz");
    // Öneri nedene uygun: kurulum kaynaklı nedende "projeyi taşı" denmez.
    expect(emitted[0]).toContain("kurulumu onarmak");
    expect(emitted[0]).not.toContain("daha az girdili");
  }));

  it("uyarı proje + neden başına BİR kez: aynı proje tekrar etmez, ikinci proje ayrıca uyarılır", () => withEnforce(() => {
    const emitted: string[] = [];
    const broken = { listDir: () => null };
    call(`${P}-tekrar`, broken, emitted);
    call(`${P}-tekrar`, broken, emitted);
    expect(emitted).toHaveLength(1);
    call(`${P2}-tekrar`, broken, emitted);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toContain("listelenemedi");
    expect(emitted[1]).toContain("daha az girdili");
  }));
});

// MAHKEME O3 (2026-11-26): "off" + ultracode yok + overlay yok iken sandboxSettingsArgs `[]` dönüyordu →
// üretilen "kanıt defteri yazmaya kapalı" ayarı o spawn'lara HİÇ gönderilmiyordu.
describe("sandboxSettingsArgs: policy off iken de yazma reddi GÖNDERİLİR", () => {
  it("ultracode ve overlay yokken bile --settings üretir; içinde sandbox yok, yazma reddi var", () => {
    const prev = getSandboxPolicy();
    setSandboxPolicy("off");
    try {
      const args = sandboxSettingsArgs("/tmp/x", false);
      expect(args[0]).toBe("--settings");
      const parsed = JSON.parse(args[1] ?? "{}") as { sandbox?: unknown; permissions?: { deny?: string[] } };
      expect(parsed.sandbox).toBeUndefined();
      expect(parsed.permissions?.deny).toContain("Edit(//tmp/x/.mycl/**)");
      expect(parsed.permissions?.deny).toContain("Edit(//tmp/x/CLAUDE.md)");
    } finally {
      setSandboxPolicy(prev);
    }
  });
});
