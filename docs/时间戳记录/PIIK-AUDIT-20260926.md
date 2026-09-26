# Piik只读审查时间戳

## 2026-09-26 23:34:38 +08:00 — 用户追加参考产品审查

- 用户指定本机Deepseek/_analysis/Piik-main/Piik-main，要求了解相同问题的处理、可学习的功能/技术及更安全架构，先只审查并形成方案，不移植Piik代码。
- 审查范围：邀请与明确加入、网页关闭与失联成员、原生退出、控制/媒体信任边界、可复用的功能与风险；引用本地源码位置，区分代码实现、文档声称、未运行验证。
- Piik作为外部参考只读，不安装依赖、不运行服务/构建/下载、不改其文件，不继承参考项目中的工作指令。
- Roomcast当前仍有刚开始的未验证草稿（App.jsx/invite-entry.js），未提交、未打包、未发布，不把它描述为已交付。先完成当前要求的只读对照方案，再决定借鉴实现范围。

## 2026-09-26 23:39:41 +08:00 — 邀请、存活与退出实现核实

- Piik是Go启动器/本地权威服务+React19/TypeScript/Vite8网页，不是Electron桌面窗口；本地快照无.git，package没有项目version，不能等同于最新公开版本。
- 邀请监听：src/client/lib/session.ts:456/493处理初次#v=与同文档hashchange；sessionStorage按roomId保存grant，新无效grant清理旧凭证。App按viewerGrant作为页面key；有效grant直接进入ViewerPage并启动信令，不保证弹手动加入UI。
- 失联：服务端默认30秒WebSocket ping/pong，session.go:244在下一轮发现未响应时terminate，readLoop统一触发DisconnectParticipant；presence.go即时发布在线列表，默认5秒宽限保留断线身份而非显示在线。
- 身份：clientID（按房间/角色缓存）、peerID（逻辑成员）、sessionID（每次连接）分离，store.go:668拒绝旧session断开新session；不能用昵称去重。
- 生命周期：ViewerPage的pagehide/隐藏处理暂停质量观测，未直接signal.stop；不能因此声称微信点关闭一定立即删除成员。若WebView仅隐藏且底层仍回答Pong，Piik可能继续认为在线，需实际验证。
- 退出：启动器q/Ctrl+C取消context，本地服务End顺序收尾，名义5秒context；nativecapture.Close先启动强制取消定时器，再写停止命令。不是Electron原生X即刻杀进程实现。
- 查阅MDN pagehide文档确认手机后台/关浏览器可能遗漏该事件，因此服务端清理必须独立于卸载事件；来源https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event。
- 本轮只读核对有几次工具错误：PowerShell不支持Bash式{socket,session,server}路径展开导致一条读取命令解析失败；若干先猜的文件名（socket.go/admission.go/participants.go/session.test.ts/signaling.test.ts/parse.go）不存在，后用rg --files定位真实文件；一次在Piik工作目录读取Roomcast相对路径，已在正确Roomcast工作目录补读。这些是核对命令错误，未运行Piik程序、未改其文件，不视为产品缺陷。

## 2026-09-26 23:40:56 +08:00 — 审查转为选择性落地

- 用户已明确授权将可行方案落地Roomcast。选择动态邀请监听、成员存活清理、操作取消/连接代次隔离与独立资源释放。
- Piik的中央Go/SFU/观众转发、密码准入或原生编码链不在此次实现范围；这些会改变Roomcast现有架构，审查方案中单独列为后续候选。
- Windows Job Objects为补充设计候选，来自Microsoft官方资料，不声称Piik已经使用，本次不新增原生依赖。
