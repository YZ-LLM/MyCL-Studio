// simplify-rules — sadeleştirme (Faz 11) boyutunun STACK BAĞIMSIZ çekirdeği. SAF (IO yok).
//
// KÖK NEDEN (YZLLM, 2026-09-12): adli öz denetim, Faz 11'in cave'in 94 iterasyonunda BİR KEZ bile
// koşmadığını gösterdi. Profillere bakınca sorun daha büyük çıktı: `simplify` komutu 19 stack'in
// yalnız 4'ünde (node ailesi) tanımlı, o dörtte de araç `ts-prune` — yani TypeScript'e bağlı.
// Sonuç: boyut pratikte yalnız "Node + TypeScript" kesişiminde ölçülebiliyordu.
//
// YZLLM kararı: "aracın tek dile bağlı olma ihtimalini ortadan kaldır." Yani boyutu bir dilin
// aracına emanet etmeyi bırakıyoruz; dilden bağımsız ölçen kendi çekirdeğimizi kuruyoruz. Dilin
// kendi aracı varsa o da koşar (profil komutu korunur) — bu çekirdek ONUN YERİNE değil, ALTINA
// konan taban.
//
// YANLIŞ ALARM YASAĞI (kullanıcının en sert kuralı): burada yalnız TARTIŞMASIZ olgular bulgu
// üretir. "Bu N satır birebir aynı" bir olgudur, yorum değil. Buna karşılık "bu dosya ölü" bir
// ÇIKARIMDIR — dinamik yükleme, çerçeve sözleşmeleri ve yapılandırmadan çağrılma bunu çürütebilir;
// o yüzden orphan dosyalar YALNIZ RAPOR eder, kapıyı DÜŞÜRMEZ.
//
// ESKİ KOD CEZALANDIRILMAZ: yasal bir eski projede kopya kod zaten vardır; ilk koşuda kapıyı
// kırmızıya boyamak kalıcı sahte alarm olurdu. Bu yüzden karar TEMEL ÇİZGİYE göre verilir
// (perf-budget.ts'in kanıtlanmış deseni): ilk koşu temel kaydeder ve ASLA düşmez; sonraki koşular
// yalnız BELİRGİN büyümede düşer. Ölçüm her koşuda görünür kalır.

/** Bir kaynak dosya (yol + içerik). */
export interface SourceFile {
  /** Proje köküne göreli yol, "/" ayraçlı. */
  path: string;
  content: string;
}

export interface DuplicateBlock {
  /** Aynı bloğun görüldüğü yerler: `yol:satır` (1 tabanlı), sıralı. */
  places: string[];
  /** Blok satır sayısı. */
  lines: number;
}

export interface SimplifyMeasurement {
  /** Taranan dosya sayısı. 0 → ölçüm YAPILAMADI (çağıran atlama bildirir, "temiz" DEMEZ). */
  filesScanned: number;
  /** Toplam kaynak satırı (boş/yorum sonrası normalize edilmiş). */
  totalLines: number;
  /** Kopya bloklarda geçen toplam satır — büyümesi izlenen ana ölçü. */
  duplicateLines: number;
  /** En büyük kopya blokları (rapor için, sıralı ve sınırlı). */
  duplicates: DuplicateBlock[];
  /** Hiçbir yerden adı geçmeyen kaynak dosyalar — YALNIZ RAPOR (çıkarım, olgu değil). */
  orphanCandidates: string[];
}

export interface SimplifyBaseline {
  duplicateLines: number;
  totalLines: number;
}

export type SimplifyOutcome =
  | { kind: "pass"; note: string }
  | { kind: "fail"; reasons: string[] }
  | { kind: "baseline"; note: string };

/** Kopya sayılması için en küçük blok. Kısa bloklar (import listeleri, tip tanımları) gürültüdür. */
export const MIN_DUPLICATE_LINES = 25;
/** Temele göre bu ORANDAN fazla büyüme kapıyı düşürür (dar dalgalanma cezalandırılmaz). */
export const GROWTH_TOLERANCE = 0.25;
/** Küçük projelerde oransal büyüme aldatıcı olur; mutlak taban da aşılmalı. */
export const GROWTH_MIN_LINES = 50;

/** Karşılaştırma için satır normalizasyonu: boşluk farkı ve satır sonu kopya saymayı bozmasın. */
function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/** Anlamlı satır mı? Boş satırlar ve tek başına ayraçlar blok kimliğini şişirir. */
function isMeaningful(line: string): boolean {
  const t = line.trim();
  if (t.length < 3) return false; // "", "}", "})", ");" …
  return true;
}

/**
 * SAF: birebir aynı (normalize edilmiş) ardışık satır bloklarını bulur — dilden bağımsız.
 *
 * NEDEN token/AST değil: her dil için ayrı ayrıştırıcı yazmak, kaçındığımız "tek dile bağlılığı"
 * geri getirirdi. Satır tabanlı karşılaştırma her dilde aynı anlamı taşır ve bulgusu tartışmasızdır.
 */
export function findDuplicateBlocks(
  files: readonly SourceFile[],
  minLines: number = MIN_DUPLICATE_LINES,
): DuplicateBlock[] {
  // Her dosyanın anlamlı satırları (orijinal satır numarasıyla birlikte).
  const prepared = files.map((f) => {
    const rows: Array<{ n: number; text: string }> = [];
    f.content.split("\n").forEach((raw, i) => {
      if (isMeaningful(raw)) rows.push({ n: i + 1, text: normalizeLine(raw) });
    });
    return { path: f.path, rows };
  });

  // minLines uzunluğundaki her pencerenin imzası → nerelerde başladığı (dosya + satır indeksi).
  const windows = new Map<string, Array<{ fi: number; ri: number }>>();
  for (let fi = 0; fi < prepared.length; fi++) {
    const rows = prepared[fi]!.rows;
    for (let ri = 0; ri + minLines <= rows.length; ri++) {
      const sig = rows.slice(ri, ri + minLines).map((r) => r.text).join("\n");
      const list = windows.get(sig);
      if (list) list.push({ fi, ri });
      else windows.set(sig, [{ fi, ri }]);
    }
  }

  // Kayan pencereler tek bloğun parçalarıdır: 30 satırlık bir kopya, minLines=25 iken 6 ayrı pencere
  // üretir. Hepsini ayrı bulgu diye raporlamak kullanıcıya 6 sorun varmış gibi görünür (gürültü,
  // yanlış alarma komşu). Bu yüzden ardışık pencereler TEK bloğa katlanır.
  // Bir konum kümesinin kimliği: `dosya:satırIndeksi` çiftlerinin sıralı birleşimi.
  const keyOf = (places: ReadonlyArray<{ fi: number; ri: number }>, shift: number): string =>
    places.map((p) => `${p.fi}:${p.ri + shift}`).sort().join(",");

  const dupKeys = new Set<string>();
  for (const places of windows.values()) {
    if (places.length >= 2) dupKeys.add(keyOf(places, 0));
  }

  const out: DuplicateBlock[] = [];
  for (const places of windows.values()) {
    if (places.length < 2) continue;
    // Bir önceki satırdan da aynı küme kopyaysa bu pencere bir bloğun ORTASI — kendi başına raporlanmaz.
    if (dupKeys.has(keyOf(places, -1))) continue;
    let extra = 0;
    while (dupKeys.has(keyOf(places, extra + 1))) extra++;
    out.push({
      places: places.map((p) => `${prepared[p.fi]!.path}:${prepared[p.fi]!.rows[p.ri]!.n}`).sort(),
      lines: minLines + extra,
    });
  }
  // Kararlı sıra: çok tekrarlanan önce, sonra alfabetik (aynı girdi → aynı rapor).
  out.sort((a, b) => b.places.length - a.places.length || a.places[0]!.localeCompare(b.places[0]!));
  return out;
}

/**
 * SAF: kopya bloklarda geçen benzersiz satır sayısı. Örtüşen pencereler aynı satırı iki kez
 * saymamalı — yoksa ölçü şişer ve temelle karşılaştırma anlamını yitirir.
 */
export function countDuplicateLines(blocks: readonly DuplicateBlock[]): number {
  const covered = new Set<string>();
  for (const b of blocks) {
    for (const place of b.places) {
      const idx = place.lastIndexOf(":");
      const path = place.slice(0, idx);
      const start = Number(place.slice(idx + 1));
      for (let i = 0; i < b.lines; i++) covered.add(`${path}:${start + i}`);
    }
  }
  return covered.size;
}

/**
 * Giriş noktası adları: bunları hiçbir dosya İSİMLE çağırmaz — çalıştırıcı doğrudan başlatır.
 * Listelenirlerse rapor her koşuda uygulamanın giriş dosyasını "referanssız" gösterir; kullanıcı
 * raporu bir süre sonra tamamen okumaz olur. Adlar dile özel değil, her ekosistemde aynı anlamda.
 */
const ENTRY_STEMS = new Set([
  "index", "main", "app", "server", "cli", "start", "bootstrap", "entry",
  "__init__", "__main__", "mod", "program", "setup", "conftest",
]);

/**
 * SAF: hiçbir dosyada adı geçmeyen kaynak dosyalar. YALNIZ RAPOR — kapıyı düşürmez.
 *
 * Neden bloklamaz: dinamik yükleme (dizin tarayan router), çerçeve sözleşmesi (dosya yolu = rota)
 * ve yapılandırmadan çağrılma bu çıkarımı çürütür. "Ölü olabilir" demek yararlı, "ölü" demek yanlış.
 */
export function findOrphanCandidates(files: readonly SourceFile[]): string[] {
  const all = files.map((f) => f.content).join("\n");
  const out: string[] = [];
  for (const f of files) {
    const base = f.path.split("/").pop() ?? f.path;
    const stem = base.replace(/\.[^.]+$/, "");
    if (stem.length < 3) continue; // çok kısa ad → rastgele eşleşme riski
    if (ENTRY_STEMS.has(stem.toLowerCase())) continue; // giriş noktası — çağıranı kod değil, çalıştırıcı
    // Kendi içeriğini çıkar: dosyanın kendi içinde adının geçmesi referans değildir.
    const others = all.replace(f.content, "");
    if (!others.includes(stem)) out.push(f.path);
  }
  return out.sort();
}

/**
 * SAF: ölçüm + temel → hüküm. İlk koşu ASLA düşmez (temel kaydedilir); sonraki koşular yalnız
 * BELİRGİN büyümede düşer (hem oransal hem mutlak eşik aşılmalı).
 */
export function decideSimplify(
  m: SimplifyMeasurement,
  baseline: SimplifyBaseline | undefined,
): SimplifyOutcome {
  if (m.filesScanned === 0) {
    // Çağıran bu duruma düşmemeli (ölçülemedi → atlama yolu); yine de sessizce "geçti" DEME.
    return { kind: "fail", reasons: ["taranacak kaynak dosya bulunamadı — bu boyut ÖLÇÜLEMEDİ"] };
  }
  const özet =
    `${m.filesScanned} dosya, ${m.duplicateLines} kopya satır` +
    (m.orphanCandidates.length > 0 ? `, ${m.orphanCandidates.length} referanssız dosya (bilgi)` : "");

  if (!baseline) {
    return { kind: "baseline", note: `${özet} — ilk ölçüm, temel olarak kaydedildi` };
  }
  const growth = m.duplicateLines - baseline.duplicateLines;
  const limit = Math.max(
    GROWTH_MIN_LINES,
    Math.ceil(baseline.duplicateLines * GROWTH_TOLERANCE),
  );
  if (growth > limit) {
    return {
      kind: "fail",
      reasons: [
        `kopya kod ${growth} satır arttı (temel ${baseline.duplicateLines} → ${m.duplicateLines}; ` +
          `tolerans ${limit}) — bu iterasyon kopyala yapıştır ile büyüdü`,
      ],
    };
  }
  return { kind: "pass", note: özet };
}

/** SAF: bir sonraki temel. Azalma HEMEN temele işlenir (iyileşme kalıcı olsun, geri kaymasın). */
export function nextSimplifyBaseline(
  m: SimplifyMeasurement,
  baseline: SimplifyBaseline | undefined,
): SimplifyBaseline {
  if (!baseline) return { duplicateLines: m.duplicateLines, totalLines: m.totalLines };
  return {
    duplicateLines: Math.min(baseline.duplicateLines, m.duplicateLines),
    totalLines: m.totalLines,
  };
}
