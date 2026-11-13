param(
    [int]$Enable = 1,
    [string]$Server = '127.0.0.1:7890'
)

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

New-ItemProperty -Path $key -Name ProxyEnable  -Value $Enable -PropertyType DWord  -Force | Out-Null
New-ItemProperty -Path $key -Name ProxyServer  -Value $Server -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name ProxyOverride -Value '<local>;127.*;localhost;10.*;192.168.*' -PropertyType String -Force | Out-Null

Add-Type -Namespace WinInet -Name Native -MemberDefinition @'
[DllImport("wininet.dll", SetLastError = true)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
'@

# 39 = INTERNET_OPTION_SETTINGS_CHANGED, 37 = INTERNET_OPTION_REFRESH
[WinInet.Native]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
[WinInet.Native]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
