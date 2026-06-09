Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d ""c:\Users\richa\Downloads\jhonny"" && node print-agent.js >> ""c:\Users\richa\Downloads\jhonny\print-agent.log"" 2>&1", 0, False
