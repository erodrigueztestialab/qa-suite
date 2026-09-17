# Transcripción — Explicación de negocio: Transferencias de inventario entre empresas (Franquicias)

**Sesión con:** Oscar Cuadros (Especialista de producto, Totto)
**Fecha:** 15-enero-2026
**Tema:** Reglas de negocio del flujo de transferencia de inventario entre empresas del grupo (franquicias/Nalsani)

---

**Oscar:** Bueno, el flujo es así: cuando una tienda necesita stock que no tiene, se genera una transferencia desde otra empresa del grupo que sí lo tiene disponible. Esto pasa todo el tiempo entre franquicias.

**QA:** ¿Y qué pasa si la empresa origen no tiene stock suficiente en el momento exacto de confirmar la transferencia?

**Oscar:** Ahí el sistema tiene que bloquear la operación completa, no se permite hacer transferencias parciales. Si pedís 10 unidades y solo hay 7, se rechaza toda la transferencia, no se manda solo lo que hay. Esa es una regla que nos costó mucho que quedara clara con el equipo técnico al principio.

**QA:** ¿Quién puede aprobar una transferencia?

**Oscar:** Solo usuarios con rol de supervisor. Un cajero normal puede *solicitar* la transferencia, pero la aprobación final la tiene que dar alguien con ese rol. Es un control que pidió el área financiera para evitar movimientos de inventario sin trazabilidad.

**QA:** ¿Hay un límite de tiempo para que la transferencia se efectivice una vez aprobada?

**Oscar:** Sí, 24 horas hábiles. Si pasa ese tiempo y no se completó el movimiento físico, la transferencia queda marcada como "vencida" y hay que volver a generarla desde cero. No se puede "revivir" una transferencia vencida.

**QA:** ¿Qué pasa con el descuento del stock? ¿Se descuenta en el momento de aprobar o cuando se confirma la recepción en la tienda destino?

**Oscar:** Se descuenta del origen en el momento en que el supervisor aprueba, no cuando llega a destino. Esto es importante porque evita que dos tiendas distintas pidan el mismo stock al mismo tiempo y se genere un doble compromiso. El destino recién suma el stock cuando confirma la recepción física.

**QA:** Última pregunta: si se cancela una transferencia ya aprobada pero antes de que llegue a destino, ¿el stock vuelve automáticamente al origen?

**Oscar:** Sí, automático. En el momento en que se cancela, el sistema devuelve el stock a la empresa origen sin necesidad de intervención manual.
