// gate-overlay/enforce — tool_deny gate'lerinin CLI yoluna bağlanması (kanca enjeksiyonu + kanarya).
//
// NEDEN KANARYA (TUZAK 1): Claude Code, `--settings` içindeki bloğu ŞEMA hatasında SESSİZCE yok
// sayıyor (exit 0, uyarı yok — ampirik 2.1.227). Yani "kancayı gönderdim" ile "kanca çalıştı" aynı
// şey değil. SessionStart kancası bir işaret dosyası yazar; işaret yoksa o koşu KAPISIZ koşmuştur ve
// sessizce kabul edilemez (KATI #4). Kanarya YALNIZ kanca gerçekten enjekte edildiğinde denetlenir —
// kancasız koşuda işaret aramak yanlış alarm üretirdi.
//
// NEDEN İŞARET DOSYASI SPAWN BAŞINA BENZERSİZ: paralel modül codegen'i aynı projede aynı anda
// birden çok claude başlatır. Ortak tek bir işaret dosyası olsaydı bir sürecin işareti diğerinin
// kanaryasını yeşile boyardı. Ad `<zaman>-<sayaç>-<pid>` ile üretilir (rastgelelik YOK — AD-5).

import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAudit } from "../audit.js";
import { emitChatMessage } from "../ipc.js";
import { log } from "../logger.js";
import type { PhaseId } from "../types.js";
import { getActiveOverlay } from "./compile.js";
import { buildGuardRules, encodeGuardRules } from "./decide.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Muhafız betiğinin MUTLAK yolu. phase-registry `securityToolPath` deseni: __dirname =
 * orchestrator/dist/gate-overlay (runtime) ya da orchestrator/src/gate-overlay (vitest);
 * iki üst = orchestrator kökü. `orchestrator/*.mjs` tauri resources listesinde paketli.
 */
export function overlayGuardPath(): string {
  return resolve(__dirname, "..", "..", "overlay-guard.mjs");
}

/** Bir spawn'a enjekte edilecek overlay kancası + o spawn'a ait kanarya işareti. */
export interface OverlayInjection {
  guardPath: string;
  /** Muhafıza argv ile geçen DONUK kural kümesi (base64 JSON). */
  rulesB64: string;
  /** SessionStart kancasının yazacağı işaret dosyası (bu spawn'a özel). */
  ackPath: string;
  projectRoot: string;
  /** Kanarya başarısızlığının denetim kaydına yazılacağı faz. */
  phase: PhaseId;
}

/** İşaret dosyalarının durduğu dizin. */
export function overlayAckDir(projectRoot: string): string {
  return join(projectRoot, ".mycl", "overlays", "ack");
}

/** Süreç içi sayaç — aynı milisaniyede iki spawn olsa da adlar çakışmaz (Math.random YOK). */
let _ackCounter = 0;

/** Bu yaştan eski işaret dosyaları süpürülür (sahibi süreç çoktan bitmiştir). */
const ACK_STALE_MS = 6 * 60 * 60_000;

/**
 * Eski işaret dosyalarını temizler. Kendi spawn'ımızın dosyası benzersiz olduğu için bayat bir
 * işaret kanaryayı zaten kandıramaz; bu temizlik yalnız dizinin sonsuza kadar şişmesini önler.
 * Fail-soft: temizlenemezse koşu etkilenmez (kanarya kararı bu dosyalara bakmaz).
 */
async function pruneOldAcks(dir: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return; // dizin henüz yok — temizlenecek bir şey de yok
  }
  for (const name of names) {
    const p = join(dir, name);
    try {
      const st = await fs.stat(p);
      if (now - st.mtimeMs > ACK_STALE_MS) await fs.rm(p, { force: true });
    } catch {
      // yarışta silinmiş/okunamıyor — önemsiz
    }
  }
}

/**
 * İmpure: bu spawn için overlay enjeksiyonu üretir. Aktif overlay'de tool_deny ailesinden
 * seçim yoksa `null` — kanca da kanarya da eklenmez, üretilen argv bugünküyle BİREBİR aynı kalır.
 */
export async function overlaySettingsFor(params: {
  projectRoot: string;
  phase: PhaseId;
}): Promise<OverlayInjection | null> {
  const rules = buildGuardRules(getActiveOverlay(), params.projectRoot);
  if (!rules) return null;

  const guardPath = overlayGuardPath();
  const dir = overlayAckDir(params.projectRoot);
  const now = Date.now();
  try {
    await fs.mkdir(dir, { recursive: true });
    await pruneOldAcks(dir, now);
  } catch (err) {
    // Dizin açılamadıysa kanarya işareti de yazılamayacak → kanarya kontrolü bunu YAKALAR
    // (görünür başarısızlık). Burada sessizce vazgeçmek gate'i düşürmek olurdu.
    log.warn("gate-overlay", "kanarya dizini hazirlanamadi", err);
  }
  _ackCounter += 1;
  return {
    guardPath,
    rulesB64: encodeGuardRules(rules),
    ackPath: join(dir, `${now}-${_ackCounter}-${process.pid}.json`),
    projectRoot: params.projectRoot,
    phase: params.phase,
  };
}

/** agent-sandbox'ın beklediği dar görünüm (ayar üretimi kanarya/faz bilgisini bilmez). */
export function sandboxOverlayArg(
  inj: OverlayInjection | null,
): { guardPath: string; rulesB64: string; ackPath: string } | undefined {
  if (!inj) return undefined;
  return { guardPath: inj.guardPath, rulesB64: inj.rulesB64, ackPath: inj.ackPath };
}

/**
 * KANARYA KONTROLÜ: spawn bitti; SessionStart kancası işaretini bıraktı mı?
 *
 * Bırakmadıysa `--settings` bloğu yutulmuş demektir → bu koşuda hiçbir tool_deny gate'i
 * uygulanmamıştır. Dönüş: hata metni (çağıran KENDİ başarısızlık yoluna koyar) ya da null.
 * Denetim olayı `overlay-canary-fail`: `-fail` soneki BİLİNÇLİ — hüküm makinesi bunu gate
 * başarısızlığı sayar, yani kapısız koşu "tamamlandı" damgası alamaz.
 */
export async function verifyOverlayCanary(inj: OverlayInjection): Promise<string | null> {
  let seen = false;
  try {
    const st = await fs.stat(inj.ackPath);
    seen = st.isFile();
  } catch {
    seen = false;
  }
  if (seen) {
    // İşaret tüketildi — dosyayı bırakma (dizin temiz kalsın). Silinemezse süpürücü halleder.
    await fs.rm(inj.ackPath, { force: true }).catch(() => {});
    return null;
  }

  const reason =
    "iterasyon gate kancalari yuklenmedi (SessionStart isareti yok) — bu kosu KAPISIZ olurdu";
  log.error("gate-overlay", "kanarya BASARISIZ — kancalar yuklenmedi", {
    ackPath: inj.ackPath,
    guardPath: inj.guardPath,
    phase: inj.phase,
  });
  await appendAudit(inj.projectRoot, {
    ts: Date.now(),
    phase: inj.phase,
    event: "overlay-canary-fail",
    caller: "mycl-orchestrator",
    detail: reason,
  }).catch((e) => log.warn("gate-overlay", "kanarya denetim kaydi yazilamadi", e));
  emitChatMessage(
    "system",
    "⛔ İterasyon gate kancaları yüklenmedi — bu adım korumasız koşacaktı; başarısız sayıp durdurdum.",
  );
  return `gate overlay kanaryası başarısız: ${reason}`;
}
