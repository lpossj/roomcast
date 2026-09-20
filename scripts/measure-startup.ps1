param(
  [string[]]$Executables = @('release\win-unpacked\Roomcast.exe', 'release\Roomcast-0.11.1-Windows.exe')
)
$ErrorActionPreference = 'Stop'
if (Get-Process Roomcast -ErrorAction SilentlyContinue) { throw '请先退出所有 Roomcast，再运行启动对比。' }
$outputDir = Join-Path (Get-Location) 'test-results\startup'
$null = New-Item -ItemType Directory -Force -Path $outputDir
$oldLog = $env:ROOMCAST_STARTUP_LOG
$oldProfile = $env:ROOMCAST_PROFILE_DIR
try {
  foreach ($executable in $Executables) {
    $exePath = (Resolve-Path -LiteralPath $executable).Path
    $runId = [guid]::NewGuid().ToString('N')
    $env:ROOMCAST_STARTUP_LOG = Join-Path $outputDir "$runId.jsonl"
    $env:ROOMCAST_PROFILE_DIR = Join-Path $outputDir 'profile'
    $startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $process = Start-Process -FilePath $exePath -WindowStyle Normal -PassThru
    $entries = @()
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
      Start-Sleep -Milliseconds 100
      if (Test-Path -LiteralPath $env:ROOMCAST_STARTUP_LOG) {
        $entries = @(Get-Content -LiteralPath $env:ROOMCAST_STARTUP_LOG | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} })
      }
    } until (($entries | Where-Object stage -eq 'load-end') -or [DateTime]::UtcNow -ge $deadline)
    $entries | Select-Object stage, elapsedMs, @{Name='launchMs';Expression={$_.at - $startedAt}} | Format-Table
    Write-Output "EXE: $exePath"
    Write-Output "LOG: $env:ROOMCAST_STARTUP_LOG"
    $mainEntry = $entries | Where-Object stage -eq 'main-entry' | Select-Object -First 1
    if (!$mainEntry) { throw '未收到主进程日志，请手动退出测试实例后检查。' }
    $mainProcess = Get-Process -Id $mainEntry.pid -ErrorAction SilentlyContinue
    if ($mainProcess) {
      $null = $mainProcess.CloseMainWindow()
      if (!$mainProcess.WaitForExit(25000)) { throw '测试实例未退出，请手动关闭后重试。' }
    }
    if (!$process.WaitForExit(15000)) { throw '启动器仍未退出，请手动关闭后重试。' }
  }
} finally {
  $env:ROOMCAST_STARTUP_LOG = $oldLog
  $env:ROOMCAST_PROFILE_DIR = $oldProfile
}
