---
name: project-plan-liz-2026-10-08
description: Plan de 6 fases salido de la demo con Liz (2026-10-08) y decisiones del usuario; orden y alcance de lo que se esta implementando.
metadata:
  node_type: memory
  type: project
  originSessionId: d4acc0f1-a490-43af-8cff-45177129a6e3
  modified: 2026-10-08T20:54:14.776Z
---

Demo/reunion con Liz (QA de TestIALab) el 2026-10-08 -> plan de 6 fases aprobado por el usuario (las decisiones son del usuario, no de Liz).

Fases: (1) bugs rapidos: Word sin idioma (w:lang) -> palabras en rojo, M5 clic evidencia, mensaje verde de cobertura completa en M4, bloqueados no salen en Avance, editables del Avance que parecen deshabilitados, estados en espanol + quitar voseo de la UI, importar Excel en M4 sin generar; (2) Informe de Avance gerencial: secciones por estado con colores, pendientes solo cantidad, detalle interno no exportable, destino del bloqueo (UAT / insumo), PNG compacto + boton "Copiar mensaje"; (3) Bugs: descripcion como QA, pasos numerados, quitar "Caso de prueba asociado" del Word; (4) M4 consolidar casos de QA/cliente (Excel cualquier plantilla, Word) con los de IA + prompt de casos operativos ejecutables (generico); (5) Informe de finalizacion en Certificacion; (6) HANDOFF/README/instalacion.

Decisiones (2026-10-08): repo queda PUBLICO por hoy (Liz lo necesita), el usuario lo pone privado el mismo -- no tocarlo. M2: complejidad NO mueve horas (ritmo), solo aclarar la nota. Mensaje de avance se pega en **Teams**. Estados en espanol (Exitoso, Fallido, Bloqueado, Desestimado, Sin ejecutar) -- sin audiencia en ingles por ahora. Chatbot y ROI fuera de alcance.

**Why:** feedback directo de una QA usando la herramienta en un requerimiento real.
**How to apply:** implementar fase por fase sin pausar (ver [[feedback-big-requests-plan-mode]]), probar contra el 3001 real, PR detallado por fase; metodologia generica ([[feedback-generic-methodology]]).
