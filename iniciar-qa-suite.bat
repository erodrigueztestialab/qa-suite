@echo off
REM Arranque con doble clic de la QA Suite (backend en http://localhost:3001).
REM La primera vez instala las dependencias (npm install) automaticamente.
cd /d "%~dp0"
title TestIALab QA Suite IA

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js no esta instalado o no esta en el PATH.
  echo  Descargalo de https://nodejs.org ^(version LTS^), instalalo y vuelve a abrir este archivo.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo  Instalando dependencias por primera vez ^(puede tardar unos minutos^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo  No se pudieron instalar las dependencias. Revisa el mensaje de arriba.
    pause
    exit /b 1
  )
)

REM Abre el navegador unos segundos despues, cuando el backend ya esta escuchando.
start "" cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:3001"

echo  QA Suite corriendo en http://localhost:3001  ^(cierra esta ventana para detenerla^)
node proxy.js
pause
