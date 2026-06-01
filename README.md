# MyCL Studio

Yapay zeka destekli yazılım geliştirme için masaüstü uygulaması. Kullanıcının
Türkçe niyetini alır, çok fazlı bir pipeline üzerinden çalıştırır ve Claude
modellerini Anthropic API üzerinden — opsiyonel olarak Claude Code CLI ile —
kullanarak kod üretir, test eder ve kalite kapılarından geçirir. Arayüz
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
ayrıca efor seviyesi ve özellik bayrakları yapılandırılır.

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
(Faz 0). Projeye uygun olmayan fazlar atlanır (örn. UI'ı olmayan projede UI
fazları, NFR tanımlı değilse yük testi). Faz tipleri dört ortak controller'a
dayanır: `qa-askq` (kullanıcıya soru/onay), `production-schema` (şema üreten),
`codegen` (kod yazan), `mechanical-runner` (komut çalıştıran).

| # | Faz | Tip |
|---|-----|-----|
| 0 | Hata Ayıklama (Debug Triage) | codegen |
| 1 | Niyet Toplama | qa-askq |
| 2 | Hassasiyet Denetimi | qa-askq |
| 3 | Mühendislik Brifingi | production-schema |
| 4 | Spec Yazımı | production-schema |
| 5 | UI Yapımı | codegen |
| 6 | UI İnceleme | qa-askq |
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
| 17 | Yük Testi (NFR varsa) | mechanical |

## Codegen backend'leri

Kod üreten fazlar iki şekilde çalışabilir:

- **Anthropic SDK** (varsayılan) — orchestrator'ın kendi turn döngüsü, kendi
  araçları (Read/Write/Edit/Bash/Glob/Grep), bash-guard ve path-sandbox ile.
- **Claude Code CLI** (opsiyonel, Ayarlar'dan bayrakla) — `claude` komutu
  kuruluysa, UI Yapımı (Faz 5) ve özellik doğrulama bu CLI üzerinden çalışır.
  `claude` bulunmazsa sessizce SDK'ya dönülür. `~/.mycl/agent-skills` dizini
  varsa CLI'a `--plugin-dir` ile bağlanır.

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
bu, hangi test fazlarının (E2E, yük) uygulanacağını belirler.

## Hata kataloğu

MyCL'in geliştirdiği her proje bir SQLite `errors.db` ile gelir. Çalışma
zamanındaki hatalar (backend hata middleware'i + frontend `ErrorBoundary` / fetch
sarmalayıcısı) kod, konum ve Türkçe açıklamayla kaydedilir; proje içinde bir
"Hata Kodları" sayfası bunları listeler. Faz 0 (Hata Ayıklama) araştırmaya
başlarken bu `errors.db`'yi okuyarak kök nedene daha hızlı ulaşır.

## Güvenlik sınırları

- **bash-guard** — yıkıcı komutlar (`rm -rf`, `sudo`, force push vb.) reddedilir.
- **path-sandbox** — dosya işlemleri seçilen proje köküyle sınırlıdır.
- **safe-env** — alt process'lere yalnızca izinli ortam değişkenleri geçer; API
  anahtarları ve token'lar sızdırılmaz.
- **redaction** — loglarda `sk-ant-…` desenleri ve anahtar alanları maskelenir.

## Geliştirme

### Önkoşullar

- **Node ≥ 22** ve npm (CI Node 24 ile koşar).
- **Rust toolchain** (stable, `rustup`) — Tauri host'u derler.
- **Tauri platform bağımlılıkları** ([tauri.app prereqs](https://tauri.app/start/prerequisites/)):
  - macOS: Xcode Command Line Tools (`xcode-select --install`).
  - Linux: `webkit2gtk-4.1`, `libgtk-3`, `librsvg2`, `libayatana-appindicator3` vb.
  - Windows: MSVC Build Tools + WebView2 Runtime.
- **`node` PATH'te erişilebilir olmalı** — paketlenmiş uygulama bile orchestrator'ı
  sistemdeki `node` ile çalıştırır (Node gömülü değildir).

### Kurulum

```bash
npm install
npm --prefix orchestrator install
```

### Çalıştır

```bash
npm run tauri dev
```

`beforeDevCommand` önce orchestrator'ı derler (`orchestrator/dist`), sonra Vite dev
sunucusunu başlatır — taze klonda ek adım gerekmez.

İlk açılışta Ayarlar otomatik açılır: API anahtarları ve model seçimi istenir.
Anahtarlar platforma göre şu dosyada saklanır (izinler `0600`):

- macOS: `~/.mycl/secrets.json`
- Linux: `$XDG_CONFIG_HOME/mycl/secrets.json` (varsayılan `~/.config/mycl/`)
- Windows: `%APPDATA%\MyCL\secrets.json`

Sonra bir proje klasörü seçilerek pipeline başlatılır.

### Build

```bash
npm run build:all      # orchestrator (tsc) + frontend (tsc && vite build)
npm run tauri build    # masaüstü uygulama paketi
```

### Test

```bash
npm --prefix orchestrator test    # vitest (500+ test)
npm --prefix orchestrator run build   # tsc, hata yok
npx tsc --noEmit                  # frontend tip kontrolü
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
    errors-db.ts      # proje hata kataloğu (errors.db)
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

Özel proje — Ümit Duman.
