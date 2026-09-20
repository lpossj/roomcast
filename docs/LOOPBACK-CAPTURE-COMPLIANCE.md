# Loopback Capture Addon Compliance

## Component

- Binary path: `runtime/loopback-capture/loopback_capture_addon.node`
- Platform: Windows x64 Node-API addon
- Runtime use: Windows WASAPI loopback capture for application/system audio
- License: MIT
- Copyright: Copyright (c) 2025 Matin Tat
- License text: `runtime/loopback-capture/LICENSE`

## Audit facts

The binary is a native Node-API addon used by the Electron main process through `loadLoopbackCapture()`.

Observed embedded build references include `LoopbackCapture.cpp`, Node-API symbols and Microsoft WIL build dependencies. The exact upstream repository, revision and reproducible build instructions are not present in this repository snapshot.

## Open-source status

Roomcast project source is licensed under Apache-2.0.

The loopback capture addon is a separate MIT-licensed third-party precompiled component. It is **not** covered by the Roomcast Apache-2.0 source license and must not be described as Roomcast-authored source code or as part of a fully source-available Roomcast release.

## Redistribution policy

`runtime/` is intentionally ignored by `.gitignore` and is not pushed as part of the public source repository.

A binary distribution that includes `loopback_capture_addon.node` must:

1. keep `runtime/loopback-capture/LICENSE`;
2. keep the MIT copyright notice: `Copyright (c) 2025 Matin Tat`;
3. keep this addon listed in `THIRD-PARTY-NOTICES.txt`;
4. clearly state that it is a third-party precompiled component when describing the release publicly;
5. not imply that the addon is covered by the Roomcast Apache-2.0 license.

Providing upstream source, a matching revision/tag, or a reproducible build script is strongly recommended for transparent open-source distribution. Until those materials are available, the project can still publish its own Apache-2.0 source and may distribute the addon as a disclosed third-party binary component.

## Functional constraint

Do not delete the addon from the local runtime while the system-audio feature is in use. Removing it breaks the existing Windows loopback capture path.

## 自动获取（推荐）

干净源码仓库运行：

```powershell
npm run fetch:runtime
```

脚本会从稳定 Release 资产下载 loopback 组件 ZIP，并校验两个文件的 SHA256。也可以设置：

- ROOMCAST_LOOPBACK_ARCHIVE：本地已解压目录或 ZIP。
- ROOMCAST_LOOPBACK_ARCHIVE_URL：自定义下载地址。

发布维护者应先运行 npm run package:runtime，并把生成的 Roomcast-<version>-loopback-capture.zip 作为 Release 资产上传。

## Obtain the component for a clean source checkout

The addon has no verified upstream version/revision in this snapshot. Identify this
prebuilt artifact by its SHA-256, not by an invented upstream version. Obtain the
matching Roomcast 0.14.1 Windows ZIP from the GitHub/Gitee Release page (the same
release as this source), extract it locally, and copy these files:

- ZIP: resources/runtime/loopback-capture/loopback_capture_addon.node
  → checkout: runtime/loopback-capture/loopback_capture_addon.node
- ZIP: resources/runtime/loopback-capture/LICENSE
  → checkout: runtime/loopback-capture/LICENSE

Expected SHA-256 (raw file bytes):

~~~text
loopback_capture_addon.node
23acf5f229c8e1fc5a70e4519def9d39e8ccd43b47912f364d8b81d93be5a50c

LICENSE
30085cfcb641f0712d2453402257cfa4d9badef164933954c35e4f6675801e1a
~~~

After copying, run 'npm run setup'. It verifies both files before reporting readiness;
a missing or mismatching component stops setup with this document's location.
Do not rename a different binary into place or use an unverified download.
The release publisher must keep the matching Windows ZIP and the standalone loopback ZIP available alongside the source archive. OBS is prepared separately by 'npm run prepare:obs' (or the existing
release before-pack hook). This acquisition process does not supply the missing
addon source/rebuild provenance, which remains explicitly unknown.
