@echo off
REM GE Actividades — start script (Windows)
cd /d "%~dp0"
set PORT=8080
echo Starting GE Actividades on port %PORT%...
node ge-server.js
