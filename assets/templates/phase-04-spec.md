# Task: Engineering Spec Writing

You are writing a concrete engineering specification based on the developer's
clarified intent from Phase 1. Output a strict structured spec via the
**write_spec** tool — the spec will be saved to disk and drive later phases
(TDD codegen).

Your job:
1. Read the intent summary below.
2. Decompose into:
   - **Title**: short, specific (5-10 words).
   - **Scope**: 1-2 paragraphs — what's included AND what's explicitly excluded.
   - **Acceptance criteria (AC)**: 3-7 testable conditions. Each must be:
     - Independently verifiable
     - Phrased as "Given X, when Y, then Z" OR a clear binary check.
     - Numbered for reference in later phases.
   - **Out of scope**: 1-5 bullets — features, integrations, polish DEFERRED.
   - **Technical risks**: 1-4 bullets — known unknowns, integration friction,
     data shape uncertainty. Each ≤ 2 sentences.
   - **Error catalog (MANDATORY)**: This project MUST persist runtime errors
     to `error_folder/errors.db` (SQLite) so MyCL Debug Triage can read
     known errors next time. Spec MUST include these acceptance criteria:
     - **AC: error catalog DB exists** — `error_folder/errors.db` opened on
       first run; schema:
       ```sql
       CREATE TABLE IF NOT EXISTS errors (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts INTEGER NOT NULL,           -- unix ms
         error_code TEXT NOT NULL,      -- e.g. "AUTH_403", "JSON_PARSE"
         location TEXT NOT NULL,        -- page route or endpoint path
         description_tr TEXT NOT NULL,  -- Turkish description
         stack TEXT,                    -- optional stack trace
         resolved INTEGER NOT NULL DEFAULT 0,
         solution_tr TEXT               -- Turkish fix summary (NULL until resolved)
       );
       ```
     - **AC: backend error middleware** logs every uncaught exception +
       4xx/5xx response to `errors.db` with location = endpoint path.
     - **AC: frontend error boundary** logs caught React errors + failed
       fetch responses to `errors.db` (via a `/api/log-error` endpoint).
     - **AC: error codes page** — every project with a UI MUST have a
       "Hata Kodları" page/route showing all rows from `errors.db` in a
       readable table (ts, code, location, description, resolved status).
       Default route: `/hata-kodlari` (or stack equivalent).
     - **AC: `error_folder/` is gitignored** — error logs are per-instance,
       not committed.
   - **Dev Workflow & Scripts**: REQUIRED. State how `npm run dev` (or stack
     equivalent) MUST behave for this project. Read the `dev_workflow` tag
     from the brief above. If `concurrent` (full-stack: UI + backend), the
     spec MUST list these scripts as acceptance:
       - `dev` → runs BOTH frontend dev server and backend concurrently
         (use `concurrently` devDependency: `concurrently "npm:dev:backend"
         "npm:dev:frontend"`).
       - `dev:backend` → backend-only (e.g., `node dist/backend/src/index.js`
         or `tsx watch backend/src/index.ts`).
       - `dev:frontend` → frontend-only (e.g., `vite`).
       - `concurrently` MUST be in `devDependencies`.
     If `frontend-only` → `dev` = frontend dev server alone (e.g., `vite`).
     If `backend-only`/`single` → `dev` = backend run command. Phase 6 will
     verify the dev server is reachable on the expected HMR port (default
     5173 for Vite); spec must include this as an acceptance criterion when
     the project has a web UI.
3. Call **write_spec** with the structured input.
4. After write_spec result, you'll receive `spec_saved: true`. Then call
   **request_spec_approval** with a 2-3 sentence elevator pitch summary.
5. User responds Approve / Revise / Cancel:
   - Approve → done.
   - Revise → revise the spec, call write_spec again with updated input.
   - Cancel → abort.

## Hard constraints

- ONE write_spec call per turn (you may call request_spec_approval after).
- AC must be **testable** — no vague "should work well".
- Out of scope must be explicit — anything not listed becomes implementation
  obligation in later phases.
- No code yet. No file paths. No library recommendations.
  Phase 5+ handles architecture / pattern matching.
- Do NOT emit free-form text outside tool calls.

## Intent summary (from Phase 1, approved by user)

---
{{INTENT_SUMMARY}}
---

## Engineering brief (from Phase 3, if available)

If empty, Phase 3 was skipped — rely on intent summary only. Otherwise, use
the tags / stakeholders / constraints below to inform scope decisions.

---
{{ENGINEERING_BRIEF}}
---
{{CONVERSATION_CONTEXT}}

Now call **write_spec** with your structured spec.
