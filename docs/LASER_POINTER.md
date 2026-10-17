# 多人实时激光笔

## 实现与范围

PR #9 的初版只有主播放器内轨迹，缺少共享者桌面与独立小窗；每帧持续重绘、头像颜色冲突、快速移动触发发送限额、权限监听闭包滞后等问题已在本轮源码中处理。

- 同一房间最多十人各用不同颜色，昵称靠近笔尖短暂出现并尽量避让；按住拖动绘制，松开后约 1.25 秒淡出，Esc 退出绘制模式。不同笔画、不同共享目标分开处理。
- 主播放器、元素全屏、现有 Windows 独立小窗及小窗全屏共用 Canvas 引擎，不新增媒体连接。坐标按实际视频内容区归一化，留黑区域不能起笔。
- 房主可控制全房激光笔；房主可管理管理员/成员，管理员仅可管理普通成员。服务端逐包检查权限、共享代次及观看资格；权限随既有房主交接/迁移保存。
- 激光沿既有鉴权控制通道传递，每个绘制表面最多约 20 包/秒、每包最多八点；接收端每成员合计限制 24 包/秒。P2P 不为轨迹分配 RPC 等待项，积压时丢弃临时轨迹，普通控制请求原有限额保持。无轨迹历史、数据库或视频合成。
- Canvas 仅在收到点到最后尾迹消失期间绘制，空闲释放位图。Windows 桌面层仅在远端轨迹到达时创建，约 1.3 秒无新轨迹销毁窗口与几何助手；不常驻轮询、不安装鼠标钩子。
- Windows 层使用透明、不抢焦点、鼠标穿透的 Electron 窗口，并申请捕获排除以避免画面二次出现轨迹。目标由实际成功的 OBS/Integrated 捕获登记；桌面使用真实显示器标识，OBS 窗口使用客户区，窗口几何通过 Win32 事件更新并转为 Electron DIP。
- 无新增 npm 依赖、服务、付费能力或登录要求。Windows 几何助手使用系统 .NET Framework 编译器一次编译至用户缓存，源码随客户端打包；失败时隐藏桌面层，不干扰原采集。原 WebRTC、EasyTier、Worker、TURN 和 OBS 路径保持。

## 成熟实现依据

- [Excalidraw 激光轨迹](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/laser-trails.ts)及 [AnimatedTrail](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/animated-trail.ts)：短寿命轨迹、去重与淡出后停止；Roomcast 直接按消息唤醒，避免常驻逐帧扫描。
- [Excalidraw Portal](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Portal.tsx)：临时游标使用 volatile 消息。Roomcast 复用现有鉴权通道并在发送前检查 [PeerJS 缓冲](https://peerjs.com/client/api/data-connection)。
- [Electron 44.3.0 Windows 实现](https://github.com/electron/electron/blob/v44.3.0/shell/browser/native_window_views.cc)、[窗口 API](https://www.electronjs.org/docs/latest/api/browser-window)、[屏幕 API](https://www.electronjs.org/docs/latest/api/screen)：原生点击穿透、不激活、捕获排除和物理像素/DIP 转换。
- [OBS 32.1.2 WGC 客户区](https://github.com/obsproject/obs-studio/blob/32.1.2/libobs-winrt/winrt-capture.cpp)：窗口客户区几何。保留 Roomcast 已有 OBS 拉伸设置，激光不改变采集或编码尺寸。

## 人工验收（尚未执行）

### beta.13 实际桌面不可见：beta.14 修复

用户实机截图确认 beta.13 只能在共享预览看到远端轨迹，实际共享显示器没有桌面轨迹。排查发现 Windows 几何助手的可见坐标 JSON 格式串包含未转义的关闭括号，取得有效区域时抛出 `FormatException`，随后静默退出、禁用桌面层。beta.14 将 JSON 外层括号与格式项分开拼接，避免 .NET Framework 的相邻括号解析问题。

同时将桌面页面的 `file://` ES module 改为构建时打包的经典脚本，保留已关闭的 `grantFileProtocolExtraPrivileges` 安全设置；绘制脚本完成初始化后显式发送就绪信号。新增单个最多 32 条的阶段诊断文件 `userData/desktop-laser/diagnostics.json`，只记录时间、阶段、错误类型/退出码，不记录房间、名称、源标识或轨迹。

本次确认了源码阻断并完成修复和编译，尚未启动新客户端进行真机验收。之前对 beta.13 桌面能力的静态判断不应被视为实际可用证明。

1. 使用此 PR 的 Windows 客户端建房，另外两名成员进入同一共享。三人分别连续拖动、快速点按、交替画线；确认颜色不同、昵称可辨、笔画不串线且自动淡出。未进入共享的成员不应发送轨迹。
2. 同时开两路共享，分别绘制；轨迹只出现在对应共享。退出观看、停止/重新共享、离房重入后没有旧轨迹。
3. 检查主播放器全屏、小窗、置顶小窗、小窗全屏及返回主窗；声音、音量、退出观看、窗口恢复和原有控制自动隐藏仍可用，Esc 能退出激光笔模式。
4. 共享者将 Roomcast 最小化，在实际共享的 Windows 屏幕上操作其他应用；远端成员绘制时，共享者应看到轨迹，鼠标点击、拖动、滚轮和键盘焦点不受影响；观看者画面不应出现双重轨迹或黑块。
5. 分别覆盖 OBS 屏幕、OBS 窗口、Integrated 屏幕/窗口；检查主副屏、负坐标、100%/150%/200% 混合缩放、跨屏移动、窗口调整大小和最小化/恢复。窗口被其他应用遮挡时桌面层安全隐藏，回到目标窗口后新轨迹恢复。
6. 房主禁用成员、管理员禁用普通成员、房主禁用全房；应立即停止发送并清除尾迹。管理员不能改房主或另一管理员。恢复权限、房主退出/交接后状态正确。
7. 网页成员与 Windows 成员互相绘制，包含浏览器房主；检查慢网络期间绘制不会导致房间断线，停止绘制后不持续回放旧轨迹。
8. 对比绘制前、多人连续绘制、结束数秒后的任务管理器 CPU/GPU/内存和网络。确认桌面窗口/助手退出、轨迹绘制循环停止；记录实际数据后再评价资源目标是否达到。

## 已知边界

- 此轮只做静态审查和编译，不新增/运行自动测试、烟雾测试或测试脚本；上述真机交互、延迟、性能和捕获排除均未实测。
- Windows 窗口共享仅在目标前台且未最小化/隐藏时显示桌面激光，避免将轨迹画到遮挡应用上。OBS 同标题/类/进程的窗口无法唯一识别、窗口在首次定位前改名、助手编译/权限受限时安全隐藏；不会猜测另一个屏幕或窗口。
- 透明置顶层不能覆盖安全桌面或独占全屏。Windows 10 2004 之前的捕获保护可能显示黑块；不同 OBS/WGC/驱动组合及混合 DPI 必须人工确认。网页共享者没有原生 Windows 桌面层；iPhone 原生视频全屏无法显示网页 Canvas，可在网页内观看/绘制。
- 首次系统助手准备或桌面窗口冷启动可能错过短笔画。已进入可靠传输通道的旧包无法撤回，网络严重停顿仍可能带来延迟；新包积压受限并主动丢弃，不保证任意网络下固定延迟。
- 本 PR 保持草稿待人工验收，未合并、发版或部署。最新源码与构建结果不等同于线上网页或安装包已更新。
