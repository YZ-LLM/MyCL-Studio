# MyCL Custom Security Rules

v15.7 (2026-05-27, Batch A3) — Production-readiness madde 13 için yer-tutucu.

## Mevcut güvenlik taraması

Phase 13 (`security`) şu komutları sırayla çalıştırır ([phase-registry.ts:265-278](../../orchestrator/src/phase-registry.ts#L265-L278)):

1. **Stack-spesifik audit**: `npm audit --omit=dev --audit-level=high` (Node) / `pip-audit` (Python) / `cargo audit` (Rust) / vb.
2. **Semgrep auto**: `semgrep --config auto` — semgrep registry'den otomatik dil/framework algılama
3. **Semgrep security-audit**: `semgrep --config p/security-audit` — OWASP-grade kural seti
4. **Semgrep OWASP Top 10**: `semgrep --config p/owasp-top-ten` — OWASP 2021 Top 10 kategorileri

Üçünden herhangi biri FAIL ise Phase 13 fail → pipeline durur. Tool yoksa (semgrep kurulu değil) skip + uyarı; security tek başına yine koşar.

## Custom rules (yer-tutucu — v16+)

Bu klasöre projeye-özel semgrep YAML kuralları konabilir. Şu an mechanical runner runtime substitution desteklemiyor (cmd template'inde absolute path expansion yok). Aktif değil.

İleride:
- SQL injection — parameterized query enforce
- XSS — `innerHTML`, `dangerouslySetInnerHTML`, `v-html` ban
- Auth bypass — express route'larda middleware miss detection
- Secret leak — hard-coded API key / token regex

## Manuel kullanım (geçici)

Custom rule eklemek isteyen developer:

```bash
semgrep --config assets/security-rules/sql-injection.yml src/
```

Hata varsa CI/CD'ye manuel eklenir. Otomatik entegrasyon v16'da.
