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

## 本地诊断

房间内本地统计只允许白名单字段，例如丢包、码率、帧率、RTT、NACK/RTX、availableOutgoingBitrate 等，不记录 peer 身份、SDP 或 ICE 地址。

当前源码未包含集中式遥测或分析上报。若未来增加，必须同步更新本文档和用户授权边界。

## 用户责任

邀请链接、房间号、临时 TURN 凭据和聊天内容只应发送给实际房间成员。不要将长期 TURN Worker access key 放入邀请、截图、日志或公开仓库。