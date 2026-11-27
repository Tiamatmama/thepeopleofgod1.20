Option Explicit
' 无窗口拉起托盘：开机自启与快捷键都走这个脚本，避免闪一下黑框。
Dim shell, fso, root, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\scripts\windows\desktop.ps1"""
If WScript.Arguments.Count > 0 Then cmd = cmd & " -Open"
shell.Run cmd, 0, False
