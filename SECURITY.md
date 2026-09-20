# Security Policy

## Supported versions

当前维护的发布线为 `0.14.x`。旧版本和本地未打包快照不承诺安全更新。

## 报告安全漏洞

请不要在公开 issue、聊天记录或邀请链接中披露未修复漏洞。

请通过以下私密渠道联系维护者 D4Y0 / Roomcast：

- 邮箱：[2106841308@qq.com](mailto:2106841308@qq.com)
- QQ：2106841308

请勿在公开评论中发布未修复漏洞或邀请密钥。报告时请提供：

- 受影响版本；
- 复现步骤；
- 影响范围；
- 是否涉及远程加入、媒体链路、聊天图片、Electron 主进程或 TURN/Worker。

维护者确认前，请勿公开利用细节。

## 安全边界与约束

- 桌面本地服务默认且应保持 `127.0.0.1` loopback 绑定；不要无理由设置 `HOST=0.0.0.0`。
- 本机网页和 Electron 渲染进程通过 loopback 与本机服务通信。
- 远程 P2P 加入以 `roomcast://join/...?secret=...` 中的高熵 invite secret 为主凭据；房间弱密码不能替代 invite secret。
- VDO.Ninja 仅作为 direct fallback；VDO 自带 TURN、forceTURN、autoRelay 和自动恢复必须保持关闭。
- Roomcast TURN 是 direct race exhausted 后的最终兜底；TURN 媒体保持 relay-only。
- TURN Worker access key 属于长期密钥，由 Electron 主进程使用 `safeStorage` 保存，不得进入邀请、renderer 状态或普通日志。
- 聊天图片仅允许 JPEG、PNG、WebP、GIF。
- 图片接收端校验 magic bytes、尺寸上限与总缓存上限，并回收 ObjectURL。
- Electron 正式包启用最小 fuses：禁用 RunAsNode、NODE_OPTIONS、Node CLI inspect，启用 Cookie 加密、ASAR 完整性校验和 only-load-app-from-asar。
- 本地服务已设置 CSP、`X-Content-Type-Options`、`Referrer-Policy` 等响应头。