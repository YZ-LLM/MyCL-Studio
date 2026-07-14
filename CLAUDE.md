# MyCL Studio — proje talimatları

## Değişmez katı kurallar (her zaman sağlam ilerle)

Bu kurallar her oturumda, her işte geçerlidir — koddan ve aşağıdaki gate'ten önce gelir.
Yeni bir katı kural konuşulduğunda buraya ekle (tek doğruluk kaynağı budur).

1. **Stack-bağımsızlık.** Güvenlik taraması butonu dahil MyCL'deki HER süreç stack-bağımsızdır.
   Stack'e bağlı her komut (lint/test/build/security/perf/e2e) [stack profilinden](assets/profiles/)
   okunur; `npm`/`Next.js`/tek bir framework hiçbir yere hardcode EDİLMEZ. Framework-spesifik
   mantık (örn. dosya→route eşlemesi) agnostik olmalı VEYA güvenli fallback'e düşmeli (kuşkuda full).
2. **Kalite sabit kısıt; yarım iş yok.** Hız yalnız kaliteyi DÜŞÜRMEYEN yerde. Bir işi ya tam bitir
   ya da temiz bir sınırda durup durumu dürüstçe söyle — yarım/half-finished bırakma.
3. **Doğrula sonra iddia et.** "Çalışıyor / bitti / temiz" demeden ÖNCE kanıtla (ilgili kod-yolunu
   gez, testi/komutu koş). Araç çıktısını, kendi varsayımını, hatta kullanıcı çerçevesini kendi
   kanıtınla doğrula.
4. **Sessiz fallback yok.** Hiçbir şey sessizce bozulmasın/atlanmasın → görünür hata + dur.
   Güvenlik aracı eksikse atlamak YOK: ya kur ya görünür hata ver.
5. **MyCL-kodu vs proje-spesifik.** MyCL'in tekrar-takıldığı / loop / yanlış-teşhis = MyCL kodunda
   BEN çözerim; proje-spesifik sorun = MyCL'in runtime işi. İkisini karıştırma.
6. **Önden-çöz (correct-by-construction).** Doğruyu kaynağında kur (doğru talimat/tip/default) —
   sonradan gate/test/retry ile yakalamak yerine. Gate son-çare emniyet ağıdır, ilk savunma değil.
7. **Çapraz-platform = macOS + Linux.** Windows kapsam dışı; araç eksikse görünür + fail-closed.
8. **Faz 5 sonrası uygulama AÇILIR.** UI kurulduktan sonra MyCL uygulamayı ÇALIŞTIRIR (dev server +
   tarayıcı) — inceleme/kullanıcı için ayakta olmalı; sessizce geçmez.
9. **Faz 6 HER ZAMAN kullanıcıdan inceleme ister — "hiçbir şey sorma" modu DIŞINDA.** UI'lı projede
   (skip_ui_phases=false) Faz 6 ASLA atlanmaz/oto-geçilmez; uygulamayı açıp kullanıcı UI'yi inceleyip
   karar verene kadar park eder (kullanıcı sürer; spec-keyword heuristiğiyle skip YASAK). TEK İSTİSNA:
   "hiçbir şey sorma" (tam otonom) modu AÇIKKEN Faz 6 otomatik geçilir (a11y/görsel rapor gösterilir);
   mod KAPALI varsayılanda bu kural aynen geçerli.
10. **README güncel kalsın.** Kullanıcıya görünür bir özellik/davranış değiştiğinde README'yi AYNI
    değişiklikte güncelle ve push'la — README hiçbir zaman bayat kalmasın (özellikler tek bakışta doğru
    görünsün). Saf-iç fix'te (test/CI/refactor) README değişmez ama her seferinde "değişti mi?" diye bak.
11. **Kullanıcıya 1-2 cümle sade Türkçe.** Kullanıcıya bir şey söyleyeceğin zaman yanıt 1-2 cümle, sade
    Türkçe olsun — uzun açıklama/jargon/parantez-örneği yığma. (Detaylı rapor/plan istenirse o ayrı; bu
    kural sohbet yanıtları içindir.)
12. **Her konuda mahkeme kur.** Önemli her iş/karar için çapraz-aile öz-denetim mahkemesini (Sonnet 4.6
    müfettiş paneli) kur — "emin olmak" demek mahkemeden geçirmek demektir. Yalnız bariz-mekanik/sohbet
    turlarında atlanır; kuşkuda kur. Mahkemeye kullanıcının GERÇEK ilke metni (bu dosyadaki katı kurallar +
    `~/.claude/CLAUDE.md` tasarım/iletişim ilkeleri + ilgili bellek) SABİT girdi olarak verilir — hangi ilkeyi
    göstereceğini SEN seçip ÖZETLEME; seçim/özet kendi kör-noktanı geri sızdırır (mahkemenin amacı o filtreden kaçmak).
13. **Hedef projeye YALNIZ MyCL dokunur; BEN yalnız MyCL koduna dokunurum.** Kullanıcının hedef projelerine
    (cave, cave5, arcelik… — MyCL'in geliştirdiği/koştuğu projeler) BEN müdahale ETMEM: onları çalıştırmam,
    komut koşmam, dosyalarını değiştirmem, `node_modules`/deps'lerini elle kurup incelemem. Bir MyCL bug'ını
    teşhis ederken hedef projeyi BEN koşup gözlemlemem — MyCL'in KENDİ yakaladığı kanıttan (audit/log/
    `attempt.output`/`.mycl/`) muhakeme ederim; eksik bilgi varsa MyCL'i o bilgiyi YAKALAYACAK/YÜZEYE
    ÇIKARACAK şekilde düzeltirim. "Projeyi çalıştırmak/incelemek üzereyim" = SERT DUR noktası → dur, yeniden
    yönlen. Fix'lerimi hedef projeye karşı DEĞİL, birim testleriyle (tmpdir/mock) doğrularım. (Ben MyCL
    kaynağını geliştiririm; projeyle etkileşim MyCL'in runtime işidir — bu #5'in dokunma-sınırı hâli.)

## Geliştirme sonrası gate (DEĞİŞMEZ KURAL)

Bu projede her anlamlı kod/davranış değişikliğinden sonra **`npm run check`** koş.
Tek doğruluk kaynağı [scripts/check.sh](scripts/check.sh): build + test + frontend
typecheck + sızıntı + eski-iddia taraması. Detay: [dev.md](dev.md).

- Gerçek zorlayıcı **CI**'dır ([.github/workflows/check.yml](.github/workflows/check.yml)) —
  her push'ta sunucuda koşulsuz çalışır; ben (AI) onu çağırmayı atlasam bile devreye girer.
- Yine de **push'tan önce yerelde `npm run check` koş** ki kırmızıyı CI'dan önce gör.
- **Yerel-yeşil ≠ CI-yeşil.** Bir fix'i "düzeldi/çözüldü" diye iddia etmeden ÖNCE CI'nın GERÇEKTEN
  yeşile döndüğünü gör (gerçek ortam = hâkim). Yerel hızlı/çekirdek-sayısı/stray-server gibi farklar
  CI'da bambaşka davranabilir (bu oturum: 4 "kök" hipotezi yerelde geçip CI'da çürüdü). Kanıtlanmamış
  teşhisi "GERÇEK kök" diye commit'leme; "hipotez — CI doğrulaması bekliyor" de.
- Otomatize edilemeyen tek iş: **zihinsel kod-yolu gezintisi** — değişen path'leri elle
  gez, kullanıcıdan önce bug'ı yakala.

Yeni bir kontrol gerekiyorsa prose listeye değil, `scripts/check.sh`'e ekle.
