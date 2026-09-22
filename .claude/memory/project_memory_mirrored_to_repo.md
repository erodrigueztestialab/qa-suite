---
name: project-memory-mirrored-to-repo
description: La memoria de este proyecto se espeja en el repo (.claude/memory/) para que este disponible al clonar en otra maquina.
metadata: 
  node_type: memory
  type: project
  originSessionId: 1ef4b47e-99ab-4207-814e-0d09291b4648
  modified: 2026-09-22T14:02:53.540Z
---

Desde 2026-09-22, todos los archivos de memoria de QA-Suite (`MEMORY.md` +
archivos individuales) tienen una copia versionada en el repo, en
`.claude/memory/` (rama `feature/claude-memory` -> PR a `develop`). Esto lo
pidio el usuario porque clono el repo en otra maquina y no tenia ningun
contexto previo del proyecto -- la memoria local de Claude Code no viaja
con el repo por defecto.

**Why:** el usuario trabaja este proyecto desde mas de una maquina y quiere
que el historial de decisiones (identidad git, flujo de ramas, politica de
modelos, preferencias de trabajo) este disponible sin depender del perfil
local de Claude Code en la maquina donde se abrio la sesion originalmente.

**How to apply:** de aca en adelante, cada vez que se guarde o edite una
memoria de tipo `project` o `feedback` relevante para QA-Suite en el sistema
de memoria local, replicar el mismo archivo (contenido y nombre) en
`C:\TestiAlab\QA-Suite\.claude\memory\` y commitear el cambio (via
feature branch + PR segun [[project_git_workflow]]). Si se olvida sincronizar
en algun momento, el usuario puede pedir "sincroniza la memoria" y hay que
diffear ambas carpetas y subir lo que falte.
