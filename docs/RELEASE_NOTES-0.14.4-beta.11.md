# Roomcast 0.14.4-beta.11 本地交付说明

此版本继续本地 beta.10，保留 EasyTier 集成、UDP 优先及此前播放器/语音恢复修复。没有用 GitHub 旧代码覆盖本地成果。实际时间与失败记录见 [本轮时间戳](时间戳记录/2026-10-13-连接恢复与媒体体验源码审查.md)。

## 本次实际改动

- **画质恢复与降档**：原网络策略遇到相邻同分辨率 30/60fps 档位、且 CPU 帧率控制已将实际帧率压到 30fps 时，因编码参数未变化而不更新逻辑档位，可能一直卡在该档，阻挡后续分辨率升降。现在无须写编码参数时也提交逻辑档位，沿用原冷却、拥塞和恢复探升规则；`setParameters` 失败仍不提交。不提高默认码率，不强推高清。
- **入房等待**：认证入房成功后，聊天历史改为后台加载，失败最多额外重试一次，仍失败则只提示聊天历史失败，不再退出已建立的房间。离房/切房后的旧响应不会更新新房间。新建房间继续跳过空历史。
- **首帧协商**：先发送屏幕 offer，候选沿原可靠有序通道立即跟随，无须等待 offer ACK 才发送。仍处理 ACK 拒绝、取消、旧会话与成员授权，保留所有回退路线。
- **普通连接 STUN**：共享 `server/stun-servers.mjs`，将腾讯、小米作为候选并保留 Cloudflare；VDO 通过固定 SDK 1.6.1 支持的 `stunServers` 接入同一列表。没有顺序探测节点或等待所有节点成功的应用层门槛。

## 入口与 STUN 审查

| 路径 | 源码事实与本轮处理 |
| --- | --- |
| 房间信令 | 继续 PeerJS 默认入口或既有 `PEER_SERVER_URL`，邀请的 `signal` 值仍经校验并用于加入、再次分享。没有新增信令后台或套用 MCTier 信令服务。STUN 无法修复信令本身不可达。 |
| 创建准备 | 原凭据与本机 socket 并行、创建面板预连接实际信令域名、跳过空历史均保留。原 `create-prepare`、`create-local`、`create-signal` 时间记录保留；没有本轮实测耗时样本。 |
| 普通房间控制 | 复用 `DEFAULT_STUN_ICE`，腾讯/小米/Cloudflare；原可选 TURN 取得、授权和启用规则不变。 |
| 原生/OBS/网页屏幕 | 同一普通媒体 ICE 默认值；采集与编码入口不变。TURN 回退继续只取 `turnIceServers`。 |
| 房间语音 | 继续采用房间的 `controlIceServers`，缺省继承上述共享默认值，显式配置不追加 STUN。 |
| VDO | 信令仍为 `wss://wss.vdo.ninja`；SDK 默认 Google+Cloudflare 改为上述三项；`turnServers:false`、`forceTURN:false`、`autoRelay:false`、`autoRecover:false` 保留。SDK 候选按事件分批发送，不等待收集完成。 |
| 校园专用 WebRTC | 准备完成后配置仍被替换为原专用 `iceServer`、`relay` 策略；不混入公网 STUN。普通 WebRTC 的候选过滤与既有独立授权保留。 |
| EasyTier 底层 | 固定源码 `8428a89d2dabc94c97d370ec607c6ca142473626` 中默认 UDP 列表已有 `stun.easytier.cn`、小米、哔哩哔哩、芒果，`global_ctx` 将配置或默认值传给采集器。本轮没有修改其 STUN、节点、MTU、核心或配置规则。仅确认源码接线，运行可达性未确认。 |

候选地址依据为 [MCTier ScreenShareService 固定提交](https://github.com/pmh1314520/MCTier/blob/7bf1dd361c2e854a89910c1116af1e7acfef3ba8/src/services/screenShare/ScreenShareService.ts) 中的 `stun:stun.qq.com:3478` 和 `stun:stun.miwifi.com:3478`。这证明该项目使用这些地址，不代表服务商承诺公共服务、当前可达或永久免费。只参考地址，没有复制其架构或代码。

候选发送时序参考 [RFC 8838 Trickle ICE](https://www.rfc-editor.org/rfc/rfc8838.html)，并核对当前 PeerJS 可靠有序 DataChannel、房间信令逐条授权和接收方候选队列。

## 边界与未确认

- 未运行任何自动化测试、烟雾测试、独立验证脚本或网络可达性探测，未添加/删除测试；构建打包不等于功能验收。
- 未确认国内/校园网入房成功率、腾讯/小米 STUN 可达性、首帧和端到端延迟、真实画质恢复、语音听感。源码问题不能直接认定为此前具体现场故障的根因。
- 没有实测数据支撑更换信令入口、EasyTier 公共节点、MTU或调整编码阈值，这些项保留。可继续依据人工导出的原阶段耗时和画面统计定位。
- 没有 push、tag、Release 或部署。电脑/手机网页共用本地静态包，线上站点没有同步更新；浏览器未新增桌面 EasyTier 能力。
- Worker、公网 TURN、凭据和授权规则、OBS/原生采集、系统声音、语音及现有回退保留；未改系统代理、DNS、默认路由或开放管理接口。

## 回滚与产物

修改前备份：`runtime/backup-20261013-connection-quality-125226/`，保留 beta.10 本地源码、dist、package/lock 和 Git 差异。逐文件恢复对应模块即可独立撤回；无需重置整个工作区。beta.10 成品保留。

仅恢复旧 STUN：将 `server/stun-servers.mjs` 列表恢复为单项 Cloudflare；VDO 如需完全恢复 SDK 原默认 Google+Cloudflare，再移除 `src/transports/vdo-transport.js` 的 `stunServers` 参数及对应导入，重新构建打包。其他画质与连接修复可保留。

预定产物（实际完成结果追加在下方）：

- `release/0.14.4-beta.11/Roomcast-0.14.4-beta.11.exe`
- `release/0.14.4-beta.11/Roomcast-0.14.4-beta.11.zip`
- `release/0.14.4-beta.11/Roomcast-0.14.4-beta.11-EasyTier-sources.zip`（原合规源码附件）
- `release/Roomcast-0.14.4-beta.11-WebViewer/`（本地静态网页包，未部署）

## 人工验收（最多五项）

1. 用新 EXE 在普通国内网络创建/加入有聊天历史的房间，再用自定义信令邀请及成员转发邀请加入；确认先进入房间、历史随后出现。慢网下导出原创建/入房阶段耗时，检查取消/切房后不串入旧历史。
2. 两台机器分别用原生和 OBS 分享文字与动态画面；人为制造负载/带宽波动再恢复，观察实际分辨率、fps、发送队列与档位能否恢复，是否长期停在低清，并与 beta.10 对照。
3. 在你的普通网络和校园网手动比较首帧时间及 ICE 路线；手动确认腾讯/小米/Cloudflare 候选可达性，单项失败时其他可用候选能否继续连接，不将配置存在当作可用。
4. 普通直连失败场景下观察原 VDO、桌面 EasyTier、公网 TURN 回退，确认专用校园和 TURN-only 不混入公网 STUN；保持系统声音及语音播放，断网后恢复，观察断音和画面恢复。
5. 在本地网页包上手动确认电脑/手机浏览器的加入、观看、声音选择与退出；打开已有线上站点时注意其仍是未部署前的版本。

实际结果（）：前端构建、网页打包和Windows EXE/ZIP封装均退出0，EXE 142341067字节、ZIP 212689297字节、EasyTier源码附件175210786字节。没有功能验收。用户随后强调校园网优先，继续补充为beta.12，beta.11保留供回滚/对照。
