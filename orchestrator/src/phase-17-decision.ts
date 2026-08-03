// phase-17-decision — Faz 17 (sızma testi) koşsun mu, koşmayacaksa NEDEN? SAF karar.
//
// KÖK NEDEN (kanıt: index.ts eski runPhase17Pentest + emitVerificationSummary, cave koşusu):
// Faz 17 pentest 2026-06-22'de makine yükü nedeniyle pipeline'dan çıkarılmıştı; geriye yalnız bir bilgi
// mesajı basıp KOŞULSUZ `phase-17-complete` yazan bir kabuk kaldı. Doğrulama özeti "atlama olayı yok +
// tamamlandı olayı var → geçti" mantığıyla çalıştığı için, HİÇBİR tarama yapılmadığı hâlde ekranda
// "✅ Doğrulandı: … Sızma testi" görünüyordu. HTTP sunan her projede sahte yeşil.
//
// YZLLM kararı (2026-08-03, ürün amacı "hiçbir katmanda güvenlik açığı olmasın"): sızma testi OTOMATİK
// koşsun ama HIZLI profille (faz sonunda geliştirme sunucusu zaten ayakta; yalnız yüksek/kritik şablonlar).
// Tam kapsamlı tarama 🛡️ butonunda kalır. Koşamadığı durumda ARTIK "geçti" demez — görünür atlama yazar.

/** Kararın girdisi — hepsi çağıranda ölçülür, burada I/O yok. */
export interface Phase17Input {
  platform: NodeJS.Platform;
  /** Çalışan yerel sunucu bulundu mu (tarama hedefi). */
  devServerAlive: boolean;
  /** nuclei kurulu mu (kurulum denemesinden SONRA ölçülür). */
  nucleiInstalled: boolean;
  /** katana kurulu mu — yoksa yalnız kök sayfa taranır (kapsam dürüstçe bildirilir). */
  katanaInstalled: boolean;
  /** Kaynak son taramadan beri değişmedi mi (docs-stamp/kaynak özeti). Bilinmiyorsa false. */
  sourceUnchanged?: boolean;
}

/**
 * Atlama sınıfı — doğrulama özetinin ve otomatik iş açmanın davranışını belirler:
 *  - not_applicable: gerçekten uygulanamaz/gereksiz → nötr (sarı uyarı YANLIŞ alarm olurdu)
 *  - installable_gap: araç kurulunca çözülür → mevcut "aracı kur + kapıyı koştur" işi otomatik açılır
 *  - gap: gerçek boşluk ama otomatik iş açmak gürültü olur → yalnız görünür sarı
 */
export type Phase17SkipClass = "not_applicable" | "installable_gap" | "gap";

export type Phase17Decision =
  | { run: true; crawl: boolean }
  | { run: false; auditDetail: string; userMsg: string; klass: Phase17SkipClass };

/**
 * SAF: deterministik sıra. Her "koşmuyor" dalı GÖRÜNÜR bir neden taşır — sessiz atlama yok, "geçti" yok.
 */
export function decidePhase17(inp: Phase17Input): Phase17Decision {
  if (inp.platform !== "darwin" && inp.platform !== "linux") {
    return {
      run: false,
      auditDetail: "unsupported_platform",
      userMsg:
        "⏭ Sızma testi atlandı — tarama araçları yalnız macOS ve Linux'ta destekleniyor. Bu boyut DOĞRULANMADI.",
      klass: "not_applicable",
    };
  }
  if (!inp.nucleiInstalled) {
    // `missing_command` biçimi bilinçli: mevcut isToolInstallableSkip bunu tanır → "aracı kur + kapıyı
    // gerçekten koştur" işi otomatik kuyruğa girer (kullanıcıya karar bırakılmaz).
    return {
      run: false,
      auditDetail: 'missing_command cmd="nuclei"',
      userMsg:
        "⏭ Sızma testi atlandı — `nuclei` kurulu değil. Bu boyut DOĞRULANMADI; aracı kurup taramayı koşturmak için iş açıyorum.",
      klass: "installable_gap",
    };
  }
  if (!inp.devServerAlive) {
    // Sunucu ayağa kalkmadıysa asıl sorun tarama değil, uygulamanın çalışmaması — onun kendi görünür yolu
    // ve kendi işi var. İkinci bir iş açmak aynı sorunu iki kez kuyruklar (gürültü).
    return {
      run: false,
      auditDetail: "no_dev_server",
      userMsg:
        "⏭ Sızma testi atlandı — tarama için çalışan bir uygulama bulunamadı. Bu boyut DOĞRULANMADI.",
      klass: "gap",
    };
  }
  if (inp.sourceUnchanged) {
    return {
      run: false,
      auditDetail: "unchanged_since_last_scan",
      userMsg: "➖ Sızma testi: kaynak son taramadan beri değişmedi — yeniden taranmadı.",
      klass: "not_applicable",
    };
  }
  return { run: true, crawl: inp.katanaInstalled };
}
