@echo off
chcp 65001 >nul
title 代理控制台
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-panel.ps1"
echo.
echo 控制台已停止。
pause
