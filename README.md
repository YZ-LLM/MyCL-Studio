# MyCL Studio v14

Tauri 2 + React + TypeScript + Anthropic SDK ile yazılmış masaüstü uygulama.
Kullanıcının Türkçe niyetini İngilizceye çevirerek **20 fazlık MyCL
pipeline'ını** Claude (Opus 4.7) üzerinde deterministik olarak çalıştırır.

## Mimari

- **Frontend**: React 19 + Vite 7 + TypeScript 5.8 (`src/`)
- **Orchestrator**: Node.js + Anthropic SDK (`orchestrator/`) — Tauri tarafından
  alt process olarak spawn edilir, stdin/stdout NDJSON ile iletişir.
- **Translator**: Sonnet 4.6 (TR↔EN), ayrı API key.
- **Main**: Opus 4.7 (max context, 1M beta), tüm faz işleri.

**Mimari yasaklar** (KESIN KURAL): Claude Code CLI subprocess yok, hook yok,
skill yok, plugin yok, MCP yok, sessiz fallback yok. Her şey orchestrator
in-process. Detay: [QC_CHECKLIST.md](QC_CHECKLIST.md).

## 20 Faz Pipeline

| # | Faz | Tip |
|---|---|---|
| 1 | Niyet Toplama | qa-askq |
| 2 | Hassasiyet Denetimi (7 boyut) | qa-askq |
| 3 | Mühendislik Brifi | production-schema |
| 4 | Spec Yazımı | production-schema |
| 5 | Desen Eşleme | codegen |
| 6 | UI Yapımı (has_ui koşullu) | codegen |
| 7 | UI İnceleme (has_ui koşullu) | qa-askq |
| 8 | Veritabanı Tasarımı (has_database koşullu) | production-schema |
| 9 | TDD Yürütme | codegen |
| 10 | Risk İncelemesi | qa-askq |
| 11-18 | Lint / Sadeleştirme / Performans / Güvenlik / Unit / Integration / E2E / Yük | mechanical |
| 19 | Etki İncelemesi | qa-askq |
| 20 | Doğrulama Raporu + Mock Cleanup | validation/codegen |

Detaylı durum: [QC_CHECKLIST.md](QC_CHECKLIST.md).

## Geliştirme

### Kurulum

```bash
npm install
npm --prefix orchestrator install
```

### Çalıştır

```bash
npm run tauri dev
```

İlk açılışta `~/.mycl/secrets.json` (API keys) ve Settings (model seçimi)
istenir. Sonra proje klasörü seçerek pipeline başlatılır.

### Build / Test

```bash
# Orchestrator
npm --prefix orchestrator run build   # tsc, 0 hata
npm --prefix orchestrator test        # vitest, 126/126 pass

# Frontend
npx tsc --noEmit                      # 0 hata
npm run build                         # vite production build
```

### Kod organizasyonu

```
orchestrator/
  src/
    base/                # 4 ortak pattern: qa-askq, production-schema, codegen, mechanical-runner
    phase-{1..20}.ts     # Faz controller'ları (ince adapter'lar)
    phase-registry.ts    # PhaseSpec kayıtları (20/20)
    audit.ts             # NDJSON audit log + spec section extract
    bash-guard.ts        # Yıkıcı komut denylist
    claude-api.ts        # Anthropic SDK wrapper
    config.ts            # ~/.mycl/secrets.json + selected models
    dev-server-launcher.ts # Faz 6 dev server detached spawn + HTTP probe
    i18n.ts              # TR/EN label resolver (tr.json + en.json)
    index.ts             # NDJSON IPC dispatcher + advanceToNextPhase
    ipc.ts               # emit helpers (chat, askq, claude_stream, ...)
    logger.ts            # NDJSON debug log + sk-ant redact
    models.ts            # Anthropic models.list cache (24h)
    safe-env.ts          # Child process env allowlist (API key sızdırma koruması)
    state.ts             # state.json load/save
    tool-handlers.ts     # Read/Write/Edit/Bash/Glob/Grep client-side execute
    translator.ts        # TR↔EN, sequential chunk + retry
  test/                  # vitest dosyaları (10 dosya, 126 test)
assets/
  i18n/                  # tr.json + en.json
  templates/             # faz başına system prompt template'leri (12 adet)
src/                     # React frontend
src-tauri/               # Rust Tauri host
```

## QC Kuralı

**Her kod döngüsü sonunda [QC_CHECKLIST.md](QC_CHECKLIST.md) güncellenir.**
Test sayısı, faz durumu, açık item'lar — hepsi gerçek durumu yansıtır
(Ümit'in kalıcı kuralı 2026-05-15).

## Lisans

Özel proje — Ümit Duman, kişisel kullanım.
