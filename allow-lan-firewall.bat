@echo off
chcp 65001 >nul
title 放行局域网代理端口 7891

net session >nul 2>&1
if errorlevel 1 (
    echo 需要管理员权限。
    echo 请右键这个文件 -^> "以管理员身份运行"
    pause
    exit /b 1
)

netsh advfirewall firewall delete rule name="mihomo-lan-7891" >nul 2>&1
netsh advfirewall firewall add rule name="mihomo-lan-7891" dir=in action=allow protocol=TCP localport=7891 profile=any
if errorlevel 1 (
    echo 添加失败。
) else (
    echo.
    echo 已放行 TCP 7891，局域网内其他设备现在可以连接：
    ipconfig | findstr /i "IPv4"
    echo.
    echo 代理地址: 上面对应的 IPv4 地址 + :7891
)
pause
