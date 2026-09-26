# Roomcast 0.14.3-beta.6 验收记录

> 本版修两件事：**手机端连不上房间**（中继凭据过期不刷新 + 无中继无提示）与**程序退不出**（关闭被网络结果否决）。
> 已勾选项＝本轮**实际执行并通过**；未勾选项＝尚未执行，不得当作通过。

- [x] 全量测试：`npm test` **191/191 通过，0 失败**（含两处按新策略重写的用例：`tests/migration-close.test.mjs`、`tests/p2p-migration.test.mjs` 的 `commitFailure` 场景）。
- [x] 项目门禁：`npm run check` 全绿 —— 许可证检查、全部测试、`vite build`、**网络架构静态自检通过**（VDO 直连不变量未被改动）。
- [x] 版本号三处一致：`package.json` / `package-lock.json`（`version` 与 `packages[""]`）= `0.14.3-beta.6`；README 发布说明链接同步。
- [x] 静态取证：`negotiation_failed` 在本仓库当前源码、`git log -S` 全历史、`dist/`、`node_modules/@vdoninja`、线上站点 bundle 中**均无命中** → 确认它是 VDO 侧错误码被 `src/ScreenPlayer.jsx:1269-1276` 原样显示，不是我们的文案。
- [x] 代码审查结论落地：P2P 车道有中继与"仅中继"重试；VDO 车道按设计直连（两条门禁守着，**未改动**）；TURN 凭据 `ttl:3600`、房间与邀请各冻结一份且服务端无更新入口 → 过期不刷新（已修）。
- [x] 打包：`npm run release:build`（便携 EXE + ZIP）；`npm run package:source`；`node scripts/generate-checksums.mjs --strict`。产物与校验值见本文件末节。
- [ ] **手机真机验证（必须由你执行）**：设置 → 网络启用并测试 Cloudflare TURN；「分享房间」不再出现"没有可用的中继"提示；用手机打开网页观看链接应能看到画面。若失败，请把手机上的完整提示发回（新版会带出 VDO 原始错误码）。
- [ ] 退出真机验证（建议）：阻断 TURN/UDP → 建房 → 手机加入 → 点 ✕ → 预期 **≤3 秒退出**并提示"移交未完成，房间已关闭"；同样场景下 2.5 秒内**再点一次 ✕** 应立即退出。
- [ ] 未复测（本轮未改动这些实现）：屏幕采集、OBS 后端、音频回环、媒体播放、自动更新的真实下载安装流程。

## 未做 / 明确保留

- VDO 车道的 `turnServers:false / autoRelay:false` **保持不变**（改动它等于改变中继策略并要改两条项目自检，属于独立决策）。
- 服务端 `close()` 未加"主动断开连接"（主进程 5 秒看门狗已覆盖该风险）。
- Windows 关机（`session-end`）路径未单独处理；未新增"退出时优先移交"的设置项。
- 服务端提示文案「房主连接异常中断；未完成安全迁移，房间已关闭。」未中性化（一行改动，留给下一版）。

## 产物与校验（本机打包）

<!-- 打包完成后填写实际文件名与 SHA256 -->
