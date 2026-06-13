# Tarayıcı Köprüsü — MyCL Studio'yu düz tarayıcıda çalıştırma

MyCL Studio bir Tauri (Rust kabuk + sistem WebView) uygulaması. Tauri WebView'i
(macOS WKWebView / Linux WebKitGTK) **Playwright/CDP'ye bağlanamaz** — uzak
hata-ayıklama soketi yok. Bu yüzden tüm faz akışlarını otomatik test edebilmek
için uygulamayı **düz Chromium**'da açan bir köprü kuruldu.

## Nasıl çalışır

Asıl beyin zaten **Node orchestrator** (`orchestrator/dist/index.js`); Tauri'nin
Rust katmanı onu spawn edip stdin/stdout NDJSON ile konuşur. Köprü, Rust'ın IPC
katmanını **birebir** taklit eder:

```
tarayıcı (vite :1420 + tauri-shim alias)
  │  POST /__bridge/invoke   →  invoke komutları (13 adet)
  │  GET  /__bridge/events   ←  SSE: orchestrator olayları (orchestrator-event)
  ▼
browser-bridge/server.mjs (:1799)
  │  stdin:  JSON.stringify(OrchestratorCommand) + "\n"
  ▲  stdout: her satır = bir OrchestratorEvent
Node orchestrator   (Tauri'dekiyle AYNI süreç, aynı sözleşme)
```

İki parça:

1. **`server.mjs`** — Node yerleşik `http` ile SSE + HTTP POST sunucusu. Sıfır
   yeni bağımlılık. `orchestrator/dist/index.js`'i Rust gibi spawn eder, stdout
   satırlarını olay olarak yayınlar, stdin'e komut yazar.
2. **`src/browser-bridge/shim/*`** — `@tauri-apps/api/{core,event,window}` +
   `plugin-{dialog,notification,opener}` modüllerinin tarayıcı karşılıkları.
   `vite.config.ts` **yalnız `MYCL_BROWSER=1`** iken bunları alias'lar →
   **bileşen kodu hiç değişmez**, Tauri build'i etkilenmez.

## Komutlar

```bash
npm run dev:browser     # köprü + vite (tarayıcı modu) → http://localhost:1420
npm run e2e:smoke       # uçtan-uca duman testi (kendi yığınını kurar/yıkar)
npm run bridge          # yalnız köprü (:1799), ayrı vite ile kullanmak için
```

Tarayıcıda proje açmak: `http://localhost:1420/?project=/mutlak/proje/yolu`
(veya Splash'ta klasör yolunu gir). Native klasör seçici tarayıcıda gerçek yol
döndüremez; Playwright `window.__MYCL_PICK_PATH` enjekte eder.

## Sınırlar (bilinçli)

- **Çoklu pencere yok**: `open_new_window` tarayıcıda no-op (tek orchestrator
  paylaşılır, cross-talk olurdu). Tek pencere = `main` (legacy IPC yolu).
- **Güncelleme yok**: `check_update_status` daima `none`, `apply_update` no-op.
- Recent projeler `~/.mycl/browser-recent.json`'da (Tauri'nin app-data
  listesinden ayrı — test izolasyonu).
- Bir **faz çalıştırınca** gerçek orchestrator çalışır → API keys varsa gerçek
  maliyet + dosya yazımı. Köprü, faz tetiklenene kadar boş durur.
