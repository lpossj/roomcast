# Roomcast 0.14.4-beta.8 Beta

Windows 10/11 x64。客户端与[网页版](https://roomcast-2dy.pages.dev/)同步更新。

## 变更

- 成员栏、共享区、聊天栏可通过两条分隔边界调节宽度，最左图标栏固定；保存宽度，支持方向键调节、双击恢复。手机继续使用抽屉。
- 简化设置与共享界面，移除重复说明和口号；长隐私、许可与更新说明折叠保留。
- 网页切换标签或进入后台不再定时离房；页面进入往返缓存不主动离房，返回后继续聊天。后台标签标题显示共享或聊天状态；不添加系统通知。
- 麦克风耳返直接通过互动音频处理图输出，减少媒体元素缓冲；房间语音采用单声道、48kHz 和低延迟采集偏好，支持的浏览器使用 20ms 接收缓冲目标。保留回声消除、降噪和自适应缓冲；共享音量与成员声音仍独立。
- 点击左上 logo 切换日间/夜间主题并保存。支持标准接口时，680ms 渐变波纹从按钮展开、靠近边缘减速；logo 明暗随主题变化，按钮中心有短彩带和“啵”声。连点合并，窗口变化或切后台会清理动画；减少动态模式跳过动画，旧接口保留正常主题切换。
- 保留 beta.7 的自定义头像、完整说话绿圈、紧凑成员音量浮框、分级管理闭麦及自动更新。

## 验证与边界

281 项发布回归、许可、生产构建与网络检查通过。真实双端 WebRTC（假麦克风/摄像头）验证共享中切换主题不更换采集轨道、33 秒页面冻结后仍在房间、返回后聊天及主动离房释放。桌面验证直接耳返实际音频输出、关闭释放和偏好重启。

浏览器按实际能力使用接口：没有标准主题动画接口仍可切换主题；没有采集能力不提供采集入口。普通 iPhone Safari 标签页无法提供常驻系统通知，因此本版取消该功能。操作系统终止页面或切断连接仍会中断共享/房间，网页不能保证后台持续运行。20ms 是浏览器偏好，耳返改善不等于真实设备声学延迟已测量。

各浏览器引擎检查及最终成品验收结果见[状态说明](https://github.com/lpossj/roomcast/blob/main/docs/STATUS.md)。手机默认浏览器、iPhone Safari 真机的后台行为和音频设备尚未完整验收；WebKit 引擎检查不能替代 iOS 硬件实测。

beta.8 高于 beta.7，可由已有更新检查发现。旧 beta.7 与首版 beta.8 的更新器存在以下包内读取错误，本次需关闭旧版后手动换用完整修订包一次。同版本后续修订保持 beta.8，已安装同号版本需要重新下载覆盖。Windows 程序未签名，附件可用 SHA256.txt 核对。

## 2026-10-02 更新器修订（版本仍为 beta.8）

更新执行改为独立原生事务程序，删除 PowerShell 脚本、编码命令与执行策略绕过；直接完成校验、完整暂存、旧版备份、替换、重启和失败恢复。移除 `ENOENT ... app.asar/electron/update-worker.ps1` 的脚本依赖，也移除火绒截图中“利用 PowerShell 执行可疑脚本”对应的更新执行链。未调整安全软件配置。

旧客户端正在执行的更新器无法通过尚未安装的新包自修，因此这次需要手动下载完整 EXE 或 ZIP；ZIP 请解压到新目录运行。安装目录的旧版名称不影响实际版本判断。

已实际克隆并核对 [electron-builder 更新器](https://github.com/electron-userland/electron-builder/tree/44c5265a9260ca6f319f111b5a2ca7e50b0a7cd6/packages/electron-updater)和 [Velopack Windows 更新事务](https://github.com/velopack/velopack/blob/92d6a1c91716729d449034df5c50307dcce39493/src/bins/src/commands/apply_windows_impl.rs)。补齐从最终 ASAR 内加载更新器的回归入口。

## 2026-10-02 界面配色补齐（版本仍为 beta.8）

共享参数、声音选项、预览外框和等待界面补齐日间配色。共享、聊天、导航和播放按钮采用统一主题色，危险操作用浅红色，禁用状态清楚区分；调整卡片、弹窗、输入和分栏边界。聊天输入与容器融合，小窗随主界面同步明暗主题和强调色。网页同步同套样式，保持房间和媒体功能。

实际 Edge 检查共享设置、预览/聊天、390px布局及日夜主题；实际 Electron 验证主预览与小窗控件、主题同步与关闭释放，媒体轨道保持不变。

## 参考实现

低延迟音频审查参考官方 [LiveKit 音频上下文](https://github.com/livekit/client-sdk-js/blob/2cf59e9875cd6382c5ed07de609db3bde8fed9d3/src/room/track/utils.ts)与[逐轨播放延迟接口](https://github.com/livekit/client-sdk-js/blob/2cf59e9875cd6382c5ed07de609db3bde8fed9d3/src/room/track/RemoteTrack.ts)，已核对对应源码；分栏参考 [W3C 分隔器模式](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)，后台处理参考 [浏览器页面生命周期](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)。保持现有 P2P 架构与 TURN 取用方式。
