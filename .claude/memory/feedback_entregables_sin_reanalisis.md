---
name: feedback-entregables-sin-reanalisis
description: Los entregables de QA (HU, plan, casos) deben salir alineados con el requerimiento sin re-análisis externo; todo defecto detectado se vuelve regla o validación de la herramienta.
metadata:
  type: feedback
---

Los entregables de QA (HU, plan de pruebas, casos) deben salir de la herramienta alineados con el requerimiento fuente sin re-análisis externo. Todo defecto que se detecte en un entregable se convierte en una regla o una validación de la herramienta, no en una corrección manual.

**Why:** el QA tenía que auditar a mano el HU de M1 contra el requerimiento (fuera de la herramienta) y pedir correcciones hasta que quedara completo. El brief de alineación de M1 (2026-10-26) encontró 9 clases de defecto (contradicciones, afirmaciones sin sustento, pendientes como definitivos, cobertura incompleta, convenciones, términos alterados, condición no propagada, premisas como hecho, escenarios con alternativas combinadas) y pidió prevenirlas en el prompt y detectarlas con un validador.

**How to apply:** cuando aparezca un defecto en un entregable, no lo corrijas solo en ese documento: agrega la regla genérica al prompt y/o un chequeo en el validador (`validators/huValidator.js` para M1, con test en `test/`) y verifícalo con una fixture sintética. M3 y M4 van a reutilizar el mismo patrón (inventario + trazabilidad [src]/[cubre] + validador + auditor + reparación + hash de versión). Ver [[feedback-generic-methodology]] (las reglas nunca llevan conceptos de un cliente) y [[feedback-check-all-edges]] (ambos motores).
