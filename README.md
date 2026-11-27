<img width="976" height="1096" alt="610782287-2a471953-4ec7-48c7-9f87-1dc2b893c35b" src="https://github.com/user-attachments/assets/b09afda3-5f9b-47a7-ac73-4b88946e0af0" />

# MyCL Studio

MyCL Studio, Claude modellerini çok fazlı bir akıştan geçirerek bir yazılım projesi kuran ya da var olan bir projeyi değiştiren masaüstü uygulamasıdır. Ne istediğini Türkçe yazarsın. MyCL niyeti netleştirir, spec yazar, kodu ve testleri yazdırır; sonra lint, test ve güvenlik kapılarını kendisi koşturur ve sonucu üç değerden biriyle bildirir: tamamlandı, kısmî ya da başarısız.

Üç parçadan oluşur: Rust ile yazılmış Tauri masaüstü kabuğu ([src-tauri/](src-tauri/)), React arayüzü ([src/](src/)) ve fazları yöneten Node orkestratörü ([orchestrator/](orchestrator/)). Modellere iki yoldan ulaşır: Claude Code aboneliği (`claude` komutu) ya da Anthropic API.

Baştan bilinmesi gerekenler:

- macOS ve Linux'ta çalışır; Windows desteklenmez.
- 19 stack profili vardır, ama destek en derin Node ailesindedir ([Stack profilleri](#stack-profilleri)).
- Kod yazan ajan bir kum havuzunda çalışır; MyCL'in kendi koşturduğu test, lint ve derleme komutları ise kum havuzu dışında, senin kullanıcı yetkilerinle çalışır ([Bilinen sınırlar](#bilinen-sınırlar)).
- Bu belge kodun bugünkü hâlini anlatır. Değişiklik geçmişi [CHANGELOG.md](CHANGELOG.md) dosyasında ve git kaydındadır.

## İçindekiler

- [Nasıl çalışır](#nasıl-çalışır) · [Fazlar](#fazlar)
- [Ajan rolleri](#ajan-rolleri) · [Arka uçlar ve modeller](#arka-uçlar-ve-modeller)
- [Doğrulama kapıları](#doğrulama-kapıları) · [Hüküm ve denetim kaydı](#hüküm-ve-denetim-kaydı)
- [Güvenlik sınırları](#güvenlik-sınırları) · [Bilinen sınırlar](#bilinen-sınırlar)
- [Hafıza ve öğrenme](#hafıza-ve-öğrenme) · [Diskte ne nerede durur](#diskte-ne-nerede-durur)
- [Arayüz](#arayüz) · [Elle başlatılan akışlar](#elle-başlatılan-akışlar)
- [Kurulum](#kurulum) · [Çalıştırma](#çalıştırma) · [Stack profilleri](#stack-profilleri)
- [Geliştirme](#geliştirme) · [Proje düzeni](#proje-düzeni) · [Lisans](#lisans)

## Nasıl çalışır

Bir proje klasörü açıkken sohbet kutusuna Türkçe ne istediğini yazarsın. Mesaj önce **orkestratöre** gider. Orkestratör, mesajı okuyup ne yapılacağına karar veren model rolüdür. Kararı tek bir eylemdir: sohbet etmek, tek bir netleştirme sorusu sormak, yeni bir geliştirme işi başlatmak, hata ayıklamak, belirli bir fazı çalıştırmak, projeyi çalıştırmak gibi ([decision.ts](orchestrator/src/orchestrator-agent/decision.ts)). Karar veremezse "Anlayamadım, tekrar yazar mısın?" der.

Yeni bir geliştirme işi şöyle ilerler:

1. **İş listesi.** Mesaj iş listesine eklenir. Mesajda birden fazla iş varsa ayrı işlere bölünür ve öneme göre sıralanır. İşler tek tek, her biri Faz 1'den başlayarak işlenir. Başka bir iş çalışıyorsa ya da Faz 6 incelemesinde bekliyorsa yeni işler yalnız kuyruğa eklenir; çalışan iş bitince öncelik sırasıyla başlar.
2. **İterasyon.** Bir işin Faz 1'den Faz 17'ye kadar bir kez geçmesine iterasyon denir. Önceki iterasyon bittiyse sayaç bir artar; niyet, spec ve faz kapsamı sıfırlanır, eski kod ve spec diskte kalır. Faz 1'den önce bu iterasyonun kapı kısıtları derlenip `.mycl/overlays/current.json` dosyasına yazılır. Derlenemezse iterasyon başlamaz ve iş kuyruğa geri döner.
3. **Fazlar.** Fazlar sırayla koşar; her faz bitince bir sonrakine geçilir ([phase-registry.ts](orchestrator/src/phase-registry.ts)). Uygun olmayan bir faz atlanır. Atlama sohbette yazılır ve denetim kaydına (`.mycl/audit.log`) işlenir.
4. **Seni beklediği yerler.** Soru cevap fazlarındaki sorular, şema üretimi fazlarındaki (Faz 3, 4, 7) onaylar, Faz 3'teki faz kapsamı sorusu, Faz 8 öncesindeki davranış değişikliği onayı ve Faz 6'daki arayüz incelemesi. Sohbet alanındaki "Oto-cevap" kutusu varsayılan olarak açıktır; açıkken netleştirme soruları modelin önerdiği cevapla, onaylar ise ilk ya da güvenli seçenekle otomatik yanıtlanır. "Proje Aç" ile entegre edilen projede Oto-cevap yalnız akışı ilerleten güvenli kararları yanıtlar (kutuda "(güvenli kararlarda oto)" yazar); kodu değiştiren kararlar sana kalır. 🛡️ Güvenlik Taraması onayını Oto-cevap hiçbir zaman yanıtlamaz. "Hiçbir şey sorma" kutusu varsayılan olarak kapalıdır; açılırsa Faz 6 incelemesi de otomatik onaylanır.
5. **Kapı düşerse.** Mekanik kapı, dil modeli kullanmadan komut çalıştırıp sonucu ölçen fazdır. Bir kapı başarısız olursa ve Oto-cevap açıksa MyCL düzeltmeyi bir kez o fazın içinde dener ve kapıyı yeniden koşar. Çözülmezse hata analizi açılır; "Kabul et, devam et" seçilirse akış sürer ama sonuç yeşil sayılmaz. Kapıların nasıl sınıflandığı [Doğrulama kapıları](#doğrulama-kapıları) bölümünde anlatılır.
6. **Sonuç.** Faz 17'den sonra sohbete iki özet gelir ([pipeline-end-summary.ts](orchestrator/src/pipeline-end-summary.ts)). "📋 Akış özeti" ne istediğini, dürüst uyarıları, sonucu, çalışma kanıtını ve harcanan token miktarını (toplam ve faz başına) yazar. "🔎 Doğrulama özeti" hangi kalite boyutunun doğrulandığını, hangisinin atlandığını ve hangisinin bu proje için uygulanamaz olduğunu gösterir. Sonuç denetim kaydından hesaplanır ve üç değerden biridir: "✅ Tamamlandı", "KISMÎ (tam doğrulanmadı)" ya da "BAŞARISIZ". Hangi durumda hangisinin verildiği [Hüküm ve denetim kaydı](#hüküm-ve-denetim-kaydı) bölümündedir.

Hata ayıklama ayrı bir yoldur. Orkestratör mesajı bir hata raporu sayarsa Faz 0 koşar. Faz 0 iterasyon sayacını ve bulunulan fazı değiştirmez, akışa bağlanmaz. Faz 0 tamamlanamazsa sohbete "⏹ Hata ayıklama tamamlanamadı." yazılır ve sorunu farklı bir cümleyle yeniden yazman istenir.

## Fazlar

Fazların dört türü vardır, her tür ortak bir denetleyici kullanır ([base/](orchestrator/src/base/)): **soru cevap** (model sana soru sorar ve onay ister), **şema üretimi** (model yapılandırılmış bir belge yazar, sen onaylarsın), **kod yazımı** (model dosya okur, yazar, komut çalıştırır), **mekanik kapı** (stack profilindeki komutlar ve gömülü kontrol betikleri çalışır, model yoktur). Bir kapının ana komutu stack profilinden gelir ([assets/profiles/](assets/profiles/)); komut tanımsızsa ya da araç kurulu değilse kapı "atlandı" yazar.

| # | Faz | Tür | Ne üretir | Ne zaman atlanır |
|---|---|---|---|---|
| 0 | Hata Ayıklama | kod yazımı | Kök neden ("🔍 Tespit") ve 2–4 çözüm önerisi. Oto-cevap açıksa önerilen çözüm sorulmadan uygulanır; Oto-cevap kapalıysa ya da önerilen çözüm tüm akışı yeniden başlatmayı gerektiriyorsa "Hangi çözümü uygulayalım?" diye sorulur | Akışın parçası değil; yalnız orkestratör hata ayıklamaya karar verince koşar |
| 1 | Niyet Toplama | soru cevap | Onaylanmış niyet özeti (en çok 6 soru) | Güvenlik bulgusundan türeyen sistem işlerinde Faz 1 ve 2 atlanır, iş sonraki bir fazdan başlar |
| 2 | Hassasiyet Denetimi | soru cevap | Sekiz boyutta zenginleştirilmiş niyet (SCOPE, USERS, DATA, SUCCESS, EDGE, PERFORMANCE, SECURITY, COMPLIANCE); proje tipi, arayüz gerekip gerekmediği, veritabanı olup olmadığı | Yalnız güvenlik bulgusundan türeyen sistem işlerinde (Faz 1 ile birlikte) atlanır. "Vazgeç" seçilirse iterasyon bırakılır, Faz 1'e dönülür |
| 3 | Mühendislik Brifingi | şema üretimi | `.mycl/brief.md` ve önerilen faz kapsamı ("Faz kapsamı nasıl olsun?": "✅ Önerilen seti onayla" / "⚙️ Tüm fazları çalıştır" / "Vazgeç") | Atlanmaz |
| 4 | Spec Yazımı | şema üretimi | `devs/_pending/<zaman>/iter-spec.md`; modelin yaptığı varsayımlar onaydan önce sohbete yazılır | Atlanmaz |
| 5 | UI Yapımı | kod yazımı | Arayüz dosyaları; geliştirme sunucusu başlar, tarayıcı açılır. Backend klasörlerine (`src/api/`, `backend/`, `server/`, `prisma/`, `migrations/` vb.) yazamaz | Proje tipi arayüz istemiyorsa (library, cli, api, ml, game) ve spec'te arayüz terimi yoksa; onaylı faz kapsamı dışındaysa. Spec yoksa faz başarısız olur |
| 6 | UI İnceleme | soru cevap (soru açmadan bekler) | Uygulamayı açar, erişilebilirlik (WCAG) ve görsel karşılaştırma raporu yazar (sayfa boş görünüyorsa tarayıcının o açılışta bildirdiği ilk hatalarla birlikte), cevabını bekler: `tamam` / `devam et` / `onayla` ile Faz 7'ye, değişiklik isteğiyle Faz 5'e döner, `iptal` / `vazgeç` ile durur. Değişiklik isteği tek seferliktir: akış yeniden Faz 6'ya geldiğinde ya da yeni bir Faz 1 başladığında kapanır, sonuçsuz kaldıysa bu sohbete yazılır. İstekten yapılacak bir değişiklik çıkmazsa (rötuş koşusu hiçbir kaynak dosyayı değiştirmediyse; MyCL koşudan önce kaynak ağacının kopyasını alıp sonra içerikçe karşılaştırır, `node_modules/`, `dist/`, `build/` gibi üst dizinler sayılmaz) bu bir hata sayılmaz: istek kapanır, "ne değişsin, somut yaz" denir ve Faz 6 yeniden bekler. Ajan yazmayı deneyip engellendiyse, dosyalar yazma aracı dışında bir yolla değiştiyse ya da koşu süre tavanına takıldıysa faz başarısız olur. Uygulama bu sırada kapatılıp açılırsa iş Faz 1'den başlamaz: rötuş yarıdaysa Faz 5'ten, inceleme bekleniyorsa Faz 6'dan sürer | Proje tipi arayüz istemiyorsa; "Proje Aç" ile entegre edilen projede |
| 7 | Veritabanı Tasarımı | şema üretimi | `.mycl/db-schema.md` | Faz 2 veritabanı yok dediyse; Faz 2 karar vermediyse ve spec'te veritabanı terimi yoksa; onaylı faz kapsamı dışındaysa. Spec yoksa uyarı verir, akış sürer |
| 8 | BDD + TDD Uygulama | kod yazımı | `features/*.feature` senaryoları, testler ve üretim kodu. Geçmek için son test sonucunun yeşil olması, MyCL'in kendi koştuğu tüm test takımının yeşil olması ve teknik borç bulgusu kalmaması gerekir. Yeşil sonuçlar kabul ölçütü kimliğiyle bildirildiyse her kabul ölçütü en az bir yeşil sonuçta adıyla geçmelidir; bildirim satırlarının sayısı önemli değildir. Kimlik bildirilmediyse ya da düzeltme işindeyse kabul ölçütü sayısına bağlı en az sayıda yeşil sonuç gerekir (en az 3, kabul ölçütü sayısının beşte biri daha büyükse o kadar; spec'te kabul ölçütü bulunamazsa 1); hata düzeltme işinde önce hatayı gösteren kırmızı test yazılmalıdır. Var olan bir davranış değişecekse kod yazılmadan önce onay sorulur | Atlanmaz. Spec yoksa başarısız olur |
| 9 | Risk İncelemesi | soru cevap | Risk kararları. "Düzelt" kararları alanına göre Faz 5 (arayüz), Faz 7 (veritabanı) ya da Faz 8 (kod) çalıştırılarak hemen düzeltilir. Abonelik (CLI) modunda çok ajanlı inceleme soru sormadan karar verir; API modunda tek ajan soru sorar | Atlanmaz |
| 10 | Lint | mekanik kapı | Profilin `lint` komutu (tanımlıysa `lint_fix` ile bir düzeltme denemesi); ek olarak HTML giriş zinciri, kod kalitesi kuralları (semgrep) ve mimari sınır kontrolü | Ana komut atlanırsa ek kontroller de koşmaz |
| 11 | Sadeleştirme | mekanik kapı | Profilin `simplify` komutu (yalnız Node profillerinde tanımlı) ve her dilde koşan kopya kod ölçümü | Ana komut yoksa yalnız kopya kod ölçümü koşar |
| 12 | Performans | mekanik kapı | Profilin `perf` komutu (Node, Go, Rust); paket boyutu bütçesi, veritabanı index kontrolü, Lighthouse sayfa skoru | Ana komut yoksa ek ölçümler koşar; build çıktısı, şema ya da çalışan uygulama yoksa ilgili ölçüm atlanır |
| 13 | Güvenlik | mekanik kapı | Profilin `security` komutu; CSP (giriş sayfasındaki meta politikası ve sunucu ayar dosyalarındaki politika birlikte okunur; `script-src 'self'` yalnız sunucu paketi olmayan statik uygulamanın meta politikasında serbesttir, sunucusu olan uygulamada yasaktır), veritabanı şeması güvenliği, osv-scanner, semgrep (`auto`, `p/secrets`, `p/security-audit`, `p/owasp-top-ten`, özel kurallar), güvenlik başlıkları, gitleaks. Başarısızlıkta Oto-cevap açıksa MyCL bir kez otomatik düzeltme dener; çözülmezse analizin önerdiği çözümü uygular, çözüm yoksa bulguyu rapora yazıp otomatik "Kabul et, devam et" ile ilerler (sonuç KISMÎ olur). Oto-cevap kapalıysa akış durur ve "Kabul et, devam et" / "Tekrar analiz et" sorulur. Birden çok ayrı bulgu varsa her biri ayrı ayrı ele alınır | Ana komut yoksa (dart, deno, flutter, swift) ek taramalar yine koşar |
| 14 | Birim Testler | mekanik kapı | Profilin `test` komutu | Komut ya da araç yoksa |
| 15 | Entegrasyon Testleri | mekanik kapı | Profilin `integration` komutu | Komut ya da araç yoksa |
| 16 | E2E Testler | mekanik kapı | Proje tipine göre seçilen E2E komutu (web için Playwright); başlamadan Playwright kurulumu ve iskeleti hazırlanır | Spec'te arayüz terimi yoksa; Ayarlar → Özellikler'de Playwright kapalıysa (varsayılan açık); hazırlık başarısızsa; proje tipi için E2E komutu yoksa |
| 17 | Sızma Testi | mekanik kapı (kendi yolu) | `nuclei` ile hızlı tarama, yalnız yüksek ve kritik açıklar. Bulgu varsa güvenlik işi olarak kuyruğa eklenir ve sonuç KISMÎ olur. Tam tarama 🛡️ Güvenlik Taraması butonuyla, onayınla koşar | Spec'te HTTP sunan bir hedef terimi yoksa (CLI, kütüphane); macOS ve Linux dışında (Windows desteklenmez); `nuclei` kurulu değilse (MyCL bu fazda aracı kurmaz, iş listesine "aracı kur" işi açılır); çalışan uygulama yoksa; tarama zaman aşımına uğrar ya da hata verirse. `katana` kurulu değilse yalnız kök sayfa taranır |

Atlama kararları için iki kaynak kullanılır. Faz 5 ve 6 için Faz 2'nin proje tipi sınıflandırması, Faz 7 için Faz 2'nin veritabanı kararı esastır. Spec metni Faz 5'te yalnız atlamayı engeller: proje tipi arayüz istemese bile spec arayüzden söz ediyorsa Faz 5 koşar. Faz 16 ve 17 ise doğrudan spec metninde arayüz ya da HTTP terimlerini arar ([mechanical-skip-signal.ts](orchestrator/src/mechanical-skip-signal.ts)); spec okunamazsa kapı atlanmaz, koşar. Faz 3'ün önerdiği kapsamda yalnız Faz 5 ve Faz 7 gerçekten atlanabilir; Faz 6 ve Faz 8 kapsamdan bağımsız koşar.

## Ajan rolleri

MyCL üç temel ajan rolüyle çalışır. Her rolün arka ucu (API ya da abonelik) Ayarlar'dan ayrı ayrı seçilir. Modeli ise rolün kendisi değil, yaptığı iş belirler (bkz. [Arka uçlar ve modeller](#arka-uçlar-ve-modeller)).

| Rol | Ne yapar | Modeli |
|---|---|---|
| Orkestratör | Her kullanıcı mesajını yorumlar ve tek bir karar verir: sohbet etmek, netleştirme sorusu sormak, bir fazı çalıştırmak, yeni iş başlatmak, açık bir soruyu cevaplamak, işi iptal etmek gibi. Karar vermeden önce proje dosyalarını okuyabilir. Emin olamazsa "anlayamadım" der, iş yapmaz. | Her zaman güçlü katman (`strong`); efor bu işte en çok `high` |
| Çevirmen (translator) | Kullanıcının Türkçe metnini İngilizceye, modelin İngilizce çıktısını Türkçeye çevirir. Boş metni modele göndermez. | Sabit `claude-haiku-4-5`, değiştirilemez |
| Ana ajan (main) | Fazların asıl işini yapar: spec, kod, test, inceleme. Yalnız İngilizce yazar. | Fazın iş türüne göre seçilen katman |

Bunlara ek olarak, ana ajanın işini bağımsız bir gözle denetleyen inceleme rolleri vardır:

| Rol | Ne zaman çalışır, ne yapar | Varsayılan |
|---|---|---|
| Müfettiş ("mahkeme") | Bir [kapı](#doğrulama-kapıları) bulgusu otomatik düzeltilmek üzereyken, aynı hata tekrar tekrar düzelmediğinde, Faz 13 güvenlik bulgusunda ve oto cevap açıkken orkestratör netleştirme sorusu sormak istediğinde. Bulguyu dosyaları okuyup komutu kendisi çalıştırarak doğrular. Gerekirse orkestratörle en çok 10 tur kanıta dayalı tartışır. Sonuca göre düzeltme uygulanır, engellenir ya da karar kullanıcıya bırakılır. İki Claude kanalı da kapalıysa mahkeme kurulmaz, karar kullanıcıya gider. | Açık (`inspector_enabled`). Ayarlar'da düğmesi yoktur. Model sabit `claude-sonnet-4-6`; tartışmada orkestratör tarafı güçlü katmanla konuşur. |
| Faz 9 tartışması | Faz 9 risk incelemesinde yedi bulucu iki dalgada salt okunur tarar. Birinci dalga: doğruluk, güvenlik, performans, sürdürülebilirlik. İkinci dalga birinci dalganın bulgularını görür: STRIDE tehdit modeli, hata ve sınır yolları, teknik borç. Her bulguyu bağımsız bir çürütücü yeniden doğrular, yanlış pozitifler elenir. | Yalnız ana ajanın arka ucu abonelik olarak çözüldüğünde. API yolunda Faz 9 tek ajanla çalışır. Birinci dalganın bulucularının hepsi hata verirse Faz 9 başarısız sayılır; boş sonuç "risk yok" diye okunmaz. Bulucu çalışıp bulgu bulmazsa bu başarısızlık değildir. |
| Düşman testi | Faz 8 testleri geçtikten sonra, kodu yazmayan ayrı bir ajan spec'teki kabul kriterlerine karşı kodu kırmaya çalışan testler yazar ve çalıştırır. Yazdığı testler projede kalır. Bir ihlal bulursa sohbete yazar ve [denetim kaydına](#hüküm-ve-denetim-kaydı) bir satır düşer. | Açık (`adversarial_tester`). "Main Modeli" ayarındaki modelle çalışır, en çok 15 dakika sürer. Yalnız abonelik yolunda; API yolunda atlanır ve bu görünür yazılır. Ayarlar'da düğmesi yoktur. |
| Kör nokta merceği | Faz 4'te spec yazıldıktan sonra ve orkestratörün geri alınamaz kararlarından önce (yeni iş, iptal, Faz 0, Faz 5/7/8 çalıştırma). Kararı vermeyen ayrı bir ajan atlanmış varsayımları arar. Bulgular görünür yazılır, akış durmaz; orkestratör kararındaki mercek 60 saniyede bitmezse karar beklemeden sürer. | `blindspot_lens: "consequential"`. Faz 4'teki mercek, spec'te en çok 3 kabul kriteri varsa ve güvenlik, veri, yetki, şema, ödeme, silme gibi riskli bir konu geçmiyorsa atlanır. Ayarlar'da düğmesi yoktur. |
| Advisor (danışman) | Güçlü katmanın altındaki akıl yürütme turları (örneğin tasarım panelinin ux, security, data rolleri) karar anlarında güçlü bir modele danışır. | Kapalı. Ayarlar → Özellikler → "🧭 Advisor (danışman)". Yalnız abonelik yolunda ve `claude` 2.1.98 ya da üstüyle çalışır. |

Kodda orkestratörün son koşusunu bir soru listesiyle denetleyen bir denetim ajanı da vardır ([quality-audit.ts](orchestrator/src/quality-audit.ts)). Arayüzde onu başlatan bir düğme yoktur.

## Arka uçlar ve modeller

Ayarlar → Modeller → "Sağlayıcı (rol-başına)" altında çevirmen, ana ajan ve orkestratör için ayrı ayrı üç seçenek vardır. Üçünün de varsayılanı Otomatik'tir ([config.ts](orchestrator/src/config.ts)).

| Seçenek | Ne yapar |
|---|---|
| "Claude Abonelik" | `claude` komut satırı aracını (Claude Code CLI) alt süreç olarak çalıştırır. API anahtarı verilmez; çağrılar aboneliğe yazılır. `claude` önce `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` içinde, sonra giriş kabuğunda aranır. |
| "Claude API" | Anthropic SDK ile API anahtarını kullanarak çağırır (çağrı başına ücretlendirilir). |
| "Otomatik (Claude CLI↔API · önerilen)" | Abonelikle başlar. Abonelik limiti dolunca API'ye geçer, limitin açılma saatini sohbete yazar. Limitliyken iki dakikada bir aboneliği yeniden dener, açılınca aboneliğe döner. `claude` bulunamazsa doğrudan API kullanılır. |

Otomatik modda kod üretimi bir kanal başarısız olunca ötekine geçer. En çok 6 deneme yapar ve denemeler arasında giderek daha uzun bekler. İki kanal da kredi ya da yetki hatası verirse durur. Çevirmen ve orkestratör yalnız bir kez öbür kanala geçer ([cli-rate-limit.ts](orchestrator/src/cli-rate-limit.ts), [codegen/backend.ts](orchestrator/src/codegen/backend.ts)). İki kanal da kapalıysa MyCL bekler. Limitin açılma saati biliniyorsa o saatten bir dakika sonra (en geç bir saat içinde), bilinmiyorsa beş dakikada bir yeniden dener ve kaldığı işe devam eder ([llm-outage.ts](orchestrator/src/llm-outage.ts)).

Abonelik ya da API elle seçildiğinde öbür kanala sessizce geçilmez. Bunun iki istisnası vardır. Birincisi: ana ajan abonelikte değilken ("Claude API" ya da "Otomatik") bir faz API kredi ya da yetki hatasıyla düşerse ve `claude` kuruluysa, MyCL üç rolün sağlayıcısını kalıcı olarak "Claude Abonelik" yapar, bunu sohbete yazar ve fazı abonelikle yeniden çalıştırır. API'ye dönmek için Ayarlar'dan elle geri almak gerekir. İkincisi orkestratördür: abonelik yolu karar üretemezse API'ye geçer ve bunu sohbete yazar. Bunların dışında abonelik seçili ama `claude` yoksa görünür bir hata verilir ve faz başarısız olur.

Kod üreten işlerden yalnız Faz 5, Faz 8, özellik doğrulama, paralel modül ve kapı otomatik düzeltmesi abonelikle çalışabilir. MyCL'e özel araç gerektiren öteki kod üretim işleri API ile çalışır; bu sohbete yazılır ve API anahtarıyla kredi gerektirir. Bu kısıt yalnız kod üretimi içindir: çevirmen, orkestratör kararı ve Faz 9 tartışması abonelikle de çalışır.

**İlk kurulumda gerekenler:** Uygulamanın hazır sayılması için yalnız ana ajan modelinin seçilip kaydedilmiş olması gerekir; seçilmemişse Ayarlar kendiliğinden açılır. Çevirmen modeli sabittir, seçilmez. **API anahtarı zorunlu değildir.** Anahtar yoksa bütün roller abonelikle çalışır; bunun için `claude` kurulu ve oturum açılmış olmalıdır. Anahtarsız durumda sağlayıcı ayarı "Otomatik" de "Claude API" de olsa rol abonelikte koşar: "Otomatik" abonelik limiti dolunca API'ye geçmez, MyCL bekler ve limit açılınca kaldığı yerden devam eder; sağlayıcısı "Claude API" seçili roller için sohbete bir kez bildirim yazılır. Anahtar "var" sayılması için çevirmen ve ana anahtarın ikisi de gerekir; yalnız biri girildiyse anahtar yok sayılır. Orkestratör anahtarı isteğe bağlıdır; boşsa ana anahtar kullanılır. Anahtarlar platformun config dizinindeki `secrets.json` dosyasına yazılır (yeri için bkz. [Diskte ne nerede durur](#diskte-ne-nerede-durur)). `MYCL_API_KEY_TRANSLATOR`, `MYCL_API_KEY_MAIN` ve `MYCL_API_KEY_ORCHESTRATOR` ortam değişkenleri de anahtar verir ve dosyadaki değerden önce gelir; ikisi de yoksa `ANTHROPIC_API_KEY` kullanılır. Model listesi anahtar varsa Anthropic API'den çekilir; anahtar yoksa MyCL'in yerleşik model kataloğu gösterilir. `claude` her açılışta arka planda güncellenir (`auto_update_claude`, varsayılan açık).

**Model seçimi:** her faz bir iş türüne, her iş türü bir katmana bağlıdır. Başarısız olunca daha güçlü bir modele geçilmez ([escalation.ts](orchestrator/src/escalation.ts), [model-catalog.ts](orchestrator/src/model-catalog.ts)).

| Faz | İş türü | Katman |
|---|---|---|
| Faz 1 | niyet | `balanced` |
| Faz 2, Faz 9 | inceleme | `strong` |
| Faz 3, Faz 7 | tasarım | `strong` |
| Faz 4 | spec | `strong` |
| Faz 5, Faz 8 | kod üretimi | `strong` |

Katmanların modelleri "İş-seviyesi modelleri" alanından seçilir. Ayarlar'daki açıklama "(main)" der, ama boş bırakılan katman katalogdaki varsayılanı kullanır: `strong` için `claude-opus-5`, `balanced` için `claude-sonnet-5`, `cheap` için `claude-haiku-4-5`. `cheap` katmanına bağlı bir iş türü yoktur; bu katman için seçilen model hiçbir fazı etkilemez. Tasarım panelinde architect, synthesizer ve verifier rolleri `strong`, ux, security, data ve hypothesis rolleri `balanced` katmanla çalışır. Katalogda olmayan bir model değiştirilmeden kullanılır ve MyCL bunu sohbete bir kez yazar. Böyle bir model Ayarlar'dan kaydedildiğinde MyCL onu bir kez çağırmayı dener ve sonucu yazar; çağrı başarısız olsa da ayar değişmez.

**Efor:** varsayılan `max`. Güçlü katmana bağlı iş türleri bu ayarı alır, ancak kod üretimi ve inceleme en çok `xhigh` ile çalışır. Öteki işler, orkestratör kararı dahil, en çok `high` ile çalışır. Kullanıcının seçtiği daha düşük efor yükseltilmez. `ultracode` yalnız güçlü katmandaki işlerde olduğu gibi kalır; öteki işlerde o da `high` ile sınırlanır. Abonelikte efor `--effort` ile, `ultracode` ise `--settings` ile geçer. API yolunda efor Opus 4.7 ve üstü ile Claude 5 modellerinde, yalnız araç seçimi zorlanmayan çağrılarda uygulanır; `ultracode` API'ye `max` olarak gider. Ayarlar'daki açıklama eforun yalnız abonelikte etkili olduğunu söyler, ama API yolu da yukarıdaki koşullarda eforu uygular.

**Yeni model önerisi:** proje açılınca MyCL güncel Claude modellerini Anthropic'in resmi sayfalarında web aramasıyla bulur (sonuç günde bir kez yenilenir). Yeni bir güçlü model bulursa "Evet, geç" / "Hayır, kalsın" diye sorar; önerilen seçenek "Hayır, kalsın" olarak işaretlidir ve soruyu yalnız kullanıcı cevaplar (otomatik cevap düzenekleri ve ekransız koşu betiği bu soruyu cevaplamaz). "Evet" denirse model önce denenir, çağrılabiliyorsa ana model ve `strong` katman ona geçer. "Hayır" kalıcı olarak hatırlanır. "Hiçbir şey sorma" modunda yalnız bilgi verilir, ayar değişmez ([model-discovery.ts](orchestrator/src/model-discovery.ts)).

**Ayarlar'da değiştirilebilenler** ([Settings.tsx](src/components/Settings.tsx)):

| Sekme | Alan |
|---|---|
| Modeller | rol başına sağlayıcı, "Main Modeli", "Orkestrator Ajan Model" (yalnız modül stoğu, yaşayan dökümantasyon, kalite denetimi ve spec tazeleme gibi yardımcı işlerde; orkestratörün kararı her zaman `strong` katmandan gelir), "Main Model Eforu (CLI aktifse)", üç katmanın modelleri, "Plan modeli" (boşsa planı `balanced` katman yazar; onaylanan planı uygulayan fazlar bu seçimden etkilenmez), "Prompt cache ömrü" (5 dakika varsayılan, 1 saat seçilebilir) |
| API Keys | Translator, Main ve isteğe bağlı Orkestrator API anahtarları |
| Özellikler | Açılıp kapanan ayarlar: "🎭 Playwright (E2E Testler)" (varsayılan açık), "🧮 Over Engineering Kontrolü" (varsayılan kapalı), "⚡ Paralel iş kümeleme" (varsayılan kapalı), "🧭 Advisor (danışman)" (varsayılan kapalı). "🩺 Bağlamı sadeleştir" bir ayar değil, düğmedir: ajana verilen bağlamı ölçer ve kesim önerir, hiçbir şeyi kendisi silmez. |
| Hakkında | "Açılışta otomatik güncelle" kutusu (varsayılan açık) ve log dosyalarının yolları |

Çevirmen modeli Ayarlar'da kilitli görünür ("🔒 Sabit"). Tasarım paneli "create-only" olarak sabittir (yeni proje ve karmaşık işlerde açılır), Çoklu Ajan Seçimi açık, Agent Teams kapalıdır. Bu üç ayar her yüklemede zorlanır, arayüzden değiştirilemez.

## Doğrulama kapıları

Faz 10 ile 17 arası mekanik fazlardır: model çağrılmaz, MyCL hedef projede komut çalıştırır ve sonucu kendisi okur ([mechanical-runner.ts](orchestrator/src/base/mechanical-runner.ts)). Her fazın ana komutu projenin stack profilinden (`assets/profiles`) alınır ([phase-registry.ts](orchestrator/src/phase-registry.ts)). Komut proje kökünde, 120 saniye zaman aşımıyla ve süzülmüş ortam değişkenleriyle koşar. Kapılar her zaman bütün projeyi tarar. Taramayı yalnız değişen dosyalara daraltan düzenek (`lint_scoped`, `test_scoped` ve ek taramalardaki `{files}` şablonları) kodda durur ama kapalıdır: değişen dosya listesi hiç doldurulmaz.

Her kapı üç sonuçtan birini verir:

| Sonuç | Ne zaman |
|---|---|
| geçti | Çıkış kodu 0. Faz kaydına `lint-pass` gibi bir olay yazılır. |
| başarısız | Çıkış kodu 0 değil. Yalnız Faz 10'da bir düzeltme komutu (`lint_fix`) vardır: bir kez koşar, tarama yeniden yapılır. Ana komut askıda kalırsa ya da başlatılamazsa (zaman aşımı, E2BIG, ENOMEM) da başarısız sayılır; kayda `spawn_env_fault` ayrıntısıyla yazılır ve `lint_fix` koşturulmaz. Fazın sonraki düzeltme akışı bu durumu ayrıca ayırt etmez. Ek taramalarda zaman aşımı sıradan bir başarısızlıktır. |
| atlandı | Araç hiç çalışmadı. `phase-N-skipped` ya da `<tarama>-skipped` olayı, nedeniyle birlikte yazılır. |

Atlama nedenleri:

| Kod | Ne zaman |
|---|---|
| `profile_resolve_null` | Profilde bu faz için komut yok ya da stack tespit edilemedi. |
| `missing_command` | Komut bulunamadı: çıkış kodu 127 ya da npm/pnpm'in kendi "Missing script" satırı. Aracın serbest çıktısına bakılmaz. |
| `stub_script` | Komut tırnaklı bir `echo` ile pass, passed, ok, success ya da check sözcüğü basıyor, örneğin `vite build && echo 'perf check passed'`. |
| `redundant_gate_command` | Faz 11, 12, 13 ya da 15'in komutu, `npm run` betikleri açıldıktan sonra build, test ya da lint komutunun aynısı. |
| `ts_tool_*` | TypeScript aracı bir JavaScript projesinde. |
| `mycl_tool_broken` | MyCL'in kendi aracı bozuk. |
| `tool_error` | Ek tarama kendi "ölçemedim" kodunu verdi. |

Atlanan bir boyut geçti sayılmaz. Akış sonundaki "🔎 Doğrulama özeti" yalnız bu iterasyonun olaylarına bakar ve her boyutu "✅ Doğrulandı", "➖ Uygulanamaz" ya da "⚠️ DOĞRULANMADI (atlandı)" satırına yazar. "➖ Uygulanamaz" satırına yalnız TypeScript aracı nedenleri (`ts_tool_js_project`, `ts_tool_not_applicable`) düşer; diğer atlamalar "DOĞRULANMADI (atlandı)" olarak görünür. Profilin `command_gaps` alanında gerekçesi yazılmış ve başka bir tarayıcının kapsadığı bir boşlukta sohbete nötr bir "➖" mesajı yazılır ve iş açılmaz; ama o fazda ek taramalar koşmadıysa boyut özette yine "DOĞRULANMADI (atlandı)" altındadır. Araç kurularak çözülebilecek atlamalarda (`missing_command`, `stub_script`, `redundant_gate_command`, gerekçesiz `profile_resolve_null`) MyCL iş kuyruğuna "aracı kur + doğrulamayı koştur" işi açar. Bu iş aynı boyut için bir kez açılır; önceki iş bitmiş olsa bile yenisi açılmaz. Faz geçtiği hâlde ek taramalarından birinin aracı eksikse özete ayrıca "🔍 Eksik tarama aracı" satırı yazılır ve o araç için de iş açılır. Aynı atlama mesajı, nedeni değişmedikçe sohbete bir kez yazılır; denetim kaydına her seferinde yazılır.

Her faz ana komuta ek olarak kendi ek taramalarını paralel koşar. "Atlama kodu" sütunu, aracın hangi çıkış kodunun bulgu değil "ölçemedim" anlamına geldiğini gösterir:

| Faz | Ek tarama | Araç | Atlama kodu |
|---|---|---|---|
| 10 | `entry-graph`, `architecture` | [entry-graph-check.mjs](orchestrator/entry-graph-check.mjs), [arch-check.mjs](orchestrator/arch-check.mjs) | 3; 2 ve 3 |
| 10 | `code-quality` | semgrep + `assets/quality-rules/code-quality.yml` | 2, 7 |
| 11 | `simplify-agnostic` (kopya kod) | [simplify-check.mjs](orchestrator/simplify-check.mjs) | 3 |
| 12 | `bundle-budget`, `db-schema-perf`, `perf-web` (Lighthouse) | [bundle-budget-check.mjs](orchestrator/bundle-budget-check.mjs), [db-schema-check.mjs](orchestrator/db-schema-check.mjs), [perf-web-check.mjs](orchestrator/perf-web-check.mjs) | 3 |
| 13 | `csp-evaluator`, `security-headers`, `db-schema-security`, `osv-scanner` | [csp-check.mjs](orchestrator/csp-check.mjs), [headers-check.mjs](orchestrator/headers-check.mjs), db-schema-check.mjs, [osv-scan.mjs](orchestrator/osv-scan.mjs) | yok; 2; 3; 3 |
| 13 | `semgrep`, `semgrep-secrets`, `semgrep-security-audit`, `semgrep-owasp-top-ten`, `data-sanitization`, `web-security` | semgrep (kayıt kuralları ve `assets/security-rules`) | 2 |
| 13 | `gitleaks` (yalnız `src/` klasörü, `--source src/ --no-git`) | gitleaks | yok |

Ana tarama ya da ek taramalardan biri başarısızsa faz başarısız olur. Ana komut atlanırsa ek taramalar yalnız Faz 11, 12 ve 13'te koşar. Bunlardan en az biri gerçekten koşarsa `phase-N-covered-by-extras` olayı yazılır ve doğrulama özeti o boyutu doğrulanmış gösterir. Faz 13'te bu hükmü kurtarmaz: `phase-13-skipped` olayı kayıtta kaldığı için hüküm yine PARTIAL olur. Faz 10'da ana komut atlanırsa ek taramalar da koşmaz. Faz 14 ve 15'te ek tarama yoktur.

Faz 16 (E2E) da aynı mekanik koşucuyla çalışır; komutu stack profilinden proje türüne göre seçilir. Koşmadan önce MyCL Playwright'ı kurar ve bir duman testi iskeleti hazırlar. Bu hazırlık başarısız olursa faz `precheck_fail`, ayarlarda Playwright kapalıysa `playwright_disabled` nedeniyle atlanır.

Faz 17 mekanik koşucuyu kullanmaz. `nuclei` ile hızlı profilde sızma testi yapar: yalnız yüksek ve kritik önemdeki şablonları kullanır ve en fazla 40 adresi tarar (`katana` kuruluysa sayfaları gezer). Yalnız macOS ve Linux'ta, çalışan bir geliştirme sunucusu varken koşar. Araç kurmaz; koşamazsa `phase-17-skipped` yazar. Bulgu bulursa bulgular iş kuyruğuna eklenir ve faz `soft_complete_after_fail` ayrıntısıyla tamamlanır; bu da hükmü PARTIAL yapar. 🛡️ Güvenlik Taraması butonu ise onay sorusundan sonra bütün önem düzeylerini tarayan tam profili kullanır. Eksik araçları kurmayı deneyen [tool-ensure.ts](orchestrator/src/tool-ensure.ts) (`nuclei`, `katana`, `semgrep`; brew, go install, pipx ya da pip3 ile) yalnız bu butonun akışında çağrılır.

**Otomatik düzeltme.** Bir mekanik kapı başarısız olursa ve Oto-cevap açıksa, MyCL o fazda bir kez odaklı bir düzeltme dener ([gate-autofix.ts](orchestrator/src/gate-autofix.ts)). Bu iş için ana model kullanılır ve yalnız `Read`, `Edit`, `Grep`, `Glob` araçlarına izin verilir. Talimat testleri zayıflatmayı ve kural kapatmayı yasaklar. Önce bir anlık yedek alınır, sonra kapı yeniden koşar. Kapı geçerse ya da atlanırsa `gate_autofix_resolved` yazılır. Faz 9'dan sonraki bir düzeltmede testler yeniden koşturulur. Başarısız bir düzeltme geri alınırken düzeltme dizisinin başındaki yedeğe dönülür; Faz 5 ve Faz 8'in başında, kod yazılmadan önce alınan yedek yalnız elle dönüş içindir ve otomatik geri almanın hedefi olmaz. Geri alma iletisi hangi yedeğe dönüldüğünü ve kaç dosyanın silinip geri yazıldığını söyler. Geri alma projedeki bütün çalışan üretim dosyalarını silecek ve yedekte hiç çalışan kod yoksa yapılmaz; proje olduğu gibi kalır, sohbete görünür hata ile yedeğin yeri yazılır ve akış geri almadan sürer.

Müfettiş, bulgunun gerçek mi yoksa yanlış alarm mı olduğuna karar veren ayrı bir model incelemesidir. Açıksa (varsayılan açık) düzeltmeden önce bulguyu inceler. Yanlış alarm derse düzeltme yapılmaz ve faz `mahkeme_false_positive_suppressed` ayrıntısıyla tamamlanmış sayılır. Kuşkulu derse otomatik düzeltme yapılmaz ve bulgu normal hata akışına gider. Faz 13'te müfettiş bir bulguyu yanlış alarm sayarak kapatamaz; böyle bir karar "kuşkulu"ya çevrilir, bulgu rapora yazılır ve akış otomatik "Kabul et, devam et" ile sürer.

Kapı çözülmezse Oto-cevap kapalıyken akış durur ve kullanıcının seçimini bekler. Oto-cevap açıkken MyCL bulguları rapora yazar ve akışı otomatik "Kabul et, devam et" ile sürdürür. Her iki durumda da hüküm PARTIAL olur; başarısız bir Faz 13 hiçbir yolla "geçti" sayılmaz. Faz 13'e özgü kurallar:

- Çıktıdaki bütün "N Code Findings" sayıları toplanır. Toplam iki deneme üst üste azalmazsa ya da sayı okunamazsa otomatik düzeltme durur ve akış "Kabul et, devam et" ile sürer ([security-convergence.ts](orchestrator/src/security-convergence.ts)).
- Analiz birden çok ayrı bulgu çıkarırsa bulgular teker teker ele alınır: Oto-cevap kapalıysa her biri ayrı sorulur, açıksa sırayla otomatik uygulanır. Kapı en sonda bir kez yeniden koşar ([finding-queue.ts](orchestrator/src/finding-queue.ts)).
- Oto-cevap kapalıysa MyCL hatayı analiz edip çözüm seçeneklerini sorar. Analiz üretilemezse yalnız "Kabul et, devam et" ve "Tekrar analiz et" seçenekleri sunulur.

Bir faz arka arkaya 3 kez başarısız olursa `phase-loop-break` yazılır. Bu durumda Oto-cevap açıksa ve testler yeşilse MyCL fazı kendisi kabul eder.

**İterasyon kapıları.** Her iterasyon başında bir model, kapalı bir sözlükten (`assets/gate-pool.json`) o işe özel kapılar seçer. Sözlükte altı kapı vardır: `file_immutable`, `forbid_new_files` ve `forbid_dependency_change` araç çağrısı anında engeller; `file_must_change`, `schema_check` ve `test_must_pass` akış sonunda denetlenir. `file_immutable` ve `forbid_dependency_change` akış sonunda ayrıca başlangıç durumuyla karşılaştırılır; böylece Bash ile yapılan değişiklik de yakalanır. Geçersiz bir seçim uygulanmaz ve sohbette nedeniyle yazılır; örneğin projede hiç bağımlılık bildirim dosyası yokken `forbid_dependency_change` reddedilir, çünkü kilitlenecek bir şey yoktur ve kilit ilk bildirim dosyasının yazılmasını engellerdi. Kabul edilen seçimler `.mycl/overlays/current.json` dosyasına yazılır; derlenemezse iterasyon başlamaz ([gate-overlay/](orchestrator/src/gate-overlay/)). Akış sonunda her kapı için Faz 16'ya `overlay-file-must-change-pass` gibi bir olay yazılır; kapı adındaki alt çizgiler tireye çevrilir. Bir `-fail` olayı hükmü PARTIAL yapar; iş "Tamamlandı" sayılmaz ve kuyruğa geri döner.

## Hüküm ve denetim kaydı

MyCL her olayı `.mycl/audit.log` dosyasına satır başına bir JSON olarak ekler ([audit.ts](orchestrator/src/audit.ts)). Olay adları yalnız yazdırılabilir ASCII karakterlerden oluşabilir; Türkçe karakter içeren bir olay adı yazılmaz, hata verir. Her satır yazıldıktan sonra diske zorla aktarılır (`fsync`). Akış sonundaki hüküm bu kayıttan, yalnız bu iterasyonun olaylarıyla hesaplanır ([harness-verdict.ts](orchestrator/src/harness-verdict.ts)). Kurallara yukarıdan aşağı bakılır; ilk uyan kural hükmü belirler:

| Koşul | Hüküm |
|---|---|
| Kaydın bütünlüğü doğrulanamadı | FAIL |
| Akış bitti ama hiçbir teslim dosyası yok | FAIL |
| `phase-17-complete` yok | FAIL |
| Bir `-fail` olayı ya da `soft_complete_after_fail` ayrıntılı bir `-complete` var | PARTIAL |
| Faz 13'te herhangi bir atlama ya da Faz 17'de araç eksikliği veya tarama hatası | PARTIAL |
| Faz 16 atlandı ve neden MyCL'in kapatabileceği bir boşluk | PARTIAL |
| Gerçek uygulama doğrulaması koşamadı | PARTIAL |
| Hiçbiri | PASS |

Bir iterasyonda yazılmış bir `-fail` olayı silinmez. Kapı sonradan fazın içinde düzeltilse, müfettiş bulguyu yanlış alarm saysa ya da kullanıcı "Kabul et, devam et" dese de hüküm PARTIAL kalır. Faz 10, 11, 12, 14 ve 15'teki atlamalar hükmü düşürmez; yalnız doğrulama özetinde görünür. Faz 17'nin çalışan sunucu olmadığı ya da desteklenmeyen bir platformda koştuğu için atlanması da hükmü düşürmez. Faz 16'nın arayüzü olmayan proje, kapalı Playwright ayarı ya da E2E'ye çevrilemeyen stack nedeniyle atlanması da öyle.

Sonuç sohbette "📋 Akış özeti" olarak gösterilir ([pipeline-end-summary.ts](orchestrator/src/pipeline-end-summary.ts)). Sonuç satırı üç biçimden biridir: "✅ Tamamlandı", "KISMÎ (tam doğrulanmadı)" ya da "BAŞARISIZ". Hüküm PASS olsa bile E2E testi yalnız genel bir sayfa açılış kontrolüyse ya da giriş bilgisi yer tutucuysa sohbetteki sonuç satırı "KISMÎ" olur; arayüze giden hüküm PASS kalır. Altında "🚦 Çalışma kanıtı" satırı (E2E geçti mi, ekran boş değil mi, giriş zinciri sağlam mı, çalışma zamanı hatası var mı) ve token dökümü yer alır. Arayüze `pipeline_end` olayı gider; hüküm hesaplanamazsa bu olay PARTIAL olarak gönderilir. Prototip kaydı ve modül stoğu bu hükmü kullanır. Arayüz olmadan çalışan [harness.mjs](orchestrator/harness.mjs) aynı hesabı bütün kayıt üzerinde yapar ve 0 (PASS), 2 (PARTIAL) ya da 1 (FAIL) çıkış koduyla biter; bütünlük ve teslim dosyası denetimlerini yapmaz.

Kaydın değiştirilmediği iki ayrı yolla denetlenir:

- **Çapa** ([audit-anchor.ts](orchestrator/src/audit-anchor.ts)): Çapa, kaydın belirli bir andaki hâlinin parmak izidir. Her iterasyon başında `audit.log` ve `accepted-findings.jsonl` dosyalarının o anki uzunluğu ve SHA-256 özeti `audit-anchors.json` dosyasına yazılır. Bu dosya proje klasöründe değil, MyCL'in genel ayar klasöründedir (macOS'ta `~/.mycl`; bütün platformlar için [Diskte ne nerede durur](#diskte-ne-nerede-durur)). Akış sonunda dosyalar çapadan kısaysa ya da baştaki kısım farklıysa kayıt kurcalanmış sayılır. Çapa yoksa kurcalama sayılmaz.
- **Süreç içi tanık** ([audit-ledger.ts](orchestrator/src/audit-ledger.ts)): Tanık, MyCL sürecinin bellekte tuttuğu kayıttır. Süreç `audit.log`'a yazdığı her satırın özetini tutar. Akış sonunda (dosya okunmadan önce ve sonra) şunlar aranır: önceki kısım değişmemiş olmalı, yazılan her satır dosyada bir kez bulunmalı ve dosyada yabancı satır olmamalı. `accepted-findings.jsonl` için yalnız eklenmiş yabancı satır aranır. Tanık kararlı bir an yakalayamazsa (kayıt sürekli yazılıyorsa) ya da hiç yazım olmadıysa bu kurcalama sayılmaz, yalnız günlüğe not düşülür. Tanık MyCL yeniden başlatılınca sıfırlanır. Aynı proje iki MyCL penceresinde açıksa öbür pencerenin satırları yabancı görünür.

İki denetimden biri kurcalama bulursa sohbete "⛔ Çalışma kaydının bütünlüğü doğrulanamadı" yazılır ve hüküm FAIL olur.

**Kabul edilen bulgular.** `.mycl/accepted-findings.jsonl` dosyası, kalıcı olarak kabul edilmiş teknik borç bulgularını tutar. Her kayıt dosya, kategori ve normalleştirilmiş kod parçasından oluşur. Kayıt üç yolla yazılır: kullanıcı "Kabul et — kalıcı, bir daha sorma" seçeneğini seçtiğinde, tekrar eden başarısızlıkta faz otomatik kabul edildiğinde ya da Faz 13 bulgu kuyruğunda bir güvenlik bulgusu kalıcı kabul edildiğinde (kategori `security`). Bu dosyayı yalnız Faz 8 ve Faz 9 okur ve eşleşen bulguyu bir daha işaretlemez; güvenlik taramaları okumaz. Bir satırı silmek o bulguyu yeniden etkin yapar. Silme iki iterasyon arasında yapılmalıdır: iterasyon sürerken çapalanmış bir satırı silmek çapa denetimine kurcalama olarak takılır ve hüküm FAIL olur.

## Güvenlik sınırları

Kod yazan ajan iki yoldan biriyle koşar. **CLI yolunda** MyCL `claude` komutunu (Claude Code aboneliği) başlatır. **API yolunda** model Anthropic API üzerinden konuşur ve araçlarını MyCL kendisi çalıştırır. Koruma iki yolda farklıdır.

**CLI yolu.** MyCL her `claude` başlatışına `--settings` ile bir ayar bloğu verir ([agent-sandbox.ts](orchestrator/src/agent-sandbox.ts)). Bu blok Claude Code'un yerli kum havuzunu açar. Kum havuzu, işletim sisteminin ajanın kabuk komutlarını belirli dizinlere hapsetmesidir: macOS'ta Seatbelt kullanılır, Linux'ta `bwrap` ve `socat` kurulu olmalıdır. Kum havuzu dışında komut çalıştırma seçeneği kapalıdır. Ajan `--permission-mode bypassPermissions` ile koşar; engel olarak ret listesi ve aşağıdaki kurallar kalır.

| Katman | Ne yapar |
|---|---|
| Kabuk okuması | Ev dizininin tamamı kapalıdır. Yalnız proje ve çalışma zamanı dizinleri açılır: `.claude`, `.claude.json`, `.config`, `.local`, `.cache`, `.npm`, `.nvm`, `.bun`, `.asdf`, macOS'ta `Library`. |
| Ev dizini muhafızı | Proje ev dizini altındaysa dosya araçları (Read, Write, Edit, Glob, Grep…) için iki katman kurulur: projeye giden yoldaki her kardeş girdi için okuma reddi ve araç çağrısından önce çalışan [home-guard.mjs](orchestrator/home-guard.mjs) kancası. Kanca ev dizini içinde olup proje dışında kalan her hedefi engeller; henüz var olmayan adlar, sembolik bağlantılar ve Unicode farkları da kapsanır, büyük küçük harf farkı yalnız macOS'ta katlanır. Kanca hata durumunda reddeder: kurallar ya da araç çağrısının girdisi okunamazsa ya da sembolik bağlantı zinciri 64 adımı aşarsa çağrı engellenir. Proje ev dizini dışındaysa ev dizini tek kuralla kapatılır. |
| Yazmaya kapalı yollar | Projedeki `.git/`, `.mycl/` (MyCL'in kanıt kaydı) ve kökteki ajan talimat dosyaları `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`, `.claude/`. Okuma açıktır. |
| Yazmaya açık ev dizinleri | Yalnız `~/.npm` ve `~/.cache` (paket önbelleği). |
| Ağ | Yalnız şu alan adları: `registry.npmjs.org`, `registry.yarnpkg.com`, `registry.npmjs.com`, `nodejs.org`, `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`. Yerel port açma izni (ajanın 127.0.0.1 üzerinde kendi test ya da dev sunucusunu açabilmesi) yalnız şu çağrılara verilir: `phase-5`, `phase-8`, `verify-feature`, `parallel-module` ve `gate-autofix` kod yazma çağrıları, Faz 0 hata ayıklama araştırması ve müfettiş (bulguyu kendisi yeniden üretmeye çalışan salt okunur denetçi). Diğer bütün çağrılarda kapalıdır. |
| Kabuk ret listesi | Her çağrıda `Bash(rm *)`, `Bash(sudo *)`, `Bash(git push *)`, `Bash(chmod *)` ve `npm`/`yarn`/`pnpm publish` reddedilir ([tool-policy.ts](orchestrator/src/tool-policy.ts)). Salt okunur fazlar üç düzeyde kısılır: yazma araçları ve alt ajan araçları (`Agent`, `Task`) kapalı, Bash açık; bunlara ek olarak Bash da kapalı; ya da okuma ve web araçları dahil hiçbir araç açık değil. Tek seferlik ve oturumlu `claude` çağrılarında ret listesi zorunludur; liste vermeyen çağrı tam yetkiyle değil, üçüncü düzeyde (araçsız) koşar. Girdisi tümüyle istemde olan yardımcı çağrılar (ilgililik sınıflandırıcısı, konuşma özeti, sohbet özeti, proje tipi, ders damıtma) araçsızdır ve MyCL'in başlatıldığı klasörde değil, MyCL'in genel ayar klasöründe koşar (sohbet özeti proje klasöründe koşar). Bu çağrılar `claude` sürecine `--tools ""` (hiç yerleşik araç yok) ve `--strict-mcp-config` (kullanıcının MCP sunucuları yüklenmez) ile başlatılır; ret listesi ikinci kat olarak kalır. Bu çağrılar Claude Code'un ajan istemine eklenmez, kendi istemleriyle (`--system-prompt`) koşar; kullanıcının kişisel ve proje talimat dosyaları (CLAUDE.md) ve otomatik hafızası onlara girmez. Kullanıcı metni istemde açıkça veri olarak sınırlanır ve çıktı talimatı verinin ardından yinelenir. |

Kum havuzu politikası MyCL ayar dosyasındaki `claude_code_flags.agent_sandbox_policy` alanıdır; arayüzde karşılığı yoktur. Varsayılan `enforce`: kum havuzu kurulamazsa (Linux'ta `bwrap` ya da `socat` yoksa, macOS ve Linux dışında her platformda) ajan başlatılmaz ve sohbette "🔒 Sandbox kurulamadı" hatası çıkar. `warn` kum havuzunu yine kurar; yalnız kurulamazsa sohbette "⚠️ Sandbox kurulamadı" uyarısı verip ajanı hapissiz çalıştırır. `off` kum havuzunu ve ev dizini okuma korumasını kapatır. Yazmaya kapalı yollar kuralı yine gönderilir, ama yalnız dosya araçları (Write, Edit…) için geçerlidir: kabuk komutları bu yollara yazabilir. Dar ev dizini kuralları üretilemezse (dizin listelenemez, ad listede aynen bulunmaz, kurallar 64 KB'ı aşar, muhafız betiği yoktur ya da kurulum yolunda kabuk için özel karakter vardır) MyCL ev dizinini tümüyle kapatır ve sohbette uyarır. O projede ajan dosya araçlarını kullanamaz, yalnız kabuk komutlarıyla çalışır.

**Dosya odaklı kapılar.** Bir iterasyonda dosya odaklı kapılar seçildiyse (değiştirilemez dosya, yeni dosya yasağı, bağımlılık dosyası yasağı), yazma araçları çağrıldığı anda engellenir: CLI yolunda [overlay-guard.mjs](orchestrator/overlay-guard.mjs) kancasıyla, API yolunda aynı karar fonksiyonuyla. Kurallar komut satırında gelir, ajan bunları değiştiremez; kanca hata verirse yazma reddedilir. Kum havuzu politikası `off` olsa da uygulanır. Kapıların nasıl seçildiği [Doğrulama kapıları](#doğrulama-kapıları) bölümündedir.

macOS'ta izinli araç listesinde Bash bulunmayan tek seferlik ve oturumlu `claude` çağrıları ayrıca `sandbox-exec` ile sarılır ([claude-folder-guard.ts](orchestrator/src/claude-folder-guard.ts)); kod yazma ajanı bu sarmalamaya girmez. Bu sarmalama `Downloads`, `Documents`, `Desktop`, `Music`, `Pictures`, `Movies` ile `Library` altındaki `Containers`, `Group Containers`, `Application Support`, `Mail`, `Calendars` ve `Mobile Documents` dizinlerinin okunmasını reddeder. Ayrıca macOS izin aracısına ve medya servislerine bağlantıyı keser; böylece sistem izin pencereleri açılmaz. `MYCL_CLAUDE_FOLDER_GUARD=0` ile kapatılır.

**API yolu.** Araçları [tool-handlers.ts](orchestrator/src/tool-handlers.ts) çalıştırır. Proje kökü dışındaki yollar reddedilir. Glob ve Grep proje kökündeki `.mycl/`, `node_modules/`, `dist/`, `build/`, `.git/` dizinlerini taramaz; alt dizinlerdeki aynı adlı dizinler (ör. `web/dist/`) bu listeye girmez. Write ve Edit bu beş kök dizine, kökteki ajan talimat dosyalarına ve fazın kendi yasak yollarına yazmaz. Faza özel yasak yollar Faz 0, Faz 5 ve Faz 8'de kullanılır; Faz 5'te giriş ve oturum yolları (`auth`, `login`, `session`) bu yasaktan muaftır. Her Bash komutu çalışmadan önce [bash-guard.ts](orchestrator/src/bash-guard.ts) düzenli ifade listesinden geçer. Bu liste kök dizine, ev dizinine ya da `.git`'e yönelik `rm -rf`, `sudo`, zorla push, uzak dala `git reset --hard`, `curl … | sh`, paket yayınlama, `chmod 777`/`666`/`a+w`, doğrudan disk yazımı, çatal bombası ve proje iskelesi kurucularını (`create-next-app`, `npm init`…) reddeder. Sıradan bir `rm` komutu reddedilmez. Ev dizinindeki kabuk ve kimlik dosyalarına, sistem dizinlerine, `.mycl`, `.git` ve talimat dosyalarına yazma girişimleri de reddedilir. Komut proje kökünde giriş kabuğu olarak (`bash -lc`) koşar. Süre sınırı varsayılan 60 saniyedir; paket kurulumu ve bazı derleme komutlarında (`npm install`, `pip install`, `cargo build`, `docker build`…) 300 saniyedir. Model kendi süresini verebilir, ama süre en az 1, en çok 600 saniyeye kırpılır.

**Karar ajanı.** Sohbetteki karar ajanı (orkestratör) API yolunda yalnız okur. Kabukta yalnız `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `find`, `echo` ve `git status|log|diff|show|branch|remote|config` çalışır. `;`, `|`, `>`, `$(` gibi kabuk işaretleri, `~` ve proje dışını gösteren yol argümanları reddedilir ([path-sandbox.ts](orchestrator/src/orchestrator-agent/path-sandbox.ts)). CLI yolunda karar ajanı salt okunur değildir ([cli-orchestrator.ts](orchestrator/src/orchestrator-agent/cli-orchestrator.ts)): Read, Grep, Glob ve Bash açıktır; yalnız Write, Edit, NotebookEdit ve `rm`, `sudo`, `git push`, `git commit`, `chmod`, `npm publish`, `curl`, `wget` ile başlayan kabuk komutları reddedilir. Kabuk yönlendirmesiyle dosya yazabilir; onu sınırlayan kum havuzudur.

**Ortam değişkenleri.** MyCL'in başlattığı alt süreçler (`claude`, test ve derleme komutları, dev sunucu, API yolunun Bash'i) yalnız izin listesindeki değişkenleri alır ([safe-env.ts](orchestrator/src/safe-env.ts)). Listede kabuk temelleri (PATH, HOME, USER, SHELL, PWD, TERM, TZ), dil ayarları, geçici dizin, Node değişkenleri (`NODE_PATH`, `NODE_OPTIONS`, `NODE_ENV`), Node sürüm yöneticisi değişkenleri, birkaç tarama aracı ayarı (`SEMGREP_RULES`, `K6_*`) ve `LC_`, `npm_` önekleri vardır. Adında `auth`, `token`, `secret`, `password`, `passwd`, `credential`, `apikey`, `api_key` ya da `private_key` geçen değişken listede olsa bile geçmez (büyük küçük harf farkı gözetilmez). 100 KB'ı aşan değişken atılır ve sohbette bir kez uyarı çıkar. `claude` başlatılırken API anahtarı eklenmez. Günlüklerde `sk-ant-` ile başlayan anahtarlar ve `api_keys` alanının tamamı maskelenir ([logger.ts](orchestrator/src/logger.ts)).

**Onay kapıları.** Entegre bir projede (MyCL dışında başlamış proje) Faz 9 risk düzeltmeleri var olan kodu değiştirmeden önce dokunulacak davranışı gösterip sorar: "Hepsini uygula", "Yalnız seçtiklerim", "Hiçbirini (bu tur atla)". Uygulamadan önce kesin dosya listesi için ayrıca "Uygula" ya da "İptal (uygulama)" sorulur ([foreign-write-consent.ts](orchestrator/src/foreign-write-consent.ts)). MyCL projelerinde yeni bir iterasyonda Faz 8 başlamadan önce, spec değişikliğinin dokunduğu var olan her davranış tek tek sorulur: değişen davranış için "Evet, değiştir" ya da "Hayır, dokunma", kaldırılan davranış için "Evet, kaldır" ya da "Hayır, dokunma" ([behavior-consent-gate.ts](orchestrator/src/behavior-consent-gate.ts)). Aynı değişiklik önceki bir iterasyonda sorulduysa önce "Evet, aynısı" / "Hayır, yeniden karar ver" sorulur. Değişiklik sayısı 12'yi aşarsa tek soru gelir: "Hepsini onayla, devam et" ya da "Dur, spec'i gözden geçireceğim". "Hiçbir şey sorma" modu açıksa (varsayılan kapalı) iki kapı da sormadan onaylar ve neyi onayladığını sohbette gösterir.

### Bilinen sınırlar

- MyCL test, lint, derleme ve düzeltme komutlarını ([mechanical-runner.ts](orchestrator/src/base/mechanical-runner.ts)) ve dev sunucuyu ([dev-server-launcher.ts](orchestrator/src/dev-server-launcher.ts)) kum havuzu dışında, senin kullanıcı yetkilerinle, proje kökünde kabukla çalıştırır. Bu komutlar ajanın yazdığı betikleri (ör. `package.json` script'leri) de çalıştırır. Dosya ve ağ kısıtı yoktur, yalnız ortam süzgeci uygulanır.
- API yolunda işletim sistemi kum havuzu yoktur. Bash, ağ dahil senin erişebildiğin her yere erişir. bash-guard yalnız açık desenleri yakalar; `cd`, değişken dolaylaması ya da bir betikle aşılabilir. Giriş kabuğu senin giriş dosyalarını (ör. `~/.bash_profile`) okur; orada tanımlanan değişkenler ortam süzgecinden sonra yeniden yüklenebilir.
- API yolundaki yol denetimi yol metnine bakar, sembolik bağlantıyı çözmez. Proje içinden dışarıya giden bir bağlantı üzerinden Read, Write ve Edit proje dışına ulaşabilir.
- CLI yolunda bash-guard çalışmaz; kabuk için yalnız ret listesi ve kum havuzu vardır. Fazın yasak yolları ve `node_modules/`, `dist/`, `build/` yazma yasağı yalnız API yolunda uygulanır.
- CLI yolunda ev dizini muhafızının ve okuma reddinin yetki alanı yalnız ev dizinidir. Kabuk ev dizini dışındaki yolları (ör. `/etc`, harici diskler) okuyabilir; dosya araçları (Write, Edit…) için de ev dizini dışında ek kural yoktur. Açık bırakılan çalışma zamanı dizinleri (`~/.config`, `~/.claude.json` gibi) başka araçların kimlik bilgilerini içerebilir.
- Ev dizini muhafızı sert bağlantıları (hardlink) ayırt edemez ve MCP araçlarını kapsamaz. Denetim araç çağrısından önce ayrı bir süreçte yapılır; bir bağlantıyı arka planda değiştiren kasıtlı bir saldırı aradaki boşluğu kullanabilir. Kanca hiç yüklenmezse yalnız var olan girdiler korunur. Proje ev dizininin kendisiyse dosya araçları için ev dizini koruması yoktur.
- Talimat dosyası koruması yalnız proje kökünü kapsar; alt dizinlerdeki `CLAUDE.md` dosyaları yazılabilir.
- "Hayır, dokunma" cevabı yazmayı engellemez; ajana talimat olarak verilir. Ajan reddedilen davranışın `.feature` ya da test dosyasına yazarsa, yazma gerçekleştikten sonra sohbette uyarı ve `behavior-consent-violation` kaydı çıkar. Kaynak kod dosyaları bu denetime girmez.
- Windows desteklenmez; `enforce` politikasında ajan başlatılmaz.

## Hafıza ve öğrenme

MyCL bir koşudan ötekine bilgiyi düz dosyalarda taşır; ayrı bir veritabanı sunucusu çalıştırmaz. Üç kapsam vardır: **proje** (projenin `.mycl/` ve `devs/` klasörleri), **kullanıcı** (bütün projelerin ortak kullandığı kullanıcı klasörü, yeri [aşağıda](#diskte-ne-nerede-durur)) ve MyCL deposundaki `prototypes/` klasörü. "Orkestratör", kullanıcıyla konuşup hangi işin yapılacağına karar veren ajandır; aşağıdaki kayıtların çoğu onun istemine (prompt) eklenir. "Mahkeme", bir kapı hatasını inceleyip bulgunun gerçek mi yanlış alarm mı olduğuna karar veren müfettiş ajanıdır (`inspector_enabled`, varsayılan olarak açık).

| Ne saklanır | Kapsam | Sonraki koşuda nereye girer | Varsayılan |
|---|---|---|---|
| Hafıza kaydı: onaylanmış bir kararın özeti, etkilenen dosyalar ve tablolar | Proje ve/veya kullanıcı | Orkestratör istemi: projeden son 15 kayıt, genel hafızadan son 8 kayıt. "stack-specific" işaretli genel kayıt yalnız aynı stack'teki projede görünür. Stack bilgisi taşımayan genel kayıt, stack'i bilinen projede görünmez; projenin stack'i bilinmiyorsa bütün genel kayıtlar görünür | Kayıt yalnız orkestratör kaydetmeyi önerirse yazılır. Tekrar eden konuyu kendiliğinden bulan karşılaştırma kodda durur ama kapalıdır (her zaman "tekrar etmiyor" döner). Öneri gelince MyCL "Hangi hafızaya kaydedeyim?" diye sorar: "📁 Projeye özel", "🌐 Genel (başka projelerde de görünür)", "📁🌐 Her İkisi", "❌ Hayır". "🌐 Genel" seçilse de kayıt projeye de yazılır. "Hiçbir şey sorma" modunda "📁 Projeye özel" kendiliğinden seçilir. Genel hafızaya yazılan kayıt API anahtarı gibi bir kimlik bilgisine benziyorsa yazma engellenmez, yalnız günlüğe uyarı düşer |
| Cevap hafızası: tekrarlayan soruya verdiğin cevap | Proje | Aynı faz kapısı hatası ya da aynı Faz 3 kapsam önerisi yeniden gelince: ikinci seferde "Evet, aynı cevabı kullan" / "Hayır, yeniden karar vereyim" diye sorar, onaylanan cevabı sonraki seferlerde sormadan uygular ve bunu sohbete yazar. Onaylanan cevap aynı hatayı üç otomatik denemede çözemezse MyCL otomatik uygulamayı durdurur, bunu sohbete yazar ve soruyu yeniden sorar | Yalnız otomatik cevap modu kapalıyken çalışır. Hassas işaretli cevaplar her seferinde onay ister |
| Netleştirme kaydı: Faz 1/2 soruları ve cevapları | Proje, yalnız aynı iterasyon | Yarım kalan iterasyon yeniden açılınca Faz 1/2 ajanına "bunlar zaten yanıtlandı, tekrar sorma" diye verilir | Her zaman açık. İş yarıda bırakılıp durumu sıfırlanınca kayıt silinir |
| Ham ders: sorun, kanıtlı çözüm, ilke | Proje | Mahkeme benzer bir kapı hatasını incelerken en çok 3 ders ipucu olarak verilir. Geri alınmış dersler verilmez | Ders yalnız mahkeme kesin bir karar verdiğinde yazılır; karar insana bırakılırsa yazılmaz. Yeni bir karar önceki bir dersle çelişirse o ders geri alınır |
| Genel ders: projeden bağımsız 1-2 cümlelik ilke | Kullanıcı | Orkestratör istemine son 12 ders "öneri, hakikat değil" etiketiyle girer | Yalnız tam tartışmayla doğrulanmış ham dersler damıtılır. Metinde dosya yolu, URL, e-posta, proje adı, kod tanımlayıcısı ya da backtick varsa ders saklanmadan atılır |
| Kalıcı yönerge: işin nasıl yapılacağına dair genel tercih | Kullanıcı | Her orkestratör istemine "KULLANICI KALICI YÖNERGELERİ" bölümü olarak girer | Orkestra panelinden yazılır. Orkestratör yönergeyi açıkça benimserse kaydedilir; itiraz ederse ya da kararı net değilse kaydedilmez. Aynı yönerge iki kez eklenmez |
| Yaşayan dökümantasyon ve mimari karar kayıtları (ADR) | Proje | `features.md` Faz 0/1 proje bağlamına ve Faz 2'ye, ADR'ler ve kök `spec.md` Faz 2'ye girer | Kod içeren bir proje her açıldığında (iş sürerken değil), pipeline sonunda ve Full Test, DAST ve bakım işlerinden sonra kontrol edilir. Git HEAD'i, çalışma ağacı ya da kaynak dosyaların özeti son yazımdan beri değişmediyse yeniden üretilmez. Boş projede üretilmez |
| İterasyon spec'leri | Proje (`devs/`) | Faz 5, 7, 8 ve 9 o iterasyonun `iter-spec.md` dosyasını okur | Kök `spec.md` ve birim başına `page-spec.md` tazeleme yalnız orkestratör CLI (abonelik) modundayken yapılır |
| Modül stoğu: yeniden kullanılabilir özellik modülleri | Kullanıcı | Orkestratör istemine aynı stack'teki en çok 15 modülün özeti girer | Yalnız stack'i bilinen, tamamlanmış ve hiçbir kapısı düşmemiş, güvenlik ya da gerçek uygulama denetimi atlanmamış koşudan ve orkestratör CLI modundayken çıkarılır |
| Golden prototip | MyCL deposu | Faz 5 başında, aynı stack'teki ve henüz kodu olmayan yeni projeye kopyalanır. Var olan dosyaların üzerine yazmaz. 30 günden eskiyse yine kopyalanır ama bağımlılıkların bayat olabileceği uyarısı verilir | İterasyon tamamlanınca yazılır: sonuç PASS ise projenin tüm dosyaları, değilse yalnız iskelet ve yapılandırma dosyaları. Teslim edilebilir çıktı yoksa yazılmaz |
| Hata kataloğu: çalışma zamanı hataları | Proje (`error_folder/`) | Faz 6 ve düzeltme akışının kanıt toplama adımı son hataları ve çözülmemiş kayıtları okur | Faz 0 eksikse kurar. Sistemde `sqlite3` komutu gerekir; yoksa katalog kurulmaz ve MyCL bunu sohbete yazar |

Hafıza kayıtları, genel dersler ve kalıcı yönergeler istemlere her seferinde yukarıdaki gibi son N kayıt olarak girer. Spec, `features.md`, ADR'ler, vazgeçilen istekler ve olay kaydı gibi proje kaynakları ise **ilgililik seçiminden** geçer: MyCL bu kaynakları parçalara böler, önce anahtar kelimeyle eler, aday çoksa bir modelle puanlar ve yalnız işe en yakın parçaları ekler ([relevance/](orchestrator/src/relevance/)). Puanlama başarısız olursa adım bu bağlam olmadan sürer ve MyCL bunu sohbete yazar.

İki dış hafıza aracı vardır. İkisi de varsayılan olarak kapalıdır ve yalnız CLI ile çalışan kod yazan ajana `--mcp-config` ile bağlanır:

| Araç | Ne yapar |
|---|---|
| `codebase_memory_mcp` | Kodun yapısal grafiğini tutar ([codebase-memory-setup.ts](orchestrator/src/codebase-memory-setup.ts)) |
| `cognee_memory` | Proje başına kalıcı bilgi grafiği tutar; her proje `cognee-data/` altında ayrı bir klasördedir. Kullanılabilir bir API anahtarı ister. Gömme (embedding) için yerel bir model kullanır; bu model ilk kullanımda indirilir ([cognee-setup.ts](orchestrator/src/cognee-setup.ts)) |

## Diskte ne nerede durur

Kullanıcı klasörü: macOS'ta `~/.mycl`; Linux'ta `$XDG_CONFIG_HOME/mycl`, tanımlı değilse `~/.config/mycl`; Windows'ta `%APPDATA%\MyCL`. `MYCL_HOME` ortam değişkeni hepsini geçersiz kılar. `~/.mycl` zaten varsa her işletim sisteminde o kullanılır ([paths.ts](orchestrator/src/paths.ts)).

| Yol | İçerik |
|---|---|
| `.mycl/state.json` | Projenin faz durumu |
| `.mycl/audit.log`, `history.log`, `decisions.jsonl`, `cost.jsonl` | Olay kaydı ([Hüküm ve denetim kaydı](#hüküm-ve-denetim-kaydı)), sohbet geçmişi, Faz 4 kararları, maliyet kayıtları |
| `.mycl/agent-memory.jsonl`, `agent-decisions.jsonl` | Proje hafızası; tekrarlanan konuyu bulmak için orkestratör kararları |
| `.mycl/answer-memory.jsonl`, `clarify-log.jsonl` | Cevap hafızası; netleştirme soruları ve cevapları |
| `.mycl/lessons.jsonl`, `abandoned-intents.jsonl` | Ham dersler; vazgeçilen istekler |
| `.mycl/phase-history-<N>.jsonl` | API yolunda bir fazın konuşma kaydı; yarıda kalan faz buradan sürer |
| `.mycl/spec.md`, `features.md`, `tech-doc.md`, `user-guide.md`, `user-guide.en.md`, `help-pages.json`, `docs-stamp.json` | Projenin genel spec'i ve yaşayan dökümantasyon |
| `.mycl/decisions/ADR-NNNN-<slug>.md` | Mimari karar kayıtları (MADR biçimi) |
| `.mycl/trace.log`, `SCHEMA.md` | Proje açıkken günlük; dosya biçimlerinin açıklaması (her açılışta yeniden kopyalanır) |
| `devs/_pending/<zaman>/iter-spec.md` | Süren iterasyonun spec'i |
| `devs/pages`, `devs/endpoints` ya da `devs/tables` altında `<ad>/<zaman>/` | Biten iterasyonun `iter-spec.md` ve `meta.json` dosyaları |
| `devs/<tür>/<ad>/page-spec.md` | Bir sayfanın, uç noktanın ya da tablonun bütün iterasyonlardan biriken spec'i |
| `devs/_shared/<zaman>/pages.json`, `devs/<zaman>/` | Bir birime bağlanamayan değişiklikler; hiç birim yoksa iterasyon çıktısı |
| `error_folder/mycl_errors.db` | SQLite hata kataloğu. `.gitignore` dosyasına `error_folder/` satırı eklenir; MyCL dışında oluşturulmuş projede bu yalnız `.gitignore` zaten varsa yapılır |
| `docs/kullanim-kilavuzu.md`, `docs/user-guide.md`, `<statik klasör>/docs/help-pages.json` | Proje içine yazılan kullanım kılavuzu (Türkçe ve İngilizce) ve uygulama içindeki "?" penceresinin okuduğu sayfa verisi |
| `<kullanıcı klasörü>/config.json`, `secrets.json` | Tercihler ve API anahtarları (dosya izni 0600) |
| `<kullanıcı klasörü>/agent-memory-general.jsonl`, `global-lessons.jsonl`, `directives.md` | Genel hafıza, genel dersler, kalıcı yönergeler |
| `<kullanıcı klasörü>/modules/<ad>/module.json` | Stoklanmış modül ve dosyaları |
| `<kullanıcı klasörü>/trace.log`, `backups/`, `agent-skills/`, `codebase-memory/`, `cognee-src/`, `cognee-data/` | Proje açılmadan önceki günlük, düzeltme yedekleri, ajan becerileri, isteğe bağlı dış hafıza araçları |
| `prototypes/<stack>/`, `prototypes/<stack>.meta.json` | MyCL deposunda golden prototip ve oluşturulma bilgisi. `MYCL_PROTOTYPES_DIR` tanımlıysa oraya, `MYCL_HOME` tanımlıysa `<MYCL_HOME>/prototypes` altına yazılır |

## Arayüz

Uygulama açılınca **Proje Klasörü Seç** ekranı gelir. Burada iki düğme vardır: **📁 Yeni Klasör Seç** (yeni ya da boş proje) ve **📂 Proje Aç (Mevcut Projeyi Entegre Et)** (var olan bir proje). Altında **Son projeler** listesi durur; listeden kaldırmak proje klasörünü silmez. Bir pencere açıldıktan sonra projesi değiştirilemez; başka proje için **➕ Yeni Pencere** kullanılır. Ana ajan modeli seçilmemişse önce yalnız Ayarlar penceresi açılır.

Proje açıkken ekran şu parçalardan oluşur ([App.tsx](src/App.tsx)):

| Bölge | Ne gösterir |
|---|---|
| Üst bar ([AppHeader.tsx](src/components/AppHeader.tsx)) | Derleme zamanı, kilitli proje yolu, "MyCL · Faz N — durum" göstergesi (Faz 0 çalışırken "MyCL · Debug" yazar). Göstergeye tıklamak hata çekmecesini açar; kırmızı rozet hata sayısıdır. Akış kısmen ya da tamamen başarısız biterse "⚠ kısmî" / "✕ başarısız" etiketi çıkar. |
| Durum şeridi ([ActivityBar.tsx](src/components/ActivityBar.tsx)) | Her an görünen "MyCL şu an ne yapıyor" satırı: çalışan iş, cevap bekleyen soru, model bekleme süresi, takılı kuyruk işleri. |
| **Fazlar** menüsü ([PhaseSidebar.tsx](src/components/PhaseSidebar.tsx)) | Faz 0 (Hata Ayıklama) en üstte, ardından pipeline fazları. Tek tık sohbette o fazın en son başladığı yere gider, çift tık fazı çalıştırmak için onay sorar. Kalite kapısı (gate, otomatik kontrol) geçilemeyen faz ⚠ ile işaretlenir. |
| Sohbet ([ChatPanel.tsx](src/components/ChatPanel.tsx)) | Mesajlar, MyCL'in soruları (askq: seçenekli soru kartı), "Detay göster" ve "Kodu göster" (salt okunur kod penceresi), "⧉ Tümünü kopyala", mesajı alıntılayan yanıt düğmesi. Altta yazma kutusu: Enter gönderir, Shift+Enter alt satıra geçer. |
| Araç çubuğu (yazma kutusunun altı) | **Oto-cevap**, **Hiçbir şey sorma**, **🗺️ Plan modu** kutucukları; **➕ İş Ekle**, **🛡️ Güvenlik Taraması**, **🧪 Full Test** (çalışırken **İptal** olur), **🔧 Bakım** düğmeleri. Kutucuk tercihleri tarayıcı belleğinde (localStorage) saklanır ve uygulama açılınca orkestratöre yeniden bildirilir. |
| Sağ panel | Aynı anda yalnız biri açık olur: **Main Ajan** (kodu yazan Claude Code oturumunun canlı akışı), **🌐 Çeviri Ajanı** (Türkçe ile İngilizce arası çeviriler), **🧠 Orkestra Ajanı** (orkestratörün kararları ve nedenleri, **📄 Proje Dökümanı** düğmesi, **Yönerge ver** kutusu). |
| Sağ eylem çubuğu ([RightActionBar.tsx](src/components/RightActionBar.tsx)) | **▶ Çalıştır**, **⏸ Duraklat** / **▶ Devam**, **📋 İş Kuyruğu** (rozet aktif iş sayısıdır), **🧾 Özet**, üç ajan paneli, **👥 Ajan Takımı**, **📑 Faz Menüsü**, **➕ Yeni Pencere**, güncelleme düğmesi (↻), token sayacı (Σ), **🔊 Ses** / **🔇 Ses** (açıkken MyCL cevap beklediğinde bip çalar; varsayılan açık, tercih tarayıcı belleğinde saklanır), **⚙ Ayarlar**. |

Açılır paneller: **📋 İş Kuyruğu** (**Aktif** ve **Tamamlananlar** sekmeleri; işi silme, yeniden gönderme, deneme sayacını sıfırlama), **🧮 Token Zaman Çizelgesi** (token sayacına tıklayınca açılır; faz başına harcama ve tahmin), **👥 Ajan Takımı** (çoklu ajan takımlarının fazı, süresi, tokenı), **🧾 Sohbet Özeti**, hata çekmecesi, **📋 Spec İncelemesi** penceresi. Paneller Esc ile kapanır.

**Orkestra Ajanı** panelindeki **Yönerge ver** kutusu görev almaz, kalıcı kural alır (örneğin "her projede sürümleme yap"). Orkestratör itiraz ederse söyler, etmezse kuralı `~/.mycl/directives.md` dosyasına ekler ([user-directives.ts](orchestrator/src/user-directives.ts)).

**⚙ Ayarlar** penceresinin dört sekmesi vardır: Modeller, API Keys, Özellikler ve Hakkında. İçerikleri [Arka uçlar ve modeller](#arka-uçlar-ve-modeller) bölümündeki tablodadır.

## Elle başlatılan akışlar

Bu akışlar normal pipeline dışında, kullanıcı bir düğmeye basınca ya da bir kutucuğu açınca çalışır. Arayüzden gelen istekleri karşılayan kayıtlar [orchestrator/src/index.ts](orchestrator/src/index.ts) içindedir.

| Akış | Ne yapar |
|---|---|
| **📂 Proje Aç** | Var olan bir projeyi MyCL'e bağlar (onboarding). Kodu okur; `.mycl/` altına `project-map.json`, `onboarding-report.md`, `features.md` ve `tech-doc.md` yazar. Kaynak koduna dokunmaz; yalnız kullanım kılavuzunu (arayüz fazları atlanmıyorsa) projenin `docs/` klasörüne de yazar. Mevcut testleri bir kez koşup davranış temelini kaydeder, bulduğu eksikleri iş kuyruğuna ekler ve onay beklemeden sırayla işler. Proje okunamazsa onu erişilebilir bir "MyCL Projeler" klasörüne kopyalar ve kopyayı açar ([onboarding/](orchestrator/src/onboarding/)). |
| **🛡️ Güvenlik Taraması** | Önce açıklama yapar ve onay ister. Onay gelirse nuclei, katana ve semgrep kurulu mu diye bakar; eksik olanı kurmaya çalışır, kuramazsa bunu görünür bir hata olarak yazar. Sonra bağımlılık zafiyet taraması, semgrep ile statik tarama (SAST) ve çalışan uygulamaya katana + nuclei ile aktif tarama (DAST) aynı anda koşar; ardından giriş akışı otomatik giriş olmadan bir kez daha taranır. Yalnız localhost hedeflenir. Bulgular iş kuyruğuna düzeltme işi olarak girer ([dast-runner.ts](orchestrator/src/dast-runner.ts), [sast-scan.ts](orchestrator/src/sast-scan.ts), [dependency-audit.ts](orchestrator/src/dependency-audit.ts)). |
| **🧪 Full Test** | Onaydan sonra beş bölüm koşar: birim, entegrasyon, Playwright ile uçtan uca (E2E), rota taraması (konsol hatası, 400 ve üstü yanıt, boş sayfa) ve işlevsel doğrulama. Koşulamayan bölüm "atlandı" ve nedeniyle yazılır. Düşen bölümler iş kuyruğuna girer; **İptal** çalışan özellik bitince kalanları atlar ([full-test.ts](orchestrator/src/full-test.ts)). |
| **🔧 Bakım Turu** | Onaydan sonra güncel olmayan bağımlılıkları raporlar. Ardından profildeki `update` komutunu yalnız git ağacı temizse çalıştırır (geri dönüş noktası raporda verilir; git yoksa manifest yedeği alınır, yedek de alınamazsa güncelleme yine çalışır ve bu raporda risk olarak yazılır). Sonra bağımlılık taraması ve SAST koşar, en sonda her zaman Full Test çalışır. Otomatik geri alma yapmaz ([maintenance.ts](orchestrator/src/maintenance.ts)). |
| **🗺️ Plan modu** | Açıkken yazılan hedef önce adımlı bir plana çevrilir ve "✅ Planı onayla", "✏️ Düzenle", "Vazgeç" seçenekleriyle sorulur. Onaylanırsa adımlar iş kuyruğuna eklenir ve plan `.mycl/plans/` altına yazılır. Bu onay "Hiçbir şey sorma" açıkken de sorulur. Varsayılan olarak kapalı ([plan-mode.ts](orchestrator/src/plan-mode.ts)). |
| **📋 İş Kuyruğu** | **➕ İş Ekle** yazma kutusundaki metni kuyruğa ekler. İşler öncelik sırasıyla (eşit öncelikte eklenme sırasıyla) tek tek pipeline'dan geçer. Bitmeyen bir iş kuyruktan düşmez; otomatik olarak toplam en çok üç kez denenir, sonra kuyrukta görünür bekler ve deneme sayacı panelden sıfırlanınca yeniden ele alınır. Kuyruk `.mycl/task-queue.jsonl` dosyasında tutulur ([task-queue/](orchestrator/src/task-queue/)). |
| **⚡ Paralel iş kümeleme** | Açıksa birbirinden bağımsız en çok üç işin yalnız kod yazma kısmı ayrı git çalışma kopyalarında (worktree) aynı anda yapılır; kalite fazları birleşik sonuçta bir kez koşar. Proje bir git deposu değilse, çalışma ağacı temiz değilse ya da işlerin bağımsızlığı kanıtlanamazsa görünür şekilde sıralı akışa döner. Bu birleşik koşuda arayüz incelemesi (Faz 6) kendiliğinden açılmaz. Varsayılan olarak kapalı ([task-batch.ts](orchestrator/src/task-batch.ts), [module-parallel/](orchestrator/src/module-parallel/)). |
| **Oto-cevap** | Açıkken öneri içeren sorular o öneriyle kendiliğinden cevaplanır. Entegre edilmiş projede yalnız güvenli akış kararlarında çalışır. Varsayılan açık ([auto-answer.ts](orchestrator/src/auto-answer.ts)). |
| **Hiçbir şey sorma** | Tam otonom mod; açıkken Oto-cevap da zorunlu olarak açık kalır. Güvenlik Taraması, Full Test, Bakım Turu, plan onayı ve iş iptali soruları yine kullanıcıya gelir. Varsayılan olarak kapalı. |
| **🧾 Özet** | Sohbet geçmişini orkestratör rolüyle Türkçe özetler ve sonucu yalnız Özet panelinde gösterir; sohbete yazmaz. **🔄 Yenile** özeti yeniden üretir ([chat-summary.ts](orchestrator/src/chat-summary.ts)). |
| **⏸ Duraklat / ▶ Devam** | Duraklatınca yeni model çağrısı başlamaz; süren çağrı tamamlanır. Devam bekleyen çağrıları serbest bırakır. Durum kalıcı değildir, uygulama yeniden açılınca sıfırlanır ([pause.ts](orchestrator/src/pause.ts)). |
| **Faz 0 (Hata Ayıklama)** | Faz menüsünden başlatılamaz; hata sohbete yazılınca orkestratör başlatır. Ajan kök nedeni ve iki ila dört çözüm önerisini bulur. Oto-cevap bu karar için geçerliyse önerilen çözüm sorulmadan uygulanır; değilse kullanıcıya "Hangi çözümü uygulayalım?" diye sorulur. Tüm pipeline'ı yeniden başlatan bir çözüm hiçbir zaman kendiliğinden uygulanmaz, onay istenir. Hiçbir şey sorma açıkken bu onayı yalnız MyCL'in denetim kurulu verebilir; kurul kararsız kalırsa soru kullanıcıya kalır ([phase-0.ts](orchestrator/src/phase-0.ts)). |
| **▶ Çalıştır** | Sohbete "projeyi çalıştır" yazar ve projenin çalıştırma komutunu başlatır: Node projelerinde package.json içindeki `dev` ya da `start` betiği, diğer stack'lerde profildeki `run` ya da `dev` komutu. Komut bulunamazsa bunu söyler. Bir faz çalıştırmaz. |

Yaşayan dökümantasyon bir düğmeyle başlamaz, kendiliğinden güncellenir ([living-docs.ts](orchestrator/src/living-docs.ts)). MyCL `.mycl/features.md`, `.mycl/tech-doc.md` ve Türkçe ile İngilizce kullanım kılavuzunu üretir; kılavuz projenin `docs/kullanim-kilavuzu.md` ve `docs/user-guide.md` dosyalarına da yazılır. Kaynak değiştiyse proje açılışında, pipeline sonunda ve Güvenlik Taraması, Full Test ya da Bakım Turu bitince yenilenir; değişmediyse model çağrılmaz. Pipeline sonunda geliştirme sunucusu açıksa kılavuz için ekran görüntüleri alınır ([guide-shots.ts](orchestrator/src/guide-shots.ts)). Üretilen teknik döküman **📄 Proje Dökümanı** düğmesiyle görülür.

## Kurulum

Gerekenler: macOS ya da Linux, Node 22 veya üstü, Rust (`cargo`) ve Tauri'nin sistem kütüphaneleri. Windows desteklenmez; CI da yalnız macOS ve Ubuntu üzerinde derler.

```bash
bash setup.sh          # veya: npm run setup
```

[setup.sh](setup.sh) kurulu olanı atlar, eksik olanı kurmayı dener:

| Adım | Ne kurar |
|---|---|
| Paket yöneticisi | macOS'ta Homebrew yoksa Homebrew. Linux'ta apt ya da dnf kullanılır. |
| Node | Node 22 veya üstü (brew, NodeSource üzerinden apt, ya da dnf). Kurulamazsa betik durur. |
| Rust | `rustup` ile Rust. `cargo` yoksa betik durur. |
| Tauri bağımlılıkları | macOS'ta Xcode Command Line Tools. Linux'ta yalnız apt ile webkit2gtk-4.1, gtk3, librsvg2, appindicator3 ve derleme araçları. |
| Node paketleri | Kökte ve `orchestrator/` içinde `npm install`. |
| Güvenlik araçları | `nuclei`, `katana`, `gitleaks`, `osv-scanner` (macOS'ta brew; brew yoksa ya da başarısız olursa, `go` kuruluysa `go install`), `semgrep` (macOS'ta brew, yoksa pipx ya da pip). |
| Tarayıcı | Playwright Chromium. |
| nuclei şablonları | `nuclei -update-templates`. |

Betiğin kendi başına bitiremediği işler: Homebrew kurulumu etkileşimsiz çalışır ve parola soramaz, yönetici parolası gerekiyorsa başarısız olur (o durumda Homebrew elle kurulmalıdır, yoksa macOS'ta dört güvenlik aracı da kurulmaz); Linux'ta bazı adımlar `sudo` şifresi ister; Xcode Command Line Tools kurulum penceresi açar ve betik onu beklemez; dnf kullanan Linux'ta Tauri kütüphaneleri kurulmaz, yalnız uyarı verilir; Linux'ta `go` yoksa dört güvenlik aracı kurulmaz. Kurulamayan bir araç için betik durmaz, elle kurma komutunu uyarı olarak yazar.

`setup.sh`, `claude` komut satırı aracını (Claude Code CLI) kurmaz. Abonelikle çalışmak için bu araç gerekir; yoksa Otomatik mod doğrudan Anthropic API'yi kullanır ([Arka uçlar ve modeller](#arka-uçlar-ve-modeller)). Kurmak için Anthropic'in kurulum betiği kullanılır, ardından `claude auth login` ile oturum açılır:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```
 MyCL aracı `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` ve oturum kabuğunun PATH'inde arar.

## Çalıştırma

| Komut | Ne yapar |
|---|---|
| `npm run tauri dev` | Orchestrator'ı derler, Vite geliştirme sunucusunu açar, masaüstü penceresini başlatır. |
| `npm run dev:browser` | Arayüzü Tauri olmadan düz tarayıcıda açar (tarayıcı köprüsü ve Vite birlikte). Orchestrator'ı kendisi derlemez; önce `npm --prefix orchestrator run build` gerekir. |
| `npm run tauri build` | Paket üretir: macOS `.app`, Linux `.deb` ve AppImage. |
| `npm run desktop-icon` | Masaüstüne kısayol koyar (macOS `.app` bağlantısı, Linux `.desktop` dosyası). Önce `npm run tauri build` ile üretilmiş paket ister; paket yoksa hata verip durur. |
| `npm run deploy` | Orchestrator'ı derler, orchestrator testlerini çalıştırır, paketi üretir ve `/Applications` altına kopyalar; var olan sürümü `.prev` adıyla saklar (yalnız macOS). `deploy:fast` testleri atlar, `deploy:rollback` saklanan sürümü geri getirir. |

İlk açılışta ana ajan modeli seçilmemişse Ayarlar penceresi proje seçme ekranının üstünde kendiliğinden açılır ve "Modeller" sekmesinde model seçimi istenir. "API Keys" sekmesi isteğe bağlıdır: boş bırakılırsa MyCL yalnız abonelikle çalışır. Anahtar girilecekse "Translator API Key" ve "Main API Key" birlikte girilmelidir; "Orkestrator Ajan API Key (opsiyonel)" boş kalırsa Main anahtarı kullanılır. Anahtarlar ortam değişkenlerinden de okunur: `MYCL_API_KEY_TRANSLATOR` ve `MYCL_API_KEY_MAIN` tanımlıysa `secrets.json` içindeki değerin önüne geçer; ikisi de bulunmazsa yedek olarak `ANTHROPIC_API_KEY` kullanılır. Sonra "Proje Klasörü Seç" ekranı gelir: yeni ya da boş bir proje için "📁 Yeni Klasör Seç", var olan bir proje için "📂 Proje Aç (Mevcut Projeyi Entegre Et)". Seçilen klasör açıldıktan sonra o pencerede değiştirilemez; başka bir proje için "➕ Yeni Pencere" kullanılır.

Anahtarlar depoya yazılmaz. `secrets.json` macOS'ta `~/.mycl/`, Linux'ta `~/.config/mycl/` altında durur ve izni `0600` olur; `~/.mycl` ve `MYCL_HOME` kuralları [Diskte ne nerede durur](#diskte-ne-nerede-durur) bölümündedir.

## Stack profilleri

Stack, bir projenin dili ve paket yöneticisi demektir. MyCL bunu proje kökündeki dosyalardan bulur (`package.json` ve kilit dosyası, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pubspec.yaml` ...). Profil, o stack için komut tablosudur: kurma, çalıştırma, derleme, test, lint, performans, güvenlik, güncelleme komutları, proje türüne göre E2E komutu, varsayılan port ve eksik bağımlılık hata imzaları. Profiller [assets/profiles/](assets/profiles/) altında, yükleyici [orchestrator/src/profile-loader.ts](orchestrator/src/profile-loader.ts) içindedir.

19 profil vardır: `node-npm`, `node-yarn`, `node-pnpm`, `node-bun`, `deno`, `python-pip`, `python-poetry`, `python-uv`, `rust`, `go`, `ruby`, `php`, `maven`, `gradle`, `elixir`, `dart`, `flutter`, `swift`, `dotnet`. Eşleşen dosya yoksa stack `unknown` olur.

Destek her stack'te aynı derinlikte değildir:

- En dolu profil Node ailesidir. Dilin kendi aracıyla sadeleştirme komutu (`ts-prune`) yalnız dört Node profilinde tanımlıdır. Yalnız değişen dosyalara lint komutu (`lint_scoped`) Node ve Python (`python-pip`, `python-poetry`, `python-uv`) profillerinde tanımlıdır, ama bu daraltma şu an kullanılmaz ([Doğrulama kapıları](#doğrulama-kapıları)). Kurulum klasörü (`deps_dir`) Node profillerinde `node_modules`, `dart` ve `flutter` profillerinde `.dart_tool`, `elixir` profilinde `deps`, `php` profilinde `vendor` olarak tanımlıdır.
- Prototip, aynı stack'te yeni ve boş bir proje başlarken kopyalanan hazır başlangıç dosyalarıdır. Depoda hazır gelen iki prototip de `node-npm` içindir: `node-npm_react_next` tam çalışan bir projedir; `node-npm_typescript_react_next` yalnız yapılandırma dosyalarından oluşan bir iskelettir.
- Diğer stack'lerde MyCL büyük ölçüde profildeki komutları çalıştırır. Profilde komutu olmayan boyut o stack'te dilin kendi aracıyla ölçülmez: `dart`, `deno`, `flutter` ve `swift` profillerinde güvenlik komutu yoktur; 13 profilde performans komutu, Node dışındaki 15 profilde sadeleştirme komutu yoktur.
- Bu boşluklar için Faz 11 (Sadeleştirme), Faz 12 (Performans) ve Faz 13 (Güvenlik), profil komutu olmasa da dilden bağımsız taramalar çalıştırır. Ölçecek bir şey yoksa tarama "temiz" sayılmaz, görünür biçimde atlanır. Tarama listesi [Doğrulama kapıları](#doğrulama-kapıları) bölümündedir.

## Geliştirme

Her değişiklikten sonra çalıştırılacak tek komut `npm run check`'tir ([scripts/check.sh](scripts/check.sh)). Bir adım düşerse betik 1 ile çıkar. Atlanan bir adım varsa özet satırı bunu ayrıca söyler.

| Adım | Ne denetler |
|---|---|
| 1 | Orchestrator derlemesi (`tsc`) |
| 2 | Orchestrator testleri (`vitest`) |
| 3 | Arayüz tip denetimi (`tsc --noEmit`) |
| 4 | Git'in izlediği dosyalar arasında `secrets.json`, `auth.json`, `.env`, `.key`, `.pem` adlı dosya ya da `sk-ant-` ile başlayan anahtar var mı |
| 5 | Eskimiş ifadeler taraması |
| 6 | MyCL'in kendi semgrep kurallarının geçerliliği. `semgrep` yoksa yerelde atlanır, CI'da düşer; CI semgrep'i sabit sürümle (`semgrep==1.187.0`) kurduğu için orada adım hep çalışır. |
| 7 | Kodun kullandığı her dış aracı `setup.sh` kuruyor mu |
| 8 | Her ölçüm boyutu ya tüm profillerde tanımlı ya da dilden bağımsız bir taramaya sahip mi |

CI ([.github/workflows/check.yml](.github/workflows/check.yml)) `main`'e her push'ta ve her pull request'te Ubuntu üzerinde `npm run check` çalıştırır; ayrıca macOS ve Ubuntu üzerinde Tauri kabuğunu `cargo check` ile derler.

Testler `orchestrator/` altındaki `*.test.ts` dosyalarıdır, çoğu [orchestrator/test/](orchestrator/test/) içindedir. Tek başına: `npm --prefix orchestrator test`. [e2e/](e2e/) betikleri (`npm run e2e:smoke`, `e2e:tour`, `e2e:faz11`) arayüzü `orchestrator/node_modules` içindeki Playwright ve Chromium ile tarayıcıda sürer; CI'da çalışmaz, elle çalıştırılır. `smoke` hiçbir faz çalıştırmaz ve model ücreti doğurmaz; `tour` ve `faz11` küçük bir model ücreti doğurabilir.

Bu depoda çalışan yapay zeka ajanlarının uyduğu kurallar [CLAUDE.md](CLAUDE.md) dosyasındadır.

## Proje düzeni

```
src/              React arayüzü
src-tauri/        Rust ile yazılmış Tauri masaüstü kabuğu
orchestrator/     Node orchestrator: src/ kaynak, test/ testler, kökte .mjs denetim betikleri
assets/           stack profilleri, ajan istemleri, şablonlar, semgrep kuralları, çeviriler
prototypes/       golden prototipler: yeni projeye kopyalanan başlangıç dosyaları
browser-bridge/   arayüzü Tauri olmadan tarayıcıda çalıştıran köprü
e2e/              tarayıcıda uçtan uca betikler
scripts/          check.sh, deploy.sh, desktop-icon.sh
```

## Lisans

Depoda lisans dosyası yoktur; `package.json` ve `src-tauri/Cargo.toml` da lisans alanı taşımaz.
