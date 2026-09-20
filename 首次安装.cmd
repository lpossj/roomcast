@echo off
chcp 65001 >nul
cd /d "%~dp0"
call npm.cmd ci
if errorlevel 1 goto fail
call npm.cmd run setup
if errorlevel 1 goto fail
call npm.cmd run build
if errorlevel 1 goto fail
echo 安装完成。请双击“启动同屏.cmd”。
pause
exit /b 0
:fail
echo 安装失败，请查看上方错误信息。
pause
exit /b 1
