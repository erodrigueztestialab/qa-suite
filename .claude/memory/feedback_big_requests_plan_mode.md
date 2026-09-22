---
name: feedback-big-requests-plan-mode
description: "Para pedidos grandes/multi-módulo en QA Suite, usar plan mode + implementación por fases con verificación en navegador tras cada fase"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 960ebcbb-2a81-44c1-ab61-631caa04f9c5
  modified: 2026-08-20T16:21:26.349Z
---

Cuando el usuario trae una lista larga de cambios que toca muchos módulos a la vez (ej: la ronda de 2026-08-20 con ~10 fases de UX/contenido en todos los módulos), el flujo que funcionó bien y el usuario aprobó sin objeciones fue:

1. Entrar a **plan mode** (EnterPlanMode) antes de tocar código, aunque el usuario no lo haya pedido explícitamente.
2. Investigar con varios agentes Explore en paralelo (agrupados por módulos relacionados) + leer directamente las plantillas/documentos reales de referencia (.docx/.png) en vez de asumir su estructura.
3. Escribir un plan con hallazgos de causa raíz explícitos (ej: un solo `max-width` en CSS explicaba el reclamo repetido en 8 módulos distintos) — esto evita reparar el mismo síntoma módulo por módulo.
4. Implementar y **probar en el navegador contra la sesión real persistida después de cada fase**, no todo al final — incluye probar inputs con foco/scroll-jump, exportar archivos reales y leer su contenido (mammoth para .docx), y simular cambios de sesión vía `restoreSnapshot()` con datos falsos cuando no vale la pena gastar otra llamada real de IA.
5. Cuando una instrucción del usuario es ambigua (ej: "el botón Regenerar no aplica, quítalo"), tomar la interpretación más razonable, implementarla, y **marcarla explícitamente como asunción a revisar** en el resumen final — no bloquear el trabajo pidiendo aclaración salvo que la decisión cambie el modelo de datos de forma difícil de revertir (ese sí ameritó una nota aparte en el plan, no una pregunta bloqueante).

**Por qué:** el usuario aprobó el plan de una sola vez (ExitPlanMode sin cambios) y dejó que se implementaran las 10 fases completas en un solo hilo de trabajo sin pedir pausas — confirma que prefiere que se ejecute con autonomía una vez el plan está aprobado, en vez de check-ins por cada fase.

**Cómo aplicar:** la próxima vez que traiga una lista similar (varios módulos, varios tipos de cambio), repetir este flujo en vez de preguntar fase por fase si puede proceder. Ver [[project_qa_suite_status]] Session 4 para el detalle de lo que se hizo con este método.
