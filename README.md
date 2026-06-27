
<img width="976" height="1096" alt="MyCL Studio" src="https://github.com/user-attachments/assets/2a471953-4ec7-48c7-9f87-1dc2b893c35b" />


Yapay zeka destekli yazılım geliştirme için masaüstü uygulaması. Kullanıcının
Türkçe niyetini alır, çok fazlı bir pipeline üzerinden çalıştırır ve Claude
modellerini Anthropic API üzerinden — opsiyonel olarak Claude Code CLI ile — ya da
**z.ai (GLM)** modellerini Anthropic-uyumlu endpoint üzerinden kullanarak kod üretir,
test eder ve kalite kapılarından geçirir. Sağlayıcı rol başına seçilir. Arayüz
Türkçedir; modellere giden tüm istekler İngilizceye çevrilir.

## Bileşenler

- **Frontend** (`src/`) — React 19 + Vite + TypeScript. Sohbet arayüzü, faz
  durumu, ayarlar ve canlı Claude çıktısı paneli.
- **Tauri host** (`src-tauri/`) — Rust. Pencereyi açar, orchestrator'ı bir alt
  process olarak başlatır ve frontend ile orchestrator arasında köprü kurar.
- **Orchestrator** (`orchestrator/`) — Node + TypeScript. Pipeline'ı yürüten
  asıl mantık. Tauri tarafından spawn edilir; iletişim stdin/stdout üzerinden
  satır-bazlı JSON (NDJSON) ile yapılır.

## Üç ajan rolü

Her rolün modeli **Ayarlar ekranından dinamik olarak seçilir** — hesabın
erişebildiği modeller listelenir, kod içinde sabit model ismi yoktur. Ayarlardan
ayrıca rol başına **Sağlayıcı** (Otomatik / Claude API / Claude Abonelik / **Z.AI**),
efor seviyesi ve özellik bayrakları yapılandırılır.

Sağlayıcı olarak **Z.AI (GLM)** seçilebilir: o rolün tüm çağrıları Anthropic-uyumlu
endpoint üzerinden bir GLM modeline (glm-5.2 … glm-4.5-air) gider. Her rol için ayrı
z.ai API anahtarı (translator / main / orchestrator) girilir; SDK ve CLI yolları,
forced tool-call, prompt-caching ve Deep Think dahil canlı doğrulanmıştır. Claude
seçili rollerde davranış birebir aynıdır (sıfır regresyon). Claude kredi/limit
dolduğunda o rol otomatik olarak z.ai'ye düşebilir (görünür mesajla).

- **Orchestrator** — Türkçe çalışır; kullanıcıyla konuşur, hangi fazın
  çalışacağına ve faz geçişlerine karar verir.
- **Translator** — Türkçe ↔ İngilizce çeviri yapar (iki yön).
- **Main (codegen)** — fazların asıl işini İngilizce yapar; yalnızca o anki
  görevi bilir.

Her role ayrı API anahtarı atanabilir. Anahtarlar proje dışında, platforma özel
config dizinindeki `secrets.json` içinde saklanır (izinler `0600`; konumlar için
[Çalıştır](#çalıştır) bölümüne bakın); depoya hiçbir anahtar girmez.

## Pipeline

İki giriş yolu vardır: yeni geliştirme/iterasyon (Faz 1 → 17) ve hata ayıklama
(Faz 0). Projeye uygun olmayan fazlar atlanır (örn. arayüzü olmayan projede UI
fazları; HTTP sunmayan — CLI/kütüphane — projede sızma testi). Faz tipleri dört
ortak controller'a dayanır:
`qa-askq` (kullanıcıya soru/onay), `production-schema` (şema üreten), `codegen`
(kod yazan), `mechanical-runner` (komut çalıştıran).

| # | Faz | Tip |
|---|-----|-----|
| 0 | Hata Ayıklama (Debug Triage) | codegen |
| 1 | Niyet Toplama | qa-askq |
| 2 | Hassasiyet Denetimi | qa-askq |
| 3 | Mühendislik Brifingi | production-schema |
| 4 | Spec Yazımı | production-schema |
| 5 | UI Yapımı | codegen |
| 6 | UI İnceleme (+ WCAG erişilebilirlik salt-raporu) | qa-askq |
| 7 | Veritabanı Tasarımı | production-schema |
| 8 | TDD Uygulama | codegen |
| 9 | Risk İncelemesi | qa-askq |
| 10 | Lint | mechanical |
| 11 | Sadeleştirme | mechanical |
| 12 | Performans | mechanical |
| 13 | Güvenlik | mechanical |
| 14 | Birim Testler | mechanical |
| 15 | Entegrasyon Testleri | mechanical |
| 16 | E2E Testler (UI varsa) | mechanical |
| 17 | Sızma Testi — **otomatik koşmaz**, 🛡️ Güvenlik Taraması butonuyla manuel | — |

## Var olan projeyi entegre etme ("Proje Aç")

Açılış ekranında iki yol vardır: **📁 Yeni Klasör Seç** (yeni/boş proje) ve
**📂 Proje Aç (Mevcut Projeyi Entegre Et)**. İkincisi, MyCL'in üretmediği — ilk kez
gördüğü — var olan bir projeyi MyCL'e taşır:

- **Derinlemesine anlama (salt-okuma):** yapı, hafif bağımlılık-merkezi haritası,
  dil/framework ve README + git geçmişinden "neden" türetilir (ağır graph DB yok).
- **MyCL dosyaları yalnız `.mycl/` altına kurulur:** `state.json`, `project-map.json`,
  yaşayan dökümantasyon (`features.md` / `tech-doc.md`) ve `onboarding-report.md`.
- **Eksikler iş-listesine OTOMATİK eklenir + sırayla yapılır:** test / responsive /
  güvenlik / parmak-izi gibi kaynak-değiştiren MyCL standartları GAP-raporu olur, her biri
  iş-listesine eklenip **onay beklemeden** normal gate'li iterasyonda sırayla işlenir.
- **Entegre modunda oto-cevap KAPALI:** mock mu gerçek-veritabanı mı gibi kararlar otomatik
  verilmez — sana sorulur. **Faz 6 (UI İncelemesi) de atlanır** (gap-işleri UI-yapımı değil,
  mevcut projede dev-server çoğu zaman yoktur).
- **Mevcut projeyi BOZMAZ:** yabancı kaynak dosyalarına dokunulmaz; MyCL yabancı bir
  projenin `vite.config`'ini onaysız düzenlemez ve mevcut `.gitignore`'a yalnız varsa
  ekler (yeni oluşturmaz). Okunamayan (sandbox) bir proje, ev-dışı **"MyCL Projeler"**
  klasörüne kopyalanıp orada işlenir; orijinal dosyalara dokunulmaz.

Onboarding bittiğinde proje birinci-sınıf bir MyCL projesi olur; sonraki geliştirmeler
normal pipeline'dan geçer (entegre modunda Faz 6 atlanır).

## Codegen backend'leri

Her ajan rolünün backend'i Ayarlar'dan rol başına seçilir:

- **Anthropic API** (SDK) — orchestrator'ın kendi turn döngüsü, kendi araçları
  (Read/Write/Edit/Bash/Glob/Grep), bash-guard ve path-sandbox ile.
- **Claude Code CLI** — `claude` komutu kuruluysa o rol bu CLI üzerinden çalışır.
  Seçili olup `claude` bulunmazsa sessizce düşülmez; görünür hata verilir.
  `~/.mycl/agent-skills` dizini varsa CLI'a `--plugin-dir` ile bağlanır.
- **Auto** — CLI ile başlar, abonelik kullanım limiti dolunca API'ye geçer, limit
  açılınca CLI'a döner.
- **Z.AI (GLM)** — o rolün çağrıları, rolün z.ai anahtarıyla Anthropic-uyumlu
  endpoint üzerinden GLM modeline gider (aynı SDK, baseURL override; geniş adapter
  yok). Hem SDK hem CLI yolları desteklenir; forced-CLI çok-ajanlı yollar (görsel
  tasarım, risk debate'i, paralel codegen) da z.ai'ye yönlenir. İstisna: bağımsız
  **müfettiş** ajanı çapraz-aile çeşitlilik için bilerek Claude'da kalır.

Karmaşık işlerde Faz 5 birden çok bağımsız tasarım üreten **çok-ajanlı tasarım
fan-out**'u kullanabilir; birbirinden bağımsız ≥2 modül varsa **Çoklu Ajan
Seçimi** modülleri izole git worktree'lerinde paralel yazıp ayrı bir adımda
entegre eder.

## Doğrulama ve güvenlik

- **Dürüst hüküm** — akış sonunda mekanik kapılar ve risk incelemesi tek bir
  sonuca toplanır: PASS / PARTIAL / FAIL. Araç yokluğundan atlanan boyutlar
  "doğrulanmadı" diye işaretlenir; patlayan bir kapı sessizce "tamamlandı"
  sayılmaz (yan menüde ⚠️, başlıkta kısmî/başarısız çip).
- **Düşman-gözü inceleme** (Faz 9) — bulan ve çürüten ajanlar birlikte çalışır;
  yanlış-pozitif bulgular elenir, gerçek riskler otomatik düzeltmeye yönlenir.
- **Mahkeme** (müfettiş ↔ orkestratör) — opsiyonel bağımsız denetim katmanı: bir
  gate/faz başarısız olup MyCL "düzeltmek" üzereyken, **farklı-aile bir model**
  (müfettiş) bulguyu kendi vantajından, **bizzat kanıt toplayarak** inceler. İki
  "bilim insanı" kanıt-temelli tartışır ve sonuç fix kararını **bağlar**:
  false-positive kanıtlanırsa çalışan kod korunur (düzeltme yapılmaz); kuşku /
  yüksek-risk / güvenlik insana yükseltilir; gerçek bulgu düzeltmeye gider —
  müfettişin bağımsız analizi düzeltmeyi besler.
  Yetki fix-kararları üzerinde evrenseldir (küçük değişiklik de incelenir), ama
  orkestratörün çalışan akışı asla zorla kesilmez. Ayrıca **döngü sınıfı**: aynı hata
  arka arkaya otomatik düzeltmeye rağmen geçmiyorsa (orkestratörün kendi göremediği
  yapısal kör-nokta), müfettiş döngüyü bağımsız inceler — fantom (false-positive) bir
  döngü kanıtlanırsa çalışan koda dönülüp devam edilir, aksi halde müfettişin bağımsız
  okuması eklenerek karar insana taşınır. Ve **netleştirme sınıfı**: orkestratör "emin
  değilim, sorayım" derken (oto-cevap açıkken) müfettiş bunu bağımsız tartar — gerçek
  belirsizlik (tercih/zevk/geri-alınamaz) ise sana sorar, gereksiz bir soruysa
  çıkarılabilir cevapla seni bekletmeden ilerler. Varsayılan **açık** (Ayarlar →
  müfettiş'ten kapatılabilir).
- **Sızma testi / DAST** — `katana` (gezinme) + `nuclei` ile çalışan uygulama
  aktif taranır. **Yalnız 🛡️ Güvenlik Taraması butonuyla manuel** çalışır (kullanıcı
  onaylı; pipeline'da otomatik koşmaz — pentest ağır olduğundan yükü kullanıcı kontrol
  eder). Bulgular önceliklenip otomatik düzeltme iterasyonlarına (Faz 3'ten) dönüşür.
- **Denetim Ajanı** (**🕵️**) — kullanıcının sorularıyla MyCL kendi çıktısını
  denetler; bir bulgunun MyCL'in kendi sorunu mu yoksa üretilen proje mi
  olduğunu ayırır.
- **Faz-Katkı Raporu** — pipeline bitiminde mahkeme her fazın o koşuya katkı
  yüzdesini değerlendirip Türkçe rapor olarak gösterir; düşük-katkılı fazlar
  işaretlenir, kullanıcı gereksizleri kendisi budamaya karar verir (otomatik
  budama yok).
- **Erişilebilirlik (WCAG) — salt-rapor** — Faz 6 UI incelemesinde, uygulama
  tarayıcıda açıkken çalışan adrese `axe-core` (WCAG 2.1 A/AA) ile bakılır. Bir
  **kapı değildir**: hiçbir fazı bloklamaz, otomatik düzeltme döngüsü tetiklemez —
  bulgular incelemenin yanında bilgi olarak gösterilir (yalnız `critical`/`serious`
  öne çıkar; karar kullanıcının). Hedef stack'ten bağımsızdır (MyCL'in kendi
  Playwright + axe'ı URL'e vurur); araç/erişim hatası "taranamadı" diye **görünür**
  şekilde geçer (sessiz "temiz" yok).
- **Mimari Karar Kayıtları (ADR)** — MyCL projenin gerçek mimari kararlarını
  (kimlik doğrulama stratejisi, veri deposu seçimi, güvenlik ödünleşimleri…)
  `.mycl/decisions/ADR-NNNN-*.md` altında MADR formatında tutar. Kayıtlar gerçek
  koddan türetilir, numara/tarih içerik değişmedikçe korunur, tarihsel olduğu için
  silinmez. Kararlar Faz 2 hassasiyet denetimine geri beslenir → ajan önceki kararla
  çelişmez / gereksiz yeniden-karar vermez.

## Golden prototip

Yeni bir proje Faz 17'ye kadar tamamlanıp **tüm gate'ler yeşil** olduğunda MyCL,
projenin **tüm dosyalarını** (bağımlılık/build çıktıları hariç) o stack'in golden
prototipi olarak `prototypes/<stack>/` altına kaydeder. Aynı stack'te yeni bir proje
başlatıldığında (Faz 5 öncesi) bu doğrulanmış-yeşil prototip iskelet olarak getirilir;
ana ajan sıfırdan değil çalışan baseline üzerine geliştirir.

## Stack profilleri

Proje tek bir dile bağlı değil. Manifest dosyalarından (`package.json`,
`pyproject.toml`, `Cargo.toml`, `go.mod` vb.) projenin stack'i tespit edilir ve
[assets/profiles/](assets/profiles/) altındaki eşleşen profil seçilir. Bir profil,
stack'i komutlara (lint / test / build / performans), dev-server portuna ve
manifest dosyalarına eşler — mekanik fazlar (10–17) bu stack-özel komutları
çalıştırır.

Mevcut **18 stack profili**: Node (npm, yarn, pnpm, bun), Python (pip, poetry, uv),
Rust, Go, Ruby, PHP, .NET, Dart, Elixir, Swift, Maven, Gradle, Deno. Ayrıca proje
**tipi** (web / cli / library / api / ml / game / desktop / mobile) sınıflandırılır;
bu, hangi test fazlarının (E2E, sızma testi) uygulanacağını belirler.

## Hata kataloğu

MyCL'in geliştirdiği her proje bir SQLite `mycl_errors.db` ile gelir. Çalışma
zamanındaki hatalar (backend hata middleware'i + frontend `ErrorBoundary` / fetch
sarmalayıcısı) kod, konum ve Türkçe açıklamayla kaydedilir; proje içinde bir
"Hata Kodları" sayfası bunları listeler. Faz 0 (Hata Ayıklama) araştırmaya
başlarken bu `mycl_errors.db`'yi okuyarak kök nedene daha hızlı ulaşır.

## Resimli kullanım kılavuzu

Bir projeyi geliştirirken MyCL, o proje için **ekran görüntülü Türkçe bir kullanım
kılavuzu** hazırlar: çalışan uygulamayı Playwright (headless Chromium) ile gezip
ilgili adımların ekran görüntülerini alır. Kılavuz **üretilen projenin içine**
gömülür — her sayfadaki bir **"?" popup'ından** açılır; tarihlidir ve içerik
değiştikçe bayatlayan görüntüler temizlenip yenilenir. Ayrıca MyCL Studio'da
projeye dair Türkçe bir teknik döküman ("Proje Dökümanı") gösterilir.

## Güvenlik sınırları

- **bash-guard** — yıkıcı komutlar (`rm -rf`, `sudo`, force push vb.) reddedilir.
- **path-sandbox** — dosya işlemleri seçilen proje köküyle sınırlıdır.
- **safe-env** — alt process'lere yalnızca izinli ortam değişkenleri geçer; API
  anahtarları ve token'lar sızdırılmaz.
- **redaction** — loglarda `sk-ant-…` desenleri ve anahtar alanları maskelenir.

## Geliştirme

### Hızlı kurulum (tek komut)

Kopyala/clone → **tek komut**, bilgisayarda olmayan her şeyi kurar (Homebrew, Node ≥22, Rust,
Tauri sistem bağımlılıkları, güvenlik araçları `nuclei`/`katana`/`semgrep`/`gitleaks`, Chromium).
macOS + Linux, idempotent (kuruluyu atlar); bazı adımlar şifre isteyebilir:

```bash
bash setup.sh          # veya: npm run setup
```

Sonra başlat:

```bash
npm run tauri dev      # ilk açılışta API anahtarları + model seçimi sorulur
```

**API anahtarları repoya GİRMEZ** — platforma göre `~/.mycl/secrets.json` (macOS) /
`~/.config/mycl/secrets.json` (Linux) içinde, izinler `0600`. Anahtarları girince bir proje
klasörü seçilir ve pipeline başlar. (Windows kapsam dışı.)

### Build

```bash
npm run build:all      # orchestrator (tsc) + frontend (tsc && vite build)
npm run tauri build    # masaüstü uygulama paketi
npm run desktop-icon   # paketten sonra: masaüstüne kısayol/ikon koy (mac .app / linux .desktop)
```

### Test

Tek doğruluk kaynağı `npm run check` ([scripts/check.sh](scripts/check.sh)):
build + test + frontend tip kontrolü + sızıntı taraması + eski-iddia taraması +
custom semgrep kuralları. Her anlamlı değişiklikten sonra koşulur; aynı betik CI'da
da çalışır ([.github/workflows/check.yml](.github/workflows/check.yml)).

```bash
npm run check                         # hepsi (önerilen)

# Tek tek:
npm --prefix orchestrator test        # vitest (1300+ test)
npm --prefix orchestrator run build   # orchestrator tsc, hata yok
npx tsc --noEmit                      # frontend tip kontrolü
```

## Proje düzeni

```
src/                  # React frontend (components, hooks, types, utils)
src-tauri/            # Rust Tauri host
orchestrator/
  src/
    base/             # 4 ortak controller (qa-askq, production-schema,
                      #   codegen, mechanical-runner)
    codegen/          # backend soyutlaması: SDK + CLI (backend.ts, cli-backend.ts)
    orchestrator-agent/  # karar ajanı (agent, decision, tools, path-sandbox)
    intent-router/    # kullanıcı mesajını eyleme yönlendirme
    relevance/        # bağlam seçimi / chunk store
    agent-memory/     # iterasyonlar arası kalıcı not
    task-queue/       # görev kuyruğu
    phase-0..9.ts     # LLM fazlarının controller'ları
    phase-registry.ts # faz tanımları (PhaseSpec)
    claude-api.ts     # Anthropic SDK sarmalayıcı (prompt caching dahil)
    translator.ts     # TR↔EN çeviri
    tool-handlers.ts  # Read/Write/Edit/Bash/Glob/Grep yürütücüleri
    bash-guard.ts     # yıkıcı komut denylist
    safe-env.ts       # alt process env allowlist
    profile-loader.ts # stack profili yükleme + tespit
    errors-db.ts      # proje hata kataloğu (mycl_errors.db)
    config.ts         # ~/.mycl/secrets.json + seçili modeller + bayraklar
    ...
  test/               # vitest dosyaları
assets/
  templates/          # faz başına İngilizce system prompt şablonları
  agent-prompts/      # orchestrator system prompt
  profiles/           # 18 stack profili (komut + port + manifest eşlemesi)
  i18n/               # tr.json + en.json
  security-rules/     # güvenlik kuralları
```

## Lisans

MIT — YZLLM.
