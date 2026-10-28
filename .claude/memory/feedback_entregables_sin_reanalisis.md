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
- "por ejemplo" con coma antes (plan y casos): la reparacion IA no siempre lo corregia; desde la sesion 29 `fixPorEjemploComma` lo reescribe sin IA a " (por ejemplo, X)" cuando no es ambiguo (sin coma o lista que cierra con y/o; limites . ; : [ ) | / >), antes de validar y despues de reparar. Si es ambiguo ("facturas, hasta el maximo") no se toca: meter de mas en el parentesis cambia el sentido.

**Casos de prueba (M4, brief 3, 2026-10-27):** los casos reciben de M1/M3 inventario, glosario, HU y plan con trazas; marcas `[src]`/`[cubre]` en la linea del ID (en el front viven en `c.marks`, nunca en pantalla ni en el Excel); `validators/casesValidator.js` (V1-V10, tests en `test/casesValidator.test.js`) + auditor (siempre) + casos para lo faltante + una reparacion + revalidacion. Reglas que no se negocian en los casos:
- Cobertura por trazabilidad, no por cantidad: todo CA/RN/ESC y cada item de "Dentro del Alcance" del plan con al menos un caso; sin "Minimo 8" ni relleno.
- Conjunto exacto / auditoria campo por campo SOLO si un CA/RN lo exige explicitamente.
- La condicion viaja completa ("Condicionado a <Ref>" con todos los codigos) y el resultado no inventa lo que el pendiente no fija; un caso, un comportamiento (sin "A o B").
- Una EXCLUSION se cubre solo con el caso negativo (que NO ocurre). Ese caso es obligatorio: el auditor no lo reporta como incoherencia y la reparacion nunca puede eliminar el unico caso que cubre un CA/RN/ESC (salvaguarda en `mergeRepairedCases`, con test; se detecto en prueba real: la reparacion borraba el caso negativo de la exclusion).
- Escenario = titulo exacto de un ESC de la HU; nombres del glosario; Tipo Smoke/Funcional/UI/UX (Excel "Func"); cada paso con su resultado.
- Si cambia el analisis de M1 o el plan de M3 (hash), los casos se marcan desactualizados; consolidar o agregar faltantes revalida sin IA (`/api/validate-cases`); Excel importado = "No auditado".
- **Revision de Liz (2026-10-27, sesion 29):** un caso por FLUJO, no por verificacion: lo que se verifica en la misma ejecucion (precargas de una pantalla, botones, datos de un registro) son pasos de un caso que cita todos los CA/RN/ESC; las variantes con otros datos u otra precondicion van aparte (V11, con dos criterios calibrados con el set real: misma preparacion, o mismo escenario y misma accion antes de la verificacion). "Conjunto exacto"/"campo por campo" solo si el requisito dice exactamente/solo estas columnas/ni mas ni menos/todos los campos (V12). Por cada dato que el usuario digita, UN caso negativo con un paso por clase invalida (vacio, cero, negativo, no numerico, mayor al disponible, inexistente, igual al origen...) sin inventar el texto del mensaje; si falta, el auditor lo reporta (FALTA_NEGATIVO_ENTRADA) y se genera en el paso de faltantes. Medido (requerimiento real, Claude, HU nueva de M1): develop 64 casos con 3 "campo por campo" y 6 precargas en casos separados; rama 30 casos, cobertura HU 97/97 y plan 19/19, mismo tiempo (~270 s).

**Revision de Liz sobre un caso real (2026-10-27, sesion 29): el HU tenia 68 RN para un requerimiento de 2 paginas y M4 saco 77 casos.** Causa raiz en M1: la regla "nada del inventario se pierde" convertia en RN todo lo que no era CA. Reglas nuevas (M1 + M3, ambos motores, validador con tests):
- Inventario con tipos de CONTEXTO (Objetivo, Contexto, Tarea, Decision, IndicacionPrueba): nunca generan CA/RN/ESC (V14); si estan pendientes van en un R_N y, en el plan, en Supuestos/Riesgos/Criterios de entrada, nunca en Alcance (V10 del plan). Lo que se deja para otra fase es EXCLUSION.
- Una RN no repite un CA (V15, contencion de raices >= 0.85) ni dice solo que algo "no esta definido" (V16, eso es un riesgo).
- Estado CONTRADICCION en el inventario (dos versiones incompatibles sin correccion explicita): se trata como PENDIENTE, nunca se elige una version, va en un R_N con las dos y el recuadro de M1 las lista "por confirmar".
- Solo un pendiente que gobierna un CA o RN exige ESC condicionado (HU) o ir en Alcance (plan): antes la reparacion fabricaba escenarios y alcance de "acceso a un ambiente" o "ubicar codigo".
- Las etiquetas internas del inventario (PENDIENTE, DEFINIDO, CONTRADICCION, "Version 1:") no van al texto (V13).
- Medido con el requerimiento real + transcripcion (Claude): develop 70 RN / 35 CA / 52 ESC; rama 10-16 RN / 31-41 CA / 39-49 ESC, cobertura completa, tiempos iguales (~230-250 s).
