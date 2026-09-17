# Handoff — TestIALab QA Suite IA

> Documento de continuidad generado desde una conversación con Claude (claude.ai) para retomar el trabajo en Claude Code. Contiene todas las decisiones de arquitectura, todo lo construido, todos los bugs encontrados y corregidos, y el estado exacto donde se dejó el proyecto.

---

## 1. Contexto del proyecto

**TestIALab** es una empresa de QA (Lizeth Camacho / equipo QA) que está migrando/adaptando un mecanismo de automatización de pruebas con IA que ya se había construido antes para **otro cliente (Cinemark)**, hacia su propia herramienta interna: **"QA Suite IA"**.

### El proyecto de referencia (Cinemark)
Un mecanismo ya construido y funcional para Cinemark con esta arquitectura:
- HTML/JS vanilla (`qa-suite.html`, ~11,900 líneas) + proxy Node.js (`proxy.js`, servidor `http` nativo, puerto 3000).
- Motor IA: **Claude Code CLI** en modo headless (`claude --print --output-format stream-json`), usando sesión Plan Pro (sin API key).
- 7 módulos secuenciales con bloqueo (`data-requires`): Analizador de riesgo → Análisis de impacto → Casos de prueba → Ejecución (con evidencia visual) → Reporte global/Bugs → ROI → Informe de Regresión/UAT → Certificación QA.
- Integración nativa con **Azure DevOps** (Work Items, Test Plans, Test Manager Service).
- Prompts fuertemente hardcodeados al dominio de Cinemark (Flutter, países LATAM, membresías Plus/Black/Fan, etc.)
- Estimación de esfuerzo QA basada en factores calibrados con datos de Cinemark (`QA_EST`, 8 min/caso de benchmark ROI).
- Historial persistido en IndexedDB por HU.

### El proyecto actual (TestIALab)
Se parte de un esqueleto mucho más simple que Cinemark:
- `qa-suite.html` (~1,000 líneas iniciales) + `proxy.js` (Express, puerto **3001**).
- Motor IA inicial: solo **Gemini CLI**.
- Solo **M1 (Analizador)** funcional; M2-M5 eran placeholders "En construcción".
- Sin integración con Azure/Jira — el flujo es: usuario sube un documento (PDF/DOCX/TXT) → IA analiza → genera Historia de Usuario + Criterios de Aceptación + Reglas de Negocio (+ Riesgos/Impactos/Escenarios QA, que se generaban pero no se mostraban — bug encontrado y corregido).
- `package.json` ya traía `mammoth` y `pdf-parse` como dependencias, pero **sin usarlas** en el código (pista de que alguien ya había planeado esto antes).

### Documentos de referencia analizados
1. **PDF/DOCX "Desarrollo para transferencias de inventario entre empresas (Franquicias/Nalsani)"** — especificación de requerimiento real de un cliente (Nalsani), usado como caso de prueba real a lo largo de toda la sesión. Tiene 6 imágenes incrustadas (capturas del POS).
2. **"Plan de pruebas - Proyecto Totto (Correo Electrónico Dafiti)"** — ejemplo real del formato de **Plan de Pruebas** que usa TestIALab con sus clientes (Objetivo, Alcance dentro/fuera, Supuestos, Riesgos funcionales/negocio, Estrategia, Tipos/Niveles de prueba, Criterios de entrada/salida, Responsables).
3. **Plantilla Excel "En blanco con logo"** — plantilla real de gestión de casos que usa TestIALab: hojas `VC`, `TestProgress` (dashboard pass/fail/blocked/etc.), `Cierre`, `TestCases` (columnas: ID, Requisito Funcional, Tipo, Escenario, Caso, Objetivo, Paso a Paso, Resultado Esperado, ciclos C1-C10, Regresión, Resultado, etc.), `TestEvidence_Pass`, `Bugs`.
4. **Imagen del "Testing progress report"** — el dashboard de avance diario que TestIALab hace hoy en Excel manualmente.
5. **"Certificación de Calidad - Totto / Proyecto Transferencia de Pedidos entre Empresas-POS"** — ejemplo real del documento de **Certificación QA final** (Información general, Alcance, Resumen de ejecución con %, Justificación de casos no ejecutados, Gestión de defectos con tabla Bug/Caso/Descripción/Estado, Validaciones clave, Conclusión de calidad, Observaciones).

---

## 2. Decisiones de arquitectura (tomadas ANTES de escribir código)

Se acordaron explícitamente estas decisiones antes de tocar el código, vía preguntas de elicitación:

| Decisión | Resultado |
|---|---|
| Motor de IA | **Dual y configurable**: Gemini CLI + Claude Code CLI, seleccionable por el usuario en un dropdown del sidebar. Selector persiste en `localStorage`. |
| Origen del requerimiento | **Solo carga de documentos** por ahora (PDF/DOCX/TXT). Se deja la puerta abierta a integrar Azure DevOps o Jira más adelante (aún no decidido cuál). |
| Formato de salida de casos/ejecución | **Excel simplificado**: solo la hoja de casos (columnas de `TestCases`), sin fórmulas ni las demás hojas (`TestProgress`, `Bugs`, etc. quedan fuera por ahora — es temporal, mientras se decide si migran a Azure o Jira). El QA pega manualmente ese Excel simplificado en la plantilla maestra real. |
| Persistencia | **Historial único global** (como Cinemark), sin separar por cliente — vive en IndexedDB, aunque **todavía no se ha implementado** (ver pendientes). |
| Entrega del "informe de avance" | **Solo generar el reporte** (dashboard/HTML/Excel) para que el QA lo copie/descargue y lo envíe manualmente — **NO** envío automático por correo (no SMTP). |

### Los 3 documentos/entregables distintos identificados (importante no confundirlos)
1. **Plan de Pruebas** (al inicio del ciclo) — Word, estructura del ejemplo Totto.
2. **Informe de Avance** (diario, durante la ejecución) — dashboard tipo el Excel de "Testing progress report" (Pass/Retired/Fail/Blocked/To Do, %, Ciclos, Re-test, Regresión), descargable.
3. **Certificación de Calidad QA** (al cierre) — Word, estructura del ejemplo de Nalsani/Totto, con prosa generada por IA (análisis de resultados, justificación de no ejecutados, conclusión de calidad) en base al estado real de casos + bugs.

### Mapeo de módulos acordado

| # | Módulo | Qué hace |
|---|---|---|
| M1 | Analizador de riesgo | Sube documento → IA genera HU, Riesgo, Criterios de Aceptación, Reglas de Negocio, Riesgos, Impactos, Escenarios QA |
| M2 | **Impacto y Estimación** (renombrado de "Riesgos" — ver §4) | El QA **valida** (no re-analiza) las áreas de impacto detectadas en M1, define cobertura y ambiente, ajusta estimación de horas |
| M3 | Casos de prueba | Genera casos con IA → tabla en pantalla + exporta Excel simplificado — **NO CONSTRUIDO TODAVÍA** |
| M4 | Ejecución | Sube evidencia, IA da veredicto por caso (críticos vs. variables, patrón de Cinemark) — **NO CONSTRUIDO** |
| M5 | Bugs | Registro de defectos — **NO CONSTRUIDO** |
| M6 | ROI | Tiempo IA vs. manual, benchmark propio de TestIALab (no el de Cinemark) — **NO CONSTRUIDO** |
| M7a | Plan de Pruebas (Word) | **NO CONSTRUIDO** |
| M7b | Informe de Avance (dashboard) | **NO CONSTRUIDO** |
| M7c | Certificación QA (Word) | **NO CONSTRUIDO** |

**Orden de construcción acordado:** M1 (arreglo) → capa de motor IA dual → M2 → M3 (+ export Excel) → M4 → M5 → M6 ROI → M7a → M7b → M7c.

**Estado real de avance: se completaron M1 y M2. M3 en adelante NO se ha tocado.**

---

## 3. Todo lo construido, en orden cronológico

### Ronda 1 — Arreglo de M1 + motor IA dual
- **M1 (bug):** el prompt de análisis ya pedía a la IA generar `RIESGOS`, `IMPACTOS` y `ESCENARIOS_QA` como secciones delimitadas, pero el HTML **nunca las renderizaba ni exportaba** — se descartaban. Se agregaron los bloques de UI (`rg-list`, `im-list`, `esc-list`) y se incluyeron en los exports a PDF y Word (que tampoco incluían nivel de riesgo/justificación antes).
- **Motor IA dual en `proxy.js`:**
  - `callGemini()` ya existía (spawn con `shell:true`, prompt por stdin).
  - Se portó `callClaude()` desde el proyecto Cinemark: invoca `claude --print --output-format stream-json --verbose --include-partial-messages --model <model> --append-system-prompt <...> --permission-mode bypassPermissions`, con parser de `stream-json` (`parseClaudeStreamJson`) que prioriza el evento `result` sobre `assistant` sobre `content_block_delta`.
  - `callAI(prompt, opts)` como dispatcher único: `opts.engine === 'claude' ? callClaude : callGemini`.
  - Selector de motor agregado al sidebar del frontend (`<select id="engine-select">`), con `onEngineChange()` que persiste en `localStorage['testialab_engine']`.

### Ronda 2 — Ajustes de UI (fondo blanco, logo, versión, leyenda)
- Cambio de tema oscuro completo a **fondo blanco** en el área principal, manteniendo el **sidebar y header de consola en navy oscuro** (identidad de marca TestiAlab).
- Todos los tintes `rgba(0,212,170,...)` (teal viejo) migrados a `rgba(0,163,136,...)` (teal recalibrado para contraste en blanco).
- Logo agrandado (176×74px → 200×76px, sidebar de 210px → 230px de ancho).
- Versión agregada: `QA Suite IA · v1.0.0`.
- Leyenda de derechos agregada al pie del sidebar: *"Software desarrollado por Equipo QA · TestiAlab · 2026 · Todos los derechos reservados"*.

### Ronda 3 — Ajustes de contraste (varias iteraciones)
- Texto de módulos bloqueados en el nav: opacidad multiplicada dejaba el texto casi invisible (`0.35 × 0.22 ≈ 7%` de opacidad real) — corregido a color directo `rgba(255,255,255,0.4)` sin multiplicador.
- Leyenda de derechos: de `8px`/`rgba(255,255,255,0.22)` a `10.5px`/`rgba(255,255,255,0.55)`.
- Selector de motor: de `9px` sin fondo/borde a `12px` blanco negrita con fondo/borde sutil (más visible que la leyenda, como se pidió explícitamente).
- **Bug de contraste real:** las `<option>` del `<select>` heredaban `color:#FFFFFF` del select cerrado, haciendo el texto invisible sobre el fondo blanco nativo del dropdown. Corregido con `#engine-select option{color:#0F1A26;background:#FFFFFF}`.
- Aviso agregado: *"Requisito: motor de IA disponible para analizar"* — inicialmente con ⚠ ámbar (se pidió como "alerta"), luego suavizado a texto gris neutro (se pidió que **no** pareciera alerta sino una precondición normal).

### Ronda 4 — Bug crítico de LibreOffice → reemplazo por `mammoth`
- **Bug original:** `docxToPdf()` llamaba `execFile('soffice', [...])` sin manejo de rutas alternativas — en la máquina real del usuario, **LibreOffice no estaba instalado**, tirando `ENOENT`.
- **Primer intento (parcial):** se agregó resolución en cascada de rutas típicas de Windows + variable de entorno `LIBREOFFICE_PATH`. Esto **se abandonó** en favor de una solución mejor:
- **Solución final:** se descubrió que `mammoth` (ya en `package.json`, sin usar) permite extraer texto **y las imágenes incrustadas** de un `.docx` **100% en JS, sin ningún binario externo**. Se implementó `extractDocx(docxPath)`:
  - Usa `mammoth.convertToHtml({path}, {convertImage: mammoth.images.imgElement(...)})`.
  - El callback de `convertImage` escribe cada imagen a un directorio temporal (`fs.mkdtempSync`) y las acumula en `imagePaths[]`.
  - El HTML resultante se convierte a texto plano con `htmlToPlainText()` (regex simple: cierra bloques con `\n`, quita tags, decodifica entidades básicas).
  - Se probó en vivo contra el DOCX real de Nalsani: **4,353 caracteres + 6 imágenes extraídas correctamente** (confirmado visualmente, coincide con las capturas del POS del PDF original).
- `.doc` legacy (binario, no ZIP) da un error claro pidiendo guardar como `.docx`, porque `mammoth` no lo soporta (a diferencia de LibreOffice que sí podía con ambos).
- Nuevo modo de análisis `docx-images`: `buildDocxAnalysisPrompt(text, imagePaths, engine)` — el texto va embebido directo en el prompt; las imágenes se referencian según el motor: `@ruta` para Gemini (sintaxis nativa), o instrucción + herramienta `Read` vía `--add-dir` para Claude (mismo patrón que Cinemark usaba en su M4 de evidencias).
- Se refactorizó el bloque de secciones de salida (`HISTORIA_DE_USUARIO`, `NIVEL_RIESGO_GLOBAL`, etc.) a una función compartida `outputSectionsBlock()`, reusada por `buildPrompt()` (texto puro), `buildVisionPrompt()` (PDF nativo) y `buildDocxAnalysisPrompt()` (DOCX extraído).
- **Bug de frontend encontrado en el camino:** `window._uploadedFile` **nunca se asignaba** en `handleFileUpload()` — solo se leía y se limpiaba. Esto significaba que subir cualquier archivo (PDF/DOCX/TXT) nunca llegaba realmente al análisis; siempre caía al textarea (vacío). Corregido agregando `window._uploadedFile = d;`.

### Ronda 5 — Bug de `spawn claude ENOENT` (Windows)
- **Causa 1:** `callClaude()` usaba `spawn('claude', args, {...})` **sin `shell:true`**, mientras que `callGemini()` sí lo tenía (con el comentario explícito de por qué: en Windows, `gemini`/`claude` son scripts `.cmd`, no ejecutables nativos, y Node solo los resuelve vía `shell:true`). Se agregó `shell:true` al spawn de Claude.
- **Causa 2 (persistió tras el fix anterior):** aun con `shell:true`, seguía dando `ENOENT` porque el usuario probaba `claude` en una terminal/app distinta ("Claude Code" app) a la que corría `node proxy.js` (PowerShell) — Node solo ve el `PATH` de su propia terminal.
- **Solución final:** se generalizó `callClaude()` a función `async` con resolución en cascada de binario (`candidateClaudeBins()`): (1) `CLAUDE_CLI_PATH` (variable de entorno opcional), (2) ruta típica de npm global en Windows (`%APPDATA%\npm\claude.cmd`), (3) `claude` a secas vía PATH. Si todos fallan, el mensaje de error guía al usuario a verificar con `claude --version` **en la misma terminal** donde corre el proxy.
- **Confirmado funcionando** por el usuario con capturas reales: análisis completo con Claude Code CLI sobre el DOCX de Nalsani, generando HU, 12 escenarios QA (incluyendo casos de borde como recepción parcial, control de acceso por rol, doble ejecución de batch), etc.

### Ronda 6 — "Conectado" no era honesto + polling innecesario
- El indicador "Conectado" del sidebar solo verificaba que el servidor Express respondiera (`GET /health`), **no** que el motor de IA elegido realmente pudiera ejecutarse.
- Se agregó `GET /api/engine-status?engine=gemini|claude` — corre `<binario> --version` de verdad del lado del servidor (con timeout corto, ~7-9s) y devuelve `{available, detail}`.
- `checkHealth()` en el frontend ahora hace dos pasos: (1) confirma que el proxy responde, (2) confirma que el motor elegido específicamente está disponible. Solo entonces muestra "Conectado" con el punto verde.
- Se re-verifica automáticamente al cambiar de motor (`onEngineChange()` llama `checkHealth()`).
- **Bug de polling encontrado:** había un `setInterval(checkHealth, 15000)` que corría **para siempre**, spawneando `claude --version` (o `gemini --version`) cada 15 segundos indefinidamente mientras la pestaña estuviera abierta. **Se removió el interval.** (Se aclaró al usuario: esto no consume tokens/sesión de uso real porque `--version` no toca la API ni el modelo — es solo metadata del CLI — pero sí era spawneo de procesos innecesario). Se agregó un botón manual (↻) junto al estado para re-verificar a demanda.

### Ronda 7 — Construcción de M2 (Impacto y Estimación)
- Se agregó estado global compartido `S = {riskLevel, huSummary, impactAreas[], cobertura, ambiente, notes, estHoursManual, cases[]}`.
- `parseImpactAreas(raw)` extrae las áreas desde la sección `IMPACTOS` del análisis de M1 (formato `AREA | Descripción`), poblando `S.impactAreas` con `{label, desc, checked:true}` por defecto.
- Al terminar un análisis en M1 (`renderAnalysis()`), se puebla `S` y se llama `unlockModule('m2')` — que le quita la clase `.locked` al botón del nav (antes **no existía ningún mecanismo** que desbloqueara nada; los botones M2-M5 estaban permanentemente bloqueados en el HTML sin `id` ni `onclick`).
- Se agregaron `id` y `onclick="tryNav('mX',this)"` a los 4 botones del nav (M2-M5). `tryNav()` es una función defensiva (el CSS `pointer-events:none` ya bloquea el click mientras esté `.locked`, pero se agregó igual por si se invoca programáticamente).
- **M2 construido con contenido real** (reemplazando el placeholder "En construcción"):
  - Checklist de áreas de impacto (checkbox por área, toggle vía `toggleM2Area(i, checked)`).
  - Selectores de **cobertura** (Feature/Regresión/UAT/Smoke/Hotfix) y **ambiente** (Laboratorio/Beta/Producción).
  - Textarea de notas/criterios de salida.
  - **Estimación de esfuerzo QA**, modelo genérico (NO viene de la IA — a diferencia de Cinemark, el prompt actual de TestIALab no pide un bloque de esfuerzo estructurado JSON):
    ```js
    const QA_EST = {
      RISK_BASE_HOURS: {ALTO:6, MEDIO:3, BAJO:1.5},
      HOURS_PER_AREA: 1.25,
      COB_FACTOR: {feature:1.0, regresion:1.5, uat:1.3, smoke:0.4, hotfix:0.6},
      AMB_FACTOR: {laboratorio:1.0, beta:1.1, produccion:1.3},
    };
    ```
    Horas = `(base_por_riesgo + areas_validadas × 1.25) × factor_cobertura × factor_ambiente`, editable manualmente por el QA. Se afinará automáticamente cuando M3 exista y haya casos reales para contar (mismo patrón que Cinemark).
  - Botón "Continuar a Casos de Prueba" (ahora con confirmación, ver Ronda 8).

### Ronda 8 — Patrón "botón avanzar con confirmación" (estilo Cinemark) + remoción de textarea manual
- Se agregó una caja "¿Todo revisado?" al final del resultado de M1 con `confirm()` antes de navegar a M2 (`confirmContinueToM2()`), replicando el patrón exacto de Cinemark (`confirmContinueToImpact()`).
- `continueToM3()` en M2 también ahora pide confirmación antes de desbloquear M3.
- **Se eliminó la sección "O pega el texto directamente"** completa (divider + textarea `#req-text`) — decisión del usuario: "nadie va a pegar el texto directamente". Los botones Analizar/Limpiar se movieron directo bajo la tarjeta de subida de documento. Se limpiaron todas las referencias a `#req-text` en `analyzeReq()`, `removeFile()`, `clearAll()`. CSS muerto (`.divider`, `.req-box`, etc.) removido; `.req-footer` se conservó (reutilizado para los botones).

### Ronda 9 — Fix de proporción consola/histórico + remoción de polling (repetido, confirmado)
- **Consola de ejecución vs. Histórico de HU no compartían proporción:** la consola tenía altura fija `180px` (`flex-shrink:0`), el histórico se llevaba todo el resto (`flex:1`). Se cambió la consola también a `flex:1` con `min-height:0` en ambos contenedores y sus listas internas (fix clásico de flexbox para que el scroll interno funcione en vez de desbordarse).
- Confirmado que el `setInterval(checkHealth, 15000)` де la Ronda 6 en efecto se había eliminado correctamente.

### Ronda 10 — Batería de bugs reportados por el usuario en vivo (con capturas reales)
Todos corregidos en una sola pasada:

1. **Nombre del documento truncado** — `.fp-name` tenía `white-space:nowrap` + `text-overflow:ellipsis`. Cambiado a `white-space:normal` con wrap, la tarjeta crece verticalmente si el nombre es largo.
2. **"Gemini leyendo el documento..." hardcodeado** en `proxy.js` — el arreglo `stages` de `/api/analyze` tenía el string fijo sin importar qué motor estuviera corriendo (confirmado con captura real: decía "Gemini" mientras corría Claude). Corregido a `engineLabel+' leyendo el documento...'` (variable que ya existía en esa función).
3. **M2 renombrado** de "Riesgos"/"Riesgos e Impactos" a **"Impacto"**/"Impacto y Estimación" — el usuario notó correctamente que llamarlo "Riesgos" era confuso, porque M1 **ya** analiza y muestra los riesgos; M2 solo los **valida**, no los re-analiza. Cambiado en: botón del nav, `page-tag`, `<h1>`, texto del diálogo de confirmación (`confirmContinueToM2()`), y el mapa de títulos del topbar en `showModule()`.
4. **Bug crítico de navegación:** `.m1-layout` (contenedor de M1) **nunca tenía la clase `.module`**, así que `showModule()` (que solo manipula `.module` para mostrar/ocultar) **nunca lo ocultaba** al navegar a otros módulos. El usuario veía M1 superpuesto/visible detrás de M2 aunque el breadcrumb ya dijera "M2 - Riesgos" — confirmado con captura real. Se reescribió `showModule()` para manejar `#m1` explícitamente vía `style.display` ('grid'/'none'), separado del mecanismo de clases que usan M2-M5 (para no romper su layout de grid de dos columnas).
5. **Estado del botón "Analizar" inconsistente** — reportado con captura real: tras completar un análisis con Claude, el botón volvía a decir "Analizar con Gemini" y quedaba habilitado para volver a hacer clic sobre el mismo archivo ya analizado. El usuario pidió específicamente:
   - El botón debe quedar **deshabilitado** tras un análisis exitoso, hasta que se use "Limpiar" (o se quite/reemplace el archivo).
   - El botón debe **conservar el motor realmente usado**, cambiando solo si el QA cambia el selector explícitamente — nunca debe resetearse solo.

   Implementado:
   - `analyzeBtnLabel()` — helper centralizado que siempre lee `_engine` real.
   - `lockUI()` / `unlockUI()` / **`markAnalyzed()`** (nueva): tras éxito se llama `markAnalyzed()` (deshabilita el botón con "✓ Documento analizado", pero libera la tarjeta de upload para poder usar Limpiar/X). Tras error se llama `unlockUI()` (reactiva todo, para reintentar).
   - `onEngineChange()` y `checkHealth()` ahora solo tocan el texto del botón `if (!btn.disabled)` — nunca lo pisan mid-análisis ni después de completado.
   - `removeFile()`, `clearAll()`, y `handleFileUpload()` (al subir un archivo nuevo, incluso reemplazando uno ya analizado) ahora llaman `unlockUI()` para reactivar el botón correctamente.

---

## 4. Estado actual exacto (dónde quedamos)

### Confirmado funcionando por el usuario (con capturas reales)
- ✅ Análisis completo de M1 con **Gemini CLI** y con **Claude Code CLI**, ambos sobre el DOCX real de Nalsani (con extracción de texto + 6 imágenes vía `mammoth`).
- ✅ Selector de motor funcional, indicador "Conectado" honesto.
- ✅ M2 (Impacto y Estimación) construido y navegable.

### Pendiente de confirmación del usuario (última ronda de fixes, aún no probada)
El usuario dijo *"voy a probar estos fixes y te confirmo. No codees nada. Solo espera."* — quedamos ahí. Los 5 fixes de la Ronda 10 (arriba) **no han sido confirmados como funcionando** todavía. Es el primer punto a verificar al retomar.

### NO construido todavía (según el plan acordado en §2)
- **M3 — Casos de prueba**: siguiente módulo a construir. Debe generar casos de prueba con IA y exportarlos a un Excel simplificado (solo columnas de `TestCases`, sin fórmulas ni las demás hojas de la plantilla real).
- **M4 — Ejecución** (con evidencia visual, patrón crítico/variable de Cinemark).
- **M5 — Bugs**.
- **M6 — ROI** (benchmark propio de TestIALab, no el de Cinemark).
- **M7a — Plan de Pruebas** (Word, estructura del ejemplo Totto).
- **M7b — Informe de Avance** (dashboard diario, estructura del "Testing progress report").
- **M7c — Certificación QA** (Word, estructura del ejemplo Nalsani/Totto, con prosa generada por IA).
- **Persistencia real** (IndexedDB) — se acordó "historial único global" pero **no se ha implementado todavía**; el historial de HU en el sidebar (`_history`, `renderHistory()`) hoy vive solo en memoria de la sesión del navegador, se pierde al recargar.

### Decisiones técnicas aún abiertas (no resueltas, habrá que decidir cuando se llegue ahí)
- Integración futura con Azure DevOps o Jira — cuál, y cuándo — no decidido.
- Si se migra de "Excel simplificado" a algo más robusto (fórmulas, hojas completas) o directamente a Azure/Jira Xray — pendiente de decisión de negocio del cliente (TestIALab), no técnica.

---

## 5. Archivos y cómo correr el proyecto

### Ubicación de archivos (en esta sesión de trabajo)
```
/home/claude/testialab-qa-suite/
├── qa-suite.html      (1,350 líneas — frontend completo)
├── proxy.js           (710 líneas — backend Express)
├── package.json       (dependencias: cors, express, mammoth, multer, pdf-parse)
├── package-lock.json
└── node_modules/       (mammoth instalado y probado en esta sesión)
```

En la máquina real del usuario (Windows), la ruta de trabajo vista en capturas es:
```
C:\Esteban\Proyecto IA QA Liz
```

### Cómo correr
```bash
npm install
node proxy.js
```
Levanta todo en **`http://localhost:3001`** — el mismo puerto sirve tanto el HTML (`GET /`) como el API (antes NO existía esta ruta de servido estático; se agregó explícitamente para no depender de abrir el archivo como `file://`).

### Variables de entorno opcionales
- `LIBREOFFICE_PATH` — **ya no se usa** (se abandonó el enfoque de LibreOffice en favor de `mammoth`). Puede quedar como referencia histórica pero no tiene efecto en el código actual.
- `CLAUDE_CLI_PATH` — ruta explícita al ejecutable de Claude Code CLI, si `claude` no se resuelve solo vía PATH en la terminal donde corre el proxy (ej: `set CLAUDE_CLI_PATH=C:\ruta\a\claude.cmd` en Windows antes de `node proxy.js`).

### Endpoints del backend (`proxy.js`)
| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/` | Sirve `qa-suite.html` |
| GET | `/health` | Confirma que el proxy (Express) está arriba — NO confirma que el motor IA funcione |
| GET | `/api/engine-status?engine=gemini\|claude` | Corre `<binario> --version` de verdad, confirma disponibilidad real del motor |
| GET | `/api/analyze-progress` | SSE de progreso en vivo durante el análisis |
| POST | `/api/upload` | Sube PDF (visión nativa) / DOCX (extracción con `mammoth`) / TXT (texto plano) |
| POST | `/api/analyze` | Dispara el análisis con el motor elegido (`body.engine`) |

### Funciones clave del backend a conocer
- `callAI(prompt, opts)` — dispatcher único, punto de entrada para cualquier módulo futuro que necesite IA (M3 en adelante debe usar esto, no reinventar).
- `callGemini(prompt, timeoutMs)` / `callClaude(prompt, opts)` — implementaciones por motor.
- `candidateClaudeBins()` — resolución en cascada del binario de Claude (útil como referencia si M3+ necesita spawnear más procesos).
- `extractDocx(docxPath)` — extracción de texto + imágenes de un `.docx`, reusar tal cual para cualquier futuro módulo que necesite leer documentos Word (ej: M7a/M7c si toman un documento base).
- `outputSectionsBlock()`, `buildPrompt()`, `buildVisionPrompt()`, `buildDocxAnalysisPrompt()` — patrón de construcción de prompts a seguir para M3+ (secciones delimitadas `---NOMBRE_SECCION---`, parseadas en frontend con `parseSection()`).

### Funciones/patrones clave del frontend a conocer
- Estado global `S` (objeto en el `<script>`) — M3 en adelante debe seguir poblando/leyendo de acá, no crear estados paralelos.
- `unlockModule(id)` / `tryNav(id, btn)` / `showModule(id, btn)` — mecanismo de navegación y desbloqueo secuencial. **Importante:** `showModule()` tiene un caso especial hardcodeado para `id==='m1'` (por el bug de la Ronda 10 §4) — cualquier módulo nuevo que se agregue debe usar el mecanismo estándar de `.module`/`.active`, no necesita ese caso especial.
- `renderM2()` — patrón de referencia para cómo construir la UI dinámica de M3 (genera HTML vía template strings, re-renderiza completo en cada cambio de estado).
- `confirmContinueToM2()` / `continueToM3()` — patrón de "avanzar con confirmación" a replicar para M3→M4, M4→M5, etc.
- `lockUI()` / `unlockUI()` / `markAnalyzed()` / `analyzeBtnLabel()` — patrón de estado de botones a replicar si M3+ tiene botones de acción similares (ej: "Generar casos").

---

## 6. Próximo paso inmediato al retomar

1. **Confirmar con el usuario** que los 5 fixes de la Ronda 10 (§3) funcionan como se espera en su máquina real — especialmente el fix crítico de `showModule()` (M1 ya no debe quedar visible detrás de otros módulos) y el estado del botón "Analizar".
2. Si todo está confirmado, **construir M3 (Casos de prueba)**:
   - Prompt de generación de casos (usar `outputSectionsBlock()`-style, sección delimitada nueva, ej. `---CASOS_DE_PRUEBA---`).
   - Render de tabla de casos en pantalla (reusar patrón visual de `renderM2()`).
   - Export a Excel simplificado — **acá hace falta agregar una librería de generación de xlsx en el backend** (ej. `exceljs` o `xlsx`/`sheetjs`), que **todavía no está en `package.json`** — hay que instalarla y agregar un endpoint nuevo (ej. `POST /api/export-xlsx`) o generarlo client-side con SheetJS.
   - Columnas exactas a respetar (de la plantilla real de TestIALab, ver §1 documento 3): `ID | Requisito Funcional | Tipo | Escenario | Caso | Objetivo | Paso a Paso | Resultado Esperado` (+ resto de columnas en blanco para que calcen al pegar en la plantilla maestra).
   - Botón "Continuar a Evidencias →" con confirmación (mismo patrón que M1→M2, M2→M3).

---

*Fin del handoff. Este documento refleja el estado completo de la conversación al momento de generarlo — no se omitió ningún bug, decisión o pieza de contexto discutida.*
