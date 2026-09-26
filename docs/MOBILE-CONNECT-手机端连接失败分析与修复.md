# 手机端连接失败（iOS `negotiation_failed` / 安卓无法建立 P2P）分析与最小修复

> 时间：2026-09-26 18:55–19:0x 分析并修改；本文件记录**每一步做了什么、依据是什么、哪些还没验证**。
> 结论一句话：**移动网络必须走中继（TURN）；本次修掉"中继凭据会过期却从不刷新、且没有中继时界面不提示"这两个真实缺陷，并把"手机能不能连"变成界面上看得见的状态。** 手机真机验证仍需你在手机上做一次。

## 1. 现象与取证

| 现象 | 取证结果 |
| --- | --- |
| iOS 显示 `negotiation_failed` | 这个字符串**在本仓库里不存在**（当前源码、`git log -S` 全历史、`dist/`、`node_modules/@vdoninja`、线上站点 bundle 全部搜过，零命中）。它是 **VDO.Ninja 侧的错误码被我们原样显示**：`src/ScreenPlayer.jsx:1269-1276` 把 `event.detail.reason` 直接当错误文本抛出，而 VDO 备用车道的失败原因来自 VDO 服务器 |
| 安卓无法建立 P2P | 对应我们自己的文案 `src/p2p.js:993`「无法与房主建立 P2P 连接。」（控制通道 `hostReady` 失败，预算 25s+8s=33s）与 `src/ScreenPlayer.jsx:885`「…TURN 未启用或不可用。」 |
| 桌面/同一网络正常 | 说明信令、鉴权、房间逻辑都是好的，失败的只是 **ICE 打洞**这一步 |

## 2. 根因（代码级）

1. **移动网络几乎一定需要中继。** 运营商 CGNAT／对称 NAT 下，纯 STUN 打洞成功率极低。安卓报"无法建立 P2P"、iOS 报 VDO 的协商失败，都是"没有可用 relay 候选"的不同叫法。
2. **两条车道的现状**：
   - 原生 P2P 车道：有中继能力 —— TURN 来自 ①邀请链接里的 `relay=`（房主用 Cloudflare TURN 取到凭据后嵌入）或 ②房间服务器配置的 coturn。媒体车道还会在直连失败后**再用"仅中继"重试一次**（`src/p2p.js:2826-2853`、`src/ScreenPlayer.jsx:1436`）。
   - VDO 备用车道：**按设计禁用中继**（`src/transports/vdo-transport.js:146-153` 的 `turnServers:false` / `autoRelay:false`），并且有两条项目门禁在守着这个不变量：`scripts/check-network-architecture.mjs:178-180`、`scripts/check-vdo-resolution-priority.cjs:17-19`。它在移动网络下**必然连不上**。
3. **真实缺陷 A（本次修复）：中继凭据会过期，但房间与邀请里的那份从不刷新。**
   - 桌面向 Worker 取凭据时固定 `ttl: 3600`，并把 `expiresAt = now + 1 小时` 一并记下（`electron/main.cjs:909,922`）；
   - 房主建房时取一次，就把 TURN 写进房间（`server/rooms.mjs:1304-1307`，服务端**没有**任何后续更新入口）和邀请（`src/p2p.js:548-551`），之后再也不刷新。
   - 结果：房间开满 1 小时（或用旧邀请链接）后，新加入的手机拿到的是**已失效的 TURN**，在移动网络下直接连不上，而界面什么都不会说。
4. **真实缺陷 B（本次修复）：没有中继时界面不提示。** `optionalRelayIce` 取不到凭据时静默返回空列表（`src/relay.js:91-94`），邀请照常显示"可分享"，房主根本不知道自己没开中继。

## 3. 本次最小修改

| 文件:位置 | 改动 | 为什么 |
| --- | --- | --- |
| `src/p2p.js`（房主建房分支） | 记下 `this.relaySettings` | 供"分发邀请前刷新凭据"复用 |
| `src/p2p.js` 新增 `refreshRelay()` | 房主在分发邀请前**重新取一次 TURN** 并更新 `relayInvite` / `controlIceServers` / `mediaIceServers`；任何失败都保留原值并返回现状 | 修缺陷 A：手机拿到的一定是**新鲜**凭据 |
| `src/App.jsx` | 打开「分享房间」时调用 `refreshRelay()`（仅 P2P 房主；进入房间时清空缓存）；把刷新后的 `relayInvite` / `relayEnabled` 传给弹窗 | 让"复制邀请链接"这一刻的链接一定带有效中继 |
| `src/App.jsx`（分享弹窗） | 无中继时显示明确提示：「当前房间没有可用的中继（TURN）：手机在移动网络下通常连不上这台电脑。可在『设置 → 网络』里启用 Cloudflare TURN 中继，然后重新建房。」 | 修缺陷 B：把"连不上"变成"看得见的原因 + 明确的下一步" |

**刻意没改的**：VDO 车道的 `turnServers:false / autoRelay:false`。
那是项目的显式架构决定（两条门禁在守），改成允许 VDO 中继等于**改变中继策略**（媒体改走第三方 TURN、产生额外带宽与限速风险），不该夹在"最小改动"里偷偷做。若你希望"零配置也能让手机看上"，这需要单独决策，见第 6 节。

## 4. 顺带修掉的退出问题（同一轮，详见 `docs/EXIT-GUARD-退出加固方案.md`）

TURN 建不起来 / 网页端连不上 / 房主移交失败时**程序退不出**，是同一类"退出被网络结果卡住"的缺陷，已按方案最小实现：
关闭窗口给 2.5 秒预算后**无条件关闭**、2.5 秒内再点一次 ✕ **立即强退**、`ok:false` 不再否决、`before-quit` 加 5 秒硬看门狗。移交失败时不再抛错，而是降级为"房间已关闭"（服务端本来就会在房主断线时关房，见 `server/rooms.mjs:734-789`）。

## 5. 验证记录

- `npm test`：**191/191 通过**（含改写后的 `tests/migration-close.test.mjs`、`tests/p2p-migration.test.mjs`，它们现在断言"退出不被移交失败阻挡"）。
- `npm run check`：许可证检查 + 全部测试 + `vite build` + **网络架构静态自检通过**（VDO 直连不变量保持不变）。
- 版本号已升到 `0.14.3-beta.6`（`package.json` + `package-lock.json` 两处 + README 链接）。
- **未验证**：真实 iOS / 安卓设备（本机没有设备）。下面的步骤就是为此准备的。

## 6. 你需要在手机上做的验证（以及两条可选路线）

**先确认中继是否开着**（这一步就能解释你遇到的现象）：

1. 打开 Roomcast →「设置 → 网络 → Cloudflare TURN 中继」；
2. 填好 Worker 地址与访问密钥后点「测试」——应显示"TURN 可用，已获取 N 个服务器"；
3. 回到房间打开「分享房间」：**不再出现"没有可用的中继"提示**，说明房间已带中继；
4. 用手机扫/打开网页观看链接：应当能看到画面。若仍失败，把手机上的完整提示发我（新版会把 VDO 的原始错误码一并带出，便于定位）。

**两条可选路线**（都需要你点头才做）：

- **路线一（推荐，零改动）**：就用现在的 Cloudflare TURN 中继（需要你已经部署 `cloudflare-worker/`，见 `docs/Cloudflare-TURN部署.md`）。这是房间自带、凭据可控的正路。
- **路线二（改架构，需同步改两条门禁）**：允许 VDO 车道在直连失败后升级到它自己的 TURN（`turnServers:null` + `autoRelay:true`）。好处：**完全零配置**，手机也能看上；代价：媒体会经过第三方 TURN（带宽/限速不可控），并要把 `scripts/check-network-architecture.mjs` 与 `scripts/check-vdo-resolution-priority.cjs` 里的"direct-only"不变量改成新策略。

## 7. 时间戳记录

| 时间（本机） | 做了什么 | 依据/结果 |
| --- | --- | --- |
| 18:55 | 全仓搜索 `negotiation_failed` | 当前源码 / 全历史 / dist / SDK / 线上站点**零命中** → 确认是 VDO 透传的错误码，不是我们的文案 |
| 18:56 | 通读两条车道的中继策略 | P2P 车道有 relay 能力与"仅中继"重试；VDO 车道被显式禁用且有两条门禁 |
| 18:57 | 追 TURN 凭据生命周期 | `ttl:3600` + 房间/邀请各存一份 + 服务端无更新入口 → **过期不刷新**（真实缺陷 A） |
| 18:58 | 检查"无中继"时的界面表现 | `optionalRelayIce` 静默返回空 → 界面无任何提示（真实缺陷 B） |
| 18:59 | 先尝试放开 VDO 中继 | 触到两条项目门禁 → **主动回滚**，改为不碰架构不变量 |
| 19:00 | 实施最小修改 | `src/p2p.js` 新增 `refreshRelay()`；`src/App.jsx` 分享前刷新 + 无中继提示 |
| 19:00 | 退出加固落地 | `src/useRoom.js`、`src/p2p.js`、`electron/main.cjs`（详见 EXIT-GUARD 文档） |
| 19:01 | 版本号 → `0.14.3-beta.6` | package.json / package-lock.json ×2 / README |
| 19:02 | 门禁 | `npm test` 191/191；`npm run check` 全绿（含网络架构自检） |
| 19:03 | 打包 | `npm run release:build`（便携 EXE + ZIP），见发布说明与验收清单 |
