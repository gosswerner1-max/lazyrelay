# Refresh Morning Brief data and open dashboard
Write-Host "Refreshing Morning Brief data..." -ForegroundColor Cyan

# Run the data collector once (no server; the dashboard's server.js runs separately)
& node C:\Users\werne\Claude\LazyRelay\support\data-collector.js --once

# Open the dashboard in default browser
Write-Host "`nOpening Morning Brief dashboard..." -ForegroundColor Green
Start-Process "https://claude.ai/artifact/96f8sofWzfCP6aZqHUdC1x"
