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
- 固定网页入口只托管公开构建文件，不将桌面本地 API、Socket.IO、音频捕获或管理接口暴露出去。静态页面通过 CSP meta 限制脚本和资源，并拒绝在第三方 iframe 中渲染房间控件；本机服务继续使用原有安全响应头。
- 邀请密钥保存在网页链接的 URL 片段（`#…`）中，片段不会随 HTTP 请求发送。完整邀请等同于入房凭据，只应发给预期成员；固定站点地址本身不授予入房权限。
- 固定观看站点可公开加载，在房间结束后仍存在；房间结束后不能凭旧链接加入已结束的房间。分享者和观看者无需网站账号。
- 浏览器房主在页面内运行与桌面端相同的房间规则（`server/rooms.mjs`）。远端访客只能通过 P2P 事件白名单访问房间服务，`room:migration-create`、`room:migration-commit`、`room:migration-abort` 等本机特权事件不在白名单内，不会被远端触达。
- 更新机制不会静默替换正在运行的程序：桌面端只检查版本并提示，下载的安装包必须通过发布页 `SHA256.txt` 校验才会写入下载目录，校验不通过直接失败。下载地址与校验地址由主进程持有（来自它自己的那次检查结果），渲染进程只能按名称选择产物，不能指定 URL；只有下载目录中的文件允许"打开文件位置"。
- 当前构建未签名，更新包同样未签名。自动执行未签名产物属于安全降级，因此本版刻意不做静默更新。

## GitHub 私密漏洞报告

如果仓库公开，优先使用 GitHub Security Advisories 私密报告入口：

- https://github.com/lpossj/roomcast/security/advisories/new

如果暂时无法使用 GitHub 私密报告，再通过上方邮箱或 QQ 联系。不要在公开 issue 中披露未修复漏洞、邀请密钥或 TURN access key。
