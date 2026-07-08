' Supervisor for the label-print agent: launches it hidden and restarts it
' 15s after any crash, so one crash never leaves printing down for days.
' Path-independent; used by the Startup shortcut / logon scheduled task.
' NOTE: the loop lives HERE (inline sh.Run) because executing a .cmd file
' from wscript is blocked on the workshop PC while inline commands are not.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = scriptDir
Do
  sh.Run "cmd /c node index.js >> agent.log 2>&1", 0, True
  sh.Run "cmd /c echo restart after exit >> agent.log", 0, True
  WScript.Sleep 15000
Loop
