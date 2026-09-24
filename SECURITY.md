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
- 临时网页入口（"分享房间"里的 Cloudflare Quick Tunnel）只提供打包后的静态页面，只接受 `GET`/`HEAD`，并只服务构建产物白名单；桌面本地 API、Socket.IO、音频捕获和管理接口都不对外开放。
- 邀请密钥保存在网页链接的 URL 片段（`#…`）中，片段不会随 HTTP 请求发送，因此 Cloudflare 与静态入口都拿不到它。该地址本身等同于入房凭据，只应发给预期成员。
- 任何拿到网页入口地址的人都能加载应用界面。入口在离开房间或退出应用时关闭，也可以在"分享房间"之外通过离开房间触发关闭。
- 浏览器房主在页面内运行与桌面端相同的房间规则（`server/rooms.mjs`）。远端访客只能通过 P2P 事件白名单访问房间服务，`room:migration-create`、`room:migration-commit`、`room:migration-abort` 等本机特权事件不在白名单内，不会被远端触达。

## GitHub 私密漏洞报告

如果仓库公开，优先使用 GitHub Security Advisories 私密报告入口：

- https://github.com/lpossj/roomcast/security/advisories/new

如果暂时无法使用 GitHub 私密报告，再通过上方邮箱或 QQ 联系。不要在公开 issue 中披露未修复漏洞、邀请密钥或 TURN access key。
