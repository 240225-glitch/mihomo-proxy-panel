@echo off
chcp 65001 >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f >nul
netsh winhttp reset proxy >nul 2>&1
taskkill /IM mihomo-windows-amd64.exe /F >nul 2>&1
echo 代理已关闭，网络恢复直连。
pause
