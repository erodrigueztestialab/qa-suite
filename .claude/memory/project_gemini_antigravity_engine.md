---
name: project-gemini-antigravity-engine
description: "El motor 'Gemini' de la QA Suite corre sobre Antigravity CLI (agy) desde el 2026-08-26 -- el gemini CLI viejo murio cuando Google cerro el tier gratis individual. La cuenta de TestiAlab tiene Google AI Pro (no tier gratis) -- cuota mas generosa de lo asumido originalmente. Detalles tecnicos, bugs encontrados/corregidos, y lo que queda pendiente."
metadata:
  type: project
  originSessionId: b759ae68-2c67-4092-bcd9-cdfd3c7aad74
  modified: 2026-09-08T21:51:11.155Z
---

## Por que existe este cambio

El motor "gemini" de `proxy.js` (`callGemini()`) nunca funciono en produccion:
apuntaba al `gemini` CLI viejo (npm `@google/gemini-cli`, login OAuth
individual). **Google cerro ese tier gratis el 18/06/2026**
(`IneligibleTierError: This client is no longer supported for Gemini Code
Assist for individuals... migrate to the Antigravity suite`) -- confirmado
por investigacion externa, no solo por el error que vimos. El reemplazo
gratuito oficial para cuentas individuales es **Antigravity CLI** (binario
`agy`, Go compilado, instalado via `winget install --id Google.AntigravityCLI
--exact`), que TestiAlab ya tiene instalado y autenticado con su cuenta.

**Restriccion de negocio explicita del usuario:** no hay forma de usar
facturacion/API key con tokens de consumo -- tiene que ser un modelo CLI
gratuito si o si (Antigravity de ser necesario). Por eso se descarto la
opcion de usar `GEMINI_API_KEY` (Google AI Studio, facturado) y se fue
directo por Antigravity.

## Validacion empirica que se hizo ANTES de tocar codigo

Se instalo `agy` (winget, v1.1.21) y se corrieron pruebas reales (Node
`spawn` + pipes, exactamente el patron que usa `proxy.js`) antes de escribir
una sola linea de implementacion:
- Invocacion headless via spawn+pipes funciona -- el bug conocido de stdout
  vacio en modo no-TTY ([issue #76](https://github.com/google-antigravity/antigravity-cli/issues/76)
  del repo oficial) **no se reprodujo** en esta version.
- Prompts largos (~5.000 chars) funcionan sin cuelgues.
- Lectura de imagenes via `--add-dir` funciona con precision (se le pidio
  describir una captura real y respondio el texto exacto del h1).
- El prompt va PEGADO al flag `-p "texto"`, NO por stdin (diferencia clave
  con el `gemini` viejo).
- No hizo falta ningun flag de "saltar permisos" ni de confianza de carpeta
  en las pruebas (a diferencia del `gemini` viejo, que fallaba con "not a
  trusted directory").

**Hallazgo aparte, no usado:** Antigravity tambien da acceso a
`claude-sonnet-4-6`/`claude-opus-4-6-thinking` bajo la misma cuenta
(partnership real Google-Anthropic, facturado por Google). **NO se uso para
nada** en la implementacion -- en ese momento se penso que corria sobre el
tier gratis (~20-30 min/semana), pero ver correccion importante mas abajo:
**la cuenta de TestiAlab en realidad tiene Google AI Pro**, no el tier
gratis. Aun asi, con Pro la cuota de Claude-via-Antigravity sigue en un pool
"fixed" separado y mas chico que el de Gemini (ver investigacion de la
propuesta original) -- seguiria sin tener sentido usarlo para reemplazar el
Plan Pro de Claude que ya tienen, pero ya no es el downgrade tan drastico que
se penso en un principio. No revisado a fondo, no es foco de este proyecto.

**CORRECCION IMPORTANTE (2026-08-26, mismo dia, confirmado con el usuario):**
la cuenta de Google que usa TestiAlab para Antigravity **tiene una
suscripcion activa a Google AI Pro** (Google One, pago mensual plano -- NO
facturacion por consumo/tokens, por eso no viola la restriccion de "sin
API key con tokens de consumo" del usuario). El usuario lo confirmo
mostrando el panel de "Límites de uso PRO" de Antigravity con 0% usado pese
a las ~15 llamadas reales de esta sesion (analisis M1 x2, PDF vision,
verify-evidence x4). Esto ANULA el supuesto de "tier gratis, se agota en
20-30 min/semana" que se uso como base de varias decisiones de esta ronda --
Google AI Pro/Ultra tiene limites bastante mas generosos, que refrescan
**cada 5 horas** (no semanal). Ver seccion "Donde ver el consumo" mas abajo.

## Que se implemento (2026-08-26, `proxy.js` + `qa-suite.html`)

- `callGemini()` reescrito completo: usa `cross-spawn` (NO `shell:true` --
  critico, porque ahora el prompt va como argumento de linea de comandos, no
  por stdin, y shell:true arriesgaria inyeccion si el prompt trae comillas/
  backticks/`$`).
- `candidateGeminiBins()`: resuelve el binario de `agy` probando (1) env var
  `AGY_CLI_PATH`, (2) `%LOCALAPPDATA%\Microsoft\WinGet\Links\agy.exe` (shim
  que en la practica NO existio en esta instalacion -- carpeta vacia), (3)
  **busqueda dinamica por prefijo** en `%LOCALAPPDATA%\Microsoft\WinGet\
  Packages\` de una carpeta que empiece con `Google.AntigravityCLI_` (el
  nombre real incluye un hash de publisher que varia, ej.
  `Google.AntigravityCLI_Microsoft.Winget.Source_8wekyb3d8bbwe` -- por eso no
  se puede hardcodear), (4) `'agy'` a secas por PATH.
- Mapeo de modelo: `GEMINI_MODEL_MAP = { opus: 'gemini-3.1-pro-high', sonnet:
  'gemini-3.1-pro-low' }` -- reusa el mismo `opts.model` que ya mandaba cada
  endpoint para Claude, CERO endpoints tuvieron que tocarse para pasar
  modelo.
- `/api/engine-status`: el chequeo de Gemini paso de `gemini --version`
  (falso positivo -- solo confirma que el binario existe, no que la auth
  funcione) a `checkGeminiAvailable()`, que corre `agy models` de verdad
  (requiere sesion valida, falla con "Please sign in..." si no la hay).
- `buildVisionPrompt`/`buildDocxAnalysisPrompt`/`buildEvidenceVerdictPrompt`:
  la rama `@ruta` especifica de Gemini (sintaxis del CLI viejo) se elimino --
  ahora ambos motores usan la misma instruccion de "lee este archivo con tu
  herramienta de lectura" + `--add-dir`, porque Antigravity es un agente con
  herramientas de archivo igual que Claude, no necesita sintaxis especial.
- **`ENGINE_DEFAULT` paso de `'gemini'` a `'claude'`** (tambien el fallback
  inicial de `_engine` en `qa-suite.html`) -- decision explicita del usuario
  via AskUserQuestion, tomada en su momento por la cuota que se creia
  semanal/ajustada de Antigravity. Esa premisa quedo corregida el mismo dia
  (la cuenta es Google AI Pro, no tier gratis, refresca cada 5h) -- se
  RE-CONSULTO al usuario con la info corregida y **confirmo explicitamente
  dejar Claude como default de todas formas** (2026-08-26, via
  AskUserQuestion): Claude Plan Pro sigue siendo el motor mas probado en este
  proyecto, prefiere no arriesgar que alguien arranque por default en el
  motor menos probado de los dos. Decision final, no reabrir sin nuevo motivo.
- UI: los rotulos pasaron de "Gemini CLI"/"Gemini" a **"Gemini (Antigravity
  CLI)"** (dropdown, toast) / **"Gemini (Antigravity)"** (botones, titulos de
  consola cortos) -- decision explicita del usuario (transparencia sobre que
  herramienta corre por debajo), no el patron neutro que usa Opus ("un
  modelo de razonamiento de IA mas alto").

## 2 bugs reales encontrados y corregidos DURANTE la verificacion (no en el diseño original)

1. **Bug critico de logica**: el patron `(req.body.engine === 'claude') ?
   'claude' : ENGINE_DEFAULT` (repetido en 8 endpoints) daba por sentado que
   ENGINE_DEFAULT seguia siendo `'gemini'` -- al cambiarlo a `'claude'`, la
   rama "no es claude" tambien resolvia a `'claude'`, haciendo IMPOSIBLE
   seleccionar Gemini desde la UI (silenciosamente ejecutaba Claude aunque
   el usuario eligiera Gemini). Se detecto porque el mensaje de progreso
   decia "Claude CLI leyendo el documento..." con Gemini seleccionado.
   Corregido a `(req.body.engine === 'gemini' || req.body.engine ===
   'claude') ? req.body.engine : ENGINE_DEFAULT` en los 8 sitios.
2. **Ruta de binario asumida incorrectamente**: se asumio que winget crea el
   shim en `WinGet\Links\agy.exe` (patron generico de winget) -- en la
   practica esa carpeta existe pero esta VACIA en esta instalacion. Sin la
   busqueda dinamica en `WinGet\Packages\Google.AntigravityCLI_*\agy.exe`
   como candidato adicional, Gemini hubiera fallado siempre con ENOENT pese
   a estar bien instalado y autenticado.

**Leccion aplicable a futuro:** con motores/CLIs nuevos, no asumir rutas de
instalacion tipicas sin verificarlas en la maquina real -- listar el
directorio primero. Y despues de cambiar una constante de default
(`ENGINE_DEFAULT`), revisar TODOS los sitios que la referencian, no solo el
que motivo el cambio -- un grep amplio post-cambio hubiera encontrado el bug
#1 antes de probar en el navegador.

3. **`spawn ENAMETOOLONG` con prompts grandes (encontrado 2026-08-27/28, al
   agregar soporte multi-archivo a M1):** el hallazgo de arriba ("el prompt va
   PEGADO al flag `-p`, NO por stdin") tiene una consecuencia practica seria
   que no se habia estresado: Windows limita la longitud total de la linea de
   comandos (~32K chars) -- con un solo archivo chico el prompt nunca se
   acercaba a ese limite, pero al analizar 3 archivos reales (o documentos
   largos) el texto embebido inline facilmente lo supera, y `spawn()` falla
   con `ENAMETOOLONG` (reportado primero por el usuario: "Falla al leer 3
   archivos"). **Fix:** dejar de embeber texto de DOCX/TXT inline en el
   prompt -- cada archivo se vuelca a un `.txt` temporal (`os.tmpdir()`) y se
   referencia por RUTA, mismo mecanismo que ya se usaba para PDFs/imagenes
   (`--add-dir` + herramienta de lectura). El prompt final queda corto sin
   importar cuantos archivos o que tan largos sean. Aplica a AMBOS motores
   (Claude ya usaba stdin asi que nunca sufrio esto, pero tambien se beneficia
   de prompts mas cortos). **Verificado real** con 3 archivos de ~23KB c/u
   (70KB combinados, muy por encima del limite que rompia antes) contra
   Gemini Y Claude -- ambos HTTP 200, contenido combinado correcto de los 3
   archivos, temporales limpiados despues. Confirmado por el usuario en
   produccion ("ya lo probe, funciona bien").
   **Leccion:** cualquier prompt que se le pase a Gemini/Antigravity via
   argumento de CLI (no solo M1) tiene este mismo techo de tamano latente --
   si a futuro otro modulo arma prompts grandes para Gemini (ej. embeber
   documentos completos), preferir referenciar por archivo temporal en vez de
   inline desde el principio, no esperar a que falle.

## Verificado real end-to-end (2026-08-26, sin mockear)

- `/api/engine-status?engine=gemini` -> `available:true` con conteo real de
  modelos.
- M1 con Gemini, requerimiento de texto simple -> analisis completo y
  coherente (Riesgo MEDIO, HU bien extraida), log del navegador confirma
  "Gemini (Antigravity CLI) leyendo el documento...".
- M1 con Gemini, **PDF real** (`Plantillas/Desarrollo para transferencias...
  .pdf`, 590KB) -> vision nativa via `--add-dir` funciono, analisis fiel al
  contenido real del PDF (Riesgo ALTO, detalle especifico de D365F&O).
- M5 `/api/verify-evidence` con Gemini, imagen real de `Demo/evidencias/` ->
  veredicto PASS correcto con razonamiento especifico sobre el contenido
  visual.
- Regresion: M1 con Claude (via curl directo) -> sin cambios, funciona
  identico a como funcionaba antes de este cambio.

## Fuera de alcance (a proposito, no hecho en esta ronda)

- Chatbot QA sigue fijo a Claude -- usa Read/Grep/Glob para RAG de carpeta,
  mecanismo no validado para Antigravity.
- El bug de desincronizacion de `_engine` (encontrado durante la sesion de
  demo del 2026-08-26: una sesion restaurada del Historico podia dejar
  `_engine` en blanco, misroteando una llamada al motor equivocado) **no se
  corrigio** -- es un issue aparte, sigue latente.
- No se implemento streaming real de progreso via `--output-format
  stream-json` de Antigravity -- se mantiene el progreso simulado por etapas
  que ya usan todos los modulos.
- No se probo concurrencia (2 llamadas Gemini en paralelo) ni el
  comportamiento exacto cuando se agota la cuota (que mensaje de error da
  `agy` en ese caso -- no se forzo a proposito para no gastar cuota real de
  pruebas).

## Donde ver el consumo (cuenta Google AI Pro de TestiAlab)

- El panel de "Límites de uso PRO" dentro de la app/extension de Antigravity
  (o pagina de Google One vinculada a esa cuenta) -- confirmado real por el
  usuario, muestra "Uso actual" (refresca cada 5h) y "Límite semanal"
  (refresca 1 vez por semana, probablemente el tope agregado).
- Desde la terminal: `agy` en modo INTERACTIVO (sin `-p`, no headless) y
  escribir `/usage` (alias `/quota`) adentro de esa sesion -- abre un panel
  TUI con el estado de cuota por modelo. No probado en esta sesion porque
  requiere TTY real (el sandbox de este proyecto no tiene uno disponible para
  automatizar login/comandos interactivos, mismo motivo por el que el login
  inicial de `agy` lo hizo el usuario manualmente).

## Limitacion real de capacidad confirmada (2026-09-08): Gemini no sigue bien instrucciones abiertas de "se exhaustivo, sin techo/piso fijo"

En M1 (analisis) y M4 (generacion de casos) de la QA Suite, ambos prompts tienen instrucciones tipo "el Minimo indicado es un piso, no una meta -- extrae/genera todo lo que el documento de para, sin importar cuantos sean". Con Gemini (`gemini-3.1-pro-high`), esta instruccion NO funciono en 2 intentos distintos (Sesion 9 en M4, Sesion 10 en M1) -- el modelo se sigue clavando en el numero minimo indicado casi exacto. Prueba de control real (mismo requerimiento, mismos 3 documentos, mismo prompt): Gemini genero 8 CA_N/6 RN_N/10 casos; Claude genero 22 CA_N/13 RN_N/30 casos. **Esto descarta que sea un problema de prompt** -- es una diferencia real de capacidad de seguimiento de instrucciones abiertas entre los dos modelos. Ver [[project_qa_suite_status]] Sesion 10 continuacion para el detalle completo y la comparacion contra un Excel de diseño manual real.

**Decision de producto (confirmada con el usuario, 2026-09-08):** Claude queda como motor recomendado para M1/M4 (analisis + generacion de casos) en requerimientos complejos; Gemini se deja para casos simples/rapidos o cuando la cuota de Claude sea la limitante. El usuario escalo esto a su lider, en espera de respuesta -- no asumir que la decision es definitiva/oficial de TestIALab hasta confirmar.

**Si en el futuro se quiere cerrar esta brecha de todos modos:** no intentar "mas instrucciones de texto en el mismo prompt" -- ya se probo 2 veces sin exito. La unica via no probada es una arquitectura de 2 pasadas: (1) pedirle a Gemini que SOLO enumere en una lista plana cada condicion/regla atomica que encuentre, sin formato final ni mencion de minimos: (2) una segunda llamada que convierta esa lista al formato con IDs. Separar "enumerar" de "redactar la seccion final" podria reducir el efecto de anclaje, a costa de duplicar las llamadas (2x latencia/cuota de Antigravity en M1). No implementado, solo propuesto y descartado por el usuario por ahora.

**How to apply:** si en el futuro Gemini/Antigravity falla con un error raro,
revisar la cuota via el panel de arriba antes de asumir que el codigo se
rompio -- pero con Google AI Pro confirmado, es mucho menos probable que sea
la causa que lo que se penso originalmente (refresca cada 5h, no 1 vez por
semana). Si se quiere fijar el binario de `agy` a una ruta especifica (ej.
otra maquina con instalacion distinta), usar la env var `AGY_CLI_PATH` antes
de iniciar el proxy.
