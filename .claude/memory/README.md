# Memoria de Claude para este proyecto

Esta carpeta es una copia versionada de la memoria persistente que Claude Code
mantiene sobre el proyecto QA-Suite (normalmente vive solo en el perfil local
del usuario, fuera del repo). Se sube al repo para que **cualquier clon de
este proyecto en otra máquina tenga el mismo contexto histórico** (identidad
git, flujo de ramas, decisiones de modelo/motor, preferencias de trabajo),
en vez de arrancar desde cero.

## Cómo usarla

- Si estás retomando este proyecto en una máquina nueva: lee `MEMORY.md`
  primero (es el índice) y después los archivos individuales que aplique
  según la tarea.
- Cada archivo tiene el mismo formato que usa el sistema de memoria de
  Claude Code: frontmatter (`name`, `description`, `metadata.type`) y cuerpo
  con la regla/hecho, `**Why:**` y `**How to apply:**` cuando corresponde.
- Los enlaces `[[nombre]]` referencian el `name:` de otro archivo de esta
  misma carpeta.

## Mantenimiento

Esta copia se actualiza manualmente cada vez que se guarda o modifica una
memoria relevante para este proyecto en el sistema de memoria local de
Claude Code. Si encuentras una memoria desactualizada acá, avísale a Claude
para que la corrija en ambos lados (local y este repo).
