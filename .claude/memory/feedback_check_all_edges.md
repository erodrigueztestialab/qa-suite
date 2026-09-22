---
name: feedback-check-all-edges
description: "When fixing a behavior bug in QA Suite, check every other spot with the same pattern (both engines, all endpoints), not just the one reported"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b49e295b-2887-4c2f-99d8-c74a0cb9b892
  modified: 2026-09-08T20:11:43.149Z
---

When diagnosing/fixing a bug in TestIALab QA Suite (`C:\TestiAlab\QA-Suite`), before declaring a fix complete, actively search for every other place that shares the same underlying pattern — don't stop at the one spot the user reported.

**Why:** On 2026-09-08, the user reported M4 case generation "still generating 10 cases" after a prompt-wording fix from a prior session. Investigation found the real cause was a DIFFERENT bug: `/api/generate-cases` only passed `model:'opus'` (the strong model) when `engine==='claude'` — for `engine==='gemini'` it silently fell back to the weak model (`gemini-3.1-pro-low`) because nobody carried the "use the strong model for M4" policy over when Gemini/Antigravity was added as a second engine (see [[project_gemini_antigravity_engine]], [[project_qa_suite_model_policy]]). The EXACT SAME `engine === 'claude' ? {model:'opus'} : {engine}` pattern was copy-pasted into 2 other endpoints (`/api/generate-gap-cases`, `/api/verify-coverage`) — all 3 had the identical gap. Had only the one reported endpoint been fixed, the other two would have kept silently under-powering Gemini. The user's explicit correction: "cuando hagamos un cambio como este, revisa todo este tipo de aristas, no solo apliques los cambios a una sola parte."

**How to apply:** Whenever a fix touches one endpoint/function in `proxy.js` or `qa-suite.html`, grep for the exact literal pattern being changed (not just the one line) across the whole file before considering the fix done — copy-pasted logic (dual-engine branches, per-endpoint model selection, per-endpoint progress-stage wiring, etc.) is common in this codebase and bugs in it tend to be duplicated across every site that copied the pattern. This is a general instance of a recurring project trait: features get added to Claude's code path first and the Gemini/Antigravity equivalent is easy to forget (also true of the M1 multi-file `--add-dir` fix and the console-slot Fix 0 from earlier sessions) — when auditing a fix, explicitly ask "does the other engine's branch need the same change?" as a checklist item, not just "does this one call site work now."
