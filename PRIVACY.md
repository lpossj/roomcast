# Privacy

Roomcast 是本地运行的 Windows Electron 屏幕共享与文字聊天程序。当前源码不包含集中式聊天内容上传、后台私聊审查或 D4Y0 内容服务器。

## 数据处理范围

- 房间状态、文字聊天和图片元数据只保存在房间服务的内存中；房间结束或房主应用关闭后释放，不写入数据库。
- 屏幕媒体通过 WebRTC DTLS-SRTP 在成员之间传输。
- VDO.Ninja direct lane 关闭其 TURN / autoRelay；仅在 Roomcast direct race exhausted 后，才可能使用 Roomcast 配置的 TURN relay-only。
- 配置 TURN 时，TURN 服务商可能看到连接元数据、IP 和加密媒体流量，但不应看到聊天文字或本地文件。
- 聊天图片由发送端切块，经房间链路转发；图片内容不会由 Roomcast 中央服务持久化。
- 接收端图片只以内存 ObjectURL 形式缓存，受限回收，不在 Roomcast 内写入长期图片缓存目录。
- 可选 TURN Worker 的长期 access key 只保存在 Electron 主进程，并通过 `safeStorage` 保护。
- 桌面端在打开"分享房间"时会启动一个临时的公网 HTTPS 网页入口（Cloudflare Quick Tunnel），把打包后的静态页面发布出去，并在离开房间或退出应用时关闭。该入口只提供页面与静态资源，不开放桌面本地 API、Socket.IO、音频捕获或管理接口；邀请密钥放在 URL 片段（`#…`）中，片段不会随请求发送给 Cloudflare 或任何服务器。任何拿到该地址的人都能加载页面，因此该地址等同于入房凭据。详见下方"第三方网络服务"。

## 本地诊断

房间内本地统计只允许白名单字段，例如丢包、码率、帧率、RTT、NACK/RTX、availableOutgoingBitrate 等，不记录 peer 身份、SDP 或 ICE 地址。

当前源码未包含集中式遥测或分析上报。若未来增加，必须同步更新本文档和用户授权边界。

## 用户责任

邀请链接、房间号、临时 TURN 凭据和聊天内容只应发送给实际房间成员。不要将长期 TURN Worker access key 放入邀请、截图、日志或公开仓库。

## 第三方网络服务

Roomcast 自身不运营中心化聊天或媒体存储服务，但默认可能使用以下第三方网络服务：

- Cloudflare Quick Tunnel（`trycloudflare.com`，由随包内置的 `cloudflared` 2026.9.2 建立）：只用于桌面端"分享房间"时临时发布静态网页入口。Cloudflare 会终结这段 TLS，能看到页面请求、请求时间与访问者 IP，并可能按其自身策略记录这些元数据；它不会收到邀请密钥（保存在 URL 片段中）。房间结束或退出应用后该入口关闭，地址也会失效。
- GitHub 公开发布接口（`api.github.com`）：桌面端"设置 → 关于"的更新检查会请求该接口获取版本号、更新说明与产物列表。请求不携带任何设备标识、房间信息或使用数据，但 GitHub 能看到发起请求的 IP 与时间。该检查默认开启，可在"设置 → 关于 → 启动时自动检查更新"关闭；关闭后不会发起任何更新相关请求。更新包只从发布页提供的地址下载，并用发布页的 `SHA256.txt` 校验。
- PeerJS 公共信令服务：未配置 PEER_SERVER_URL 时，P2P 连接控制元数据和 ICE 信息可能经过 PeerJS 公共云。
- VDO.Ninja：VDO direct fallback 可能连接 wss://wss.vdo.ninja。
- Cloudflare TURN 或你自行配置的 TURN 服务：只有 direct race exhausted 后才可能使用；TURN 服务商可能看到连接元数据、IP 和加密媒体流量，但不应看到聊天文字或本地文件。

这些第三方服务有自己的隐私政策、日志保留和可用性策略。你可以通过自建 PeerJS 和 TURN、或在网络策略中限制相关域名，降低对公共服务的依赖。不使用网页入口就不会建立 Quick Tunnel。

详见 docs/自建信令.md。
