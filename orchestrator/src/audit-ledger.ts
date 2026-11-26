// audit-ledger — denetim defterinin SÜREÇ İÇİ (bellekteki) tanığı.
//
// KÖK NEDEN (harness kaçış denetimi, 2026-11-26): disk çapası (audit-anchor.ts) iterasyon BAŞINDA
// alınıyor ve yalnız o ana kadarki öneki kapsıyor. Hüküm ise `eventsSince(iteration_started_at)` ile
// yalnız BU iterasyonun satırlarından hesaplanıyor — yani hükmün üretildiği satırlar çapanın
// kapsamadığı kuyrukta duruyor. Bu iterasyonda yazılmış bir `-fail` satırını `-complete` yapmak ya da
// sahte bir kanıt satırı eklemek çapayı hiç bozmuyordu.
//
// İkinci neden: çapa dosyası `~/.mycl` altında ve ajanın KUM HAVUZU onu kapatıyor, ama MyCL'in
// kendisinin koşturduğu proje komutları (test/lint/build/dev sunucu — ajanın yazdığı kod) ve API arka
// ucundaki Bash işletim sistemi hapsinde DEĞİL; aynı kullanıcı olarak hem deftere hem çapaya
// yazabilirler.
//
// ÇÖZÜM: tanık diskte değil, orkestratör sürecinin BELLEĞİNDE durur. Bu süreç deftere yazdığı her
// satırın özetini tutar; hüküm öncesinde dosya bu tanıkla karşılaştırılır. Proje içinde ya da ev
// dizininde hiçbir dosya değiştirilerek tanık kandırılamaz — çalışan sürecin belleğine yazmak gerekir.
// İşletim sistemi hapsine, platforma ya da arka uca bağlı değildir (macOS + Linux aynı; KATI #7).
//
// NEDEN SIRASIZ KARŞILAŞTIRMA: audit-anchor.ts'in belirttiği gibi `appendAudit` üç yerde beklemesiz
// çağrılıyor; iki satırın diske düşme sırası çağrı sırasından farklı olabilir. Bu yüzden zincir değil
// ÇOKLU KÜME karşılaştırılır: bu sürecin yazdığı her satır dosyada tam olarak bir kez bulunmalı ve
// dosyada bu sürecin yazmadığı satır olmamalı.
//
// KAPSAM / DÜRÜST SINIR:
//  - Tanık süreçle birlikte doğar. MyCL yeniden başlatılırsa o andan öncesi için yalnız disk çapası
//    konuşur (ikisi birbirinin yerine değil, üst üste çalışır).
//  - Taban, bu sürecin o dosyaya İLK yazımında ölçülür; proje açılışı ile ilk yazım arasındaki
//    değişiklik tabana girer (o aralık için yine disk çapası konuşur).
//  - Aynı kullanıcıyla koşan kod çalışan sürecin belleğine erişebilirse (hata ayıklayıcı) tanık da
//    aşılır; bu, dosya değiştirmekten çok daha yüksek bir çıtadır ama sıfır değildir.
//  - Tanık pipeline SONUNDA sorulur; faz içi ara kontroller defteri doğrulamadan okur.
//  - Aynı proje aynı anda İKİ MyCL sürecinde açılırsa diğer sürecin satırları "yabancı" görünür.
//    Bunu sahte satırdan ayırt etmek mümkün değil (ayırt edilebilseydi sahtesi de o kılığa girerdi);
//    mesajda bu olasılık açıkça söylenir.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

/**
 * strict    → önek değişmemiş + kuyruk TAM OLARAK bu sürecin yazdıkları (audit.log).
 * additions → yalnız EKLENEN yabancı satır yakalanır; silme serbest (accepted-findings.jsonl:
 *             kullanıcının bir satırı silerek bulguyu yeniden etkinleştirmesi belgelenmiş meşru akış).
 */
export type LedgerMode = "strict" | "additions";

export type LedgerVerdict =
  | { status: "ok"; lines: number }
  | { status: "no-ledger" }
  /** Yazımlar hiç durmadı → kararlı bir an yakalanamadı. KURCALAMA DEĞİL; çağıran görünür kaydeder. */
  | { status: "busy" }
  | { status: "tampered"; reason: string };

interface Ledger {
  mode: LedgerMode;
  /** strict: bu sürecin ilk yazımından ÖNCEKİ dosya uzunluğu. */
  baseBytes: number;
  /** strict: ilk `baseBytes` baytın özeti (baseBytes 0 ise null). */
  baseSha: string | null;
  /** additions: başlangıçta dosyada bulunan satırların özetleri. */
  baseLines: Set<string>;
  /** Bu sürecin yazdığı satırlar: özet → adet. */
  written: Map<string, number>;
  /**
   * Yazımı HATA ile biten satırlar: diskte olabilir de olmayabilir de (ör. `write` başarılı, `fsync`
   * hatalı). Dosyada bulunurlarsa "yabancı" sayılmaz, bulunmazlarsa "eksik" sayılmaz — geçici bir
   * disk hatası "kurcalama" diye raporlanmasın (mahkeme Y2).
   */
  maybe: Map<string, number>;
  /** Her yazım başında ve sonunda artar — doğrulama okuma sırasında yazım oldu mu buradan anlar. */
  gen: number;
  /** Diske düşmesi beklenen yazımlar — doğrulama bunlar bitmeden okumaz. */
  pending: Set<Promise<void>>;
}

const ledgers = new Map<string, Promise<Ledger>>();

function sha(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function readOrEmpty(path: string): Promise<Buffer> {
  try {
    return await fs.readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw err;
  }
}

/** Dosya içeriğini satırlara böler; son satır "\n" ile bitmiyorsa o parça da bir satır sayılır. */
function splitLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function initLedger(path: string, mode: LedgerMode): Promise<Ledger> {
  let p = ledgers.get(path);
  if (!p) {
    // Tek paylaşılan söz: eşzamanlı ilk yazımların hepsi AYNI taban ölçümünü bekler; taban bu
    // sürecin hiçbir yazımı diske düşmeden önce alınmış olur.
    p = (async (): Promise<Ledger> => {
      const buf = await readOrEmpty(path);
      return {
        mode,
        baseBytes: buf.length,
        baseSha: buf.length > 0 ? sha(buf) : null,
        baseLines: new Set(mode === "additions" ? splitLines(buf.toString("utf-8")).map((l) => sha(l.trim())) : []),
        written: new Map(),
        maybe: new Map(),
        gen: 0,
        pending: new Set(),
      };
    })();
    ledgers.set(path, p);
    // Taban okunamadıysa kaydı bırakma: sonraki yazım yeniden denesin (kalıcı zehirli söz olmasın).
    p.catch(() => {
      if (ledgers.get(path) === p) ledgers.delete(path);
    });
  }
  return p;
}

/**
 * Bir satırı tanıklı olarak ekler. `line` sondaki "\n" DAHİL diske yazılacak metnin tamamıdır;
 * `write` gerçek yazımı yapar. Yazım başarısız olursa satır tanıktan geri alınır ve hata aynen
 * fırlatılır (çağıranın hata davranışı değişmez).
 */
export async function ledgerAppend(
  path: string,
  line: string,
  mode: LedgerMode,
  write: () => Promise<void>,
): Promise<void> {
  const led = await initLedger(path, mode);
  const body = line.endsWith("\n") ? line.slice(0, -1) : line;
  const key = sha(mode === "additions" ? body.trim() : body);
  led.written.set(key, (led.written.get(key) ?? 0) + 1);
  led.gen++;
  const op = write();
  // Doğrulama `pending`i beklerken reddedilen söz işlenmemiş ret üretmesin diye sessiz kopya tutulur;
  // asıl hata aşağıdaki `await op` ile çağırana gider.
  const settled = op.then(
    () => undefined,
    () => undefined,
  );
  led.pending.add(settled);
  try {
    await op;
  } catch (err) {
    // Hata hangi adımda oldu bilinmiyor (open / write / fsync / close) → satır diske düşmüş OLABİLİR.
    // "Kesin yazıldı"dan çıkar, "belki yazıldı"ya al: iki yönde de yanlış alarm üretmez.
    const n = (led.written.get(key) ?? 1) - 1;
    if (n <= 0) led.written.delete(key);
    else led.written.set(key, n);
    led.maybe.set(key, (led.maybe.get(key) ?? 0) + 1);
    throw err;
  } finally {
    led.gen++;
    led.pending.delete(settled);
  }
}

/**
 * Dosyayı bellekteki tanıkla karşılaştırır. `no-ledger` KURCALAMA DEĞİLDİR: bu süreç o dosyaya
 * hiç yazmamıştır (karşılaştıracak tanık yok) — çağıran eski davranışla sürer (KATI #14).
 */
export async function verifyLedger(path: string): Promise<LedgerVerdict> {
  const p = ledgers.get(path);
  if (!p) return { status: "no-ledger" };
  let led: Ledger;
  try {
    led = await p;
  } catch {
    return { status: "no-ledger" };
  }
  // KARARLI AN (mahkeme Y1): tanığın anlık görüntüsü dosya okunmadan ÖNCE alınır; okuma sırasında
  // yeni bir yazım başladıysa/bittiyse (gen değişti) ya da hâlâ uçuşta yazım varsa sonuç ATILIR ve
  // yeniden denenir. Aksi halde okuma ile karşılaştırma arasına giren `void appendAudit` (çalışan dev
  // sunucunun hata izleyicisi keyfi anda yazar) "eksik satır" diye sahte kurcalama üretirdi.
  for (let attempt = 0; attempt < STABLE_ATTEMPTS; attempt++) {
    while (led.pending.size > 0) {
      await Promise.all([...led.pending]);
    }
    const gen = led.gen;
    const written = new Map(led.written);
    const maybe = new Map(led.maybe);
    let buf: Buffer;
    try {
      buf = await readOrEmpty(path);
    } catch (err) {
      return { status: "tampered", reason: `kayıt okunamadı (${String(err).slice(0, 120)})` };
    }
    if (led.gen !== gen || led.pending.size > 0) {
      await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
      continue;
    }
    return compare(led, buf, written, maybe);
  }
  return { status: "busy" };
}

/** Kararlı an için en fazla deneme (aralar 5·n ms; toplam ~1 sn). */
const STABLE_ATTEMPTS = 20;

function take(m: Map<string, number>, k: string): boolean {
  const n = m.get(k);
  if (n === undefined) return false;
  if (n <= 1) m.delete(k);
  else m.set(k, n - 1);
  return true;
}

const HINT = "(aynı proje ikinci bir MyCL penceresinde açık değilse ya da kayıt elle düzenlenmediyse bu bir kurcalamadır)";

/** SAF: dosya içeriği ↔ tanık anlık görüntüsü. `written`/`maybe` kopyadır, tüketilir. */
function compare(
  led: Ledger,
  buf: Buffer,
  written: Map<string, number>,
  maybe: Map<string, number>,
): LedgerVerdict {
  if (led.mode === "additions") {
    let foreign = 0;
    let lines = 0;
    for (const raw of splitLines(buf.toString("utf-8"))) {
      // Satır sonu / kenar boşluğu farkı (CRLF kaydeden editör) içerik değişikliği DEĞİLDİR.
      const l = raw.trim();
      if (!l) continue;
      lines++;
      const k = sha(l);
      if (!led.baseLines.has(k) && !written.has(k) && !maybe.has(k)) foreign++;
    }
    return foreign > 0
      ? { status: "tampered", reason: `MyCL'in yazmadığı ${foreign} satır eklenmiş ${HINT}` }
      : { status: "ok", lines };
  }

  if (buf.length < led.baseBytes) {
    return { status: "tampered", reason: "kayıt bu oturumun başındakinden KISA — geçmiş satırlar silinmiş" };
  }
  if (led.baseSha !== null && sha(buf.subarray(0, led.baseBytes)) !== led.baseSha) {
    return { status: "tampered", reason: "oturum başından önceki kayıtlar değiştirilmiş" };
  }
  let foreign = 0;
  let lines = 0;
  for (const l of splitLines(buf.subarray(led.baseBytes).toString("utf-8"))) {
    lines++;
    const k = sha(l);
    if (!take(written, k) && !take(maybe, k)) foreign++;
  }
  let missing = 0;
  for (const n of written.values()) missing += n;
  if (missing > 0 || foreign > 0) {
    const parts: string[] = [];
    if (missing > 0) parts.push(`MyCL'in yazdığı ${missing} satır yok ya da değiştirilmiş`);
    if (foreign > 0) parts.push(`MyCL'in yazmadığı ${foreign} satır var`);
    return { status: "tampered", reason: `${parts.join("; ")} ${HINT}` };
  }
  return { status: "ok", lines };
}

/** Yalnız testler: süreç içi tanıkları sıfırlar. */
export function resetAuditLedgersForTest(): void {
  ledgers.clear();
}
