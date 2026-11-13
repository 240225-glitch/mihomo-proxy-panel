$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$ps      = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$ws      = New-Object -ComObject WScript.Shell

function New-Lnk($tmpName, $finalName, $script, $icon, $desc, $showWindow = $false) {
    $tmp   = Join-Path $desktop $tmpName
    $final = Join-Path $desktop $finalName
    Remove-Item $tmp, $final -Force -ErrorAction SilentlyContinue

    $s = $ws.CreateShortcut($tmp)
    $s.TargetPath       = $ps
    $args               = "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
    if (-not $showWindow) { $args = '-WindowStyle Hidden ' + $args }
    $s.Arguments        = $args
    $s.WorkingDirectory = $root
    $s.IconLocation     = "$env:WINDIR\System32\shell32.dll,$icon"
    $s.Description      = $desc
    $s.Save()

    [IO.File]::Move($tmp, $final)
}

New-Lnk '_t1.lnk' '启动代理.lnk'   (Join-Path $root 'start-auth.ps1') 44  '启动代理（需账号密码）'
New-Lnk '_t2.lnk' '停止代理.lnk'   (Join-Path $root 'stop-auth.ps1')  131 '关闭代理，恢复直连'
New-Lnk '_t3.lnk' '代理控制台.lnk' (Join-Path $root 'panel\start-panel.ps1') 13 '打开代理控制台' $true

Get-ChildItem $desktop -Filter '*.lnk' | Where-Object { $_.Length -lt 3000 } |
    Select-Object Name, Length | Format-Table -AutoSize
