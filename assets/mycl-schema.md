# `.mycl/` Veri Şeması — Dataset Kılavuzu

Bu dosya MyCL Studio'nun proje başına ürettiği NDJSON kayıtlarının şemasını dokümante eder. Amaç: ilerde bu dosyaları **dataset** olarak kullanabilmek (LLM fine-tune, replay, analiz, audit).

> **NOT**: Bu dosya MyCL tarafından her boot'ta `<project>/.mycl/SCHEMA.md`'ye otomatik kopyalanır — el ile düzenleme yapma, kaybolur.

---

## Ortak metadata (her satırda)

`v15.6` (2026-05-24) itibariyle tüm NDJSON kayıtlarına şu **anchor alanları** otomatik enjekte edilir:

| Alan          | Tip      | Açıklama                                                                |
|---------------|----------|-------------------------------------------------------------------------|
| `_schema_v`   | `int`    | Bu kayıt tipinin schema sürümü. Alan eklenir/kaldırılırsa bump edilir.  |
| `_session`    | `string` | MyCL session UUID — `state.session_id`. Process lifetime boyunca sabit. |
| `_iter`       | `int`    | İterasyon sayacı — `state.iteration_count`. Yeni iterasyonla artar.     |
| `_phase`      | `int`    | Kayıt anındaki aktif faz — `state.current_phase`. 0-17 aralığı.          |
| `_record_ts`  | `int`    | Kayıt zamanı (ms epoch). Domain `ts`'i bozmaz; sadece append anı.       |

**Cross-file join**: `_session` + `_iter` ile bir iterasyonun tüm event'leri (audit + history + memory + decisions) birlikte çekilebilir.

**Eski kayıtlar**: v15.6 öncesi satırlarda bu alanlar yok — okuyan kod undefined fallback yapmalı.

---

## Dosyalar

### `<project>/.mycl/state.json`
- **Format**: JSON (NDJSON değil — tek snapshot, son durum)
- **Schema versioning**: `schema_version` alanı (1, 2, 3, ...). Migrations `state-migrations.ts` içinde.
- **Atomic write**: temp + fsync + rename pattern (yarım yazma yok).
- **Kullanım**: anlık durum sorgusu, boot restore.

### `<project>/.mycl/audit.log` (NDJSON)
- **Tip**: append-only.
- **Domain alanları**: `{ ts, phase, event, caller, detail? }`
- **Atomic append**: POSIX O_APPEND + fsync (line-level race-free).
- **Event isim kuralı**: ASCII safe, kebab-case (örn. `phase-5-complete`, `tdd-red`, `iteration-3-start`).
- **Caller**: `user | mycl-orchestrator | claude-code | bridge`.
- **Kullanım**: pipeline ilerleme audit'i, replay, dataset için "ne oldu" iz dökümü.

### `<project>/.mycl/history.log` (NDJSON)
- **Tip**: append-only, en hızlı büyüyen dosya.
- **Domain alanları**: `{ ts, kind, data }` — `kind` = `chat_message | translation | claude_stream | askq | phase_changed | ...`
- **Atomic append**: POSIX O_APPEND (fsync YOK — performance trade-off).
- **Kullanım**: UI replay (boot'ta panel restore), full-fidelity dataset.

### `<project>/.mycl/agent-decisions.jsonl` (NDJSON)
- **Tip**: append-only.
- **Domain alanları**: `{ ts, user_text, topic_slug, action, reason, confirmed }`
- **Kullanım**: orchestrator agent'ın verdiği kararların kaydı (recurring topic detection için input, ilerde fine-tune kaynağı).

### `<project>/.mycl/agent-memory.jsonl` (NDJSON)
- **Tip**: append-only.
- **Domain alanları**: `{ ts, topic_slug, type, summary, user_text, decision_action, affected_files?, affected_db_tables?, affected_algorithms?, change_description?, confirmed_at }`
- **Kullanım**: projeye özel hatırlanan kararlar/patternler.

### `<project>/.mycl/abandoned-intents.jsonl` (NDJSON)
- **Tip**: append-only.
- **Domain alanları**: `{ ts, iteration, phase, intent, concerns, reason }`
- **Kullanım**: Faz 2 compliance check'inde vazgeçilen niyetlerin kalıcı kaydı (sonraki iterasyonlarda Claude'a context).

### `~/.mycl/agent-memory-general.jsonl` (NDJSON, global)
- **Tip**: append-only, **proje-üstü**.
- **Domain alanları**: agent-memory.jsonl ile aynı.
- **Kullanım**: birden fazla projede yararlı patternler (örn. JWT auth, form validation).

---

## Dataset üretimi için ipuçları

### Bir iterasyonun komple izini çıkarmak
```bash
jq -c 'select(._session == "<UUID>" and ._iter == 5)' \
  .mycl/audit.log .mycl/history.log .mycl/agent-decisions.jsonl
```

### Belirli fazın tüm kayıtlarını çıkarmak
```bash
jq -c 'select(._phase == 8)' .mycl/audit.log .mycl/history.log
```

### JSONL → Parquet
```python
import pandas as pd
df = pd.read_json(".mycl/history.log", lines=True)
df.to_parquet("history.parquet")  # `_*` kolonları metadata olarak kalır
```

### LLM fine-tune dataset (örn.)
`agent-decisions.jsonl`'den `{ user_text, action, reason }` → instruction tuning örnekleri. `_session`/`_iter` ile pencereleme yapılabilir.

---

## Schema versiyonlama kuralı

- **`_schema_v` bump**: bir kayıt tipine alan **eklenir** veya **kaldırılır**ya da **anlamı değişir**se bu sürümü artır.
- **Migration**: gerekirse `applyMigrations` benzeri bir helper ile eski satırlar runtime'da yeni şemaya çevrilir.
- **Backward compat**: okuyan kod her zaman optional field gibi tüketmeli (`record._iter ?? 0`).

---

## v15.6 değişiklik notu (2026-05-24)

- Tüm NDJSON writer'ları `enrichRecord()` ile sarıldı — yukarıdaki anchor metadata alanları otomatik enjekte ediliyor.
- Eski kayıtlar (v15.5 öncesi) bu alanlara sahip değil; readers undefined fallback ile çalışıyor.
- `SCHEMA.md` (bu dosya) her boot'ta MyCL'den `.mycl/` altına otomatik kopyalanıyor (manual edit kaybolur).
