---
name: feedback-jira-worklog
description: "Formato del resumen para el reporte de horas en JIRA Timeboard: titulo + 4 bullets cortos, una linea por correccion"
metadata:
  type: feedback
---

Cuando el usuario pide un resumen para su reporte de horas en JIRA Timeboard, el formato aprobado (2026-10-21, tras dos iteraciones) es:

- Titulo en negrita: "<Producto>: <que se hizo> + <segundo bloque>" (ej. "QA Suite: correccion de bugs reportados por QA (Liz) + restablecimiento del motor Gemini").
- 3-4 bullets, UNA linea cada uno, con el modulo en negrita y la correccion en lenguaje de negocio (sin nombres de funciones, causas tecnicas ni tablas).
- Ultimo bullet: pruebas + PRs ("Pruebas end-to-end con IA real y entrega en PRs #69/#70").

**Why:** la primera version (bullets largos con causas tecnicas) fue "muy larga"; la segunda (4 bullets de 5 palabras) quedo demasiado escueta en las correcciones. El punto medio fue el aprobado.

**How to apply:** entregar directo en ese formato, sin version larga alternativa. Ver [[project-qa-suite-status]].
