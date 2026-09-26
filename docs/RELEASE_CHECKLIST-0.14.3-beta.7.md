# Roomcast 0.14.3-beta.7 验收单

用户于 2026-09-27 明确授权 beta.7、push、Release 和必要的线上观看网页更新，同时禁止把 WebViewer ZIP 作为本次附件。历史 beta.6 的真实验证证据保留，下面仅追加本版本实际完成结果。

## 当前范围

- 已有四项独立修复：新邀请确认 fe2d19a；首次离开 0281295；失联清理 4095bdc；资源释放 e8581a6。
- 版本更新为 0.14.3-beta.7，网页无法建房的限制保持，电脑网页共享能力保持。
- 不改 TURN/ICE/鉴权/媒体策略，不重复下载大型发布包，不替换旧 beta.6 标签或附件。
- 6 项 Release 附件：Windows EXE、Windows ZIP、源码 ZIP、loopback ZIP、SHA256.txt、OBS 对应源码；无 WebViewer ZIP。

## 验收进度

- [x] 本版本完整 check：215 通过、0 失败、1 可选旧 beta.1 ZIP 测试跳过；许可证、构建、网络门禁通过，另通过发布运行时许可证检查。
- [x] 网页动态邀请与手机/电脑浏览器入口权限回归通过：手机没有采集 API 时只加入/观看；电脑有共享入口，但未加入只能打开加入确认，不能建房。
- [x] 本版本 EXE/ZIP 顺序构建、实际便携包校验通过；未启用 TEST_MODE 的原有 ×/Escape 取消后能继续操作，冻结渲染器下 SC_CLOSE 70ms/code0、自身 7 个进程无残留。
- [ ] app.asar/ZIP 与本次源码和构建匹配，源码归档来自干净发布提交。
- [ ] main、v0.14.3-beta.7、公开 prerelease 及全部附件元数据/SHA256 核对。
- [ ] gh-pages、Pages 构建、线上 JS/版本/邀请界面核对。
- [ ] iOS/微信真机及手机跨网验收（用户操作，不能用桌面模拟代替）。

实际进度和未知范围持续记录在 [时间戳](时间戳记录/发布-beta7-20260927.md)。

包内 Electron/服务端关键文件与完整 dist 共 12 项逐字节匹配；实际 Windows ZIP 的 app.asar/主程序/NOTICE/version 与本次目录产物相同。源码归档及线上发布项将在完成后追加，不提前勾选。

EXE SHA256：`E89C1B0261626F90F579BF695C8C4A74DE61901143A12C53E09378AF6B72FD52`；Windows ZIP：`78255D4D05E779323725E17D1427EFA3F61DAD3A3B14F794F9997EC7B9B412D8`。
