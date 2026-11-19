# Creates the OneChat shortcut on the Desktop (and in the Start menu with -StartMenu).
# Double-click it, or press Ctrl+Alt+A, to open the app. Remove it by deleting the .lnk file.
# ASCII only: Windows PowerShell 5.1 reads .ps1 files as ANSI.
param([switch]$StartMenu, [switch]$NoHotkey)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root 'OneChat.vbs'
$cmd = Join-Path $root 'OneChat.cmd'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$icon = Join-Path $root 'public\icon.ico'
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$ws = New-Object -ComObject WScript.Shell

$folders = @([Environment]::GetFolderPath('Desktop'))
if ($StartMenu) { $folders += [Environment]::GetFolderPath('Programs') }

foreach ($folder in $folders) {
  $path = Join-Path $folder 'OneChat.lnk'
  $lnk = $ws.CreateShortcut($path)
  if (Test-Path $electron) {
    $lnk.TargetPath = $electron                # the desktop app: own window, tray icon
    $lnk.Arguments = '"' + $root + '"'
  } elseif (Test-Path $wscript) {
    $lnk.TargetPath = $wscript                 # no console window at all
    $lnk.Arguments = '"' + $vbs + '"'
  } else {
    $lnk.TargetPath = $cmd                     # VBScript unavailable: minimized console instead
    $lnk.WindowStyle = 7
  }
  $lnk.WorkingDirectory = $root
  if (Test-Path $icon) { $lnk.IconLocation = $icon }
  $lnk.Description = 'OneChat - one window, every AI'
  if (-not $NoHotkey -and $folder -eq $folders[0]) { $lnk.Hotkey = 'CTRL+ALT+A' }
  $lnk.Save()
  Write-Output "shortcut: $path"
}
