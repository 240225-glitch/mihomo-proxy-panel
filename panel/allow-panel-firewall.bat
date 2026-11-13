@echo off
chcp 65001 >nul
title 放行控制台与局域网代理端口

net session >nul 2>&1
if errorlevel 1 (
    echo 需要管理员权限。
    echo 请右键这个文件 -^> "以管理员身份运行"
    pause
    exit /b 1
)

netsh advfirewall firewall delete rule name="proxy-panel-8080" >nul 2>&1
netsh advfirewall firewall add rule name="proxy-panel-8080" dir=in action=allow protocol=TCP localport=8080 profile=any >nul
if errorlevel 1 (echo [失败] 8080) else (echo [完成] 已放行 TCP 8080 - 控制台)

netsh advfirewall firewall delete rule name="mihomo-lan-7891" >nul 2>&1
netsh advfirewall firewall add rule name="mihomo-lan-7891" dir=in action=allow protocol=TCP localport=7891 profile=any >nul
if errorlevel 1 (echo [失败] 7891) else (echo [完成] 已放行 TCP 7891 - 局域网代理)

netsh advfirewall firewall delete rule name="mihomo-lan-7891-udp" >nul 2>&1
netsh advfirewall firewall add rule name="mihomo-lan-7891-udp" dir=in action=allow protocol=UDP localport=7891 profile=any >nul

echo ok> "%~dp0.lan-ok"

echo.
echo 局域网内其他设备现在可以访问：
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    for /f "tokens=* delims= " %%b in ("%%a") do (
        echo   控制台  http://%%b:8080
        echo   代理    %%b:7891
    )
)
echo.
pause
