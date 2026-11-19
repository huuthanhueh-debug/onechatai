' OneChat launcher: starts the local server with no console window and opens the app window.
' If OneChat is already running, this just opens another window on it. ASCII only.
Option Explicit
Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
' The desktop app, when installed: its own window with the OneChat icon on the taskbar
' (a browser window would carry the browser's icon instead).
Dim electron
electron = dir & "\node_modules\electron\dist\electron.exe"
If fso.FileExists(electron) Then
  sh.Run """" & electron & """ """ & dir & """", 1, False
  WScript.Quit 0
End If
If sh.Run("cmd /c where node >nul 2>&1", 0, True) <> 0 Then
  MsgBox "OneChat needs Node.js 22 or newer (https://nodejs.org)." & vbCrLf & "OneChat can Node.js 22 tro len.", vbExclamation, "OneChat"
  WScript.Quit 1
End If
' --use-system-ca: trust the Windows certificate store (antivirus TLS inspection would otherwise break HTTPS).
' run-hidden.cmd also restarts the server if it ever stops abnormally; the open window reconnects by itself.
sh.Run "cmd /c """ & dir & "\scripts\run-hidden.cmd""", 0, False
