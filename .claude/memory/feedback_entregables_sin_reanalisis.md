---
name: feedback-entregables-sin-reanalisis
description: Los entregables de QA (HU, plan, casos) deben salir alineados con el requerimiento sin re-análisis externo; todo defecto detectado se vuelve regla o validación de la herramienta.
metadata:
  type: feedback
---

Los entregables de QA (HU, plan de pruebas, casos) deben salir de la herramienta alineados con el requerimiento fuente sin re-análisis externo. Todo defecto que se detecte en un entregable se convierte en una regla o una validación de la herramienta, no en una corrección manual.

**Why:** el QA tenía que auditar a mano el HU de M1 contra el requerimiento (fuera de la herramienta) y pedir correcciones hasta que quedara completo. El brief de alineación de M1 (2026-10-26) encontró 9 clases de defecto (contradicciones, afirmaciones sin sustento, pendientes como definitivos, cobertura incompleta, convenciones, términos alterados, condición no propagada, premisas como hecho, escenarios con alternativas combinadas) y pidió prevenirlas en el prompt y detectarlas con un validador.

**How to apply:** cuando aparezca un defecto en un entregable, no lo corrijas solo en ese documento: agrega la regla genérica al prompt y/o un chequeo en el validador (`validators/huValidator.js` para M1, con test en `test/`) y verifícalo con una fixture sintética. M3 y M4 van a reutilizar el mismo patrón (inventario + trazabilidad [src]/[cubre] + validador + auditor + reparación + hash de versión). Ver [[feedback-generic-methodology]] (las reglas nunca llevan conceptos de un cliente) y [[feedback-check-all-edges]] (ambos motores).

**Plan de Pruebas (M3, brief 2, 2026-10-26):** el plan recibe de M1 el inventario (Estado, Tipo con EXCLUSION, Ref), el glosario y el analisis con trazas, y pasa por `validators/planValidator.js` (V1-V9, tests en `test/planValidator.test.js`) + auditor + una reparacion. Reglas que no se negocian en el plan:
- Pendiente (PENDIENTE / DEP-XX) va en Dentro del Alcance "(condicionado a DEP-XX)" con TODAS sus Ref; nunca en Fuera. Fuera solo lleva EXCLUSION explicitas.
- Ninguna afirmacion mas fuerte que la fuente: modales y premisas se conservan; nada de "tiempo real", "exige" o dano legal si la fuente no lo dice.
- Nombres del glosario tal cual; prohibidos los genericos ("terceros", "el proveedor") cuando la fuente nombra al actor.
- Cada DEP se cita por codigo en supuestos, riesgos o criterios de entrada; cada riesgo del analisis aparece en 4.1 o 4.2.
- El mismo item, con la misma condicion, en Objetivo, Alcance, Estrategia, Tipos/Niveles y Criterios de salida.
- "Cliente" con mayuscula; "por ejemplo," con coma despues y nunca antes; N/N-1/X en vez de cifras inventadas; equipo "TestIAlab".
- Titulo del proyecto con conectores en minuscula ("B2B y Cadenas"); Responsables nunca con relleno: 3 filas solo con Equipo si el QA no dio datos.
- Si el analisis de M1 cambia (S.analysisHash distinto de S.planAnalysisHash), el plan se marca desactualizado.
