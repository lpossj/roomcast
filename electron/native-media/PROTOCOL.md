# Native RTP helper protocol

Launch `RoomcastNativeMedia.exe <absolute datachannel.dll path>`. The DLL is the existing OBS bundle component. Node/Electron ABI is not involved. Stdout is NDJSON, stderr is reserved for diagnostics. Never log incoming commands: ICE URLs may contain credentials.

Input objects have `cmd`:

- `create`: `id` (unique <=95 ASCII bytes), `offer` (base64 UTF-8 SDP), `iceServers` (array of libdatachannel ICE URLs), `relay` (boolean), `video`/`audio` (booleans), `profileLevelId` (six hex digits from the actual encoder SPS). Only the already authorized route configuration is supplied. Percent-encode TURN username/password in the URL. H264 High with packetization-mode=1 and Opus PT/mid are selected from the corresponding receiving offer m-sections. The receiver must support the actual SPS profile and level; the answer declares that actual format. A baseline/constrained-high-only receiver, inadequate receive level, or required audio without Opus/48000/2 is rejected and uses the established fallback. Audio-disabled sharing remains valid without Opus.
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

The main bridge waits at most three seconds for the first IDR's Annex-B SPS before reporting native startup ready. OBS NVENC supplies its headers with the first encoded packet, so startup cannot infer a fixed level from a preset. This preserves native low-resolution streams (for example, 720p60 High 3.2) as well as 1080p60 High 4.2. Cancellation or missing metadata closes the session and permits the normal fallback.

Chromium 152 advertises H264 using a default 720p30 configuration. The receiving browser therefore queries MediaCapabilities with `type: "webrtc"` for the existing 1080p60, 1080p30, and 720p60 formats, within one 1.5-second budget, and caches the highest supported smooth configuration. Only its recvonly High/mode-1 offer is raised to that confirmed level. Missing API, unsupported configurations, errors, or timeout preserve the original offer. RFC 6184 section 8.2.2 requires respecting the receiver's level even when level asymmetry is allowed; RFC 7587 section 7 requires Opus signaling at 48000 Hz with two channels.

Build with existing MinGW gcc: `gcc -std=c11 -O2 -Wall -Wextra -municode roomcast-native-rtc.c -o RoomcastNativeMedia.exe -lcrypt32`. Windows Crypt32/Kernel32/UCRT and the existing datachannel.dll are used; no added Node addon or compiler is shipped.

API declarations were checked against the official libdatachannel `include/rtc/rtc.h` at OBS's pinned commit [9d5c46b8f506943727104d766e5dad0693c5a223](https://github.com/paullouisageneau/libdatachannel/blob/9d5c46b8f506943727104d766e5dad0693c5a223/include/rtc/rtc.h) (v0.21.0, MPL-2.0). OBS32.1.2's retained CMakePresets.json selects obs-deps release2025-08-23; that release's `deps.ffmpeg/70-libdatachannel.ps1` pins this commit. Configuration, TrackInit, PacketizerInit and the imported C function signatures match that header; the prototype's unnecessary trailing packetizer padding was removed. The helper C source has its own MPL-2.0 notice, with the full license adjacent. Actual exported symbols and two-viewer H264/Opus interoperability were exercised before this declaration-only cleanup. OBS implementation reference is the bundled OBS 32.1.2 `plugins/obs-webrtc/whip-output.cpp`.

Evidence: `report-640x360.json` and `report-1080p60.json`, Electron 44.3.0 Chromium 152.0.7977.78, synthetic WebCodecs input; both viewers decode video/audio, one viewer's repeated close leaves the other decoding. This is transport/interoperability evidence, not OBS latency or WAN performance evidence. First restricted-token Electron attempt failed GPU loading; normal-permission hidden Electron succeeded.
