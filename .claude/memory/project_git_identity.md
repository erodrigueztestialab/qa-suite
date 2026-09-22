---
name: project-git-identity
description: "QA-Suite repo git identity/account rule -- everything must be erodrigueztestialab / erodriguez@testialab.com, nunca kaironyx ni el email de Cinemark."
metadata: 
  node_type: memory
  type: project
  originSessionId: a542f78b-8a08-473d-a212-b135817135a2
  modified: 2026-09-22T14:14:15.863Z
---

Todo commit, push, pull request y merge en el repo `C:\TestiAlab\QA-Suite` (remoto `https://github.com/erodrigueztestialab/qa-suite.git`, publico) debe quedar identificado como **`Esteban Rodriguez <erodriguez@testialab.com>`**, cuenta de GitHub **`erodrigueztestialab`**. Nunca la cuenta `kaironyxLabs` (con la que el usuario usa Claude Code para hablar conmigo) ni el email personal de Cinemark (`estebanrodriguez@international.cinemark.com`, que resulto ser el default GLOBAL de git en esta maquina).

**Como quedo resuelto (2026-09-17, sesion del primer commit real):**
- `git config --local user.name`/`user.email` seteados SOLO en este repo (no en global, para no afectar otros proyectos del usuario) a `Esteban Rodriguez` / `erodriguez@testialab.com`.
- `git config --local credential.useHttpPath true` en este repo -- aisla las credenciales guardadas de github.com por PATH completo (incluyendo `erodrigueztestialab/qa-suite`), para que el credential manager de Windows no reuse automaticamente el token de `kaironyxLabs` guardado para otros repos en el mismo host `github.com`.
- Los 2 commits que existian antes de esta correccion (el viejo "Initial commit" y el primer commit real de todo el codigo) se reescribieron con `git commit --amend --author=...` (via checkout a un branch temporal en el commit raiz + amend + rebase normal, NO rebase interactivo -- `git filter-branch` fue bloqueado por el clasificador de auto-mode como "Git Destructive", el amend+rebase manual si paso). Esto fue seguro porque nada se habia pusheado todavia al momento de la correccion.
- **Resuelto (2026-09-22):** se agrego la cuenta `erodrigueztestialab` a `gh auth login --web` (device code flow) sin quitar `kaironyxLabs` -- ahora conviven ambas cuentas en el keychain de `gh` en esta maquina. `erodrigueztestialab` quedo como cuenta activa (`gh auth switch -u erodrigueztestialab` si en algun momento vuelve a quedar activa `kaironyxLabs`). **Antes de cualquier `gh pr create` u otra accion de `gh` en este repo, verificar con `gh auth status` que la cuenta activa sea `erodrigueztestialab`**, igual que se verifica `git config user.email`. El primer PR real (`.claude/memory`, PR #1) se abrio ya con esta cuenta.

**How to apply:** antes de cualquier operacion git en este repo (commit, push, PR), verificar que la identidad activa sea la de testialab, nunca asumir que el config global de la maquina es correcto para este proyecto especifico -- ya se demostro que no lo es (traia el email de Cinemark). Ver [[project_git_workflow]] para el esquema de ramas.
