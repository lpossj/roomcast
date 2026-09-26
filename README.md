# Roomcast 0.14.3 Beta

Windows 10/11 x64 的 Electron 屏幕共享与文字聊天软件。每个房间最多 10 人，可多人同时共享。

Roomcast 只面向合法、知情同意的屏幕共享与聊天。使用前请阅读 [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md)。

> 当前版本是公开测试版（Beta）。创建房间（当房主）只由 Windows 桌面客户端发起，桌面端可立即生成固定 HTTPS 电脑／手机网页邀请，无需网站注册或登录；观看者用邀请链接在浏览器里加入观看，**电脑浏览器在房间里也可以共享屏幕**，手机浏览器通常不实现 `getDisplayMedia`，因此手机网页以观看和聊天为主（共享按钮显示为"仅支持观看"）。默认可能使用 PeerJS / VDO.Ninja 公网服务，代码签名状态和已知限制见发布说明与 [状态文档](docs/STATUS.md)。

[下载](https://github.com/lpossj/roomcast/releases) · [发布说明](docs/RELEASE_NOTES-0.14.3-beta.7.md) · [发布流程](docs/RELEASING.md) · [版本策略](docs/VERSIONING.md) · [更新日志](CHANGELOG.md) · [问题反馈](https://github.com/lpossj/roomcast/issues)（也可发邮件：2106841308@qq.com / z2106841308@163.com） · [安全报告](SECURITY.md)

Roomcast 0.14.3 Beta 的媒体架构是：

```text
原生 Roomcast P2P (t=0)
        │ 3 秒内未出画 / 提前失败
        ▼
VDO.Ninja direct viewer（默认延迟 3000ms；P2P 提前失败则立即启动）
        │ 两条直连均失败/耗尽
        ▼
TURN relay-only
```

OBS Studio 32.1.2 只作为可选的 **固定帧率 Capture Layer**。OBS 负责采集屏幕/窗口并通过 Virtual Camera 把视频交回 Roomcast；OBS 不负责房间、WHIP、ICE、TURN 或网络传输。

旧 Quick Tunnel / MediaMTX 媒体链已经退出当前运行架构，不应恢复。

## 使用

1. 启动 `Roomcast.exe`。
2. 在桌面应用或网页点击“创建房间”，填写昵称和房名。网页房主需保持该页面运行。
3. 点击“邀请朋友”，复制 `roomcast://join/...` 邀请。
4. 好友可运行 Roomcast 并打开 `roomcast://` 邀请，也可以直接打开房间的 HTTPS 网页链接。
5. 点击“共享屏幕”，选择 OBS 或原生采集、显示器/窗口、分辨率、FPS、目标码率以及音频选项。

Cloudflare TURN 是可选的最终媒体兜底。配置 TURN 后，Roomcast 会先在 t=0 立即尝试原生 P2P；VDO.Ninja direct-only viewer 默认延迟 3 秒启动，P2P 提前明确失败则立即启动 VDO。只有两条直连都没有建立可播放画面时，才允许进入 TURN relay-only。TURN Worker 配置见 `docs/Cloudflare-TURN部署.md`。

## 当前关键架构约束

- **P2P 优先：** P2P viewer 在 t=0 立即开始；VDO viewer 默认延迟 3000ms，P2P 在 3 秒内 playable 时不启动 VDO，P2P 提前明确失败时 VDO 立即启动。
- **近同时成功：** 仍使用现有 `media-race-manager.js` 规则处理 P2P/VDO 竞争；不要另写第二套竞争逻辑。
- **VDO.Ninja：** 仅作为 direct lane，VDO 自带 TURN / auto relay 必须保持关闭。
- **TURN：** 只能在 direct race exhausted 后进入，媒体 TURN 使用 relay-only。
- **OBS：** 仅做 Capture Layer；不得恢复 OBS WHIP / OBS ICE / OBS TURN。
- **Quick Tunnel / MediaMTX：** 当前运行时与发布包不得依赖或恢复这条旧媒体链。
- **本机预览：** 复用本机正在发布的 MediaStream，不应为了自看再走公网 P2P、VDO 或 TURN。

网络核心文件在无明确证据时不要重写：

```text
src/p2p.js
src/media-race-manager.js
src/ice-policy.js
src/transports/*
server/rooms.mjs
```

## 采集

共享设置提供两种采集后端：

- **OBS**：内置固定版本 OBS Studio 32.1.2，用于维持用户选择的固定 FPS。首次需要时可进行 Virtual Camera 注册；Roomcast 管理的 OBS worker 使用 managed termination 清理。
- **原生采集**：Electron / Chromium Desktop Capture。

Windows 系统声音按 Core Audio 会话枚举，可选择共享/排除具体应用。OBS 采集失败不会自动把用户设置静默改成原生采集；用户可以手动切换后端。

## 网络与安全

- 房间控制与聊天继续使用现有 Roomcast P2P/房间控制链。
- 屏幕媒体使用 WebRTC DTLS-SRTP。
- VDO.Ninja direct lane 禁用 VDO TURN、forceTURN、autoRelay 和自动恢复，由 Roomcast 自己管理 race/重试/清理。
- TURN Worker 只提供临时 TURN ICE 凭据；长期 Worker access key 不得放入邀请、renderer 状态或日志。
- Electron 主进程保存敏感配置时使用 `safeStorage`。
- 桌面本地服务应保持 loopback 绑定，不得无理由暴露到 LAN。
- 独立 server 默认仅监听 `127.0.0.1`；只有显式设置 `HOST=0.0.0.0` 才暴露到 LAN/Tailscale。
- 远程 P2P 以高熵 invite secret 为加入凭据；手动房间号 + 弱密码不能替代 invite secret。
- 图片仅支持 JPEG/PNG/WebP/GIF，接收端校验 magic bytes、尺寸上限和缓存上限，并回收 ObjectURL。

## 构建

干净源码包不含系统音频预编译组件。先运行 `npm run fetch:runtime`，从稳定 Release 资产下载并校验组件；也可以设置 `ROOMCAST_LOOPBACK_ARCHIVE` 或 `ROOMCAST_LOOPBACK_ARCHIVE_URL` 使用本地 ZIP / 自定义下载地址。详见 [组件取得与校验](docs/LOOPBACK-CAPTURE-COMPLIANCE.md)。

```powershell
npm ci
npm run fetch:runtime
npm run setup
npm run check
npm run dist:obs-verified
```

常用目标：

```text
npm run pack           -> release/win-unpacked
npm run dist           -> Windows portable EXE
npm run dist:zip       -> ZIP
npm run dist:nsis      -> NSIS installer
npm run release:build  -> 一次构建 portable EXE 和 ZIP
npm run package:source -> 源码 ZIP
npm run package:runtime -> loopback 组件 ZIP
npm run checksums      -> release/SHA256.txt
npm run verify:release -> 打包后 EXE smoke 校验
```

OBS 发布包必须通过 `scripts/check-packaged-obs-step5d.cjs` 验证。不要通过猜测 DLL 用途来裁剪 OBS runtime；Step 6B 的任何体积优化都必须配套 packaged OBS verifier。

## 回归要求

修改后按受影响范围执行测试，不要把“构建成功”等同于“功能已验证”。网络修改至少保持：

```text
P2P + VDO direct race
VDO TURN disabled
TURN gated after direct race exhaustion
TURN media relay-only
Quick Tunnel runtime residue absent
MediaMTX runtime/package residue absent
```

Windows 才能证明的项目（例如 OBS Virtual Camera 注册/UAC、managed termination、系统代理、真实 NAT、打包 EXE）如果当前环境未运行，应明确标记 **NOT VERIFIED**。

## 开源状态

- Roomcast source: Apache License 2.0, see LICENSE.
- Windows loopback capture addon: third-party MIT prebuilt binary, not part of the Roomcast Apache-2.0 source grant. See docs/LOOPBACK-CAPTURE-COMPLIANCE.md.
- OBS Studio 32.1.2: GPL-2.0-or-later with corresponding source archive.
- This repository is main-source-open plus separately licensed third-party components.

## 文档与署名

- [安全策略](SECURITY.md)
- [隐私说明](PRIVACY.md)
- [使用教程与注意事项](docs/使用教程与注意事项.md)
- [第三方声明](NOTICE)
- [商标说明](TRADEMARKS.md)
- [第三方许可证清单](THIRD-PARTY-NOTICES.txt)
- [合法使用说明](ACCEPTABLE_USE.md)
- [社区行为准则](CODE_OF_CONDUCT.md)
- [贡献指南](CONTRIBUTING.md)

Roomcast 由 D4Y0 / Roomcast 维护。项目源码采用 Apache License 2.0，详见 `LICENSE`；第三方组件与许可证见 `THIRD-PARTY-NOTICES.txt`。

## 固定网页入口

默认地址：https://lpossj.github.io/roomcast/ 。分享弹窗在本地生成链接，不启动临时隧道，不要求使用者登录或注册。站点只提供静态网页，房间控制和媒体沿用现有独立流程。

维护者执行 `npm run build` 和 `npm run package:web` 可生成 `release/Roomcast-<version>-WebViewer/`，将其部署到 HTTPS 静态站点即可。网页包同时适配根路径和子目录。已有配置可通过 `ROOMCAST_WEB_VIEWER_URL` 指向自己的 HTTPS 网页目录。
