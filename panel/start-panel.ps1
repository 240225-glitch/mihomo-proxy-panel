# 启动控制台：确保内核在跑 -> 起 Node 服务 -> 打开浏览器

$root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$proxyRoot = Split-Path -Parent $root
$mihomoDir = Join-Path $proxyRoot 'mihomo'
$exe       = Join-Path $mihomoDir 'mihomo-windows-amd64.exe'
$ErrorActionPreference = 'SilentlyContinue'

if (-not (Get-Process mihomo-windows-amd64)) {
    if (Test-Path $exe) {
        Start-Process -FilePath $exe -ArgumentList '-d', "`"$mihomoDir`"" -WorkingDirectory $mihomoDir -WindowStyle Hidden
        Write-Host '正在启动内核...'
        for ($i = 0; $i -lt 30; $i++) {
            $tc = New-Object Net.Sockets.TcpClient
            try { $tc.Connect('127.0.0.1', 9090); $tc.Close(); break } catch { Start-Sleep -Milliseconds 500 } finally { $tc.Dispose() }
        }
    } else {
        Write-Host "找不到内核：$exe"
    }
}

# 等服务起来再开浏览器
Start-Process powershell -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command',"Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8080'" -WindowStyle Hidden

Set-Location $root
node server.js
