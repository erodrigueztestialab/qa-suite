# Demo end-to-end — TestIALab QA Suite

Paquete listo para mostrarle a los managers el flujo completo de la QA Suite
funcionando de punta a punta con datos reales (llamadas de IA reales, no
simuladas). Todo lo que hay en esta carpeta corresponde a una corrida real ya
verificada — nada fue inventado a mano.

## Qué hay en cada carpeta

- **`requerimiento/`** — el requerimiento demo (`RQ-DEMO-001 - Login con
  bloqueo de cuenta.txt`), una feature inventada (login con bloqueo de cuenta
  tras 3 intentos fallidos) redactada como la escribiría un BA/PM real, sin
  ninguna etiqueta ni ayuda especial para la IA. Es el archivo que se sube en
  M1 · Procesar Requerimiento.
- **`evidencias/`** — las capturas que se suben en M5 · Ejecución y Evidencias:
  - `caso-exito-login-1-formulario.jpg` + `caso-exito-login-2-dashboard.jpg`:
    evidencia de un login exitoso → la IA la verifica como **PASS**.
  - `caso-error-bloqueo.jpg`: evidencia de que la cuenta NO se bloqueó al
    tercer intento fallido (el bug) → la IA la verifica como **FAIL**.
  - Los `_mock-*.html` son el código fuente de esas capturas (mockups de
    pantalla), por si hay que regenerarlas o ajustarlas.
- **`artefactos-generados/`** — copia de respaldo de todos los documentos
  reales que la app generó en esta corrida (HU, Plan de Pruebas, Excel de
  Casos, Word del bug con la evidencia incrustada, PNG del Informe de Avance,
  Certificación de Calidad en Word y PDF). Sirven para mostrar sin tener que
  regenerar nada en vivo si hay afán o falla de conexión el día de la demo.

## Qué generó la IA en esta corrida (para saber qué esperar)

- M1 detectó el riesgo correcto: *"El bloqueo no se activa exactamente en el
  tercer intento fallido (off-by-one)..."* — la IA anticipó el bug antes de
  que existiera evidencia.
- M4 generó 10 casos (Smoke/Funcional/UI/UX). Los dos usados en la demo:
  - **CP_1** — Autenticación exitosa y acceso al Dashboard.
  - **CP_3** — Activación del bloqueo únicamente en el tercer intento fallido
    consecutivo.
- M5 verificó CP_1 como **PASS** y CP_3 como **FAIL**, con una justificación
  paso a paso citando exactamente qué se ve en cada captura.
- M6 autocompletó el bug (título, severidad sugerida, pasos para reproducir,
  tipo de error) a partir del caso fallido, con la captura de evidencia
  incrustada directamente en el Word del bug.
- El Informe de Avance y la Certificación de Calidad reflejan en vivo el
  resultado: 1 Pass, 1 Blocked (por el bug), 8 To Do, con el bug listado con
  desarrollador y severidad.

## Guion sugerido para la demo en vivo

1. **M1 · Procesar Requerimiento** — subir el `.txt` de `requerimiento/` y
   pulsar "Analizar con Claude". Mostrar cómo la IA extrae HU, Criterios,
   Reglas, Riesgos e Impactos de un texto plano, sin ninguna estructura previa.
2. **M2 · Impacto y Estimación** — mostrar que el QA puede editar todo, nada es
   una caja negra.
3. **M3 · Plan de Pruebas** — generar y mostrar el documento con estructura
   real de plantilla.
4. **M4 · Escenarios y Casos QA** — generar los 10 casos, mostrar la tarjeta
   de un caso (pasos + resultado esperado) y la cobertura de criterios.
5. **M5 · Ejecución y Evidencias** — el momento fuerte de la demo:
   - Ejecutar **CP_1** subiendo las dos capturas de éxito → mostrar el
     veredicto PASS con la justificación de la IA.
   - Ejecutar **CP_3** subiendo `caso-error-bloqueo.jpg` → mostrar el
     veredicto FAIL, con el desglose paso a paso (rojo en el paso donde
     debería bloquear y no bloqueó).
   - Click en "Reportar bug" → mostrar el formulario ya autocompletado.
6. **M6 · Gestión de Bugs** — mostrar el bug guardado y exportar el Word
   (la evidencia va incrustada como imagen dentro del documento).
7. **Informe de Avance Diario** — mostrar cómo el % efectivo, la tabla de
   bugs y el estado de cada caso se actualizan solos en tiempo real.
8. **Certificación de Calidad** — cerrar el ciclo generando el documento
   final, que referencia el bug real encontrado.

## Cómo repetirla

- Con `node proxy.js` corriendo en `C:\TestiAlab\QA-Suite`, abrir
  `http://localhost:3001`.
- La sesión de esta corrida quedó guardada en el **Histórico** del navegador
  donde se ejecutó (sesión "Inicio de sesión con bloqueo de cuenta") — si es
  el mismo equipo/navegador el día de la demo, se puede abrir directo desde
  ahí sin resubir nada.
- Si se necesita una sesión nueva desde cero (por ejemplo en otro equipo),
  repetir el guion de arriba con los archivos de `requerimiento/` y
  `evidencias/` — el resultado de la IA puede variar levemente en la
  redacción de los casos entre corridas, pero el patrón (un caso de éxito
  claro y un caso de bloqueo con el bug) se mantiene por cómo está redactado
  el requerimiento.

## Nota sobre las evidencias

Las capturas de `evidencias/` son mockups (pantallas de un "Portal
Corporativo Aurora" ficticio, no un sistema real) creados específicamente
para esta demo — el objetivo es mostrar que el motor de verificación de la
QA Suite (Claude con visión) evalúa el contenido real de la imagen contra
cada paso del caso de prueba, no que confirme cualquier captura a ciegas. De
hecho, durante la preparación de esta demo la IA rechazó dos versiones
intermedias de las capturas por evidencia incompleta o inconsistente con el
caso — quedaron así las versiones finales, ya validadas.
