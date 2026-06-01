' Launches the label-print agent with no visible console window, logging to
' agent.log next to this script. Path-independent so it works on any PC.
' Used by the "JA Label Print Agent" logon scheduled task.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = scriptDir
sh.Run "cmd /c node index.js >> agent.log 2>&1", 0, False
