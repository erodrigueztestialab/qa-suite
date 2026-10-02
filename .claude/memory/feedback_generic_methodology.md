---
name: feedback-generic-methodology
description: La metodologia QA de la herramienta debe ser generica para cualquier requerimiento; nunca quemar conceptos de negocio de un cliente (EAN, EDI, etc.) en prompts, reglas ni backlog.
metadata:
  type: feedback
---

La QA Suite aplica la metodologia de TestIALab a CUALQUIER tipo de requerimiento: los casos se derivan de los CA/RN del requerimiento analizado en ese momento. Nunca meter conceptos de negocio de un cliente/proyecto puntual como casos fijos, reglas, ejemplos de prompt ni pendientes de producto.

**Why:** 2026-10-02 el usuario se preocupo seriamente ("no seguimos avanzando hasta que sea claro") al ver que yo arrastraba en el backlog "4 casos recurrentes de M4 (EAN aparte)" -- eran resultados de UN requerimiento real (Documentos dinamicos EDI), no algo del producto. Se verifico que el codigo no tenia EAN/EDI/factura/volumen; el unico rastro era el ejemplo "flujo de venta Y flujo de transferencia" en el prompt de M4, que se cambio a "flujo A y flujo B".

**How to apply:** (a) al convertir un hallazgo de un requerimiento real en regla, redactarla en abstracto (tipo de situacion, no datos del cliente) y usar ejemplos neutros; (b) no llevar decisiones sobre los casos de un entregable puntual como pendientes del producto; (c) si hablo de un caso de un proyecto, decir explicitamente que es un resultado de ese requerimiento, no una politica. Ejemplos genericos de formulario (NIT/proveedor en MAL/BIEN) se aceptaron como ilustrativos. Ver [[project-testialab-qa-strategy]].
