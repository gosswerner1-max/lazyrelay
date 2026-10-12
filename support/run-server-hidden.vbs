' Starts the Morning Brief dashboard's small file server (server.js, port 3001)
' with no visible window. Started at logon by the Windows scheduled job
' "MorningBriefServer" (registered 2026-10-02). The dashboard artifact at
' https://claude.ai/artifact/96f8sofWzfCP6aZqHUdC1x fetches
' http://localhost:3001/morning-brief-data.json from it. Serves the file only;
' the data itself is refreshed by the 08:55 collector job or refresh-brief.ps1.
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\werne\Claude\LazyRelay\support\server.js""", 0, False
