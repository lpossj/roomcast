# Roomcast 0.14.4-beta.2 本地候选包

本轮范围：保持 Roomcast 采集、房间和媒体架构，先做安全加固并验证，再诊断视频并修正已证实的策略误判路径；按追加要求启用网页建房、按实际能力提供摄像头/屏幕共享并清理无用入口。仅本地修改和打包，没有 push、tag、Release 或线上网页部署。逐步实际时间见 [当前时间戳](时间戳记录/安全加固与动态画质-20260927.md)。

## 历史待办与既有实现

- 旧 beta.1 发布记录缺最后公开状态；本轮只读 API 证实其已于 2026-09-27 11:08:40 +08:00 公开，并追加收尾，保留原先未提交记录。
- 原先暂缓的邀请撤销属于本轮要求，现已实现。代码签名、Windows Job Objects、共享编码源和真实公网完整矩阵仍是后续事项，没有用历史测试充当本轮结果。
- 已有 OBS 固定 FPS、canvas.captureStream(0)、requestFrame()、motion 提示；已有 sender maxBitrate/maxFramerate/scale/优先级/maintain-resolution；已有每 PeerConnection 的有界 stats 环。本轮复用这些实现。
- 主窗、更新窗安全 flags、浮窗继承限制、同源主帧 IPC 检查、loopback token、更新 SHA-256、fragment 清理和 Worker 主进程密钥存储已有实现，不重复创建安全框架。

## 安全结果

| 项目 | 原先问题与本轮改动 | 边界和剩余风险 |
| --- | --- | --- |
| OBS UAC / DLL | 缺口确实存在：用户可写 runtime 的 DLL 只检查存在，管理员直接复制/加载；管理员 .ps1 也放在用户可写目录。现在从固定内容提交 EncodedCommand，管理员侧固定官方两个 DLL 哈希，源、复制后目标均验证；读取源和目标时持有禁止写/删共享的文件句柄，目标保持锁定至 regsvr32 完成 | 不是只相信普通进程 verified=true。实际 UAC 新注册没有运行；本机已有摄像头的桥接实测通过。管理员取消路径保留 |
| 安装目录与路径 | 目标固定 Program Files/Roomcast/obs-virtualcam/32.1.2，管理员根据系统 SpecialFolder 再次校验。目录仅 Administrators/System 可写、Users 可读；每级源/目标祖先拒绝 reparse。旧目标移除后 CreateNew，避免继承旧文件 ACL/硬链接 | symlink/junction 和目标替换由 Windows helper 行为测试覆盖；未引入驱动。原有有效外部 OBS 注册继续保留 |
| 环境覆盖 | 正式包已有 bundle override 禁用，runtime override 原先遗漏；现在两项同时受 allowBundleOverride 控制，main 中仍为 !app.isPackaged | 开发模式保留覆盖。管理员目标与 expected hash 不从环境/marker/renderer 取值 |
| Kick / credential | 原先只断开成员，旧邀请可立即再次认证。现在踢人时房主收到服务端撤销事件，轮换 inviteSecret；被踢连接、未认证和已认证但未入房的旧授权连接关闭。仅其他已入房连接收到新密钥，继续共享/聊天；迟到认证和入房检查旧值失效 | 当前没有不可伪造的成员独立邀请，采用房间级轮换；**所有旧邀请均失效**。合法成员需使用新邀请。新 Viewer 更新内存密钥和邀请配置，迁移携带新密钥，armed payload 同步更新 |
| P2P auth | 已有随机 32 字节 nonce、v2/room/mode HMAC 和 WebCrypto verify；新增 Host role domain + Viewer 随机 nonce 的 Host proof，Viewer 验证前不处理房间/控制回包。挑战只消费一次、Host proof 只验证一次；错误关闭 | v2 Viewer proof 格式保留。新 Viewer 要求支持 Host proof 的 Host；旧客户端作为 Host 不满足此要求。没有 DTLS/channel binding，恶意信令双连接实时转发 HMAC 的 MITM 仍未完全解决 |
| Pre-auth DoS | 仍保留 6 个槽、25 秒 ICE、8 秒打开后认证，避免慢网络误杀；新增重复未认证 peer 拒绝、失败 3 秒冷却（128 项有界）、关闭时立刻释放槽/监听/等待 | 可缓解重复 peer 和失败重试；更换 peer ID 的分布式槽占用仍不能完全防住，不声称 endpoint 已不可预测 |
| Electron / IPC / shell | 原 flags/窗口所有权/mainFrame/trusted origin 及固定 action allowlist 保留；OBS 的管理员脚本不再从可替换临时文件执行，regsvr32 使用系统路径和参数 | 不新增任意 shell/可执行文件/文件读写 IPC。未输出邀请、凭据、token、proof；未新增秘密日志 |
| Update | checksum 和用户确认安装保留；构建仍 unsigned | SHA-256 能发现损坏/与校验文件不符，不能防发布渠道同时替换程序和校验文件。DLL 哈希修复解决低权限程序篡改 OBS runtime 后诱导管理员加载的问题，不等价完整发布者身份认证 |
| Web / TURN | fragment 读取后 replaceState 清除、仅 sessionStorage；CSP 无 unsafe-eval，静态 route 与本地服务分离。Worker 长期 key 仍在 Electron 主进程 safeStorage，临时凭据 TTL 不变 | 线上 Viewer 目前仍 beta.1。本轮新静态产物可另行部署；旧 Viewer 留在新 Host 仍可观看，但不会消费密钥通知，重连需新邀请；旧 Viewer 接管为 Host 后不能提供新客户端要求的 Host proof。应同步更新网页和桌面再做跨版本移交。不改 TURN 取用/刷新，不增加中继不可用提示。平台级限流尚需部署配置 |

官方 OBS 32.1.2 x64 ZIP API 摘要为 `8d97e4563bd8d22d03e63042aa7dccede1d555c9bd35ce8a9e5019b0d0201bf6`。仅从官方 HTTPS 资产读取 ZIP 目录及两个 DLL，共 561271 字节；与本机模块和编译常量相同：

- x86：`9fc2de9d69e33138cb3b00c85f4461f6070aeaa1a3b10e7fd13aa6c184646150`
- x64：`008f808f8f4306ef9ec2cac4d22745ac063686e47d3c24eda16fce6da1197c89`

两模块 PE imports 仅 gdiplus、KERNEL32、SHELL32、ole32、ADVAPI32 系统 DLL。打包前严格检查两个固定哈希，不信任 runtime marker。

依据：[Microsoft FileShare](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare)、[W3C WebRTC Stats](https://www.w3.org/TR/webrtc-stats/)、[OBS 32.1.2 官方发布](https://github.com/obsproject/obs-studio/releases/tag/32.1.2)。

## 视频结论及十九项边界

| 要求 | 结果 |
| --- | --- |
| 最终根因 | **用户真实场景的最终根因尚未知**。已确认 policy 有误判放大通路；本机本轮未复现用户严重模糊，因此不称已彻底解决 |
| policy 是否参与 | 模拟明确的 bandwidth-only 信号时参与；真实本地 A/B 两轮始终 tier0，没有主动降档 |
| 修改前降档 | 1 秒轮询；bandwidth、低可用估计、loss>=5% 或 send delay>=100ms 任一连续2个坏样本即降档 |
| 修改后降档 | 需 loss>=5% 或 send delay>=100ms，或 bandwidth + 低可用估计 + RTT>=300ms 的交叉证据。单独 bandwidth 或配置上限高于 BWE 不触发；仍需连续2个坏样本 |
| 修改前恢复 | 连续8个健康样本且距上次变化10秒；要求下一档预算可用、低 loss/RTT/send delay |
| 修改后恢复 | 保留原恢复逻辑；本轮缺真实弱网恢复数据，不任意改8→3或宣称缩短了真实恢复时间。误降档不发生时也不会额外等待这段冷却 |
| 与 Chromium 协调 | Chromium 继续负责瞬时 encoder/BWE 和拥塞控制；Roomcast 仅在网络证据支持下调整。maxBitrate 仍是上限，无固定 CBR/padding；参数只在变化时写入当前 getParameters |
| Piik 参考 | 只读固定 commit `59d21702fe127dd672c62dca5823d0cec9fb19b2` 的 encoding output/producer，参考授权可撤销思想；没有借用视频代码 |
| 未采用 Piik | 没有移植 encoding pool、producer、output、整套 grant/generation/房间架构 |
| carrier | 未加入 |
| 不加入原因 | 当前数据不足证明其必要；Piik 方案结合编码帧输出架构与 detail 提示，不能直接搬入 Roomcast |
| SDP | 未修改 |
| codec | 未修改；本地协商实测 VP8，其他环境协商结果不作推定 |
| OBS | 保留主采集/Virtual Camera/固定 FPS；仅管理员注册信任与正式路径覆盖修复 |
| 网络架构 | 未修改。当前实际源码的原有媒体车道、ICE 配置和 TURN 取用原样保留，不按旧提示词重建路线 |
| 多 Viewer | 每 pc stats、tier、计数、timer 保持独立；实际双 pc A/B 和回归覆盖隔离 |
| P2P / TURN | 本机实际 host candidate pair WebRTC 与 OBS bridge 通过；TURN 控制/凭据策略与网络门禁覆盖。公网 IPv6/IPv4/TURN UDP/TCP/TLS 不是本轮真机通过结果 |
| 模糊时长前后 | 用户真机没有可用的前后测量。模拟：旧策略3秒降1080p30、5秒720p60、7秒720p30，17秒才回720p60；新策略同信号始终1080p60。不得将模拟结果写成真实收益 |
| CPU/GPU/带宽 | 视频策略没有新 carrier、额外轨道或 monitor；实际新策略 A/B 1080p 59~61FPS、QP约39~45、码率约8Mbps。没有完整 CPU/GPU 对照数据，不能宣称零开销或明显改善 |

诊断新增累计 qpSum/totalEncodeTime 的窗口差分、codec MIME、maxBitrate/maxFramerate、压力信号与计数。首样本、累计回退和字段缺失返回 null，不使用绝对 qpSum 判断清晰度。仍是原先最多20连接×120样本的本地内存环，无自动上传。

## 本轮实际验证和未验证范围

- 安全定向初次85项中84通过、1个测试初值误写失败；修正后认证21/21，通过后安全全量234项中233通过、0失败、1个旧归档条件项跳过。最终认证/迁移33/33，新增踢出后浏览器内存密钥更新和移交。
- Windows helper 使用不可执行的 benign 文本：正常哈希、篡改、marker 不可信、错误哈希、junction、目标替换和目标写删锁通过。没有执行恶意载荷，也没有触发真实管理员注册。
- 实际 OBS→Virtual Camera→Electron→WebRTC 1080p60：OBS约60 FPS，source/encoder/decoder约60 FPS，render/output skip为0。首次检查启动被 ELECTRON_RUN_AS_NODE 影响，失败已记录；清除该变量后通过。
- 原/新策略各一次真实 Chromium 双 pc A/B：静止30秒、运动14秒；26项视频定向回归通过。两轮都未复现 policy 降档，不能给出用户模糊改善结论。
- 用户曾反馈 Electron 进程号码报错，但没有截图/原文；不能将其等同检查环境错误，也不能宣称已定根因。最终新包验证结果另记时间戳。
- 最终全量、生产构建和打包结果在当前时间戳逐步追加；本文不提前写未发生的成功。

Worker 平台建议：在 Cloudflare 对现有 POST `/` 凭据接口按来源 IP 设置平台限流，并保留 Bearer 鉴权；仅作为部署建议，本轮没有改 credential issuance、TTL/CORS、取用方式或部署 Worker。长期 key 可按已有 secrets 配置轮换。

## 修改文件与未改模块

| 文件 | 修改内容与原因 |
| --- | --- |
| electron/obs-virtualcam-trust.cjs | 固定可信值、Windows hash/file lock/reparse/ACL helper；补管理员加载边界 |
| electron/obs-virtualcam-registration.cjs | 管理员固定内容执行、受保护目标、源目标锁定验证、可信系统注册进程；阻止可替换脚本/DLL |
| electron/obs-fixed-fps.cjs | 正式 runtime override 限制；封遗漏路径 |
| scripts/before-pack.cjs | 双 DLL 固定哈希打包门禁；拒绝篡改 bundle |
| server/rooms.mjs | Kick 撤销通知、被踢立即拒绝成员操作 |
| src/p2p-auth.js | role-separated、Viewer nonce-bound Host proof 和协议验证 |
| src/p2p.js | 旧授权撤销/合法成员新密钥/迁移同步、Host proof 验证、重复 peer 与失败冷却、监听清理 |
| src/useRoom.js | 邀请配置跟随当前新密钥，供合法成员重连/分享 |
| src/p2p-video-policy.js | 网络证据降档与已有诊断补充，避免短时编码状态误判 |
| scripts/check-p2p-video-ab.cjs | 独立本地真实 Chromium 开启/暂停策略对照，不加入生产开关 |
| src/App.jsx、src/browser-capabilities.js、src/browser-capture.js | 网页建房，按安全上下文/API/策略/已知拒绝权限显示采集；摄像头直接请求浏览器权限，归一旧声音偏好 |
| src/lib.js、electron/main.cjs、electron/preload.cjs | 删除无调用的本地媒体包装和 OBS 状态查询；网页屏幕采用原始轨道，桌面固定 cadence 保留 |
| scripts/prepare-viewer-site.mjs、verify-browser-host.mjs、verify-web-invite-entry.mjs、tests/browser-capture.test.mjs、room-cancel.test.mjs、README.md | 可部署静态包、浏览器联机验证与新需求断言；修正测试源码截取对CRLF的隐含依赖 |
| tests/obs-trust.test.mjs、p2p-auth.test.mjs、p2p-migration.test.mjs、p2p-video-policy.test.mjs | 对应安全行为、轮换/移交、策略误判、诊断差分回归 |
| package.json、package-lock.json、CHANGELOG.md、本报告、当前时间戳、旧发布记录 | beta.2 输入和明确证据/未知边界，保留旧记录 |

OBS 主采集、IPv6/IPv4/既有 TURN 车道、房间主要协议、聊天逻辑、音频、播放器和 codec negotiation 未重写。房间新增一个内部撤销通知与定向密钥通知；协议仍为 v2 的 Viewer proof，增强 Host 验证存在上述跨版本兼容边界。没有复制 Piik 架构。

## 网页功能和接口清理

- 网页创建复用现有 `createBrowserRoomService` 和同一房间规则。静态站点无需新增常驻服务器；PeerJS 控制信令、现有媒体线路和网络限制仍然存在。网页房主关闭页面或后台挂起可能中断房间，界面提示保持前台。
- 摄像头用 `getUserMedia`，优先前/后置选项为 ideal，不承诺设备一定有两枚摄像头；质量/帧率受硬件和浏览器能力限制。摄像头声音仅加入麦克风。屏幕用 `getDisplayMedia`，由浏览器选择来源和可允许的声音。
- 不按手机型号假设屏幕 API。安全上下文、Permissions Policy、可用 API 决定入口；查询到摄像头 denied 时隐藏入口，权限变动可恢复。Safari 若不支持权限查询，按 API/策略显示，实际点击时由系统授权；拒绝或无设备显示具体失败并清理采集。
- 网页删除“所选程序声音”和“排除所选程序”，旧保存模式自动归一；摄像头不显示系统声音。Windows 对应功能仍有调用，保留。麦克风设置、观看音量、浮窗、聊天沿用原逻辑。
- 154 个源码/脚本/测试文件的接口引用审查删除 `lib.localAction/tokenPromise`、`obsCaptureStatus` 的 preload/main 对和未使用 `EntryModal.setServer`。独立本地 HTTP 管理入口、OBS engine.status、脚本调用的注册辅助没有删除。本轮确认旧onBeforeClose/closeReady均无主进程handler，删除并把浮窗安全工具改为验证接口不再暴露；正常退出/更新等待保留。纯写OBS阶段和两个退役Worker公链export也已清理。扫描不等于动态调用的形式化证明。
- 白名单网页包为 `release/Roomcast-0.14.4-beta.2-WebViewer/`，含 index/assets、404/version/_headers；不部署 updater/桌面 API。线上主域已于2026-09-27更新到beta.2，实际共享弹窗确认无两项原生声音按钮；主脚本SHA256与本地包一致。

验证：能力/权限/旧偏好/清理定向8/8；HTTPS模型站点使用真实 Chromium 假摄像头与真实 WebRTC，通过网页建房、邀请、双向认证加入、datachannel聊天、观看端1920×1080解码、停止后的轨道释放/播放器移除及拒绝权限入口隐藏，0 pageerror。另有浏览器初始房主移交回归通过。最终全量245项中243通过、1因旧测试行尾拼接失败、1旧条件跳过；修正仅测试拼接换行后相关8项通过，合并同代码有效结果为244通过/0待处理失败/1跳过。最终生产构建及网络架构自检通过。

没有手机真机、真实摄像头硬件或公网连通验证，不将假设备测试称为真机上线保证。接口依据：[W3C Screen Capture](https://www.w3.org/TR/screen-capture/)、[WebKit WebRTC](https://webkit.org/blog/7763/a-closer-look-into-webrtc/)。

## 2026-09-27 同版本重新交付

版本仍为0.14.4-beta.2。本轮依据用户的线上截图、目录清理和安全审查要求重新生成Windows包，旧beta.2交付保留于release/重打包前-beta2-20260927/；请使用release根目录的新包。

- Windows.exe：136953194字节，SHA256 20124F8E8DC75F14C755099C090332A4ED5866087F691F2A1710EB102859937B。
- Windows.zip：203935472字节，SHA256 A926657C08912314E66E3375977CA84E62236255BA58D1898D2E25963CF80DB2。
- release/Roomcast-0.14.4-beta.2-WebViewer/及同名ZIP：实际部署到https://roomcast-2dy.pages.dev，beta.2与完整静态安全响应头生效，桌面API路径404。线上建房/聊天/假摄像头1080p观看、停止清理、权限门控和两项音频按钮缺席验证通过，0pageerror；测试隔离了PeerJS信令，不是公网媒体/真机质量保证。
- 修复Worker旧key跨域复用、query邀请密钥残留、ZIP解压资源限额、清理脚本既存claim误删和CI输入模板注入；网页无Windows强调色假按钮及不支持setSinkId时的扬声器切换。详情见[代码安全与清理审查](代码安全与清理审查-20260927.md)。
- 当前全量249项248通过/0失败/1历史ZIP不存在跳过；最后删除退役公链helper后相关4项再次通过，其他未受影响检查沿用；生产构建、架构、许可证通过。最终EXE实际隔离启动、版本/资源检查通过，28个electron/server/dist文件与成品asar逐字节相同；新ZIP真实读取成功（2099条目），asar及两枚vcam DLL与成品unpacked摘要一致。
- 项目和父级迁移备份仅删除9处与保留ZIP逐文件SHA256匹配且无占用的重复解压副本，释放3818600287字节（3.56GiB）；日志、源码、Git、个人配置、唯一压缩包、其他项目保留，恢复说明与旧失败记录保留。旧win-unpacked与ZIP未完全匹配，归档保留未删。

仍存在DTLS通道未绑定的主动代理风险、未独立签名的更新渠道信任、持TURN key滥用等边界。真实UAC新注册、手机真机/公网网络和第三方原生二进制内部内存安全未在本轮验证。未知Electron进程号码报错没有原文，当前启动未复现，不能宣称根因已修复。

已完成静态网页部署；没有push、tag、GitHub Release或Worker部署。源码ZIP及SHA256清单以release当前实际文件为准；本轮逐步骤实际时间和失败原因见[时间戳记录](时间戳记录/网页接口与目录清理-20260927.md)。
