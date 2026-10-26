---
name: feedback-merge-authorization
description: El usuario autoriza a Claude a mergear los PRs (feature->develop y develop->main) si las pruebas pasan; no hay CI en el repo.
metadata:
  node_type: memory
  type: feedback
  originSessionId: d6b7b2f8-49bc-40f9-9ade-04c6d36fd74c
  modified: 2026-10-26T21:37:39.567Z
---

El usuario autoriza que Claude mergee sus PRs ("mergea tú sin restricciones si todo bien en el CI"), tanto feature/* -> develop como develop -> main, cuando todo pasa.

**Why:** dicho el 2026-10-26 al cerrar el brief de M3; quiere que el flujo de PRs no lo frene. El repo NO tiene CI (gh pr checks: "no checks reported"), así que "todo bien" = `npm test` en verde + PR MERGEABLE/CLEAN + las pruebas reales del brief ya hechas.

**How to apply:** antes de mergear, correr `npm test` y `gh pr view N --json mergeable,mergeStateStatus`; si está limpio, mergear ambos PRs y avisar. Ojo: el clasificador del modo auto bloquea `gh pr merge` ("Merge Without Review") aunque el usuario lo autorice en el chat; en ese caso decirle que responda "mergea el N" o que agregue una regla de permiso `Bash(gh pr merge:*)`. Ver [[project-git-workflow]].
