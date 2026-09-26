# Roomcast 交接说明书（2026-09-26 会话全程）

> 接手更正（2026-09-26 21:08:52 +08:00）：以下为历史交接稿；其中手机失败阶段、Windows参数、代理必要性及旧验收记录有不准确结论。请先读 `docs/HANDOFF-AUDIT-20260926.md` 和 `docs/BETA6-LOCAL-REBUILD-20260926.md`。用户已确认beta.5/beta.6同网均可观看、TURN未启用；本轮不声称手机跨网故障已修复，保持beta.6，仅本地验证打包，禁止push/tag/Release。

> 生成时间：2026-09-26 19:3x（本机时间 UTC+8）
> 交接对象：接手此仓库的另一个模型 / 另一位工程师
> 仓库：`C:\Users\Administrator\Documents\Deepseek\roomcast-source`（远端 `github.com/lpossj/roomcast`，分支 `main`）
> **当前状态：本地已提交、已打包、按用户要求「未 push、未打 tag、未发 Release」**

---

## 0. 一句话现状

- 版本号已升到 **`0.14.3-beta.6`**，本机产物已打好（见第 5 节哈希）。
- 本地领先远端 **4 个提交**（远端 `main` 停在 `fce66c5`），**尚未推送**。
- 本会话做了三块工作：①桌面自动更新（已发布到 beta.3/beta.4/beta.5，其中 beta.5 被**同号重发**覆盖）；②退出加固（无法退出程序的问题，已在 beta.6 修好并打包）；③手机端连接排查（**TURN 相关改动已按用户要求全部撤回**，问题仍未定位，需要真机证据）。

---

## 1. 用户的诉求与约束（必须遵守）

1. **别动 TURN**：不要改中继（Cloudflare TURN）的取用方式、不要加"没有中继"之类的提示。用户明确说过"之前手机是可以连的"，认为问题不在中继。
2. **最小修改**：每次改动要小、能回滚，不做与任务无关的重构。
3. **每做一步都要写文档、带时间戳**：记录"做了什么、依据是什么、验证结果"。
4. **不要浪费流量/Token**：避免不必要的 200 MB+ 重复下载；但需要联网时可以联网。
5. **发版节奏由用户决定**：本次明确"先不 push"。用户此前也抱怨过"你又要 release 一次？"。
6. 用户会自己用真机（iOS / 安卓）验证，不要把验证工作推给用户——需要用户做的只有"手机上点一下"这类无法替代的操作，其余（分析、定位、修、测、打包）都要自己做完。

---

## 2. 本会话完整时间线（时间戳均为本机时间）

### 2.1 自动更新功能（桌面端）

| 时间 | 事件 | 结果/产物 |
| --- | --- | --- |
| 15:09 | 对比两侧源码（`ChatGPT\屏幕共享` vs 本仓库） | 代码零差异，只同步 3 个文档；`docs/auto-update/STEP-01` |
| 15:10 | 全自动更新设计 | `STEP-02`（流程、安装目标判定、覆盖策略、失败路径） |
| 15:11 | 下载与校验改造 | `electron/update-check.mjs`：流式下载 + 进度 + `.part` + 资产选择 |
| 15:12 | 替换模块 | `electron/update-install.mjs`：目标判定 / 纯 Node ZIP 解压 / `apply.cmd` 生成 / 清理 |
| 15:17 | 主进程管线 + 更新窗口 + 启动弹窗 + 设置面板 | `main.cjs`、`public/updater.*`、`src/App.jsx` |
| 15:28 | 测试与对抗式审查 | 13 项问题 + 20 条发散失败模式，逐条修 |
| 15:39 | 真机报"接口请求过于频繁" | `STEP-09`：加固定站点清单兜底 |
| 15:46 | 真机报"缺少 resources/app.asar" | `STEP-10`：Electron 把 asar 报成虚拟目录 → 改判定 |
| 16:0x | 自驱动端到端脚本 | `scripts/check-auto-update.cjs`（CDP 驱动） |
| 16:25 | 建立全程时间戳文档 | `docs/auto-update/TIMELINE-全程时间戳记录.md` |
| 16:42:32 | 按用户要求重新发布网页站点 | gh-pages `fcf7221 → d8b710d`，`version.json` 停在 beta.3（此后站点冻结） |
| 16:47:30 | **beta.3 发布成功** | 自动更新首个正式可用版本 |
| 16:51 | 给用户造 beta.2 目录版测试包 | 用于人工观看更新过程 |
| **16:53–16:54** | **用户亲眼看到完整自动更新（beta.2 → beta.3）** | `apply.log` 记录 `16:53:57 update start` / `16:54:00 files replaced, restarting` |
| 16:55 | 用户反馈两点：删掉 EXE/ZIP 手动下载按钮；更新后冒出 3 个 cmd 窗口 | `STEP-15` |
| 17:15:40 | **beta.4 发布成功**（窗口修复 + 删除多余下载入口） | 但窗口修复用了错误手段（见 2.2） |
| 17:2x | 第一轮真实更新验证失败：报"没有可用更新" | 定位为 GitHub 接口限流 + 站点清单陈旧 → `STEP-16`：降级链改为"发布订阅 releases.atom 优先" |
| 17:37:58 | **beta.5 发布成功**（含订阅降级） | 但 beta.5 含"替换脚本被连带终止"的回归 |
| 17:38:40 | 真实更新 beta.4 → beta.5 失败 | `apply.log` 只有 91 字节一行 `update start`，程序目录未变 → `STEP-17` |
| 17:44–17:46 | 修复：两级隐藏启动器（分离的隐藏 PowerShell → `Start-Process -WindowStyle Hidden`） | 可见控制台计数回到基线；标记文件证明脚本活过父进程退出；191/191 |
| 17:47 | 用户叫停发版 | 只提交本地 `21d9f38` |
| 17:47–18:03 | 用户要求"就 beta.5 的 release 修改，不要 beta.6" → **同号重发 beta.5** | 移动标签 `v0.14.3-beta.5` → `dc6dd2e`；CI 重新构建并用 `--clobber` 覆盖 6 个资产；核对新 `SHA256.txt` 与基线（3 个重建哈希变化、未重建的逐字节不变）；发布资产 `source.zip` 内含修复 |
| 18:05–18:09 | 试图"就地改包"做实机验证 | **失败**：Electron 校验 electron-builder 写进 exe 的归档头哈希 → `FATAL: Integrity check failed for archive entry '<header>'`。结论：改 asar 不可行，必须重新构建 |
| 18:14 | 用户实测：beta.4 显示"已是最新版本"，看不到 beta.5 | 取证：未登录 API 403（`x-ratelimit-used: 60/60`）、额度 18:41:27 重置、站点清单停在 beta.3 → **beta.4 缺 beta.5 才有的订阅降级**，不是 beta.5 的问题 |
| 18:41 | 额度重置时刻；后台任务报"代理未开" | 用户机器的代理（FlClash，127.0.0.1:7890）当时是关闭的 |

### 2.2 退出加固（关不掉程序）

| 时间 | 事件 |
| --- | --- |
| 18:2x | 用户报三个症状：TURN 建不了公网连接、不打开 TURN 时网页端连不上、移交房主失败 → **都退不出程序** |
| 18:2x | 定位：`src/useRoom.js:1051` 回 `ok:false` → `electron/main.cjs:522` 把它当**否决票**；20 秒计时器到点只清标志不关窗；`before-quit` 收尾无期限（`main.cjs:1199-1204`） |
| 18:2x | 产出方案文档 `docs/EXIT-GUARD-退出加固方案.md`（含精确行号、测试策略、取舍） |
| 18:59–19:02 | 最小实现：关窗 2.5 秒预算 → 无条件关闭；2.5 秒内再点一次 ✕ 立即强退；`ok:false` 不再否决（只记日志）；`before-quit` 5 秒看门狗 + `app.exit(0)`；`leave()` 移交失败改为降级"房间已关闭"而不是抛错 |
| 19:02 | 重写 `tests/migration-close.test.mjs`、`tests/p2p-migration.test.mjs` 的 `commitFailure` 场景；`npm test` **191/191** |

### 2.3 手机端连接（问题未解决，改动已撤回）

| 时间 | 事件 |
| --- | --- |
| 18:55 | 全仓搜索 `negotiation_failed`：**当前源码、`git log -S` 全历史、`dist/`、`node_modules/@vdoninja`、线上站点 bundle 全部零命中** → 它是 VDO.Ninja 侧错误码，被 `src/ScreenPlayer.jsx:1269-1276` 原样显示 |
| 18:56–18:58 | 查两条媒体车道：原生 P2P 有中继与"仅中继重试"（`p2p.js:2826-2853`、`ScreenPlayer.jsx:1436`）；VDO 备用车道**按设计禁用中继**（`vdo-transport.js` 的 `turnServers:false / autoRelay:false`，且被 `scripts/check-network-architecture.mjs:178-180`、`scripts/check-vdo-resolution-priority.cjs:17-19` 两条门禁守着） |
| 18:57 | 发现 TURN 凭据 `ttl:3600`（`main.cjs:909,922`），房间（`server/rooms.mjs:1304-1307`）与邀请（`p2p.js:548-551`）各冻结一份且服务端无更新入口 → "过期不刷新" |
| 18:59 | 先尝试放开 VDO 中继 → 触到门禁 → **主动回滚**（不动架构不变量） |
| 19:00 | 改为：分享前刷新 TURN 凭据（`refreshRelay()`）+ 无中继时提示 |
| **19:20** | **用户要求撤回 TURN 与提示并质问"哪一步改错了"** |
| 19:22–19:24 | 全部撤回；`src/App.jsx` 与 `v0.14.3-beta.5` **零差异**；`npm test` 191/191 |
| 19:25 | 重新打包 + 重新生成校验和 |

---

## 3. 当前代码改动清单（相对 `v0.14.3-beta.5`）

`git diff --stat v0.14.3-beta.5 -- src/ electron/`：

```
 electron/main.cjs | 50 ++++++++++++++++++++++++++++++++-----   ← 关闭/退出
 src/p2p.js        | 35 +++++++++++++++++++-------------      ← 只有 leave()
 src/useRoom.js    | 20 ++++++++++++++++----                  ← 只有关窗握手
```

- **`src/App.jsx` 与 beta.5 逐字节相同**（`git diff v0.14.3-beta.5 -- src/App.jsx` 为空）→ 邀请链接生成、分享弹窗、入口、ICE 传参、`canHostRoom` 全部未动。
- `src/p2p.js` 的改动**全部在 `leave()`**（房主退出时的移交）：失败不再抛错、降级为"移交未能完成（原因），房间已关闭"。
- 加入房间、`openPeer`、`peerAuthProtocol`、ICE 服务器接线、媒体车道顺序 **未改动**。

其他（自动更新那一批，已发布）：`electron/update-check.mjs`、`electron/update-install.mjs`、`electron/preload.cjs`、`public/updater.*`、`electron/updater-preload.cjs`、`src/App.jsx` 的 `UpdateSection`/`UpdatePromptModal`、`src/preferences.js`、`src/styles.css`、`scripts/check-auto-update.cjs`、`scripts/check-update-apply.cjs`、以及大量测试。

---

## 4. 我怀疑的问题点（按可信度排序）

### 4.1 手机端连不上（**未解决**）

1. **信令是通的、卡在 ICE/中继**：iOS 的 `negotiation_failed` 是 VDO 侧错误码，安卓那句是 `src/p2p.js:993`「无法与房主建立 P2P 连接。」——两者都发生在"已进房、正在协商"之后。所以问题不在邀请链接/协议/鉴权，而在打洞或中继。
2. **"之前能连、现在不能"缺少对照**：用户自述"网不一样都能连、流量和 Wi-Fi 都能连，现在只有手机端不行"，且当前跑的是我打的 **beta.6**。但我改的东西与连接路径无关（见第 3 节），**必须先做 A/B**：同一部手机、同一网络，分别跑 `Downloads\Roomcast-0.14.3-beta.5-Windows`（未被我改动过）与 beta.6。
3. **TURN 凭据 1 小时过期且不刷新**（已撤回，未修）：房间与邀请各冻结建房时的那份凭据，服务端无更新入口。若手机在房间开出 1 小时后才加入、或用了旧邀请，拿到的中继是失效的。**这是一个真实存在的隐患，但用户不许动**。
4. **VDO 备用车道在移动网络下必然失败**：它被显式设为直连（`turnServers:false / autoRelay:false`），且有两道项目门禁。若原生 P2P 也打不通，手机就没有任何可用通路。**放开它需要同时改两条门禁**（属于架构决策，用户未批准）。
5. **web 观看链接指向冻结的静态站点**：手机加载的是 `lpossj.github.io/roomcast/`（站点 bundle 停在 beta.3 时代），只有桌面端在更新。若两端协议不兼容，会在协商阶段失败——但 `peerAuthProtocol` 仍是 2，理论上兼容。**未验证**。

### 4.2 退出加固（**已修，未真机验证**）

6. 已按方案实现，但**没有在真机上复现过"TURN 不可用 + 手机在线"的退出场景**；打包产物的冒烟测试只验证了"空房间关窗 157 ms 退出"。
7. 主动放弃的两项：服务端 `close()` 未加"主动断开连接"（靠 5 秒看门狗兜底）；`session-end`（Windows 关机）路径未单独处理。
8. 服务端文案「房主连接异常中断；未完成安全迁移，房间已关闭。」会出现在"正常退出但移交失败"的场景里，措辞偏负面，未改。

### 4.3 自动更新（**已发布，仍有已知缺口**）

9. 覆盖是 `robocopy /E`，**非原子、无回滚、不删除多余文件**。
10. 便携单文件 EXE 的"整包更新"路径**从未实测**（只实测过目录版 ZIP）。
11. 产物未签名（SmartScreen 提示）；装在 `Program Files` 等无写权限目录时更新失败。
12. `beta.4`/`beta.5` 的自动更新能力有历史缺陷（beta.4 闪窗口、beta.5 替换脚本被连带杀死，均已在**同号重发的 beta.5** 资产里修好）；**已运行 beta.5 的机器因版本号相同不会看到这次覆盖**，需要手动换包。

---

## 5. 产物与校验（本机打包于 2026-09-26 19:14–19:16）

| 产物 | SHA256 |
| --- | --- |
| `release/Roomcast-0.14.3-beta.6-Windows.exe` | `A008FFC943F3F214759187AA7405497A6BA06134FAF6F710D5AE685CC4A41BD4` |
| `release/Roomcast-0.14.3-beta.6-Windows.zip` | `1144E5BD581DA7A2FB0F2C52800CA1A00084146AC7642A8333985BAE333D7294` |
| `release/Roomcast-0.14.3-beta.6-source.zip` | `A926D4D1A7603624155404D928A2B42477B2880006DB432CAD8384C06EB94AED` |
| `release/Roomcast-0.14.3-beta.6-loopback-capture.zip` | `01517EEA4BF967880F89BDC0BD2928197350FB9F43CB4F5A60B629A944A3503B` |
| `release/SHA256.txt` | 7 条，含 OBS 源码归档、loopback 插件、LICENSE、cloudflared |

验证记录：`npm test` 191/191 · `npm run check` 全绿（含网络架构静态自检）· `npm run verify:release` = `"ok": true` ·
打包产物内代码核对（解包 `app.asar`：版本 `0.14.3-beta.6`、`CLOSE_GRACE_MS`/`EXIT_GRACE_MS` 存在、旧否决行已消失）·
打包产物冒烟（1 051 ms 启动、`window.close()` 后 **157 ms 以退出码 0 结束**）。

---

## 6. 我不知道 / 未验证的东西（清单）

1. 手机端失败的真实原因（**最关键的未知**）：需要真机 A/B + 手机上的完整提示文本 + 是否 Wi-Fi/流量 + 桌面「设置 → 网络 → TURN 中继」的开关与「测试」结果。
2. 用户的 TURN 到底有没有配置：我在 `%APPDATA%\roomcast\preferences.bin` 里读不到（内容被加密，DPAPI 解密失败），所以**无法从本机确认**他们的中继设置。
3. beta.6 的退出加固在真机（有手机在线、TURN 不可用）下的表现。
4. 手机浏览器加载的静态站点（beta.3 时代 bundle）与 beta.6 桌面端之间是否真的完全兼容（`peerAuthProtocol: 2` 一致，但没有端到端验证过）。
5. 便携单文件 EXE 的更新路径、无写权限目录、签名缺失导致的 SmartScreen 行为。
6. OBS/音频回环/媒体播放这些实现本会话**未改动也复测过**。
7. 为什么本机会话中 GitHub 未登录接口额度长期是 0：出口走代理（`13.159.16.105`，共享 IP），`x-ratelimit-used: 60/60`；直连时 `api.github.com` 通（额度 58/60）而 `github.com` 完全不通（下载发布资产必须开代理）。

---

## 7. 关键坑与教训（接手时最容易踩）

1. **不要试图修改 `app.asar`**：electron-builder 把归档头哈希写进 exe 的 `ElectronAsarIntegrity`，任何重打包都会让程序启动即 `FATAL: Integrity check failed for archive entry '<header>'`。要验证打包后的行为，只能重新构建。
2. **VDO 车道是"直连-only"且被门禁锁定**：改它必须同步改 `scripts/check-network-architecture.mjs:178-180` 与 `scripts/check-vdo-resolution-priority.cjs:17-19`。
3. **本机 git 必须显式走代理**：`git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 …`（系统代理 FlClash 时开时关，代理关闭时 git 与 `github.com` 都不通，但 `api.github.com` 直连可用）。
4. **`package:source` 要求工作区干净**：必须先提交再打源码包。
5. **`@electron/asar` 会缓存归档头**：读取前要 `asar.uncache(path)`；`extractFile` 对 `listPackage` 给出的路径要剥掉前导分隔符。
6. **`detached:true` 与 `windowsHide` 互斥**：前者让子进程活过父进程退出（Windows 忽略 `CREATE_NO_WINDOW` → 出现控制台窗口），后者无窗口但会被 Chromium 的 job object 连带杀死。当前用"隐藏 PowerShell 启动器接力"同时满足两者。
7. **GitHub 未登录接口 60 次/小时/IP**：自动更新已改为"发布订阅 `releases.atom` 优先"（零额度）。
8. **用户很在意"不要多发包"**：同号重发（移动标签 + CI 覆盖资产）是用户明确认可的发版方式；但本次要求先不 push。

---

## 8. 交接提示词（可直接粘贴给下一个模型）

见同包内的 `PROMPT-交接提示词.md`（内容与下面一致）：

> 你是接手 Roomcast（Windows 桌面端 + 网页观看端，Electron 44 + React 19 + Vite 7，仓库 `github.com/lpossj/roomcast`，本地 `C:\Users\Administrator\Documents\Deepseek\roomcast-source`）的工程师。
>
> **当前状态**：本地 `main` 领先远端 4 个提交（远端停在 `fce66c5`），版本号已是 `0.14.3-beta.6`，产物已在本机 `release/` 打好并通过校验（`npm test` 191/191、`npm run check` 全绿、`npm run verify:release` ok）。**按用户要求尚未 push、未打 tag、未发 Release**。
>
> **必须遵守的用户约束**：①不要改动 TURN/中继的取用方式，也不要加"没有中继"这类提示（用户明确禁止，且认为手机问题是别的原因）；②最小修改，不做无关重构；③每做一步都要写带时间戳的文档；④不要浪费流量/Token；⑤发版节奏听用户的，发版前先问。
>
> **未解决的主要问题**：手机端连不上。iOS 显示 `negotiation_failed`（这是 VDO.Ninja 侧的错误码，被 `src/ScreenPlayer.jsx:1269-1276` 原样显示，仓库里没有这个字符串），安卓显示 `src/p2p.js:993`「无法与房主建立 P2P 连接。」——两者都发生在**协商/ICE 阶段**，说明手机已进房、信令正常。用户自述"之前 Wi-Fi 和流量都能连，现在只有手机端不行"，且当前跑的是本地打的 beta.6。请注意：**beta.6 相对 beta.5 只改了关闭/退出路径**（`electron/main.cjs`、`src/useRoom.js`、`src/p2p.js` 的 `leave()`），`src/App.jsx` 与 beta.5 逐字节相同，连接路径未被改动。第一步应当是让用户做一次 A/B（同一部手机、同一网络分别跑 beta.5 与 beta.6），并收集：手机上的完整提示、Wi-Fi 还是流量、桌面「设置 → 网络 → Cloudflare TURN 中继」的开关状态与「测试」结果。
>
> **已知隐患（未修，用户禁止乱动）**：TURN 凭据 `ttl:3600`，房间（`server/rooms.mjs:1304-1307`）与邀请（`src/p2p.js:548-551`）各冻结一份且服务端无更新入口，房间开满 1 小时后新加入者拿到的是失效中继；VDO 备用车道被显式设为直连（`src/transports/vdo-transport.js` 的 `turnServers:false / autoRelay:false`，并被 `scripts/check-network-architecture.mjs:178-180`、`scripts/check-vdo-resolution-priority.cjs:17-19` 锁定）；手机加载的网页客户端来自冻结的静态站点 `lpossj.github.io/roomcast/`（bundle 停在 beta.3 时代）。
>
> **不要踩的坑**：不要手工改 `app.asar`（electron-builder 把归档头哈希写进 exe，改了会 `FATAL: Integrity check failed`）；本机 git 必须显式走代理 `-c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890`；`npm run package:source` 要求工作区干净。
>
> **先读这些文档**：`HANDOFF-交接说明.md`（含全程时间戳与证据）、`docs/EXIT-GUARD-退出加固方案.md`（第 11 节是实施记录）、`docs/MOBILE-CONNECT-手机端连接失败分析与修复.md`（第 8 节是撤回记录）、`docs/auto-update/TIMELINE-全程时间戳记录.md`、`docs/auto-update/STEP-01…18`、`docs/RELEASE_NOTES-0.14.3-beta.6.md`、`docs/RELEASE_CHECKLIST-0.14.3-beta.6.md`。
>
> **你的任务**：先与用户确认要解决的是哪一件事（手机连接 / 其他），再按"最小修改 + 每步带时间戳文档"的方式推进；在拿到真机证据之前，不要凭空修改连接或中继相关代码。

---

## 9. 附件清单（本包内）

- `HANDOFF-交接说明.md`（本文）
- `PROMPT-交接提示词.md`
- `docs/**`：本会话全部时间戳文档（含 `docs/auto-update/STEP-01…18`、`TIMELINE-全程时间戳记录.md`、`FULL-REVIEW-代码全量审查.md`、`EXIT-GUARD-退出加固方案.md`、`MOBILE-CONNECT-手机端连接失败分析与修复.md`、`RELEASE_NOTES/CHECKLIST-0.14.3-beta.6.md` 等）
- `evidence/git-log-local.txt`：本地提交与"未推送"状态
- `evidence/diff-vs-beta5-connection-path.txt`：连接路径零差异的证据
- `evidence/SHA256.txt`：本次产物校验和
- `evidence/artifacts.txt`：产物清单（含大小与时间）
- `evidence/rate-limit-and-proxy.txt`：GitHub 限流与代理状态的取证
