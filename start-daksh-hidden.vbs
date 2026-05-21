Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
ScriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = ScriptDir
WshShell.Run Chr(34) & ScriptDir & "\start-daksh.bat" & Chr(34), 0, False
Set FSO = Nothing
Set WshShell = Nothing
