# MyCL — Living Project Documentation Update

You maintain the project's living documentation, kept in sync as the project evolves.
Inspect the ACTUAL codebase with your tools (Read / Grep / Glob / Bash) and produce
UPDATED, COMPLETE versions of the document(s) below.

## Current iteration intent (what just changed / was requested)
{{INTENT_SUMMARY}}

## Existing features.md — PRESERVE and update (do NOT drop unrelated features)
---
{{EXISTING_FEATURES}}
---

## Existing user-guide.md — PRESERVE and update
---
{{EXISTING_USER_GUIDE}}
---

## Your task
1. Read the codebase to discover ALL real features: pages/routes, API endpoints,
   data models/stores, key user flows. Grep for routers, `app.get/post`, components,
   storage modules. Ground every claim in actual code — do not invent.
2. Produce **features.md** — a cumulative catalog, written **in ENGLISH** (this file
   feeds the English-only main agent; Turkish here would break it). One
   `## <Feature Name>` heading per feature, each with:
   - **What it does**
   - **Where** (UI route/page/component — or "backend"/"CLI" if no UI)
   - **Data source** (endpoint / store / file)
   - **Behavior / notes**
   Keep existing features; add new ones; update changed ones; remove a feature ONLY
   if it was genuinely deleted from the code.
3. {{USER_GUIDE_INSTRUCTION}}
4. {{TECH_DOC_INSTRUCTION}}
5. {{HELP_PAGES_INSTRUCTION}}
6. {{ADR_INSTRUCTION}}

## Existing architecture decisions (ADRs) — keep consistent, do NOT contradict
---
{{EXISTING_DECISIONS}}
---

## Output — a SINGLE JSON block, nothing else (no prose around it)
Do NOT write files yourself. Emit EXACTLY one block:

```json
{"kind":"docs","features_md":"<full updated features.md>","user_guide_tr_md":"<full Turkish user-guide, or empty string>","user_guide_en_md":"<full English user-guide, or empty string>","tech_doc_md":"<full Turkish technical document for THIS iteration>","help_pages":[{"route":"/path","title_tr":"<task name TR>","title_en":"<task name EN>","body_tr":"<Turkish step-by-step help>","body_en":"<English step-by-step help>"}],"adr_decisions":[{"slug":"auth-strategy","title":"Authentication strategy","status":"accepted","context":"<why needed>","options":"<alternatives>","decision":"<what was chosen>","consequences":"<trade-offs>"}]}
```

Rules:
- The markdown content goes INSIDE the JSON string values (escape newlines as \n, quotes as \").
- All values must be COMPLETE documents (not diffs/patches). `tech_doc_md`/`help_pages` may be empty ("" / []) if not applicable.
- **features.md → ENGLISH** (agent-facing). **tech_doc_md → Turkish** (human-facing). **user-guide + help_pages → BOTH Turkish AND English** (the in-app "?" popup has TR/EN tabs; mirror the same tasks in both languages).
  Keep code identifiers/paths verbatim in all.
- **STALE/BAYAT TEMİZLİĞİ**: features.md, user-guide.md tasks AND help_pages are CUMULATIVE — drop an entry ONLY if its code/route was genuinely DELETED; UPDATE entries whose usage CHANGED this iteration (leave NOTHING stale). `help_pages[].route` MUST be a REAL route appearing in features.md (invented routes are cross-checked and dropped).
- **EFFICIENCY — treat docs as a LIVING KNOWLEDGE BASE (YZLLM 2026-06-14: token israfı yapma)**: The "Existing" docs above ARE your accumulated, already-verified knowledge. For areas the iteration did NOT touch, **TRUST them — do NOT re-scan, re-grep or re-derive facts that are already documented and stable.** Anchor your code inspection on what the **iteration intent** says changed (`{{INTENT_SUMMARY}}`) + the files it implies. This saves tokens (don't re-discover unchanged things). **BUT** if while doing so you find a change that INVALIDATES a previously-documented "stable" fact (a route renamed, a module restructured, a behavior/contract moved — something we treated as fixed but it moved), you MUST update that entry too and treat it as changed (a living organism: assumptions that break get corrected, not left stale). Bootstrap/first-open mode is the ONE exception: do a FULL deep scan to build the complete knowledge base from scratch (there is no prior knowledge to trust).
- **TECH-DOC**: `tech_doc_md` reflects the CURRENT whole-project state. In incremental (iteration) mode, update the sections affected by this iteration's change + any invalidated stable facts (keep the rest); in bootstrap/first-open mode, document the ENTIRE codebase from real code, miss nothing.
