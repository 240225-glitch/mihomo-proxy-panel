@echo off
chcp 65001 >nul
cd /d "%~dp0mihomo"

tasklist /FI "IMAGENAME eq mihomo-windows-amd64.exe" | find /I "mihomo" >nul
if errorlevel 1 (
    start "" /min mihomo-windows-amd64.exe -d .
    echo 正在启动节点并测速，约 30 秒...
    timeout /t 30 >nul
)

reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:7890" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyOverride /t REG_SZ /d "<local>;127.*;localhost;10.*;192.168.*" /f >nul
netsh winhttp set proxy 127.0.0.1:7890 >nul 2>&1

echo.
echo ============================================
echo   代理已开启   127.0.0.1:7890
echo   出口检测：
curl -s -m 20 -x http://127.0.0.1:7890 https://api.country.is/
echo.
echo ============================================
echo   关闭代理请双击 stop.bat
pause
