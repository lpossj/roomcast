# Roomcast 0.14.1：EXE 使用与异地开房

## 准备

Roomcast 面向 Windows 10/11 x64。便携版包含应用自身运行所需的组件；OBS 固定帧率模式使用 Roomcast 随包携带并固定版本的 OBS Studio 32.1.2 runtime，不依赖用户系统安装的 OBS 版本。

每台电脑首次运行 Roomcast 后，程序会注册 `roomcast://` 链接。首次实际使用 OBS Virtual Camera 时，干净机器可能出现一次 UAC 注册流程。

## 开房和加入

1. 房主点击 **创建房间**，填写昵称、房名和可选密码。
2. 点击 **邀请朋友**，复制完整邀请链接。
3. 好友先运行 Roomcast，再打开邀请链接；若聊天软件不能打开自定义链接，可在 **加入房间** 中粘贴完整邀请。
4. 房主离开时，现有房间迁移逻辑按程序当前规则处理，不要依赖旧 Quick Tunnel 或 MediaMTX 服务。

如果房主为新房间启用了 Cloudflare TURN，邀请中可以携带临时 TURN ICE 凭据。长期 Worker access key 和 Cloudflare API Token 不应进入邀请链接。

## 多人共享

1. 有共享权限的成员点击 **共享屏幕**。
2. 选择 OBS 固定帧率采集或原生采集。
3. 选择显示器/窗口、分辨率、FPS、目标码率以及需要的音频选项。
4. 点击 **开始共享**。

OBS 只是采集层。无论使用 OBS 还是原生采集，媒体网络路径都由 Roomcast 管理：

```text
Roomcast P2P direct (t=0)
                    ↓ 3 秒内未出画 / 提前失败
          VDO.Ninja direct viewer（默认延迟 3000ms）
                    ↓ 两者均未建立可播放画面
               Roomcast TURN relay-only
```

本机预览复用本机正在发布的 MediaStream，不应为了自看重新走公网 P2P、VDO 或 TURN。

## 异地网络

Roomcast 会先在 t=0 立即尝试原生 P2P；VDO.Ninja direct-only viewer 默认延迟 3000ms，P2P 提前明确失败时立即启动。P2P 在 3 秒内出画则不启动 VDO。严格 NAT、校园网或公司网络导致两条直连都失败/耗尽时，才允许进入 Roomcast TURN relay-only。TURN 配置方法见 [Cloudflare TURN 部署](Cloudflare-TURN部署.md)。

旧 Quick Tunnel / cloudflared / MediaMTX 媒体链已经退役，不应作为当前故障排查方案恢复。

## 常见问题

| 情况 | 处理方法 |
| --- | --- |
| 邀请链接打不开 | 先运行 Roomcast，或在“加入房间”中粘贴完整邀请。 |
| P2P 与 VDO 均无法出画 | 检查 TURN 是否已启用并能获取临时 ICE 凭据。 |
| OBS 首次共享失败 | 检查首次 UAC Virtual Camera 注册是否完成，再重新打开共享设置。 |
| 麦克风打不开 | 在 Windows 隐私设置中允许桌面应用访问麦克风。 |
| 画面移动时模糊 | 检查目标码率和共享者上行带宽。 |
| 延迟或卡顿 | 尝试降低分辨率/FPS/码率或减少同时观看/共享路数。 |
| SmartScreen 警告 | 当前未签名构建应核对发布方提供的 SHA-256；正式签名与 EXE metadata 在发布阶段处理。 |

房间密码、邀请链接和临时 TURN 凭据都只应发送给实际房间成员。
