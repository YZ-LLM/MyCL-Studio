// service-provision — çalıştırırken app'in RUNTIME servis bağımlılığını (DB/cache) tespit et + tamamlamaya çalış.
//
// Neden (YZLLM 2026-07-14, "MyCL stack'i biliyor; çalıştırırken ona göre davranmalı, eksik olanı tamamlamaya
// çalışmalı ve bana söylemeli"): Faz 5 dev-server, app bir servise (MySQL/Postgres/Mongo/Redis) bağlanamayınca
// (ECONNREFUSED) çöküyordu → MyCL dürüst duruyordu ama servisi BAŞLATMAYI denemiyordu. Bu modül: crash'ten +
// package.json'dan eksik servisi tespit eder; proje bir `docker-compose` bildirmişse `docker compose up -d` ile
// TAMAMLAMAYA çalışır (güvenli — projenin kendi bildirdiği servisler); sonra dev-server retry edilir. Compose yoksa
// veya docker yoksa: SPESİFİK + eyleme dönük rehber (jenerik "bağlantı sorunu" değil). Her adım kullanıcıya söylenir.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { tryDevServerChain, type DevServerChainResult } from "./dev-server-launcher.js";
import { emitChatMessage } from "./ipc.js";
import { safeEnv } from "./safe-env.js";
import { loadProfile, resolveCommand } from "./profile-loader.js";
import type { StackId } from "./types.js";

/**
 * Dev-server'ı başlat; app bir servise bağlanamayıp çökerse eksik servisi TAMAMLAMAYA çalış (docker-compose) + BİR KEZ
 * retry. TEK KAYNAK — phase-5 (pipeline) VE intent-router "projeyi çalıştır" komutu bunu kullanır (drift yok). Provision
 * mesajını KENDİ emit eder (kullanıcıya "X başlatılıyor/başlatılamadı"); audit'i çağıran yapar (faz-özel event adı).
 * @returns dev-server sonucu (retry sonrası; attempts birleştirilmiş) + provision denendiyse audit-detayı.
 */
export async function launchWithProvision(
  projectRoot: string,
  candidates: Array<{ cmd: string; ports: number[] }>,
  timeoutMs: number,
  opts: { stackId?: StackId | null } = {},
): Promise<{ result: DevServerChainResult; provisionAudit?: string }> {
  const crashOf = (r: DevServerChainResult): string =>
    r.attempts.map((a) => a.output).filter((o): o is string => !!o).join("\n---\n");
  const pkgDeps = await fs.readFile(join(projectRoot, "package.json"), "utf-8").catch(() => "");
  const auditParts: string[] = [];

  // Kurulum komutu PROFİLDEN — TEK KAYNAK (KATI #1, hardcode YOK); stackId çağırandan TAZE detectStack ile gelir.
  const installCmd = opts.stackId ? resolveCommand(await loadProfile(opts.stackId), "install") : null;
  const runInstall = async (startMsg: string): Promise<boolean> => {
    if (!installCmd) return false;
    emitChatMessage("system", startMsg); // kullanıcı beklerken NE olduğunu ANINDA görsün (başlarken + bitince).
    const inst = await tryInstallDeps(projectRoot, installCmd);
    if (inst.message) emitChatMessage("system", inst.message);
    auditParts.push(`deps-install attempted=${inst.attempted} ok=${inst.ok}`);
    return inst.ok;
  };

  // PROAKTİF (KATI #6 correct-by-construction, YZLLM: "bunu MyCL tespit etmeliydi"): app'i çalıştırmadan ÖNCE
  // deps kurulu mu diye BAK — node_modules yok / kısmi (bildirilen bir runtime paket eksik) ise KUR. Crash'i BEKLEME.
  // MyCL stack'i biliyor; "node_modules eksik → kur" elle forensic değil, deterministik dosya kontrolü.
  let depsHandled = false;
  if (installCmd && (await nodeDepsUninstalled(projectRoot, pkgDeps))) {
    await runInstall(`📦 Bağımlılıklar kurulu değil (node_modules eksik) — \`${installCmd}\` ile kuruyorum…`);
    depsHandled = true; // kurulum denendi (başarılı ya da değil) → aşağıdaki reaktif tur TEKRAR kurmasın.
  }

  let result = await tryDevServerChain(projectRoot, candidates, timeoutMs);
  if (result.ok && result.handle && result.cmd) {
    return { result, provisionAudit: auditParts.length ? auditParts.join("; ") : undefined };
  }
  let crashOut = crashOf(result);

  // REAKTİF FALLBACK — proaktif YAKALAMADIYSA (non-node stack; ya da node_modules "dolu görünüp" runtime'da bir
  // paket eksikse) crash "Cannot find module"/eşdeğer imzasından tespit + kur + BİR KEZ retry. Servisten ÖNCE.
  if (!depsHandled && detectMissingDeps(crashOut, pkgDeps)) {
    const ok = await runInstall(`📦 Uygulama başlamadı: bağımlılıklar kurulu değil. \`${installCmd}\` ile kuruluyor…`);
    if (ok) {
      const retry = await tryDevServerChain(projectRoot, candidates, timeoutMs);
      result = { ...retry, attempts: [...result.attempts, ...retry.attempts] };
      if (result.ok && result.handle && result.cmd) {
        return { result, provisionAudit: auditParts.join("; ") };
      }
      // Kurulum ok ama app hâlâ çök/timeout — ROUND 2 GÜNCEL crash'i görsün (bayat "module yok" değil).
      crashOut = crashOf(retry);
    }
  }

  // ROUND 2 — EKSİK SERVİS (DB/cache). Crash'teki ECONNREFUSED :port → servis; docker-compose ile tamamla veya rehber.
  const missing = detectMissingService(crashOut, pkgDeps);
  if (missing) {
    const prov = await tryProvisionService(projectRoot, missing);
    emitChatMessage("system", prov.message);
    auditParts.push(`${missing.name}:${missing.port} attempted=${prov.attempted} ok=${prov.ok}`);
    if (prov.ok) {
      const retry = await tryDevServerChain(projectRoot, candidates, timeoutMs);
      // attempts BİRLEŞTİR (mahkeme feedback_surface_real_error): retry fail ederse GÜNCEL çıktı görünsün.
      result = { ...retry, attempts: [...result.attempts, ...retry.attempts] };
    }
  }
  return { result, provisionAudit: auditParts.length ? auditParts.join("; ") : undefined };
}

export interface ServiceDep {
  /** Görünen ad (MySQL/PostgreSQL/...). */
  name: string;
  /** Varsayılan port. */
  port: number;
  /** Elle başlatma ipucu (compose yoksa). */
  hint: string;
}

/** Bilinen servis portları + package.json bağımlılık imzaları. */
const KNOWN_SERVICES: { port: number; name: string; deps: RegExp; hint: string }[] = [
  { port: 3306, name: "MySQL", deps: /\bmysql2?\b/, hint: "MySQL 3306'da çalışmalı (ör. `docker run -p 3306:3306 mysql` veya `brew services start mysql`)" },
  { port: 5432, name: "PostgreSQL", deps: /\b(pg|postgres|sequelize|typeorm|prisma)\b/, hint: "PostgreSQL 5432'de çalışmalı (ör. `docker run -p 5432:5432 postgres` veya `brew services start postgresql`)" },
  { port: 27017, name: "MongoDB", deps: /\b(mongodb|mongoose)\b/, hint: "MongoDB 27017'de çalışmalı (ör. `docker run -p 27017:27017 mongo`)" },
  { port: 6379, name: "Redis", deps: /\b(redis|ioredis)\b/, hint: "Redis 6379'da çalışmalı (ör. `docker run -p 6379:6379 redis`)" },
  { port: 9200, name: "Elasticsearch", deps: /\b(elasticsearch|@elastic)\b/, hint: "Elasticsearch 9200'de çalışmalı" },
];

/**
 * Crash çıktısı + package.json bağımlılıklarından EKSİK servisi tespit et. SAF (testli).
 * Öncelik: crash'teki `ECONNREFUSED ...:<port>` (kesin kanıt) → o porta ait servis. Yoksa null.
 * (package.json imzası tek başına YETMEZ — servis çalışıyor olabilir; yalnız crash+port kesin eksikliği gösterir.)
 */
/** Kod-hatası imzaları (uncaught exception) — bunlar servis-hatası DEĞİL, Faz 0 debug'a gitmeli. */
const CODE_ERR_RE = /\b(TypeError|ReferenceError|SyntaxError|RangeError|is not a function|is not defined)\b|Cannot read propert/gi;
const CONN_ERR_RE = /\b(ECONNREFUSED|ETIMEDOUT)\b/gi;
/** Bir regex'in metindeki SON eşleşme konumu (yoksa -1). */
function lastMatchIndex(re: RegExp, s: string): number {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let last = -1;
  while ((m = re.exec(s)) !== null) last = m.index;
  return last;
}

export function detectMissingService(crashOutput: string, pkgDepsText: string): ServiceDep | null {
  if (!crashOutput) return null;
  // YANLIŞ-POZİTİF önleme (mahkeme): eski/kurtarılmış "ECONNREFUSED ... now connected" log'u ölümcül-hata SANMA.
  // ÖLÜMCÜL hata (process'i öldüren, çıktının SONUNDAKI uncaught exception) bağlantı-hatası MI yoksa kod-hatası MI?
  // Son kod-hatası, son bağlantı-hatasından SONRAYSA → kod çöküşü (servis değil) → null (Faz 0 debug).
  const lastConn = lastMatchIndex(CONN_ERR_RE, crashOutput);
  if (lastConn === -1) return null; // hiç bağlantı-hatası yok → servis değil
  const lastCode = lastMatchIndex(CODE_ERR_RE, crashOutput);
  if (lastCode > lastConn) return null; // ölümcül hata bir KOD hatası (bağlantı-hatası eski/benign log)
  // Ölümcül hata bağlantı-hatası → eksik servis. Port: son bağlantı-hatası satırındaki port.
  const conn = /(ECONNREFUSED|ETIMEDOUT)[^\n]*?:(\d{2,5})\b/i.exec(crashOutput.slice(lastConn));
  const portFromCrash = conn ? parseInt(conn[2], 10) : null;
  if (portFromCrash) {
    const svc = KNOWN_SERVICES.find((s) => s.port === portFromCrash);
    if (svc) return { name: svc.name, port: svc.port, hint: svc.hint };
    return { name: `servis (port ${portFromCrash})`, port: portFromCrash, hint: `Port ${portFromCrash}'daki servis çalışmıyor — başlatın` };
  }
  // Port okunamadı → package.json imzasından en olası servisi tahmin et.
  const svc = KNOWN_SERVICES.find((s) => s.deps.test(pkgDepsText));
  if (svc) return { name: svc.name, port: svc.port, hint: svc.hint };
  return null;
}

// Non-node ekosistem "kurulmamış bağımlılık" crash imzaları. MAHKEME (2. tur) uyarısı: yalnız PAKET/BAĞIMLILIK
// sistemine ÖZGÜ, kesin imzalar tutuldu (genel "dosya/modül bulunamadı" olanlar YEREL-yol typo'sundan ayırt
// edilemez → yanlış-pozitif). Çıkarılanlar: Ruby `cannot load such file --`, PHP `Failed opening required`,
// Rust `use of undeclared crate` (hepsi yerel-modül typo'suyla aynı metni verir). Tutulanlar paket-sistemine gömülü.
const OTHER_STACK_MISSING_DEPS_RE =
  /ERR_MODULE_NOT_FOUND|ModuleNotFoundError|No module named|Cannot find package\s+['"]|could not determine executable to run|vendor\/autoload|Couldn't resolve the package\s+['"]|no required module provides package/i;

/** Bir bare specifier'ın KÖK paket adı (@scope/name → @scope/name; express/lib/x → express; routes/db → routes). */
function rootPackageName(spec: string): string {
  const segs = spec.split("/");
  return spec.startsWith("@") ? segs.slice(0, 2).join("/") : segs[0];
}

/** package.json ham metninde bir paket dependencies/devDependencies/peer/optional altında BİLDİRİLMİŞ mi? */
function isDeclaredDep(pkg: string, pkgDepsText: string): boolean {
  if (!pkgDepsText) return false;
  try {
    const j = JSON.parse(pkgDepsText) as Record<string, Record<string, string> | undefined>;
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      if (j[key] && Object.prototype.hasOwnProperty.call(j[key], pkg)) return true;
    }
  } catch {
    /* parse edilemedi → bildirilmemiş say */
  }
  return false;
}

/**
 * Crash çıktısı KURULMAMIŞ bağımlılık (paket) hatası mı? SAF (testli). Stack-bağımsız imzalar.
 * Node CJS ("Cannot find module 'X'"): X BARE paket olmalı (./ veya / ile başlayan YEREL yol typo'su install ile
 * çözülmez) VE (mahkeme yanlış-pozitif fix) X package.json'da BİLDİRİLMİŞ olmalı — `require('routes/db')` gibi `./`
 * unutulmuş yerel yol bare görünür ama deps değildir → install çözmez. pkgDepsText YOKSA (okunamadı) bare→true (cave
 * gibi node_modules hiç yok senaryosu için güvenli taraf). ESM/Python/Ruby/PHP/Dart/Go/Rust imzaları zaten specifik.
 */
export function detectMissingDeps(crashOutput: string, pkgDepsText = ""): boolean {
  if (!crashOutput) return false;
  const m = /Cannot find module\s+['"]([^'"]+)['"]/i.exec(crashOutput);
  if (m) {
    const spec = m[1];
    if (!spec.startsWith(".") && !spec.startsWith("/")) {
      const root = rootPackageName(spec);
      if (isDeclaredDep(root, pkgDepsText)) return true; // bildirilmiş paket + kurulu değil → kur
      if (!pkgDepsText) return true; // package.json okunamadı → bare paketi kurulmamış say (güvenli taraf)
      // pkgDepsText var ama root bildirilmemiş → yerel-yol typo'su / undeclared → install çözmez (FP önle)
    }
  }
  return OTHER_STACK_MISSING_DEPS_RE.test(crashOutput);
}

/**
 * PROAKTİF deps kontrolü (KATI #6): node projesi çalıştırılmadan ÖNCE bağımlılıkları kurulu mu? package.json runtime
 * `dependencies` bildiriyorsa `node_modules`'te HEPSİ var mı? Yoksa (node_modules hiç yok / kısmi — cave: yalnız
 * fsevents kurulu, express yok) → true (kur). Yalnız `dependencies` kontrol edilir: optional/peer prod-install veya
 * platform-özel (fsevents Linux'ta yok) paketler yanlış "eksik" tetiklemesin. package.json yoksa/parse edilemezse
 * false (node değil / kurulacak şey yok → reaktif yol devrede). fs yan etkili (SAF değil).
 */
export async function nodeDepsUninstalled(projectRoot: string, pkgDepsText: string): Promise<boolean> {
  if (!pkgDepsText) return false;
  let deps: string[];
  try {
    const j = JSON.parse(pkgDepsText) as { dependencies?: Record<string, string> };
    deps = Object.keys(j.dependencies ?? {});
  } catch {
    return false;
  }
  if (deps.length === 0) return false;
  const nm = join(projectRoot, "node_modules");
  const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true).catch(() => false);
  if (!(await exists(nm))) return true; // node_modules hiç yok → kesin eksik
  for (const d of deps) {
    if (!(await exists(join(nm, ...d.split("/"))))) return true; // bildirilen bir runtime paket eksik → kısmi kurulum
  }
  return false;
}

export interface InstallResult {
  /** Kurulum DENENDİ mi (installCmd boş değildi). */
  attempted: boolean;
  /** Başarılı mı (kurulum komutu exit 0). */
  ok: boolean;
  /** Kullanıcıya görünür mesaj (boşsa emit edilmez). */
  message: string;
}

/** Kurulum çok uzun sürebilir (büyük dep ağacı, native derleme, puppeteer→Chromium indirmesi) — üst sınır
 *  (asılma önleme). phase-5'in kendi install adımıyla TUTARLI (600s); 300s ağır projede yetmeyip erken kesiyordu. */
const INSTALL_TIMEOUT_MS = 600_000;

/**
 * Eksik bağımlılıkları stack'in kurulum komutuyla (installCmd — çağıran profile'dan stack-bağımsız çözer) KUR.
 * Fail-soft: komut yok/hata/timeout → {ok:false} + görünür mesaj (sessiz fallback YOK). installCmd profilden gelir
 * (kullanıcı girdisi değil), basit "npm install"/"pip install -r requirements.txt" biçimi → boşlukla ayır (shell yok).
 */
export async function tryInstallDeps(projectRoot: string, installCmd: string): Promise<InstallResult> {
  const parts = installCmd.trim().split(/\s+/).filter(Boolean);
  const bin = parts[0];
  if (!bin) return { attempted: false, ok: false, message: "" };
  const args = parts.slice(1);
  const r = await new Promise<{ code: number; out: string }>((resolve) => {
    let out = "";
    let settled = false;
    const done = (v: { code: number; out: string }): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    // safeEnv (mahkeme CRITICAL): foreign projede `npm install` üçüncü-taraf postinstall = keyfi kod → orkestratörün
    // TAM env'ini (API anahtarları) child'a SIZDIRMA. Kardeş kod da böyle: phase-5 install + dev-server-launcher.
    const child = spawn(bin, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...safeEnv(), LC_ALL: "C" },
    });
    const CAP = 16 * 1024; // out üst-sınır (mahkeme feedback_resource_careful): gevşek-loglayan kurulum belleği şişirmesin.
    const append = (d: Buffer): void => {
      out = (out + d.toString()).slice(-CAP);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* zaten öldü */
      }
      done({ code: -2, out: `${out}\n[MyCL: ${installCmd} ${INSTALL_TIMEOUT_MS / 1000}s'i aştı — kesildi]` });
    }, INSTALL_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: -1, out: `${out}\n${String(e)}` }); // binary yok (PATH) → fail-soft
    });
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, out });
    });
  });
  return {
    attempted: true,
    ok: r.code === 0,
    message:
      r.code === 0
        ? `📦 Eksik bağımlılıkları \`${installCmd}\` ile kurdum. Dev server'ı yeniden deniyorum.`
        : `⚠️ \`${installCmd}\` başarısız oldu (${r.out.slice(-200).trim()}). Bağımlılıklar kurulamadı — elle \`${installCmd}\` çalıştırıp tekrar deneyin.`,
  };
}

/** Port'a TCP connect ederek servisin kalktığını doğrula (timeoutMs içinde, ~1sn aralıkla dener). */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const tryOnce = (): Promise<boolean> =>
    new Promise((resolve) => {
      const sock = new Socket();
      const fin = (up: boolean): void => {
        sock.destroy();
        resolve(up);
      };
      sock.setTimeout(1000);
      sock.once("connect", () => fin(true));
      sock.once("timeout", () => fin(false));
      sock.once("error", () => fin(false));
      sock.connect(port, "127.0.0.1");
    });
  while (Date.now() < deadline) {
    if (await tryOnce()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Projede bir docker-compose dosyası var mı → yolunu döner (yoksa null). */
export async function findComposeFile(projectRoot: string): Promise<string | null> {
  for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    try {
      await fs.access(join(projectRoot, f));
      return f;
    } catch {
      /* yok */
    }
  }
  return null;
}

/** `docker compose up -d` (veya `docker-compose up -d`) çalıştır. Fail-soft: docker yok/hata → {ok:false}.
 *  Timeout'lu (image pull uzayabilir ama üst-sınır — asılma önleme, mahkeme). v2 "compose not a command" → v1'e düş. */
const COMPOSE_TIMEOUT_MS = 180_000;
async function runComposeUp(projectRoot: string): Promise<{ ok: boolean; detail: string }> {
  for (const [cmd, args] of [
    ["docker", ["compose", "up", "-d"]],
    ["docker-compose", ["up", "-d"]],
  ] as const) {
    const r = await new Promise<{ code: number; out: string } | null>((resolve) => {
      let out = "";
      let settled = false;
      const done = (v: { code: number; out: string } | null): void => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const child = spawn(cmd, args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* zaten öldü */
        }
        done({ code: -2, out: `${out}\n[MyCL: docker compose ${COMPOSE_TIMEOUT_MS / 1000}s'i aştı — kesildi]` });
      }, COMPOSE_TIMEOUT_MS);
      child.on("error", () => {
        clearTimeout(timer);
        done(null); // binary yok → sonraki varyant
      });
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code: code ?? -1, out });
      });
    });
    if (r === null) continue; // bu docker varyantı yok → diğerini dene
    // v2 `docker compose` alt-komutu desteklenmiyorsa (eski docker CLI) → v1 `docker-compose`'a düş.
    if (r.code !== 0 && /not a docker command|unknown command|is not a docker/i.test(r.out)) continue;
    return { ok: r.code === 0, detail: r.out.slice(-500) };
  }
  return { ok: false, detail: "docker / docker-compose kurulu değil veya compose desteklenmiyor" };
}

export interface ProvisionResult {
  /** Servis başlatma DENENDİ mi (compose vardı + docker vardı). */
  attempted: boolean;
  /** Başarılı mı (compose up 0 döndü). */
  ok: boolean;
  /** Kullanıcıya görünür mesaj (her durumda dolu). */
  message: string;
}

/**
 * Eksik servisi TAMAMLAMAYA çalış: proje docker-compose bildirmişse `docker compose up -d`. Değilse spesifik rehber.
 * Güvenli: yalnız projenin KENDİ compose'unu başlatır (yeni infra uydurmaz). Fail-soft (docker yok → rehber).
 */
export async function tryProvisionService(projectRoot: string, svc: ServiceDep): Promise<ProvisionResult> {
  const compose = await findComposeFile(projectRoot);
  if (!compose) {
    return {
      attempted: false,
      ok: false,
      message: `⚠️ Uygulama **${svc.name}**'e bağlanamadı (çalışmıyor). Projede docker-compose yok → otomatik başlatamadım. ${svc.hint}. Servisi başlatınca devam edeceğim.`,
    };
  }
  const r = await runComposeUp(projectRoot);
  if (!r.ok) {
    return {
      attempted: true,
      ok: false,
      message: `⚠️ **${svc.name}** için \`${compose}\` başlatılamadı (${r.detail.slice(-150)}). ${svc.hint}. Servisi başlatınca devam edeceğim.`,
    };
  }
  // compose 0 döndü — ama servis GERÇEKTEN kalktı mı DOĞRULA (mahkeme: exit=0 ≠ tespit edilen servis up;
  // compose başka servis içeriyor olabilir + DB init birkaç sn sürer). Port'a ~30s connect dene.
  const up = await waitForPort(svc.port, 30_000);
  return {
    attempted: true,
    ok: up,
    message: up
      ? `🔧 Uygulama **${svc.name}**'e bağlanamamıştı → projenin \`${compose}\`'unu \`docker compose up -d\` ile başlattım; ${svc.name} (port ${svc.port}) artık ayakta. Dev server'ı yeniden deniyorum.`
      : `⚠️ \`${compose}\` başlatıldı ama **${svc.name}** (port ${svc.port}) 30s içinde yanıt vermedi — compose bu servisi içermiyor olabilir veya init uzun sürüyor. ${svc.hint}.`,
  };
}
