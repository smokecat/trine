' trine agent background launcher — called by the scheduled task TrineAgent, hidden window.
'
' Copy this file to start-agent.vbs and fill in the four values below. start-agent.vbs is
' git-ignored because it contains your relay URL and machine paths.
'
'   schtasks /create /tn TrineAgent /tr "wscript.exe C:\path\to\trine\start-agent.vbs" /sc onlogon /rl highest
'   schtasks /run /tn TrineAgent
'
' Do not add --enroll once the identity exists in the home directory.

Dim shell, repo, bunExe, serverUrl, trineHome

repo = "C:\path\to\trine"
bunExe = "C:\Users\<you>\.bun\bin\bun.exe"
serverUrl = "https://trine.example.com"
trineHome = "C:\Users\<you>\.trine"

Set shell = CreateObject("WScript.Shell")
shell.Run "cmd /c cd /d """ & repo & """ && """ & bunExe & _
  """ run apps\agent\src\cli.ts --server " & serverUrl & " --home """ & trineHome & """", 0, False
