' Runs the Morning Brief data collector once with no visible window.
' Started daily at 08:55 by the Windows scheduled job "MorningBriefCollector"
' (registered 2026-10-02). Writes morning-brief-data.json for the 09:00 brief
' task and the dashboard; exits when done (--once), never leaves a server up.
' cmd /c is needed for the log redirect: WScript.Shell.Run has no shell of its own.
Set sh = CreateObject("WScript.Shell")
WScript.Quit sh.Run("cmd.exe /c """"C:\Program Files\nodejs\node.exe"" ""C:\Users\werne\Claude\LazyRelay\support\data-collector.js"" --once > ""C:\Users\werne\Claude\LazyRelay\support\collector-last-run.log"" 2>&1""", 0, True)
