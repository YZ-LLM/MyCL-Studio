# Task: TDD Implementation — Integration-First (Outside-In)

You are implementing the spec from Phase 4 using **integration-first TDD**.
The spec is located at **.mycl/spec.md** in the project root.

## METHODOLOGY — Outside-In (v15.7, 2026-05-25)

Kullanıcı talebi: "TDD sürecinde gereksiz testler yazmış olabilir mi? Çalışacağı
kesin olan şeyler için testler yapmasına gerek yok. testi aşamalı yapalım. önce
bütünsel testleri yapsın. hata çıkarsa o kısımın hata ile ilgili kısımlarına
test yazsın ve onları test etsin."

## ITERATION SCOPE — En önemli kural (v15.7, 2026-05-25)

Kullanıcı talebi: "sadece o iterasyondaki iş için yapılacak değil mi test?"

**EVET — sadece bu iterasyonda YENİ veya DEĞİŞEN AC'ler için test yaz.**
Önceki iterasyonların testleri zaten dosyalarda mevcut (tests/, __tests__/,
*.test.* dosyaları). Onları silme, kırma, yeniden yazma. Sadece bu iterasyonun
ek işi için test ekle.

### Tespit prosedürü

1. **Mevcut test envanteri**: `find . -name "*.test.*" -o -name "*.spec.*" | head -30` ve `npm test` çıktısını incele. Hangi AC'ler zaten test ediliyor?
2. **Spec.md ile karşılaştır**: spec'teki AC'leri mevcut testlerle eşleştir. Eksik olanlar → BU iterasyonun konusu.
3. **Edge case — her şey zaten green**: Eğer `npm test` zaten her şeyin yeşil olduğunu gösteriyorsa ve bu iterasyon sadece refactor/dokümantasyon ise → tek bir smoke test eklemen yeterli; final suite koş + dur. Phase tamamlanır.

BU iterasyonda eklenen/değişen AC'ler için **gerçek, çalışan testler** yaz;
önceki iterasyonların testlerine güvenme (onlar bu işi kapsamaz). MyCL testleri
**kendisi koşar** (otoriter anchor) — yani yorum/stub/print ile "yeşil gibi
göstermek" İŞE YARAMAZ; yalnız gerçekten geçen testler sayılır. Hiçbir audit/
metadata olayını elle üretme; MyCL kaydı otomatik tutar.

**Strateji**: Her AC için ayrı RED-GREEN-REFACTOR YAPMA. Bunun yerine:

### ADIM 0 — SMOKE TEST FIRST (zorunlu ilk adım)

**EN BAŞTA tek bir smoke test yaz** — uygulamanın happy-path'ini uçtan uca
çağıran 1 (BIR) test. Backend yoksa minimal sunucu/server ayağa kalksın
mı, ana endpoint cevap veriyor mu, DB query çalışıyor mu? Bu test
"uygulama temel olarak çalışıyor mu?" sorusunu sorar.

- Smoke test YEŞIL ise → "iskelet hazır", devam et (ADIM 1).
- Smoke test KIRMIZI ise → temel bir şey eksik (route yok, DB schema yok,
  bağlantı kopuk). Smoke'u yeşillendir, sonra ADIM 1'e geç. Bu noktada
  zaten yarısı çözüldü demektir.

Smoke test, kalan integration testlerin de iskeletini oluşturur — aynı
fixture/setup'ı paylaşır.

### ADIM 1 — Integration testler (kullanıcı senaryosu bazlı)

> **v15.7 (2026-05-27, Batch A4) — Non-UI projeler için COVERAGE ZORUNLULUĞU**:
> CLI / library / api-only / ml / desktop-cli projelerde Phase 16 (E2E)
> tamamen atlanır (`skip_unless: "has_ui"`). Bu projelerde **integration
> testler tek koruyucu hat**. Kural: her acceptance criteria'nın **%80'i**
> integration test ile kapsanmalı. Web/desktop UI projelerde standart
> (5-15 AC per group); CLI/lib/api'de 1-3 AC per group veya 1:1 mapping.

1. **AC'leri kullanıcı senaryolarına grupla**. Genelde 5-15 AC tek bir
   integration test'le kapsanır (örn. "auth flow", "survey CRUD", "results
   view"). Her grup = 1 integration test. **AC'lerde Given/When/Then varsa
   AYNI _Given_'ı paylaşanları tek senaryo-grubunda topla** (ortak precondition
   = tek setup).
2. **Her grup için 1 integration/E2E-stili test yaz** (uçtan uca senaryo —
   API çağrı zinciri, HTTP request → response → DB state, vb.). Bu test
   birden fazla AC'yi aynı anda doğrular. **AC'nin _Then_'i = testin assert'i**:
   her davranışsal AC için testin o _Then_ (gözlemlenebilir sonuç) çıktısını
   AÇIKÇA doğruladığından emin ol — "test koştu" değil "then gerçekleşti".
3. **Production kodu yaz**, integration test'i koş.
4. **Hata çıkarsa**: hatanın hangi katmandan geldiğini belirle (DB? handler?
   validation? auth?). SADECE o noktayı izole eden bir unit test yaz, fix,
   integration'a geri dön.
5. **Aynı süreci recursive uygula**: yeni unit test fail ederse, o da bir alt
   katmana ihtiyaç doğurursa, daha küçük test yaz.

**ÖNEMLİ — Tek atışta bitir**: Phase 8 controller artık retry YAPMIYOR
(v15.7, 2026-05-25 — token maliyeti). Tek run'da smoke + integration grupları
yeşil olmalı. Stop yapma, çalış. Fail olursa kullanıcı Faz 8'i sidebar'dan
tekrar tıklar veya spec'i revize eder.

**Test yazma yasak listesi** (trivial / değersiz):
- ❌ Framework default davranışı (örn. "Express GET / 200 dönmeli" — Express
  zaten 404 / 200 standardını uygular)
- ❌ Standart library wrapper (örn. `JSON.stringify` sonucu test etme)
- ❌ Getter/setter / constructor (state değişikliği yapmıyorsa)
- ❌ Type-system'in zaten yakaladığı şeyler (TS interface uyumu)
- ❌ Aynı assertion'ı 5 farklı input'la tekrar etme (1 sample + edge case yeter)

**Test yazma değerli listesi**:
- ✅ Business logic (validation, hesaplama, state machine geçişleri)
- ✅ API contract (request/response shape, status codes, error responses)
- ✅ DB integration (gerçek query'lerin doğru veriyi döndürdüğü)
- ✅ Edge case'ler (boş input, negatif sayı, çok uzun string, duplicate, race)
- ✅ Auth boundary (yetkisiz user 403, yetkili 200)
- ✅ Hata path'leri (DB down, invalid token, malformed body)

**Stop kuralı**: 
- Tüm integration testleri yeşil + sıfır teknik borç + final full-suite çalıştırıldı → STOP.
- Gate `min_greens = max(3, ceil(acCount / 5))` istiyor (30 AC = 6 test grubu,
  10 AC = 3 test). Daha az test yazma; ama spec'i kapsadığından eminsen
  fazla yazma da — her test maintenance maliyeti taşır.

## HARD RULE — Pes etme

- Test fail kalırsa (3+ red runs aynı assertion'da) strateji değiştir; ASLA
  test'i `.skip` etme veya silme.
- Beklenmedik blocker → Bash/Read ile araştır, devam et. Stop ETME.
- Phase 8 controller fail olursa retry yapar (10 attempt'e kadar, ilerleme
  varsa) — yine de tek atışta bitirmeye çalış.

Your job:
1. Read the spec. Count ACs, group them into 3-8 user scenarios. Announce
   your grouping in initial reasoning.
2. For EACH scenario group:
   a. **RED**: Bir integration test yaz (senaryo: setup → action → assertions).
      Bash `npm test` ile koş, fail confirm et.
   b. **GREEN**: Production kodu yaz. Senaryo yeşillenene kadar üzerinde çalış.
      Eğer integration belirli bir katmanda fail ederse, o katman için
      izole unit test yaz → fix → integration tekrar.
   c. **REFACTOR**: DRY, naming, dead code temizliği. Test re-run → green kalmalı.
3. Tüm gruplar yeşillendikten sonra **full suite** koş — hepsi green olmalı.
4. Bitince kısa özet (text). Orchestrator audit log'dan tamamlanmayı algılar.

## ZERO TECHNICAL DEBT POLICY (MyCL_Pseudocode.md:203 — "ASLA TEKNİK BORÇ BIRAKMA")

This phase enforces zero-technical-debt. The orchestrator scans every Write/Edit
to production paths and fails the phase if ANY of the following appear in
production code:

- **No TODO / FIXME / HACK / XXX / WIP comments** — write the code right or
  defer the work to a follow-up phase, never leave a "fix it later" marker.
- **No mock / stub / dummy / fake data in production paths** — these belong in
  test paths only (`*.test.*`, `*.spec.*`, `__tests__/`, `tests/`).
- **No hardcoded credentials / API keys / passwords** — read from env vars
  (`process.env.*`, `os.environ[...]`) or config files; never inline literals.
- **No empty `catch {}` blocks or `// ignore` swallows** — every catch must
  log, rethrow, or document why silent (single-line comment WITH reason).
- **No unused imports / unused declarations / dead branches** — clean before
  declaring AC complete.
- **No "ileride lazım olur" abstractions** — implement only what the current
  AC needs (YAGNI).
- **No skipped tests** — `.skip`, `.only`, `xit`, `xdescribe`, `@pytest.skip`
  marks block the phase; resolve or delete.

The orchestrator runs the technical debt scan automatically after each Write/Edit
and emits `tdd-tech-debt-detected` audit events with file:line + reason. The
gate fails if any such event remains at phase end.

## Error catalog — MANDATORY in every project

The spec includes acceptance criteria for `error_folder/errors.db`. Phase 5
patterns.md gives the backend + frontend pattern. You MUST implement:

1. `error_folder/init-errors-db.js` (or stack-equivalent) — opens or creates
   the SQLite DB with the schema below, exports a `recordError({
   error_code, location, description_tr, stack })` helper.
2. **Backend**: Express (or stack) error middleware that calls
   `recordError(...)` for every uncaught exception + 4xx/5xx response.
   Endpoint path is the `location`. Plus a `POST /api/log-error` endpoint
   the frontend can call. Plus `GET /api/errors` returning the rows for
   the UI's Hata Kodları page.
3. **Frontend**: a global `fetch` wrapper that POSTs to `/api/log-error`
   on non-2xx responses, and a React ErrorBoundary that calls the same
   endpoint on render errors. (Phase 6 builds the Hata Kodları page itself
   that reads from `/api/errors`.)
4. `.gitignore` must include `error_folder/`.
5. Write TDD tests for: (a) `recordError` writes a row; (b) error middleware
   catches a thrown error from a dummy route; (c) `/api/errors` returns
   the inserted rows; (d) frontend fetch wrapper POSTs on 4xx (mock backend).

Schema (must match exactly so Phase 0 Debug Triage and MyCL's "Hata Ara"
scanner can read it):
```sql
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  error_code TEXT NOT NULL,
  location TEXT NOT NULL,
  description_tr TEXT NOT NULL,
  stack TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  solution_tr TEXT
);
```

`solution_tr` is filled by MyCL when an error is fixed (Turkish summary of
the applied solution). Runtime error logging code (middleware /
ErrorBoundary) should write rows with `resolved=0` and `solution_tr=NULL`.

Treat these as ACs and TDD them just like the spec's own ACs.

## Observability — logging + health (MANDATORY when a backend exists)

The error catalog above captures *errors*. Observability also requires the app
to say what it is *doing* and whether it is *up*. If the project is
frontend-only (static SPA / library / CLI with no server) → SKIP this section
and note "no backend → observability skipped" in your summary. Do NOT add a
server or any dependency just to satisfy it.

When a backend exists, treat these as ACs and TDD them (RED first):

1. **Structured logging — minimal-dep.** No bare `console.log("...")`. Use ONE
   thin logger module emitting machine-readable lines with `level`, `msg`, `ts`,
   and (when available) a `requestId`:
   ```js
   // logger.js (.ts if TS) — zero-dep structured logger
   function log(level, msg, fields = {}) {
     process.stdout.write(JSON.stringify({ ts: Date.now(), level, msg, ...fields }) + "\n");
   }
   export const logger = { info:(m,f)=>log("info",m,f), warn:(m,f)=>log("warn",m,f), error:(m,f)=>log("error",m,f) };
   ```
   `pino` is allowed ONLY if the spec explicitly asks for heavy structured logs —
   otherwise the zero-dep wrapper is the default (no winston / Sentry / OTel).
   Python: stdlib `logging` (a `Formatter` subclass for JSON) — never `print()`.
   Correlate with a request id: read `x-request-id` or `crypto.randomUUID()` in a
   middleware/hook (Express/Fastify/Nest) or at the top of a Next route handler.
   Log to stdout/stderr (12-factor); never hardcode an absolute log-file path.

2. **Health endpoint — `GET /health` (or `/healthz`).** No auth. Returns HTTP
   200 + `{ "status": "ok" }`. Read-only, no side effects (no DB writes, no
   downstream chains). Stack: Express/Fastify route, Nest controller, Next
   `app/health/route.ts` or `pages/api/health.ts`, FastAPI/Flask route, Django
   view. (Optional: a light `SELECT 1` returning 503 `{status:"degraded"}` on
   failure — but the minimum is 200/ok.)

3. **Central error handler → reuse the error catalog, do not duplicate.** The
   single error middleware/handler from the Error catalog section above must
   (a) call `recordError(...)`, (b) log via the structured `logger` at `error`
   level, and (c) return a generic 500 — the stack trace / internal message MUST
   NOT leak to the client (`res.send(err.stack)` / `res.json({error: err.message})`
   are forbidden). One place, not two systems.

Silent-catch stays forbidden (the tech-debt scan flags bare empty catches):
every `catch`/`except` logs, rethrows, or carries a one-line comment stating why
the swallow is safe. A commented best-effort catch is fine.

**TDD these (RED first, in-process — do NOT boot a long-running server):**
- `GET /health` → 200 with `status: "ok"` (your route, not a framework default).
- A dummy throw route → response is 500 AND the body contains NO stack/internal
  message (leak test).
- `logger` as a pure function: `info/warn/error` produce a record with the right
  `level` + fields (inject a `sink`/`write` so the test can assert without
  capturing global stdout).

## Resilience — anticipate failure, don't just record it (when external calls exist)

Error catalog + Observability make a failure *visible*; resilience keeps one flaky
dependency from taking the request — or the app — down. This is IDE-scale
defensive coding, NOT chaos engineering (no fault-injection harness, no extra
dependency). If the backend makes no outbound / cross-process calls (pure
in-process logic) → note "no external dependencies → resilience N/A" and skip.
When it calls anything it does not own (HTTP API, DB, cache, queue, FS under
load), apply these and TDD the observable ones:

1. **Timeout every outbound call.** No timeout = blocks forever and exhausts the
   pool. Bounded deadline: `AbortController` + `signal` for `fetch`; the client's
   native timeout for DB/SDK; `timeout=` for Python `httpx`/`requests`. Never
   unbounded.
2. **Retry only transient, idempotent failures — bounded.** Network error / 5xx /
   429 with a small cap (2-3) + exponential backoff + jitter. NEVER retry 4xx;
   NEVER blindly retry a non-idempotent write. A ~10-line helper, not a framework
   (`p-retry` only if the spec already pulls it in).
3. **Graceful degradation — a dependency being down is not a 500.** When a
   non-critical dependency fails after timeout+retry, return a meaningful reduced
   result (cached/stale, empty-but-valid, documented partial), not an opaque
   error. A critical dependency may still 500 — but through the central error
   handler (recordError + log), never a raw crash. State which deps are critical
   vs degradable in your summary.
4. **Validate input at the boundary** so bad input returns 400, not a 500 from a
   deeper crash. One validation layer (shared with the security "validate inputs"
   rule), not two.

Bind to the Observability handler/logger — retry/degradation logs through the same
`logger`; the final unrecoverable error flows through the same one error handler.
Do NOT add a second error sink. A `catch` doing backoff/fallback is a *handled*
catch (it logs the attempt); a swallow still fails the tech-debt scan.

**TDD (RED first, in-process — inject a fake dependency that fails/times out; do
NOT hit a real network):**
- A handler whose dependency times out returns the degraded result (or a clean 500
  through the central handler), never an unhandled rejection.
- The retry helper stops at the cap and does NOT retry a 4xx (assert attempt count
  with a stub call counter).
- Malformed/oversized input → 400 from validation, not a 500 from a deeper crash.

## API contract testing — make the "API contract" valuable-test concrete

The valuable-test list above names "API contract" as a target; here is HOW. No new
dependency or runner — write these into the existing integration tests (Phase 15
runs `test:integration`), using whatever schema lib the project already has
(`zod` / `pydantic` / builtin) or plain assertions. Skip entirely if there is no
backend.

1. **Request/response shape.** For each endpoint, assert the response body matches
   the spec's contract — required fields present, types correct, no unexpected
   field leaking. Test the happy path AND a missing/extra-field body.
2. **Status-code matrix.** Assert the codes the spec defines, not just 200: create
   → 201, validation error → 400/422, unauthenticated → 401, forbidden → 403, not
   found → 404. Map each to the spec'd behavior; do not test framework defaults.
3. **Error-envelope consistency.** Error bodies follow one shape (e.g.
   `{ error: { code, message } }`) produced by the central error handler from the
   Error catalog / Observability sections — not two formats, and never leaking a
   stack/internal message.
4. **OpenAPI (opportunistic — only if a file already exists).** If the repo already
   ships `openapi.yaml`/`openapi.json`/`swagger.json`, validate responses against
   it too. Do NOT create one — not every backend needs OpenAPI.

## Rationalizations → rebuttals (do NOT fall for these)

| You might think… | Reality |
| --- | --- |
| "I'll mock the DB/API so the test passes." | A test that mocks the thing under test proves nothing — that is a fake green. Mocks belong in test paths only, never to fake the behavior you are supposed to verify. Test against real persisted state. |
| "This test is failing oddly; I'll just `.skip` it." | `.skip`/`.only`/`xit` block the phase. A skipped test is an unverified AC. Fix the cause or change strategy, never hide it. |
| "Tests pass, so the feature works." | Only if the test actually exercises the real path AND you saw it go RED before GREEN. A test that was never red may be asserting nothing. |
| "I'll write the implementation first, then a test that matches it." | That is not TDD and tends to encode the bug. RED first: write the test, watch it fail for the right reason, then implement. |
| "Let me add tests for every getter/constructor to be safe." | Trivial tests are noise + maintenance cost (see forbidden list). Test business logic, contracts, edge cases — not the framework. |
| "I'll leave a TODO and fix it later." | Zero-technical-debt is enforced; TODO/FIXME/HACK in production paths fails the phase. Write it right now or defer the AC explicitly. |
| "This input is probably trusted, skip validation." | Untrusted until proven. Validate/normalize inputs, parametrize every query (no string-concat SQL), enforce authz on each handler, never inline secrets (env vars only). OWASP basics are ACs, not polish. |
| "This will be slow, let me optimize it now." | No measurement = speculation. Implement the simple correct version; optimize only against an observed number (a failing perf AC or a profiled hotspot), never a hunch. |
| "I'll call the library/framework API the way I remember it." | Memory invents signatures. Ground every API call in code you Read in this repo or an existing pattern; verify the signature before relying on it. |
| "This code looks unused, I'll delete it in REFACTOR." | Understand WHY it exists first (callers, tests, git history). Remove only once you can state what it did and why it is now safe (Chesterton's Fence). |

## Red flags — STOP and course-correct if you notice these

- A test went green without ever having been red — it may assert nothing real.
- You are adding `route.fulfill`, `jest.mock`, `sinon.stub`, or fake data to
  make a test pass instead of fixing production code.
- You are about to add `.skip`/`.only`/`xit`/`xdescribe` to move past a failure.
- You wrote production code before its test existed.
- The final full suite was not run, or you are declaring done off a partial run.
- A `tdd-tech-debt-detected` event fired and you are ignoring it.
- You are optimizing code with no measurement showing it is a bottleneck.
- You wrote an API/library call from memory without confirming its signature in-repo.
- You added a hardcoded secret, an unparametrized query, or skipped an authz check.
- You are deleting/rewriting code in REFACTOR without knowing why it was there.

## Verification — "seems right" is never enough

Before declaring done, confirm with evidence you actually observed:

- **RED happened**: each new test was seen failing for the right reason before
  you implemented — not green-on-first-write.
- **Real path tested**: tests exercise real handlers/DB/contract, not mocks of
  the unit under test. Persisted state is checked where the AC implies it.
- **Full suite green**: you ran the complete suite once at the end and saw it
  pass — you did not assume it from per-group runs.
- **Zero debt**: no TODO/mock-in-production/skip/empty-catch remains; no
  `tdd-tech-debt-detected` event is outstanding.
- **Security basics**: inputs validated, queries parametrized, authz enforced,
  no inlined secrets — for every handler this iteration touched.
- **Clean supersession (iteration > 1)**: when this iteration replaces prior
  behavior, the superseded code is removed or migrated — no dead duplicate of
  the thing you just replaced remains (it would trip the zero-tech-debt scan).

## Escalation — `AskUserQuestion` (rare)

You may call `AskUserQuestion` to ask the user, but ONLY when ALL THREE hold:
(1) the decision is non-trivial, (2) it is hard to reverse later, and (3) neither
the spec, the existing code, nor a reasonable default resolves it. Routine choices
(naming, file layout, which test to write, an obvious default) are NOT
escalation-worthy — pick the sensible default and note it in your output. If you
can proceed by flagging the assumption, do that instead of asking. Asking for
routine choices is itself a failure mode. (Escalation surfaces on the SDK backend
only; if it is unavailable you'll be told to proceed with your best judgment.)

## Hard constraints

- **Strict TDD order**: test FIRST (RED), then implementation (GREEN), then
  REFACTOR (mandatory cleanup pass — see Zero Technical Debt section above).
- Use ONLY: Read, Write, Edit, Bash, Glob, Grep.
- Do NOT create files outside the project root.
- Do NOT touch `.mycl/` directory (state, audit, traces).
- Do NOT create any audit/logging/emitter file (e.g. `mycl-audit.js`) or anything
  that writes to `.mycl/` or `audit.log`. MyCL records your edits automatically by
  observing your tool calls — that is MyCL's own infrastructure, NEVER project code.
- Do NOT modify `node_modules/`, `dist/`, `build/` directories.
- One file per Write call. Use Edit for incremental changes.
- Bash commands must be idempotent or have clear effects. Avoid long-running
  servers (no `npm start` / `node server.js`); use tests as the verification
  path.
- If `package.json` exists, prefer the existing `npm test` script. Otherwise
  install/configure a minimal test runner (vitest preferred, jest acceptable)
  via Bash.
- For each Bash test run, use a clear timeout (max 60s).
- **Final full-suite run mandatory**: before declaring done, run the complete
  test suite once. The orchestrator audits the final Bash test command.
- **Zero technical debt mandatory** — see policy section above. The phase
  cannot complete if any `tdd-tech-debt-detected` audit event remains.

## Project root

`{{PROJECT_ROOT}}`

## Spec to implement

The spec is in `.mycl/spec.md`. Start by reading it. The spec contains:
- Title
- Scope (what's in, what's out)
- Acceptance Criteria (AC1...ACn) — your TDD targets
- Out of Scope — do NOT implement
- Risks — be aware, plan mitigation

## Workflow

```
For each AC:
  Read spec to refresh.
  Write failing test exercising AC.
  Bash: run tests → expect failure containing the new test.
  Write production code (minimal).
  Bash: run tests → expect pass.
  Continue to next AC.

After last AC:
  Bash: run full test suite.
  Output a short summary listing what was implemented and which tests pass.
```

Begin by reading the spec.
