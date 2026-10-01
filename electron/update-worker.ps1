# Windows PowerShell 5.1 worker. The plan is data, never interpolated shell code.
$ErrorActionPreference = 'Stop'
$plan = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'update-plan.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$stage = $null
$backup = $null
$replaced = $false
$directoryMoved = $false
$next = $null
$lock = $null
function Write-Log([string]$message) {
    Add-Content -LiteralPath $plan.logPath -Value ('[{0}] {1}' -f [DateTimeOffset]::Now.ToString('o'), $message) -Encoding UTF8
}
function Wait-ProcessExit([int]$processId, [int]$seconds) {
    if ($processId -le 0) { throw 'Invalid process ID' }
    try { $previous = [Diagnostics.Process]::GetProcessById($processId) }
    catch [ArgumentException] { return }
    try {
        if (-not $previous.WaitForExit($seconds * 1000)) { throw "Timed out waiting for PID $processId" }
    } finally { $previous.Dispose() }
}
function File-Hash([string]$file) {
    $stream = [IO.File]::OpenRead($file)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
}
function Start-App([string]$file, [bool]$confirm = $false) {
    # Start-Process resolves wildcard characters in FilePath on Windows PowerShell.
    # ProcessStartInfo treats the executable name literally, including square brackets.
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $file
    $info.WorkingDirectory = [IO.Path]::GetDirectoryName($file)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    if ($confirm) {
        $info.EnvironmentVariables['ROOMCAST_UPDATE_RECEIPT'] = $plan.receiptPath
        $info.EnvironmentVariables['ROOMCAST_UPDATE_TOKEN'] = $plan.token
    } else {
        $info.EnvironmentVariables.Remove('ROOMCAST_UPDATE_RECEIPT')
        $info.EnvironmentVariables.Remove('ROOMCAST_UPDATE_TOKEN')
    }
    return [Diagnostics.Process]::Start($info)
}
function Copy-Tree([string]$source, [string]$destination) {
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($source)) {
        $attributes = [IO.File]::GetAttributes($entry)
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing linked install entry: $entry" }
        $dest = Join-Path $destination ([IO.Path]::GetFileName($entry))
        if ($attributes -band [IO.FileAttributes]::Directory) { Copy-Tree $entry $dest }
        else { [IO.File]::Copy($entry, $dest, $true) }
    }
}
function Verify-Payload([string]$root) {
    foreach ($entry in $plan.files) {
        if ((File-Hash (Join-Path $root $entry.name)) -ne $entry.sha256) { throw "Payload checksum mismatch: $($entry.name)" }
    }
}
try {
    # Only this exact start record acknowledges that this attempt is running.
    $lock = [IO.File]::Open($plan.lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    Write-Log "update start kind=$($plan.kind) pid=$($plan.pid) parentPid=$($plan.parentPid) version=$($plan.version)"
    Write-Log "target=$($plan.targetPath) source=$($plan.assetPath)"
    Wait-ProcessExit $plan.pid 180
    if ($plan.kind -eq 'portable-exe' -and $plan.parentPid -gt 0) {
        $launcher = $null
        try {
            $launcher = [Diagnostics.Process]::GetProcessById([int]$plan.parentPid)
            # process.ppid may be a shell/debugger; wait only for the portable image.
            $launcherPath = $launcher.MainModule.FileName
            if ([string]::Equals($launcherPath, $plan.targetPath, [StringComparison]::OrdinalIgnoreCase)) {
                Write-Log "waiting for portable launcher PID $($plan.parentPid)"
                if (-not $launcher.WaitForExit(120000)) { throw 'Portable launcher did not exit' }
            } else { Write-Log "parent is not portable launcher: $launcherPath" }
        } catch [ArgumentException] {
            Write-Log 'portable launcher already exited'
        } finally { if ($launcher) { $launcher.Dispose() } }
    }
    # File.Replace requires the same volume. Write the complete new image alongside
    # the installed EXE; failures here cannot truncate the installed program.
    $suffix = [Guid]::NewGuid().ToString('N')
    $stage = $plan.targetPath + '.update-' + $suffix + '.tmp'
    $backup = $plan.targetPath + '.previous-' + $suffix
    if ($plan.kind -eq 'portable-exe') {
        if ((File-Hash $plan.assetPath) -ne $plan.sha256) { throw 'Downloaded file changed after checksum verification' }
        [IO.File]::Copy($plan.assetPath, $stage, $false)
        if ((File-Hash $stage) -ne $plan.sha256) { throw 'Staged file checksum mismatch' }
        for ($attempt = 1; $attempt -le 30; $attempt++) {
          try {
            # Atomically swaps names, preserving the old image even if another
            # launcher still has it mapped. Never copy over a running image.
            [IO.File]::Replace($stage, $plan.targetPath, $backup)
            $replaced = $true
            break
          } catch [IO.IOException] {
            Write-Log "replace attempt=$attempt hresult=$($_.Exception.HResult) error=$($_.Exception.Message)"
            if ($attempt -eq 30) { throw }
            Start-Sleep -Seconds 1
          }
        }
        if ((File-Hash $plan.targetPath) -ne $plan.sha256) { throw 'Installed file checksum mismatch' }
    } elseif ($plan.kind -eq 'directory') {
        Verify-Payload $plan.payloadDir
        # Preserve user-added files while avoiding a partially overwritten installation.
        Copy-Tree $plan.targetPath $stage
        Copy-Tree $plan.payloadDir $stage
        Verify-Payload $stage
        [IO.Directory]::Move($plan.targetPath, $backup)
        $directoryMoved = $true
        [IO.Directory]::Move($stage, $plan.targetPath)
        $replaced = $true
    } else { throw 'Unsupported install kind' }
    Write-Log "files replaced; backup=$backup"
    $next = Start-App $plan.launchPath $true
    Write-Log "restart started pid=$($next.Id); waiting for version receipt"
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $confirmed = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ([IO.File]::Exists($plan.receiptPath)) {
            $receipt = [IO.File]::ReadAllText($plan.receiptPath) | ConvertFrom-Json
            if ($receipt.token -eq $plan.token -and $receipt.version -eq $plan.version) { $confirmed = $true; break }
            throw 'Startup receipt does not match the requested version'
        }
        if ($next.HasExited) { throw 'New application exited before confirming startup' }
        Start-Sleep -Milliseconds 200
    }
    if (-not $confirmed) { throw 'Timed out waiting for new application startup confirmation' }
    Write-Log "COMMITTED version=$($plan.version)"
    if ($plan.failureMarkerPath) { Remove-Item -LiteralPath $plan.failureMarkerPath -Force -ErrorAction SilentlyContinue }
    # A committed startup is not undone by failure to clean temporary data.
    if ($plan.assetPath) { Remove-Item -LiteralPath $plan.assetPath -Force -ErrorAction SilentlyContinue }
    if ($plan.payloadDir) {
        try { [IO.Directory]::Delete($plan.payloadDir, $true) } catch { Write-Log "cleanup deferred: $($_.Exception.Message)" }
    }
    exit 0
} catch {
    $failure = $_
    Write-Log "FAILED hresult=$($failure.Exception.HResult) error=$($failure.Exception.Message)"
    $canRestart = $null -ne $lock
    if ($replaced -or $directoryMoved) {
        try {
            # Stop only the process tree this worker just launched before rollback.
            if ($next -and -not $next.HasExited) {
                $stop = [Diagnostics.ProcessStartInfo]::new()
                $stop.FileName = Join-Path $env:SystemRoot 'System32/taskkill.exe'
                $stop.Arguments = "/PID $($next.Id) /T /F"
                $stop.UseShellExecute = $false
                $stop.CreateNoWindow = $true
                $killer = [Diagnostics.Process]::Start($stop)
                $killer.WaitForExit(10000) | Out-Null
                if (-not $next.HasExited -and $killer.HasExited -and $killer.ExitCode -ne 0) {
                    Write-Log "process-tree stop failed exit=$($killer.ExitCode); stopping owned process by handle"
                    $next.Kill()
                }
                $next.WaitForExit(10000) | Out-Null
            }
            # PowerShell binds $null to an empty string for this overload. NullString
            # is required for Replace's optional backup filename.
            if ($plan.kind -eq 'portable-exe') { [IO.File]::Replace($backup, $plan.targetPath, [NullString]::Value) }
            else {
                if ([IO.Directory]::Exists($plan.targetPath)) { [IO.Directory]::Move($plan.targetPath, $stage) }
                [IO.Directory]::Move($backup, $plan.targetPath)
            }
            Write-Log 'rolled back to previous image'
        } catch {
            $canRestart = $false
            Write-Log "ROLLBACK FAILED; retained backup=$backup error=$($_.Exception.Message)"
        }
    }
    if ($lock -and $plan.failureMarkerPath) {
        [IO.File]::WriteAllText($plan.failureMarkerPath, "$($plan.version)`r`n$($plan.workDir)`r`n$($failure.Exception.Message)", [Text.UTF8Encoding]::new($false))
    }
    if ($canRestart) {
        try {
            $previousApp = Start-App $plan.launchPath
            Write-Log "previous image restarted pid=$($previousApp.Id)"
        } catch { Write-Log "restart failed: $($_.Exception.Message)" }
    }
    exit 1
} finally {
    # Delete only the worker-created staging path. Always retain the old backup.
    if ($stage -and [IO.File]::Exists($stage)) { [IO.File]::Delete($stage) }
    if ($stage -and [IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage, $true) }
    if ($lock) { $lock.Dispose() }
}
