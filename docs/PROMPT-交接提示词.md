# 交接提示词（可直接复制粘贴给下一个模型）

---

你是接手 **Roomcast**（Windows 桌面端 + 网页观看端；Electron 44 + React 19 + Vite 7；仓库 `github.com/lpossj/roomcast`；本地路径 `C:\Users\Administrator\Documents\Deepseek\roomcast-source`）的工程师。

**当前状态**：本地 `main` 领先远端 4 个提交（远端停在 `fce66c5`），版本号已是 `0.14.3-beta.6`，产物已在本机 `release/` 打好并通过校验（`npm test` 191/191、`npm run check` 全绿、`npm run verify:release` ok）。**按用户要求尚未 push、未打 tag、未发 Release**——发版前必须先问用户。

**必须遵守的用户约束**
1. **不要改动 TURN/中继的取用方式**，也不要加"没有可用的中继"这类提示。用户明确禁止过，并认为手机问题不是中继造成的。
2. **最小修改**，不做无关重构；每处改动要能单独回滚。
3. **每做一步都要写带时间戳的文档**（做了什么、依据、验证结果）。
4. **不要浪费流量/Token**（避免重复下载 200 MB+ 的发布包；需要联网时可以联网）。
5. 需要用户配合的只有"无法替代的真机操作"（例如在手机上点一下）；分析、定位、修改、测试、打包都要自己做。

**未解决的主要问题：手机端连不上**
- iOS 显示 `negotiation_failed` —— 这是 **VDO.Ninja 侧的错误码被原样显示**（`src/ScreenPlayer.jsx:1269-1276` 把 `event.detail.reason` 当错误文本抛出）；这个字符串在本仓库当前源码、全部 git 历史、`dist/`、`node_modules/@vdoninja`、线上站点 bundle 里**都不存在**。
- 安卓显示我们的文案「无法与房主建立 P2P 连接。」（`src/p2p.js:993`，控制通道 `hostReady` 失败，预算 25 s + 8 s）。
- 两者都发生在**协商/ICE 阶段** → 手机已进房、信令正常，问题在打洞或中继。
- 用户自述"网不一样都能连、流量和 Wi-Fi 都能连，**现在只有手机端不行**"，且现在跑的是本地打的 **beta.6**。
- **关键事实**：beta.6 相对 beta.5 只改了关闭/退出路径（`electron/main.cjs`、`src/useRoom.js`、`src/p2p.js` 的 `leave()`）；**`src/App.jsx` 与 beta.5 逐字节相同**，加入房间/信令/`peerAuthProtocol`/ICE 接线/媒体车道**未改动**（证据：`git diff --stat v0.14.3-beta.5 -- src/ electron/`）。
- **第一步**：请用户做一次 A/B —— 同一部手机、同一网络，分别跑 `C:\Users\Administrator\Downloads\Roomcast-0.14.3-beta.5-Windows\Roomcast.exe`（未经我改动）与本机 `release\win-unpacked\Roomcast.exe`（beta.6）；同时收集：①手机上的完整提示文本；②手机是 Wi-Fi 还是流量；③桌面「设置 → 网络 → Cloudflare TURN 中继」的开关状态与「测试」按钮的结果。**在拿到这些证据之前，不要凭空修改连接或中继相关代码。**

**已知隐患（未修，用户禁止乱动，仅记录）**
- TURN 凭据 `ttl:3600`（`electron/main.cjs:909,922`），房间（`server/rooms.mjs:1304-1307`）与邀请（`src/p2p.js:548-551`）各冻结建房时那一份，服务端没有更新入口 → 房间开满 1 小时后新加入者拿到的是**失效中继**。
- VDO 备用车道被显式设为直连：`src/transports/vdo-transport.js` 的 `turnServers:false / autoRelay:false`，并由 `scripts/check-network-architecture.mjs:178-180`、`scripts/check-vdo-resolution-priority.cjs:17-19` 两条门禁锁定。放开它需要同步改门禁（属于架构决策）。
- 手机加载的网页客户端来自**已冻结的静态站点** `https://lpossj.github.io/roomcast/`（bundle 停在 beta.3 时代，`version.json` 也停在 beta.3）；只有桌面端在升级。

**不要踩的坑**
- **不要手工改 `app.asar`**：electron-builder 把归档头哈希写进 exe 的 `ElectronAsarIntegrity`，重打包后程序启动即 `FATAL: Integrity check failed for archive entry '<header>'`。要验证打包行为只能重新构建。
- 本机 git 必须显式走代理：`git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 …`（系统代理是 FlClash，时开时关；代理关闭时 `github.com` 与 git 都不通，但 `api.github.com` 直连可用）。
- `npm run package:source` 要求**工作区干净**（先提交再打源码包）。
- `@electron/asar` 会缓存归档头：读取前 `asar.uncache(path)`；`extractFile` 的路径要剥掉 `listPackage` 返回的前导分隔符。
- `detached:true` 与 `windowsHide` 在 Windows 上互斥：前者能让子进程活过父进程退出但会显示控制台窗口；当前用"隐藏 PowerShell 启动器接力 + `Start-Process -WindowStyle Hidden`"两者兼顾。

**先读这些文档**（都在本包内）：`HANDOFF-交接说明.md`（全程时间戳与证据）、`docs/EXIT-GUARD-退出加固方案.md`（第 11 节为实施记录）、`docs/MOBILE-CONNECT-手机端连接失败分析与修复.md`（第 8 节为撤回记录）、`docs/auto-update/TIMELINE-全程时间戳记录.md`、`docs/auto-update/STEP-01…18`、`docs/RELEASE_NOTES-0.14.3-beta.6.md`、`docs/RELEASE_CHECKLIST-0.14.3-beta.6.md`。

**建议的推进顺序**
1. 与用户确认这次要解决的具体目标（手机连接？还是别的）。
2. 拿到真机证据 → 再定位；每一步按"最小修改 + 时间戳文档 + 可回滚提交"执行。
3. 用户确认可以发版时：`git push` + 打 tag `v0.14.3-beta.6`，让 CI 出正式资产（或按用户偏好做"同号重发"）。
