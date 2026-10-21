param([string]$Compiler = 'gcc', [string]$DllTool = 'dlltool')
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    # Relative arguments also work with MinGW tools in non-ASCII workspaces.
    $nativeCache = '../../runtime/native-media/.build-obs-plugin'
    New-Item -ItemType Directory -Force -Path $nativeCache | Out-Null
    & tar -xf '../../runtime/obs-source/OBS-Studio-32.1.2-Sources.tar.gz' -C $nativeCache obs-studio-32.1.2-sources/libobs obs-studio-32.1.2-sources/plugins/obs-websocket/lib/obs-websocket-api.h
    if ($LASTEXITCODE) { throw 'OBS 32.1.2 source extraction failed' }
    & $DllTool -d obs.def -l "$nativeCache/libobs.a"
    if ($LASTEXITCODE) { throw 'OBS import library generation failed' }
    & $Compiler -O2 -Wall -Wextra -shared -static-libgcc -I . -I $nativeCache -I "$nativeCache/obs-studio-32.1.2-sources/libobs" roomcast-native.c "$nativeCache/libobs.a" -o ../../runtime/native-media/roomcast-native.dll
    if ($LASTEXITCODE) { throw 'OBS bridge compilation failed' }
    Get-Item ../../runtime/native-media/roomcast-native.dll | Select-Object Name, Length
} finally { Pop-Location }
