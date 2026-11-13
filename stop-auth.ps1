Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = 'SilentlyContinue'

$inet = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty $inet -Name ProxyEnable -Value 0
netsh winhttp reset proxy | Out-Null
Get-Process mihomo-windows-amd64 | Stop-Process -Force

[System.Windows.Forms.MessageBox]::Show(
    "代理已关闭，网络恢复直连。",
    '停止代理', 'OK', 'Information') | Out-Null
