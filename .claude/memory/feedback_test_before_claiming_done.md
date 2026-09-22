---
name: feedback-test-before-claiming-done
description: "User requires actual testing (browser/reproduction) before I report a fix or feature as done, not just code review"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a2b2d1f1-2b3d-40f6-ab0e-532d818ce455
  modified: 2026-08-18T22:30:22.018Z
---

Never report a bug as fixed or a feature as "listo"/working based only on code review or static reasoning. Actually reproduce and verify it (browser via claude-in-chrome, jsdom simulation, curl, etc.) before claiming success.

**Why:** In the TestIALab QA Suite project, I built M3–M7c and reported "todo listo" after only code review + endpoint curl checks. The user pushed back: "por favor haz pruebas antes de indicar que todo está listo." I then found a real bug (M2 rendering blank) that only surfaced through actual reproduction — first via jsdom, then confirmed and fixed via a real Chrome session (claude-in-chrome). The root cause (inline `style="display:none"` beating a CSS class rule in `showModule()`) was invisible to code review and to my first jsdom checks (which checked `innerHTML` length but not actual computed `display`) — only a real rendered screenshot / `getComputedStyle` check caught it.

**How to apply:** For this project (and as a general habit), before declaring a fix or new feature done: (1) actually run it — browser automation, a real request, a script execution — not just re-read the code; (2) when checking visual/DOM state, verify actual rendered output (screenshot, `getComputedStyle`) not just that the code executed without throwing, since silent non-exception failures (like CSS specificity issues) don't show up as errors. See [[project-qa-suite-status]].
