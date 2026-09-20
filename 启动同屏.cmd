@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules\electron\dist\electron.exe" (
    echo Electron not found. Please run npm install first.
    pause
    exit /b 1
)

echo Building Roomcast...
call npm.cmd run build

if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
)

echo Starting Roomcast...
start "" "node_modules\electron\dist\electron.exe" .

endlocal