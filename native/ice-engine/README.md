# Roomcast Windows 原生连接

第四步从第三步候选 `1e5f4f3` 接入桌面客户端。Windows x64 包包含 `runtime/native-ice/RoomcastNativeIce.exe` 和依赖许可。普通 WebRTC 和 VDO 仍先尝试；仅对具备能力的桌面对端使用原生备用。开发环境可通过 `npm run prepare:native-ice` 编译，使用 PATH 中的 Go 或 `ROOMCAST_GO` 指向的 Go。依赖版本见本目录的 go.mod 和 go.sum。

## 房间控制

Electron 主窗口通过受检查的 IPC 使用同一普通权限子进程。每个会话单独准备 UDP socket，STUN、ICE、DTLS 和 SCTP 复用同一个 mux。socket、接口枚举、STUN 解析均使用该会话的 Pion transport.Net。准备开始后异步观测最多三个已有 STUN 地址。ICE 对候选进行实际连通性确认，准备完成表示 socket 已分配。

桌面邀请可以携带 native=1。原生协商通过当前 PeerServer，offer 和 answer 的短时签名绑定到房间、双方信令身份、连接 ID 和 SDP。房主验证请求后才准备该会话。可靠有序 DataChannel 承载 PeerJS 既有二进制房间消息。房主继续做协议 2 的双向鉴权，房间服务决定成员准入。取消、离房和主窗口重载会释放会话。网页沿用普通控制路径。

## 屏幕音画

共享者按本次开播声明原生能力。普通观看路线耗尽后，已登记的观看者可通过现有房间信令单独协商原生媒体。每端有一条对外 Pion 连接及一条限本机收发的 WebRTC 媒体桥。本机候选和对端候选分别交换，Chromium 保留采集轨道、编解码和播放界面。Go 转发 H.264 和 Opus 的 RTP，映射发送者报告中的 SSRC 并保留原始 RTP/NTP 时钟，转送关键帧请求。传输拥塞反馈单独约束本路共享者的视频编码码率。首帧由现有播放器观测。

## 诊断与交接

“设置 → 关于”导出的诊断修订为 `native-step4-20261120`。入房时间线的 `route=native`、`nativeTransports` 的角色和状态、`playback-native` 的开始和首帧完成事件可用于将控制、网络媒体和播放器对齐。控制记录与媒体记录独立；默认使用普通路线的会话可能没有原生记录。导出字段只保留本地会话 ID、阶段及网络计数。

Pion WebRTC v4.2.26 的 [TrackLocalStaticRTP](https://pkg.go.dev/github.com/pion/webrtc/v4@v4.2.26#TrackLocalStaticRTP.WriteRTP) 提供压缩 RTP 转发，拥塞估计使用同版本示例依赖的 Pion GCC。

## Windows 物理网卡直连

用 `Roomcast.exe --physical-direct` 启动独立配置的房主，创建房间后分享手机网页邀请。Windows x64 引擎仅在操作系统标记为物理且已连接的网卡上建立 WebRTC 房间和媒体通道。UDP 按地址和接口索引绑定，TCP 在相应物理地址上监听。此启动方式使用纯直连，适用于当前网页与支持签名原生控制通道的桌面成员。网站和公共信令的 HTTPS 连接仍由系统网络设置管理。

公网 IPv6 需要物理网卡启用 IPv6 并取得可路由的地址，双方还必须能通过 ICE 连通性检查。关闭这个房主即可结束会话。
