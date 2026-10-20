@echo off
chcp 65001 >nul
title FaceID Seguro
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERRO] Node.js nao encontrado.
  echo Instale a versao LTS em https://nodejs.org/ ou rode: winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)
node server.js --open
pause
