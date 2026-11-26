@echo off
title Preguntas en vivo - deja esta ventana abierta durante la clase
cd /d "%~dp0"
rem La carpeta portatil trae node y cloudflared en bin.
set "PATH=%~dp0bin;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Falta instalar Node.js desde https://nodejs.org
  pause
  exit /b 1
)
set ABRIR_PANEL=1
node --env-file-if-exists=.env server.js
if errorlevel 1 pause
