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

## Output — a SINGLE JSON block, nothing else (no prose around it)
Do NOT write files yourself. Emit EXACTLY one block:

```json
{"kind":"docs","features_md":"<full updated features.md>","user_guide_md":"<full updated user-guide.md, or empty string>"}
```

Rules:
- The markdown content goes INSIDE the JSON string values (escape newlines as \n, quotes as \").
- Both values must be COMPLETE documents (not diffs/patches).
- **features.md → ENGLISH** (agent-facing). **user-guide.md → Turkish** (end-user facing).
  Keep code identifiers/paths verbatim in both.
