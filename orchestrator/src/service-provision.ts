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
