# Transcripción — Explicación de negocio: Política de devoluciones en tienda

**Sesión con:** Laura Gómez (Líder de Operaciones, Totto)
**Fecha:** 22-enero-2026
**Tema:** Reglas de negocio para devoluciones de producto en tienda física

---

**Laura:** La política general es 30 días calendario desde la fecha de compra, con factura o comprobante electrónico. Sin comprobante no se puede procesar la devolución, solo cambio por otra prenda de igual o mayor valor, y ahí sí con autorización del encargado de tienda.

**QA:** ¿Aplica el mismo plazo para productos comprados online y recogidos en tienda?

**Laura:** No, ahí es diferente. Para compras online el plazo son 5 días hábiles desde que el cliente confirma la recepción en el sistema, no desde la compra. Es una diferencia que generó bastante confusión en el equipo de QA la primera vez que lo probamos.

**QA:** ¿Hay productos que no admiten devolución bajo ninguna condición?

**Laura:** Sí: ropa interior, trajes de baño y productos en promoción marcados explícitamente como "venta final". Esos tres casos el sistema debe bloquear la devolución aunque el usuario tenga el comprobante y esté dentro del plazo.

**QA:** ¿El reembolso es siempre al mismo medio de pago original?

**Laura:** Por defecto sí. La única excepción es si el cliente pagó en efectivo y el monto supera cierto umbral (actualmente 500.000 pesos), en ese caso el reembolso se hace por transferencia bancaria, no en efectivo en caja, por temas de seguridad y control de caja.
