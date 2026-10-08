---
name: project-git-identity
description: "QA-Suite repo git identity rule -- todo commit/push/PR solo con un correo de dominio @testialab.com (erodriguez@testialab.com, cuenta GitHub erodrigueztestialab); nunca un correo de otro dominio ni otra cuenta."
metadata:
  node_type: memory
  type: project
  originSessionId: a542f78b-8a08-473d-a212-b135817135a2
  modified: 2026-10-08T21:49:21.793Z
---

**Regla:** todo commit, push, pull request y merge en el repo `erodrigueztestialab/qa-suite` (remoto `https://github.com/erodrigueztestialab/qa-suite.git`) debe quedar identificado con un correo del dominio **`@testialab.com`**: hoy **`Esteban Rodriguez <erodriguez@testialab.com>`**, cuenta de GitHub **`erodrigueztestialab`**. **Nunca** un correo de otro dominio (personal, de otra empresa o de otro cliente) ni otra cuenta de GitHub, aunque sea la que tenga activa la maquina o la que el usuario usa para hablar con Claude Code.

**Why:** la configuracion global de git de una maquina puede traer un correo de otro dominio (ya paso: los primeros commits salieron con uno), y el credential manager / `gh` pueden reusar la sesion de otra cuenta en `github.com`. El repo es de TestIALab y la autoria debe ser siempre de TestIALab.

**How to apply:** antes de cualquier operacion git en este repo, verificar:
- `git config user.email` termina en `@testialab.com`. Si no, `git config --local user.name "Esteban Rodriguez"` y `git config --local user.email erodriguez@testialab.com` (siempre `--local`, para no afectar otros proyectos de la maquina).
- `gh auth status` muestra activa la cuenta `erodrigueztestialab` (`gh auth switch -u erodrigueztestialab` si no).
- `git config --local credential.useHttpPath true` en el repo, para que Windows no reuse el token de otra cuenta en `github.com`.

**Historia (resuelto):**
- 2026-09-17: los 2 primeros commits salieron con un correo de otro dominio (default global de git de la maquina); se corrigio con `git config --local` + reescritura de autoria (`commit --amend --author` + rebase normal) ANTES de pushear nada. `git filter-branch` lo bloquea el clasificador de auto-mode.
- 2026-09-22: `gh auth login --web` con `erodrigueztestialab` sin quitar la otra cuenta; conviven ambas y `erodrigueztestialab` quedo activa.
- 2026-09-23: el repo vive en mas de una maquina (`C:\TestiAlab\QA-Suite` y `C:\Repos\qa-suite`); la regla aplica al repo por su remoto, no a la ruta. En una maquina nueva puede no haber ningun `git config` ni `gh`: setear `--local` igual y, si `gh` no esta (`gh --version`), abrir los PRs en el navegador con `https://github.com/erodrigueztestialab/qa-suite/compare/develop...feature/<rama>?expand=1`.

Ver [[project-git-workflow]] para el esquema de ramas.
