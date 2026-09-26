# STEP-16 修复：限流时检查不到新版本（降级源改用发布订阅）

> 时间：创建于 2026-09-26 17:2x；本步的完整时间线见 [TIMELINE-全程时间戳记录.md](TIMELINE-全程时间戳记录.md)。

- 触发：**真实更新测试（用户要求）当场暴露** —— beta.4 已发布，但运行 beta.3 的 app 报"没有可用更新"。
- 结论：已定位修复，随 `0.14.3-beta.5` 发布。

## 1. 取证

| 检查 | 结果 |
| --- | --- |
| 端到端脚本输出 | `[auto-update] 检查更新： {"available":false}` → 拒绝执行（脚本行为正确） |
| 同一代理下的 API 额度 | `core: limit=60 remaining=0`，`reset=17:41:27` → **被限流** |
| 直接请求发布列表 | `403 (rate limit exceeded)` |
| 固定站点清单（旧降级源） | `{"version":"0.14.3-beta.3", …}` → 与当前版本相同 → 判为"无更新" |
| 发布订阅（新降级源） | HTTP 200、9 个条目、最新 `v0.14.3-beta.4`，**不消耗 API 额度** |

根因链：**API 限流 → 退回固定站点清单 → 站点在 STEP-13 已冻结、停在 beta.3 → 检查不到 beta.4**。
（STEP-12/13 已把这个滞后登记为"长期状态"，但当它真的挡住一次更新时，就必须修。）

## 2. 修复：降级链改为"订阅优先"

```
GitHub API（60 次/小时/IP）
  ↓ 403 / 429 / 网络错误
发布订阅 releases.atom   ← 同源、含测试版、零额度
  ↓ 失败
固定站点 version.json    ← 仅作最后备选（站点已不再随版本发布）
  ↓ 失败
把原始 API 错误报给界面
```

实现（`electron/update-check.mjs`）：

- 新增 `RELEASE_FEED_URL` 与 `parseReleaseFeed(xml)`：用极小的正则解析 Atom
  （不引入 XML 依赖），只接受形如 `/releases/tag/<版本>` 的链接，按语义化版本**倒序**返回；
- 抽出 `describeFallback(version, {...})`：资产直链、`SHA256.txt` 地址、tag 源码里的更新说明
  由订阅与清单两条路径共用，避免重复；
- 抽出 `newerThanCurrent(version)`：把"稳定版不推送测试版"与版本比较两条规则统一；
- 结果里用 `viaFeed` / `viaManifest` 标明来源，界面据此如实显示
  "已改用发布订阅检查" / "已改用固定站点版本清单"。

## 3. 验证

| 项目 | 结果 |
| --- | --- |
| 新增单测 | `a rate-limited GitHub API falls back to the release feed`（含请求顺序：API → 订阅）、`parseReleaseFeed reads tags, ignores junk and sorts newest first`、`the manifest is only used when the feed fails too` |
| 既有单测 | 原"限流退回清单"用例更新为"API → 订阅 → 清单"的顺序断言 |
| 全量测试 | `npm test` **191/191 通过** |
| 线上核实 | 订阅可访问且已含 beta.4（见上表） |
| 真实更新验证 | 见 `RELEASE_CHECKLIST-0.14.3-beta.5.md` 的"真实更新验证结果" |
