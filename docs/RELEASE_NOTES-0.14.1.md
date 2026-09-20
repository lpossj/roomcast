# Roomcast 0.14.1 Beta Release Notes

## 版本

- 版本号：0.14.1
- 类型：公开测试版（Beta）/ 基础版
- 平台：Windows 10/11 x64
- 签名状态：未签名；Windows SmartScreen 可能提示未知发布者
- 上游 RC：无（基于 0.14.0 稳定版）

## 主要变化

### P2P 优先

- P2P viewer 在 t=0 立即开始。
- VDO.Ninja viewer 默认延迟 3000ms。
- P2P 在 3 秒内 playable 时不启动 VDO。
- P2P 提前明确失败时 VDO 立即启动。
- 两条直连都失败或耗尽后，才允许进入 TURN relay-only。

### P2P 码率自适应

- 60fps 拥塞时先切换 30fps。
- 持续拥塞时按分辨率阶梯降级：1080p60 -> 1080p30 -> 720p60 -> 720p30 -> 480p60 -> 480p30。
- 初始 30fps 设置不会提高到 60fps。
- 码率恢复到所设码率后，经连续健康采样和冷却时间按阶梯回升。
- 接管方先待命确认，旧房主释放连接后再接管；拒绝或确认超时不会提前迁走其他成员。
- 混用旧版本时，旧接管方可能不支持新的迁移待命确认；退出会被阻止，请房间成员统一更新后再迁移。

### 安全加固

- 独立 server 默认只监听 127.0.0.1。
- Electron loopback 行为保持。
- 远程 P2P 只接受高熵 invite secret，弱密码不能替代。
- 图片仅支持 JPEG / PNG / WebP / GIF。
- 接收端校验 magic bytes、尺寸上限和总缓存上限。
- ObjectURL 回收；缓存满时淘汰最旧图片。
- CSP 响应头和 Electron Fuses 加固。

### 开源与合规

- Roomcast 自身源码：Apache License 2.0。
- OBS Studio 32.1.2：GPL-2.0-or-later，随包提供对应源码归档。
- Windows loopback capture addon：第三方 MIT 预编译组件，已单独披露。
- 新增第三方网络服务说明、自建 PeerJS 文档、发布流程和验证状态文档。
- loopback 组件合规说明：docs/LOOPBACK-CAPTURE-COMPLIANCE.md。

## 已知限制

- 当前版本未进行商业代码签名，Windows SmartScreen 可能提示未知发布者。
- 观看者和房主都需要安装 Roomcast，当前没有浏览器免安装观看入口。
- 未配置 PEER_SERVER_URL 时，PeerJS 公共信令服务可能处理连接元数据。
- VDO.Ninja direct fallback 依赖其公共服务；TURN 需要自行部署或配置。
- 房间服务和聊天数据为内存态，房间关闭后不保留历史。
- macOS / Linux 暂不在本发布线支持范围内。
- 更完整的未验证项见 docs/STATUS.md。

## 升级说明

- 直接替换旧版本程序目录或便携 EXE 即可。
- 设置保存在 Electron 用户数据目录，版本升级使用原有迁移逻辑。
- 邀请链接格式保持 roomcast://join/... 格式。
- 房间成员在迁移或高级功能前，建议统一更新到最新 Beta 版本。

## 校验与下载

发布时应同时提供：

- Roomcast-0.14.1-Windows.exe
- Roomcast-0.14.1-Windows.zip
- SHA256.txt
- Roomcast-0.14.1-source.zip
- Roomcast-0.14.1-loopback-capture.zip
- OBS-Studio-32.1.2-Sources.tar.gz

请从 GitHub Releases 获取，并核对 SHA256。