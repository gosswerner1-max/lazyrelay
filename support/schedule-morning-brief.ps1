# Create Morning Brief scheduled task at 9 AM daily
$taskName = "Morning Brief Data Collector"
$taskPath = "\Claude"
$scriptPath = "C:\Users\werne\Claude\LazyRelay\support\data-collector.js"

# Create action: run node with the collector script
$action = New-ScheduledTaskAction `
  -Execute "node" `
  -Argument $scriptPath

# Create trigger: daily at 9 AM
$trigger = New-ScheduledTaskTrigger `
  -Daily `
  -At 9:00AM

# Create settings: allow task to run for up to 1 hour, start if missed
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -StartWhenAvailable

# Register the task
try {
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -RunLevel Highest
  Register-ScheduledTask `
    -TaskName $taskName `
    -TaskPath $taskPath `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force

  Write-Host "✓ Scheduled task created: '$taskName'" -ForegroundColor Green
  Write-Host "  Runs daily at 9:00 AM" -ForegroundColor Green
  Write-Host "  Updates morning-brief-data.json automatically" -ForegroundColor Green
} catch {
  Write-Host "✗ Error creating task: $_" -ForegroundColor Red
}
