---
name: project-testialab-qa-strategy
description: Modelo real de entrega/ejecucion de QA en TestIALab (una sola entrega completa, sin ciclos) que deben reflejar el Plan de Pruebas y cualquier prompt que hable de estrategia.
metadata:
  type: project
---

En TestIALab **no hay entregas a QA por ciclos, sprints ni entregas parciales**. Desarrollo entrega el desarrollo COMPLETO de una sola vez; QA ejecuta TODOS los casos; a medida que Desarrollo corrige bugs, QA hace re-test de cada bug y regresion focalizada de los casos impactados, hasta cerrar. Confirmado por el usuario el 2026-09-29.

Criterios base acordados con el usuario:
- **Entrada:** desarrollo completo desplegado en el ambiente de pruebas, casos aprobados, datos de prueba disponibles.
- **Salida:** todos los casos ejecutados, bugs corregidos y re-testeados (o aceptados formalmente por el cliente), regresion focalizada de los casos impactados en Pass.

**Why:** el prompt del Plan de Pruebas (`buildPlanPruebasPrompt` en proxy.js) pedia "enfoque de pruebas (ciclos, regresion, ambientes)" sin explicar el modelo, y el plan salia con "primer ciclo / segundo ciclo / ciclos adicionales". Corregido con la instruccion 6 del prompt (modelo de entrega) + Estrategia y Criterios de entrada/salida guiados.

**How to apply:** cualquier prompt o texto que hable de estrategia de pruebas, entregas o criterios (Plan de Pruebas, Certificacion, README) debe usar este modelo. "Ciclo de pruebas" como nombre del proceso completo de QA de un requerimiento es aceptable (se usa en la Certificacion y la UI); lo que NO va es dividir la ejecucion en ciclos/entregas. El Informe de Avance ya es coherente (sin campo "Ciclos"; Re-test/Regresion calculados).

**Actualizacion (2026-09-30):** el modelo ya esta tambien en `buildCertificationPrompt` (instruccion 6, PR #24): los casos pendientes se ejecutan sobre la misma entrega y esta prohibido "iteracion complementaria", "siguiente ciclo", etc. Ademas, ni el Plan ni la Certificacion citan IDs internos del analisis (CA_N/RN_N/R_N/ESC_N); la Certificacion si puede citar CP_N y BUG_N (PR #22).
