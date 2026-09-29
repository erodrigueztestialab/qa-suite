---
name: feedback-pr-descriptions
description: Las descripciones de PR en QA-Suite deben ser ultra detalladas (contexto, causa raiz, cambios por funcion, verificacion con tabla de resultados, riesgos, commits), nunca un resumen corto.
metadata:
  type: feedback
---

Toda descripcion de Pull Request en QA-Suite (feature->develop Y develop->main) debe ser **ultra detallada**. El usuario califico de "muy pobre" una descripcion de sync de 5 bullets (PR #17, 2026-09-29) y pidio rehacerla.

**Why:** los PRs son el registro de que se cambio y por que; un resumen de bullets no le sirve al equipo ni a quien revise despues.

**How to apply:** estructura minima (ver PR #17 como plantilla de referencia):
1. Contexto: que se reporto/pidio (tabla si son varios puntos).
2. Diagnostico/causa raiz, con ejemplo antes/despues cuando aplique.
3. Cambios por archivo y por funcion (nombres reales), incluyendo decisiones del usuario y consumidores revisados sin impacto.
4. Verificacion: datos de prueba + tabla Paso | Que se verifico | Resultado (incluyendo lo que fallo en la primera corrida y como se corrigio).
5. Riesgos y pendientes (lo que NO se probo, p. ej. Gemini).
6. Commits incluidos (tabla hash | descripcion | archivos).
Un sync develop->main repite el detalle del PR de feature, no solo lo referencia. Cuerpos largos: escribirlos con la herramienta Write a un .md del scratchpad y usar `gh pr create/edit --body-file` (un heredoc con tanto markdown se rompio en Bash). Ya no hace falta la advertencia "NO usar Delete branch" en syncs a main: el ruleset protege `develop` tambien del boton manual (ver [[project-git-workflow]]).
