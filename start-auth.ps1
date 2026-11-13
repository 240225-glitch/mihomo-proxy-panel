param([switch]$SkipLogin)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'SilentlyContinue'

$root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$mihomoDir = Join-Path $root 'mihomo'
$exe       = Join-Path $mihomoDir 'mihomo-windows-amd64.exe'

# 管理员账号从控制台的 users.json 读取，不把密码写死在脚本里
$USER      = ''
$PASS      = ''
$usersFile = Join-Path $root 'panel\users.json'
if (Test-Path $usersFile) {
    $admin = (Get-Content $usersFile -Raw -Encoding UTF8 | ConvertFrom-Json).users |
             Where-Object { $_.role -eq 'admin' } | Select-Object -First 1
    if ($admin) { $USER = $admin.username; $PASS = $admin.pass }
}
# 没有 users.json 时不弹登录框，直接启动（账号由控制台管理）
if (-not $PASS) { $SkipLogin = $true }

function Show-Box($text, $title, $icon) {
    if ($SkipLogin) { Write-Host "[$title] $text"; return }
    [System.Windows.Forms.MessageBox]::Show($text, $title, 'OK', $icon) | Out-Null
}

function Ask-Login {
    $form            = New-Object System.Windows.Forms.Form
    $form.Text       = '启动代理'
    $form.Size       = New-Object System.Drawing.Size(340, 200)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.TopMost    = $true

    $lbUser          = New-Object System.Windows.Forms.Label
    $lbUser.Text     = '账号'
    $lbUser.Location = New-Object System.Drawing.Point(25, 25)
    $lbUser.Size     = New-Object System.Drawing.Size(60, 22)
    $form.Controls.Add($lbUser)

    $tbUser          = New-Object System.Windows.Forms.TextBox
    $tbUser.Text     = $USER
    $tbUser.Location = New-Object System.Drawing.Point(90, 22)
    $tbUser.Size     = New-Object System.Drawing.Size(210, 24)
    $form.Controls.Add($tbUser)

    $lbPass          = New-Object System.Windows.Forms.Label
    $lbPass.Text     = '密码'
    $lbPass.Location = New-Object System.Drawing.Point(25, 63)
    $lbPass.Size     = New-Object System.Drawing.Size(60, 22)
    $form.Controls.Add($lbPass)

    $tbPass                  = New-Object System.Windows.Forms.TextBox
    $tbPass.UseSystemPasswordChar = $true
    $tbPass.Location         = New-Object System.Drawing.Point(90, 60)
    $tbPass.Size             = New-Object System.Drawing.Size(210, 24)
    $form.Controls.Add($tbPass)

    $btnOk          = New-Object System.Windows.Forms.Button
    $btnOk.Text     = '启动'
    $btnOk.Location = New-Object System.Drawing.Point(130, 105)
    $btnOk.Size     = New-Object System.Drawing.Size(80, 30)
    $btnOk.DialogResult = 'OK'
    $form.AcceptButton = $btnOk
    $form.Controls.Add($btnOk)

    $btnCancel          = New-Object System.Windows.Forms.Button
    $btnCancel.Text     = '取消'
    $btnCancel.Location = New-Object System.Drawing.Point(220, 105)
    $btnCancel.Size     = New-Object System.Drawing.Size(80, 30)
    $btnCancel.DialogResult = 'Cancel'
    $form.CancelButton = $btnCancel
    $form.Controls.Add($btnCancel)

    $form.Add_Shown({ $tbPass.Focus() })
    $result = $form.ShowDialog()

    if ($result -ne 'OK') { return $null }
    return @{ User = $tbUser.Text.Trim(); Pass = $tbPass.Text }
}

# ---------- 1. 登录 ----------
if (-not $SkipLogin) {
    $c = Ask-Login
    if ($null -eq $c) { exit }
    if ($c.User -ne $USER -or $c.Pass -ne $PASS) {
        Show-Box '账号或密码错误，代理未启动。' '启动代理' 'Error'
        exit
    }
}

# ---------- 2. 启动内核 ----------
if (-not (Get-Process mihomo-windows-amd64 -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $exe -ArgumentList '-d', "`"$mihomoDir`"" -WorkingDirectory $mihomoDir -WindowStyle Hidden
}

for ($i = 0; $i -lt 45; $i++) {
    $tc = New-Object Net.Sockets.TcpClient
    try { $tc.Connect('127.0.0.1', 7890); $ok = $true } catch { Start-Sleep -Seconds 1 } finally { $tc.Close() }
    if ($ok) { break }
}

# ---------- 3. 系统代理 ----------
$inet = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Set-ItemProperty $inet -Name ProxyEnable -Value 1
Set-ItemProperty $inet -Name ProxyServer -Value '127.0.0.1:7890'
Set-ItemProperty $inet -Name ProxyOverride -Value '<local>;127.*;localhost;10.*;192.168.*'
netsh winhttp set proxy 127.0.0.1:7890 | Out-Null

# ---------- 4. 等节点就绪（最多 40 秒）----------
$out = $null
for ($i = 0; $i -lt 20; $i++) {
    $out = & curl.exe -s -m 8 -x http://127.0.0.1:7890 https://api.country.is/
    if ($LASTEXITCODE -eq 0 -and $out) { break }
    Start-Sleep -Seconds 2
}

if ($out) {
    Show-Box "代理已开启`r`n`r`n出口: $out`r`n`r`n关闭：双击桌面「停止代理」。" '启动代理' 'Information'
} else {
    Show-Box "内核已启动，但节点暂时没连上。`r`n`r`n等 30 秒再试，或重新双击启动换节点。" '启动代理' 'Warning'
}
