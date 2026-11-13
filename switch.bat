@echo off
chcp 65001 >nul
setlocal
set GROUP=MAIN
set TARGET=%~1
if "%TARGET%"=="" set TARGET=AUTO

curl -s -X PUT "http://127.0.0.1:9090/proxies/%GROUP%" -H "Content-Type: application/json" -d "{\"name\":\"%TARGET%\"}" >nul
if errorlevel 1 (
    echo 切换失败：代理没在运行？先双击 start.bat
) else (
    echo 已切换到 %TARGET%
    curl -s -m 15 -x http://127.0.0.1:7890 https://api.country.is/
    echo.
)
timeout /t 3 >nul
