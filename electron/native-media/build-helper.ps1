param([string]$Compiler = 'gcc')
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    New-Item -ItemType Directory -Force '../../runtime/native-media' | Out-Null
    & $Compiler -std=c11 -O2 -Wall -Wextra -municode roomcast-native-rtc.c -o ../../runtime/native-media/RoomcastNativeMedia.exe -lcrypt32
    if ($LASTEXITCODE) { throw 'Native RTP helper compilation failed' }
    Get-Item ../../runtime/native-media/RoomcastNativeMedia.exe | Select-Object Name, Length
} finally { Pop-Location }
