# Native RTP helper protocol

Launch `RoomcastNativeMedia.exe <absolute datachannel.dll path>`. The DLL is the existing OBS bundle component. Node/Electron ABI is not involved. Stdout is NDJSON, stderr is reserved for diagnostics. Never log incoming commands: ICE URLs may contain credentials.

Input objects have `cmd`:

- `create`: `id` (unique <=95 ASCII bytes), `offer` (base64 UTF-8 SDP), `iceServers` (array of libdatachannel ICE URLs), `relay` (boolean), `video`/`audio` (booleans). Only the already authorized route configuration is supplied. Percent-encode TURN username/password in the URL. H264 High with packetization-mode=1 and Opus PT/mid are selected from the corresponding offer m-sections. A baseline-only receiver is rejected and should use the established fallback.
- `candidate`: `id`, `candidate` (candidate string), `mid`. Candidate queuing before create is the bridge's responsibility.
- `close`: `id`; unknown/already closed IDs are no-ops. Session IDs must not be reused while the old main-process request is pending.
- `video`: `data` (base64 Annex-B access unit including SPS/PPS on IDR), `ptsUs` (common capture epoch microseconds), `keyframe` (boolean).
- `audio`: `data` (base64 Opus access unit), `ptsUs` (the same capture epoch microseconds). Do not separately reset the two stream clocks to zero.

Output objects have `event`:

- `ready` after DLL symbols resolve.
- `answer`: `id`, `sdp` (base64 UTF-8).
- `candidate`: `id`, `candidate`, `mid`.
- `state`: `id`, integer libdatachannel state 0=new,1=connecting,2=connected,3=disconnected,4=failed,5=closed.
- `feedback`: `id`, either `keyframe:true`, receiver `bitrate` (REMB, bits/s), or `fractionLost` (RR raw 0..255 fraction /256) and `jitter` (track RTP-clock units).
- `error`: optional `id`, stable `reason`; bridge must close/fallback failed negotiations.
- `closed`: `id` after that connection and its two tracks are deleted.

H264 is encoded once outside the helper. Each viewer has independent SRTP/ICE, packetizer, SR reporter and NACK cache. New viewers wait for an IDR; open/PLI emits an encoder keyframe request. The helper does not implement a congestion controller: bridge must apply feedback to the encoder and bound its stdin queue. No ICE/TURN discovery or global route mutation happens in this process.

Build with existing MinGW gcc: `gcc -std=c11 -O2 -Wall -Wextra -municode roomcast-native-rtc.c -o RoomcastNativeMedia.exe -lcrypt32`. Windows Crypt32/Kernel32/UCRT and the existing datachannel.dll are used; no added Node addon or compiler is shipped.

API declarations were checked against the official libdatachannel `include/rtc/rtc.h` at OBS's pinned commit [9d5c46b8f506943727104d766e5dad0693c5a223](https://github.com/paullouisageneau/libdatachannel/blob/9d5c46b8f506943727104d766e5dad0693c5a223/include/rtc/rtc.h) (v0.21.0, MPL-2.0). OBS32.1.2's retained CMakePresets.json selects obs-deps release2025-08-23; that release's `deps.ffmpeg/70-libdatachannel.ps1` pins this commit. Configuration, TrackInit, PacketizerInit and the imported C function signatures match that header; the prototype's unnecessary trailing packetizer padding was removed. The helper C source has its own MPL-2.0 notice, with the full license adjacent. Actual exported symbols and two-viewer H264/Opus interoperability were exercised before this declaration-only cleanup. OBS implementation reference is the bundled OBS 32.1.2 `plugins/obs-webrtc/whip-output.cpp`.

Evidence: `report-640x360.json` and `report-1080p60.json`, Electron 44.3.0 Chromium 152.0.7977.78, synthetic WebCodecs input; both viewers decode video/audio, one viewer's repeated close leaves the other decoding. This is transport/interoperability evidence, not OBS latency or WAN performance evidence. First restricted-token Electron attempt failed GPU loading; normal-permission hidden Electron succeeded.
