---
name: project-git-workflow
description: "Esquema de ramas del repo QA-Suite: main/develop/feature con Pull Request obligatorio en ambos niveles, sin proteccion de rama activada todavia."
metadata: 
  node_type: memory
  type: project
  originSessionId: a542f78b-8a08-473d-a212-b135817135a2
  modified: 2026-09-17T21:48:51.142Z
---

Repo: `https://github.com/erodrigueztestialab/qa-suite.git` (publico). Ver [[project_git_identity]] para la identidad de autor obligatoria.

**Esquema de ramas acordado con el usuario (2026-09-17):**
- `main` -- version estable/demostrable. Solo recibe merges via Pull Request desde `develop`.
- `develop` -- rama de integracion, dia a dia. Solo recibe merges via Pull Request desde ramas `feature/<tarea>`.
- `feature/<tarea>` -- una por cada trabajo puntual (fix, ajuste, feature). Nace desde `develop`, se prueba, se sube como PR hacia `develop`.
- El usuario eligio explicitamente PR en AMBOS niveles (feature->develop Y develop->main), no merge directo en ninguno.
- **Sin proteccion de rama activada en GitHub todavia** (decision explicita del usuario, "no por ahora") -- el flujo de PRs es un acuerdo de trabajo, no esta tecnicamente forzado. Push directo a main/develop seria posible pero no se debe hacer salvo que el usuario lo pida.

**Bootstrap (unica excepcion al flujo de PRs):** el primer commit real de todo el codigo (que nunca se habia comiteado -- ver [[project_qa_suite_status]] sesion 10-12 para el historial de por que quedo pendiente tanto tiempo) se subio DIRECTO a `main` sin PR, porque era el punto de partida mismo, no una tarea sobre una base existente. `develop` se creo a partir de ese mismo commit e incluye los 3 fixes hechos en esa misma sesion (nombre de archivo con requerimiento, tabla desproporcionada en M6, campo "Paso a paso" cortado, fix de extractDesarrolloTitle) -- esos 3 fixes tambien quedaron en el commit inicial de bootstrap, no en una feature branch aparte, porque tampoco existia un `develop` previo del cual partir en ese momento.

**A partir de la PROXIMA tarea:** toda tarea nueva nace en `feature/<nombre-corto>` desde `develop` actualizado, se prueba en el navegador real (ver [[feedback_test_before_claiming_done]]), se sube, y se abre PR hacia `develop` con `gh pr create --base develop`. Pendiente resolver la autenticacion de `gh` CLI como `erodrigueztestialab` antes del primer PR real (ver [[project_git_identity]]).

**How to apply:** nunca comitear directo a `main` ni a `develop` para trabajo nuevo -- siempre crear una rama `feature/` primero. Si el usuario pide un cambio, el primer paso tecnico (despues de confirmar el entendimiento del pedido) es `git checkout develop && git pull && git checkout -b feature/...`.

**Excepcion registrada (2026-09-17, tarea del README):** el usuario pidio explicitamente saltarse el PR "por esta unica vez" para mergear `feature/readme` directo a `develop` (merge local + push, sin abrir PR en GitHub). Acto seguido pidio tambien subir `develop` a `main` -- se le pregunto explicitamente PR vs. push directo (dado que develop->main es la regla mas estricta) y eligio push directo de nuevo. Ambas fueron excepciones puntuales pedidas por el usuario, no un cambio de la regla -- seguir exigiendo PR por defecto en la proxima tarea salvo que lo pida de nuevo explicitamente. `main` y `develop` quedaron sincronizados en el mismo commit (`78eac51`, README completo) al cierre de esta tarea.
