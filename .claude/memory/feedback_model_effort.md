---
name: feedback-model-effort
description: "User's preference for which Claude model/effort to use for fixes and development work in the QA Suite project"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d8ff15e7-0d22-40c4-beb2-4b3ce5b9d7cf
  modified: 2026-08-19T16:40:28.213Z
---

For fixes and development work (bug fixes, feature builds like the QA Suite work), use Sonnet at medium reasoning effort by default, unless the user explicitly asks for something else (e.g. a deeper/higher-effort pass for a specific hard problem).

**Why:** User said "trabaja por favor con Sonnet medio, para lo que son fixes y desarrollos aqui, por ahora, a menos que te indique lo contrario" (2026-08-19) — this is a cost/speed calibration for routine implementation work, not a permanent ceiling.

**How to apply:** Default to medium effort for routine bug-fix/feature-build turns in this project. If the user asks for a harder investigation (e.g. deep debugging, architecture design), it's fine to reason more — the instruction is about the default, not an absolute cap.
